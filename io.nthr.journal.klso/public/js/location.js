import { api } from './api.js';

/**
 * Location capture and resolution. The device position comes
 * from the browser's Geolocation API in place of CoreLocation; geocoding and
 * place search go through the server's proxy in place of CLGeocoder/MapKit.
 *
 * The rule that matters is unchanged: an entry stores exactly a granularity, a
 * display name, and *one coordinate at that granularity* — the centroid for
 * city and neighborhood, the place's own point, or the precise captured point
 * for Exact. A coarse tag never keeps the user's precise position.
 */

export const LEVELS = [
  { key: 'off', name: 'Off' },
  { key: 'city', name: 'City' },
  { key: 'neighborhood', name: 'Neighborhood' },
  { key: 'poi', name: 'Place' },
  { key: 'exact', name: 'Exact' },
];

/** "<name>, <locality>" — the Place tag's display string. */
export const placeDisplayName = (place) =>
  place?.locality ? `${place.name}, ${place.locality}` : (place?.name ?? null);

export class LocationService {
  constructor() {
    this.remembered = 'city';
    /**
     * Injected by the app. Writing in progress keeps its location in the
     * session, which carries it into the commit; only a geocode that finishes
     * *after* the commit needs to reach the server.
     */
    this.applyLocation = async (entry) => entry;
    this.denied = !navigator.geolocation;
    this.resolving = new Set();
    /** Per-entry generation so a stale GPS/geocode cannot overwrite a later pick. */
    this.epochs = new Map();
    /**
     * A location chosen before an entry exists (granularity or Place). Shown in
     * the write header immediately and applied on the first keystroke.
     */
    this.pendingLocation = null;
    this.pendingToken = 0;
    this.watchPermission();
  }

  bumpEpoch(entryId) {
    if (!entryId) return 0;
    const next = (this.epochs.get(entryId) ?? 0) + 1;
    this.epochs.set(entryId, next);
    return next;
  }

  epoch(entryId) {
    return this.epochs.get(entryId) ?? 0;
  }

