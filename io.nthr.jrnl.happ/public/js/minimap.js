import { icon } from './icons.js';

/**
 * A small slippy map — the stand-in for MapKit in read mode's map view.
 * Written from scratch rather than pulled from a CDN so the
 * app stays a single self-hosted bundle; it does Web Mercator tiles, pan,
 * zoom, and count-badged clustering.
 */

const TILE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
/** Entries closer together than this on screen merge into one cluster. */
const CLUSTER_PX = 56;

const worldSize = (zoom) => TILE * 2 ** zoom;

function project(lat, lon, zoom) {
  const size = worldSize(zoom);
  const latRad = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * size,
  };
}

function unproject(x, y, zoom) {
  const size = worldSize(zoom);
  const n = Math.PI - 2 * Math.PI * (y / size);
  return {
    lon: (x / size) * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
  };
}

export class MiniMap {
  /** `points` are `{ id, latitude, longitude }`; `onSelect` gets the ids behind a pin. */
  constructor(container, { points, onSelect }) {
    this.container = container;
    this.points = points;
    this.onSelect = onSelect;
    this.zoom = 12;
    this.center = { lat: 37.77, lon: -122.42 };

    container.classList.add('map');
    container.innerHTML = `
      <div class="map-tiles"></div>
      <div class="map-pins"></div>
      <div class="map-zoom">
        <button type="button" aria-label="Zoom in">+</button>
        <button type="button" aria-label="Zoom out">−</button>
      </div>
      <div class="map-attribution">© <a href="https://www.openstreetmap.org/copyright"
        target="_blank" rel="noreferrer">OpenStreetMap</a></div>`;

    this.tileLayer = container.querySelector('.map-tiles');
    this.pinLayer = container.querySelector('.map-pins');
    const [zoomIn, zoomOut] = container.querySelectorAll('.map-zoom button');
    zoomIn.addEventListener('click', () => this.setZoom(this.zoom + 1));
    zoomOut.addEventListener('click', () => this.setZoom(this.zoom - 1));

    this.bindPan();
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(container);
    this.fit();
  }

  destroy() {
    this.observer.disconnect();
  }

  get size() {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  /** Initial camera: fit all pins, or hold the last view when there are none. */
  fit() {
    if (this.points.length === 0) return this.render();
    const lats = this.points.map((point) => point.latitude);
    const lons = this.points.map((point) => point.longitude);
    const bounds = {
      north: Math.max(...lats),
      south: Math.min(...lats),
      east: Math.max(...lons),
      west: Math.min(...lons),
    };
    this.center = {
      lat: (bounds.north + bounds.south) / 2,
      lon: (bounds.east + bounds.west) / 2,
    };

    const { width, height } = this.size;
    if (width === 0 || height === 0) return this.render();

    let zoom = MAX_ZOOM;
    while (zoom > MIN_ZOOM) {
      const topLeft = project(bounds.north, bounds.west, zoom);
      const bottomRight = project(bounds.south, bounds.east, zoom);
      // Leave a margin so pins aren't flush against the edges.
      if (bottomRight.x - topLeft.x <= width - 80 && bottomRight.y - topLeft.y <= height - 120) {
        break;
      }
      zoom -= 1;
    }
    this.zoom = Math.min(zoom, 16);
    this.render();
  }

  setZoom(zoom, anchor) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
    if (next === this.zoom) return;
    if (anchor) {
      // Keep the point under the cursor fixed while zooming.
      const before = this.toLatLon(anchor.x, anchor.y);
      this.zoom = next;
      const after = this.toLatLon(anchor.x, anchor.y);
      this.center = {
        lat: this.center.lat + (before.lat - after.lat),
        lon: this.center.lon + (before.lon - after.lon),
      };
    } else {
      this.zoom = next;
    }
    this.render();
  }

  /** Screen point → geographic coordinate. */
  toLatLon(x, y) {
    const origin = this.origin();
    return unproject(origin.x + x, origin.y + y, this.zoom);
  }

  /** World-pixel coordinate of the container's top-left corner. */
  origin() {
    const { width, height } = this.size;
    const middle = project(this.center.lat, this.center.lon, this.zoom);
    return { x: middle.x - width / 2, y: middle.y - height / 2 };
  }

