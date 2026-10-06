import { api } from './api.js';
import { LEVELS } from './location.js';
import { distanceLabel } from './format.js';
import { icon } from './icons.js';
import { closeSheet, note, openSheet, row, rowGroup } from './sheet.js';

/**
 * The journal picker — existing journals with the active one
 * checked, plus an inline "New journal…" row. Create and switch only: no
 * rename, delete, or reorder.
 */
export function openJournalPicker({ journals, activeId, onSelect, onCreate }) {
  openSheet(
    (sheet) => {
      sheet.setTitle('Journals');
      const journalRows = () =>
        journals.map((journal) =>
          row({
            title: journal.name,
            checked: journal.id === activeId,
            onSelect: () => {
              closeSheet();
              if (journal.id !== activeId) onSelect(journal);
            },
          })
        );

      const render = () => {
        sheet.body.replaceChildren();
        const newRow = row({
          title: 'New journal…',
          accent: 'plus',
          onSelect: () => showField(),
        });
        sheet.body.append(rowGroup([...journalRows(), newRow]));
      };

      const showField = () => {
        sheet.body.replaceChildren();
        const field = document.createElement('div');
        field.className = 'row';
        field.innerHTML =
          '<input class="field" style="flex:1;border:0;background:none;padding:0" ' +
          'placeholder="Journal name" autocapitalize="none" autocorrect="off" spellcheck="false" />';
        const input = field.querySelector('input');

        input.addEventListener('keydown', async (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          input.disabled = true;
          closeSheet();
          await onCreate(name);
        });

        sheet.body.append(rowGroup([...journalRows(), field]));
        input.focus();
      };

      render();
    },
    { presentation: 'modal' }
  );
}

/**
 * The location flow behind the header geo arrow: granularity levels
 * coarse → precise, each previewing what it would tag, so the user sees the
 * value before choosing. Selecting a level re-tags the open entry *and*
 * updates the remembered granularity. Place pushes the POI picker.
 */
export function openLocationPicker({ service, entry, onChange }) {
  openSheet((sheet) => {
    sheet.setTitle('');

    const selected = entry?.location
      ? entry.location.granularity
      : entry
        ? 'off'
        : (service.pendingLocation?.granularity ?? service.remembered);

    // When the browser has denied us the position, explain once and stay
    // quiet otherwise — no banners, no nagging.
    if (service.denied) {
      const message = document.createElement('div');
      message.className = 'sheet-message';
      message.innerHTML = `
        ${icon('location-slash')}
        <p>Location is blocked for Jrnl, so entries aren't tagged.<br />
        Re-allow it in your browser's site settings for this page.</p>`;
      sheet.body.append(message);
      return;
    }

    let names = { city: null, neighborhood: null };
    let coordinate = null;
    let loading = true;

    const previewFor = (key) => {
      if (key === 'off') return undefined;
      if (key === 'poi') return 'Choose nearby…';
      if (key === 'city') return names.city ?? (loading ? 'Locating…' : undefined);
      return names.neighborhood ?? (loading ? 'Locating…' : undefined);
    };

    const render = () => {
      sheet.body.replaceChildren();
      sheet.body.append(
        rowGroup(
          LEVELS.map((level) =>
            row({
              title: level.name,
              subtitle: previewFor(level.key),
              checked: level.key === selected,
              onSelect: async () => {
                if (level.key === 'poi') return showPlaces();
                closeSheet();
                onChange(await service.tag(entry, level.key));
              },
            })
          )
        )
      );
    };

    // MARK: - Place picker

    const showPlaces = () => {
      sheet.push('Place', () => {
        const search = document.createElement('div');
        search.className = 'sheet-search';
        search.innerHTML = '<input class="field" style="width:100%" placeholder="Search places" />';
        const results = document.createElement('div');
        sheet.body.append(search, results);

        const show = (places, message) => {
          results.replaceChildren();
          if (message) return results.append(note(message));
          results.append(
            rowGroup(
              places.map((place) =>
                row({
                  title: place.name,
                  subtitle: place.locality ?? undefined,
                  trailing: distanceLabel(place.distance),
                  onSelect: async () => {
                    closeSheet();
                    onChange(await service.tagPlace(entry, place));
                  },
                })
              )
            )
          );
        };

        const load = async (query) => {
          if (!coordinate) return show([], 'Waiting for your location…');
          show([], 'Searching…');
          const token = (load.token = Symbol('search'));
          try {
            const { places } = await api.places(coordinate.latitude, coordinate.longitude, query);
            if (load.token !== token) return;
            show(places, places.length ? null : query ? 'No matches' : 'No places found nearby');
          } catch {
            if (load.token === token) show([], 'Could not reach place search');
          }
        };

        // A small debounce so each keystroke doesn't fire a request.
        let timer = 0;
        search.querySelector('input').addEventListener('input', (event) => {
          clearTimeout(timer);
          const query = event.target.value.trim();
          timer = setTimeout(() => load(query), 300);
        });

        load('');
      }, render); // Back rebuilds the level list, handlers and all.
    };

    render();

    // Resolve the previews in the background; the list fills in as they land.
    (async () => {
      coordinate = await service.currentCoordinate();
      if (!coordinate) {
        loading = false;
        return render();
      }
      try {
        names = await api.reverseGeocode(coordinate.latitude, coordinate.longitude);
      } catch {
        // Leave the previews blank rather than blocking the choice.
      }
      loading = false;
      render();
    })();
  }, { presentation: 'modal' });
}