  /** Keeps the header arrow's dimmed slash state honest as permission changes. */
  async watchPermission() {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      const update = () => {
        this.denied = status.state === 'denied';
        this.onPermissionChange?.();
      };
      update();
      status.addEventListener('change', update);
    } catch {
      // Permissions API unavailable: fall back to observing failures.
    }
  }

  /**
   * One-shot position. The browser prompts at first entry creation — never
   * on page load. Explicit granularity picks also call this before any
   * text is typed.
   */
  currentCoordinate() {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          this.denied = false;
          resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        },
        (error) => {
          if (error.code === error.PERMISSION_DENIED) {
            this.denied = true;
            this.onPermissionChange?.();
          }
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 }
      );
    });
  }

  // MARK: - Auto-tagging

  /**
   * Tags a just-created entry at the remembered granularity — zero effort, no
   * taps. If the user already picked a location from the header, that wins.
   */
  async autoTag(entry) {
    if (this.pendingLocation) {
      const location = this.pendingLocation;
      this.pendingLocation = null;
      this.pendingToken += 1;
      this.bumpEpoch(entry.id);
      const tagged = await this.applyLocation(entry, location);
      this.onEntryUpdated?.(tagged);
      return location.isResolved ? tagged : this.resolveIfNeeded(tagged);
    }
    if (this.remembered === 'off') return null;
    const epoch = this.bumpEpoch(entry.id);
    const coordinate = await this.currentCoordinate();
    if (!coordinate || epoch !== this.epoch(entry.id)) return null;
    const tagged = await this.applyLocation(entry, {
      granularity: this.remembered,
      displayName: null,
      ...coordinate,
      isResolved: false,
    });
    if (epoch !== this.epoch(entry.id)) return null;
    this.onEntryUpdated?.(tagged);
    return this.resolveIfNeeded(tagged, epoch);
  }

  /**
   * Completes pending name/centroid resolution. Safe to call any time — from
   * write mode, from a read-mode row, after a reload. Finishing resolution on
   * a closed entry is system bookkeeping, not a content mutation, so entry
   * immutability holds.
   */
  async resolveIfNeeded(entry, epoch = this.epoch(entry?.id)) {
    if (!entry?.location || entry.location.isResolved) return entry;
    if (this.resolving.has(entry.id)) return entry;
    this.resolving.add(entry.id);
    try {
      const { latitude, longitude, granularity } = entry.location;
      const names = await api.reverseGeocode(latitude, longitude);
      if (epoch !== this.epoch(entry.id)) return entry;
      // Show the name as soon as reverse-geocode returns; centroid may still
      // refine the stored coordinate afterward.
      const provisional = provisionalName(granularity, names);
      if (provisional && provisional !== entry.location.displayName) {
        const early = await this.applyLocation(entry, {
          ...entry.location,
          displayName: provisional,
        });
        this.onEntryUpdated?.(early);
        entry = early;
      }
      const resolved = await this.resolve(granularity, names, { latitude, longitude });
      if (!resolved || epoch !== this.epoch(entry.id)) return entry;
      const updated = await this.applyLocation(entry, resolved);
      this.onEntryUpdated?.(updated);
      return updated;
    } catch {
      // Offline or upstream trouble: keep the temporary coordinate and retry
      // lazily the next time this entry is seen.
      return entry;
    } finally {
      this.resolving.delete(entry.id);
    }
  }

  /** Maps a granularity plus resolved names onto the location to store. */
  async resolve(granularity, names, captured) {
    if (granularity === 'exact') {
      // Same neighborhood-style display name; the precise point is kept — the
      // granularity is what distinguishes a point from a centroid.
      const name = names.neighborhood ?? names.city;
      return name ? { granularity, displayName: name, ...captured, isResolved: true } : null;
    }

    // A Place tag is only ever set by explicit choice. An auto-tagged `poi`
    // the user never finished degrades honestly to a neighborhood rather than
    // guessing a place they didn't name.
    const level = granularity === 'poi' ? 'neighborhood' : granularity;
    const name = level === 'city' ? names.city : names.neighborhood;
    if (!name) return null;
    const { centroid } = await api.centroid(name);
    if (!centroid) return null;
    return { granularity: level, displayName: name, ...centroid, isResolved: true };
  }

  // MARK: - Explicit tagging from the picker

  /** Re-tags an entry at a chosen level and remembers the level. */
  async tag(entry, granularity) {
    this.remembered = granularity;
    this.onRememberedChange?.(granularity);
    if (!entry) return this.tagPending(granularity);

    this.pendingLocation = null;
    this.pendingToken += 1;
    const epoch = this.bumpEpoch(entry.id);
    if (granularity === 'off') {
      const cleared = await this.applyLocation(entry, null);
      this.onEntryUpdated?.(cleared);
      return cleared;
    }
    const coordinate = await this.currentCoordinate();
    if (!coordinate || epoch !== this.epoch(entry.id)) return null;
    const tagged = await this.applyLocation(entry, {
      granularity,
      displayName: null,
      ...coordinate,
      isResolved: false,
    });
    if (epoch !== this.epoch(entry.id)) return null;
    this.onEntryUpdated?.(tagged);
    return this.resolveIfNeeded(tagged, epoch);
  }

  /**
   * No entry yet: resolve into `pendingLocation` so the write header updates
   * immediately, then attach on the first keystroke via `autoTag`.
   */
  async tagPending(granularity) {
    const token = ++this.pendingToken;
    if (granularity === 'off') {
      this.pendingLocation = null;
      this.onPendingChange?.();
      return null;
    }
    const coordinate = await this.currentCoordinate();
    if (!coordinate || token !== this.pendingToken) return null;
    this.pendingLocation = {
      granularity,
      displayName: null,
      ...coordinate,
      isResolved: false,
    };
    this.onPendingChange?.();
    try {
      const names = await api.reverseGeocode(coordinate.latitude, coordinate.longitude);
      if (token !== this.pendingToken) return null;
      const provisional = provisionalName(granularity, names);
      if (provisional) {
        this.pendingLocation = { ...this.pendingLocation, displayName: provisional };
        this.onPendingChange?.();
      }
      const resolved = await this.resolve(granularity, names, coordinate);
      if (!resolved || token !== this.pendingToken) return null;
      this.pendingLocation = resolved;
      this.onPendingChange?.();
    } catch {
      // Keep the coordinate; a later autoTag / resolve can finish the name.
    }
    return null;
  }

  /** Tags with a chosen place: its own coordinate, "<name>, <locality>". */
  async tagPlace(entry, place) {
    this.remembered = 'poi';
    this.onRememberedChange?.('poi');
    const location = {
      granularity: 'poi',
      displayName: placeDisplayName(place),
      latitude: place.latitude,
      longitude: place.longitude,
      isResolved: true,
    };
    if (!entry) {
      this.pendingToken += 1;
      this.pendingLocation = location;
      this.onPendingChange?.();
      return null;
    }
    this.pendingLocation = null;
    this.pendingToken += 1;
    this.bumpEpoch(entry.id);
    const tagged = await this.applyLocation(entry, location);
    this.onEntryUpdated?.(tagged);
    return tagged;
  }
}

function provisionalName(granularity, names) {
  if (granularity === 'city') return names.city ?? null;
  if (granularity === 'neighborhood' || granularity === 'exact' || granularity === 'poi') {
    return names.neighborhood ?? names.city ?? null;
  }
  return null;
}