  bindPan() {
    let start = null;
    let moved = false;

    this.container.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.map-zoom, .map-pin, .map-attribution')) return;
      start = { x: event.clientX, y: event.clientY, center: { ...this.center } };
      moved = false;
      this.container.setPointerCapture(event.pointerId);
      this.container.classList.add('is-panning');
    });

    this.container.addEventListener('pointermove', (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      const anchor = project(start.center.lat, start.center.lon, this.zoom);
      this.center = unproject(anchor.x - dx, anchor.y - dy, this.zoom);
      this.render();
    });

    const end = (event) => {
      if (!start) return;
      start = null;
      this.container.classList.remove('is-panning');
      this.container.releasePointerCapture?.(event.pointerId);
    };
    this.container.addEventListener('pointerup', end);
    this.container.addEventListener('pointercancel', end);

    this.container.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const bounds = this.container.getBoundingClientRect();
        this.setZoom(this.zoom + (event.deltaY < 0 ? 1 : -1), {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      },
      { passive: false }
    );
  }

  render() {
    const { width, height } = this.size;
    if (width === 0 || height === 0) return;
    this.renderTiles(width, height);
    this.renderPins(width, height);
  }

  renderTiles(width, height) {
    const origin = this.origin();
    const zoom = this.zoom;
    const count = 2 ** zoom;
    const firstX = Math.floor(origin.x / TILE);
    const firstY = Math.floor(origin.y / TILE);
    const lastX = Math.floor((origin.x + width) / TILE);
    const lastY = Math.floor((origin.y + height) / TILE);

    const wanted = new Map();
    for (let x = firstX; x <= lastX; x += 1) {
      for (let y = firstY; y <= lastY; y += 1) {
        if (y < 0 || y >= count) continue;
        const wrappedX = ((x % count) + count) % count;
        wanted.set(`${zoom}/${wrappedX}/${y}@${x}`, {
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
          left: x * TILE - origin.x,
          top: y * TILE - origin.y,
        });
      }
    }

    // Reuse tiles that are still on screen so panning doesn't reload them.
    this.tiles ??= new Map();
    for (const [key, element] of this.tiles) {
      if (!wanted.has(key)) {
        element.remove();
        this.tiles.delete(key);
      }
    }
    for (const [key, tile] of wanted) {
      let element = this.tiles.get(key);
      if (!element) {
        element = document.createElement('img');
        // OSM refuses tiles with no Referer. The page is `no-referrer` so
        // pasted media doesn't leak the journal URL; tiles send origin only.
        element.referrerPolicy = 'origin';
        element.src = tile.url;
        element.loading = 'lazy';
        element.alt = '';
        this.tileLayer.append(element);
        this.tiles.set(key, element);
      }
      element.style.transform = `translate(${Math.round(tile.left)}px, ${Math.round(tile.top)}px)`;
    }
  }

  /** Nearby entries merge into one count-badged pin. */
  clusters(width, height) {
    const origin = this.origin();
    const cells = new Map();
    for (const point of this.points) {
      const world = project(point.latitude, point.longitude, this.zoom);
      const x = world.x - origin.x;
      const y = world.y - origin.y;
      if (x < -60 || y < -60 || x > width + 60 || y > height + 60) continue;
      const key = `${Math.floor(x / CLUSTER_PX)},${Math.floor(y / CLUSTER_PX)}`;
      const cell = cells.get(key) ?? { x: 0, y: 0, ids: [] };
      cell.x += x;
      cell.y += y;
      cell.ids.push(point.id);
      cells.set(key, cell);
    }
    return [...cells.values()].map((cell) => ({
      x: cell.x / cell.ids.length,
      y: cell.y / cell.ids.length,
      ids: cell.ids,
    }));
  }

  renderPins(width, height) {
    this.pinLayer.replaceChildren();
    for (const cluster of this.clusters(width, height)) {
      const pin = document.createElement('button');
      pin.className = 'map-pin';
      pin.type = 'button';
      pin.style.left = `${cluster.x}px`;
      pin.style.top = `${cluster.y}px`;
      pin.innerHTML = cluster.ids.length > 1 ? String(cluster.ids.length) : icon('pin');
      pin.setAttribute(
        'aria-label',
        cluster.ids.length > 1 ? `${cluster.ids.length} entries` : 'Entry'
      );
      pin.addEventListener('click', () => this.onSelect(cluster.ids));
      this.pinLayer.append(pin);
    }
  }
}
