import { dayLabel, entryStamp, mediaCount, monthLabel, plainText, startOfDay, timeLabel } from './format.js';
import { icon } from './icons.js';
import { mediaFigure } from './media.js';
import { MiniMap } from './minimap.js';
import { closeSheet, openSheet, row, rowGroup } from './sheet.js';

/**
 * Read mode: the active journal's closed entries as a list, a
 * calendar heatmap, or a map. Entries are read-only — no edit, no delete, no
 * swipe actions anywhere. Publishing is the one exception: open an entry and
 * tap its title stamp.
 */

/** Published marker shown as a prefix on the first line the owner sees. */
function publishMark() {
  const mark = document.createElement('span');
  mark.className = 'publish-mark';
  mark.setAttribute('aria-label', 'Published');
  mark.innerHTML = icon('web');
  return mark;
}

/**
 * One list row. Time, place, a one-line preview that fades out at the
 * edge, and a media hint. Tapping opens the entry in the reader overlay.
 */
function entryRow(entry, { onSelect }) {
  const element = document.createElement('article');
  element.className = 'entry-row';
  element.dataset.entryId = entry.id;

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  if (entry.published) meta.append(publishMark());
  const time = document.createElement('span');
  time.className = 'entry-time';
  time.textContent = timeLabel(new Date(entry.createdAt));
  meta.append(time);
  if (entry.location?.displayName) {
    const dot = document.createElement('span');
    dot.className = 'entry-place';
    dot.textContent = '·';
    const place = document.createElement('span');
    place.className = 'entry-place';
    place.textContent = entry.location.displayName;
    meta.append(dot, place);
  }
  element.append(meta);

  const preview = document.createElement('p');
  preview.className = 'entry-text';
  preview.textContent = plainText(entry).trim();
  element.append(preview);

  const count = mediaCount(entry);
  if (count > 0) {
    const hint = document.createElement('span');
    hint.className = 'media-hint';
    hint.innerHTML = `${icon('photo')}<span>${count === 1 ? '1 item' : `${count} items`}</span>`;
    element.append(hint);
  }
  element.addEventListener('click', () => onSelect(entry));
  return element;
}

function fillBlocks(body, entry) {
  for (const block of entry.blocks) {
    if (block.kind === 'media') {
      body.append(mediaFigure(block));
      continue;
    }
    const text = (block.text ?? '').trim();
    if (!text) continue;
    const paragraph = document.createElement('p');
    paragraph.className = 'entry-text';
    paragraph.textContent = text;
    body.append(paragraph);
  }
}

export class ReadView {
  constructor(container, { locationService, onEntryResolved, onReadingChange, onSetPublished }) {
    this.container = container;
    this.locationService = locationService;
    this.onEntryResolved = onEntryResolved;
    this.onReadingChange = onReadingChange;
    this.onSetPublished = onSetPublished;
    this.entries = [];
    this.view = 'list';
    this.openId = null;
    this.scrollTargetDay = null;

    this.reader = document.createElement('div');
    this.reader.className = 'entry-reader';
    this.reader.hidden = true;
    this.reader.setAttribute('role', 'article');
    container.parentElement.append(this.reader);
  }

  get reading() {
    return !!this.openId;
  }

  setEntries(entries) {
    this.entries = entries;
    // Lazy retry of pending geocode/centroid resolution — including
    // for entries closed before their names ever came back.
    for (const entry of entries) {
      if (entry.location && !entry.location.isResolved) {
        this.locationService.resolveIfNeeded(entry).then((updated) => {
          if (updated !== entry) this.onEntryResolved?.(updated);
        });
      }
    }
    this.render();
    if (this.openId) {
      const entry = this.entries.find((item) => item.id === this.openId);
      if (entry) this.paintReader(entry);
      else this.closeEntry();
    }
  }

  setView(view) {
    this.view = view;
    this.render();
  }

  render() {
    this.map?.destroy();
    this.map = null;
    this.container.replaceChildren();

    if (this.view === 'calendar') return this.renderCalendar();
    if (this.view === 'map') return this.renderMap();
    return this.renderList();
  }

  openEntry(entry) {
    closeSheet();
    this.openId = entry.id;
    this.paintReader(entry);
    this.reader.hidden = false;
    this.onReadingChange?.(true);
  }

  /** Hides the reader. Returns true if one was open. */
  closeEntry() {
    if (!this.openId) return false;
    this.openId = null;
    this.reader.hidden = true;
    this.reader.replaceChildren();
    this.onReadingChange?.(false);
    return true;
  }

  /** Title stamp → Publish? Yes publishes, No unpublishes. Esc / backdrop cancel. */
  promptPublish(entry) {
    openSheet(
      (sheet) => {
        sheet.setTitle('Publish?');
        sheet.body.append(
          rowGroup([
            row({
              title: 'Yes',
              onSelect: () => {
                closeSheet();
                this.onSetPublished?.(entry, true);
              },
            }),
            row({
              title: 'No',
              onSelect: () => {
                closeSheet();
                this.onSetPublished?.(entry, false);
              },
            }),
          ])
        );
      },
      { presentation: 'modal' }
    );
  }

  paintReader(entry) {
    const date = new Date(entry.createdAt);
    const inner = document.createElement('div');
    inner.className = 'entry-reader-inner';

    const stamp = document.createElement('button');
    stamp.type = 'button';
    stamp.className = 'stamp stamp-publish';
    stamp.title = 'Publish or unpublish';
    if (entry.published) stamp.append(publishMark());
    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = timeLabel(date);
    stamp.append(time);
    const line = entryStamp(date, entry.location?.displayName);
    const dot = document.createElement('span');
    dot.className = 'entry-place';
    dot.textContent = '·';
    const rest = document.createElement('span');
    rest.className = 'entry-place';
    rest.textContent = line;
    stamp.append(dot, rest);
    stamp.addEventListener('click', (event) => {
      event.preventDefault();
      this.promptPublish(entry);
    });

    const body = document.createElement('div');
    body.className = 'entry-body';
    fillBlocks(body, entry);
    inner.append(stamp, body);
    this.reader.replaceChildren(inner);
  }

  // MARK: - List

  get dayGroups() {
    const groups = new Map();
    for (const entry of this.entries) {
      const day = startOfDay(new Date(entry.createdAt));
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(entry);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]);
  }

  renderList() {
    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No entries yet';
      this.container.append(empty);
      return;
    }

    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    const inner = document.createElement('div');
    inner.className = 'scroll-inner';
    scroller.append(inner);

    for (const [day, entries] of this.dayGroups) {
      const header = document.createElement('h2');
      header.className = 'day-header';
      header.textContent = dayLabel(day);
      header.dataset.day = String(day);
      inner.append(header);
      for (const entry of entries) {
        inner.append(entryRow(entry, { onSelect: (item) => this.openEntry(item) }));
      }
    }

    this.container.append(scroller);

    // Calendar drill-down: land with the tapped day's header at top.
    if (this.scrollTargetDay !== null) {
      const target = inner.querySelector(`[data-day="${this.scrollTargetDay}"]`);
      this.scrollTargetDay = null;
      if (target) {
        // Measured against the scroller itself — `offsetTop` would be relative
        // to the nearest positioned ancestor and overshoot by the chrome.
        scroller.scrollTop +=
          target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    }
  }

  // MARK: - Calendar heatmap

  renderCalendar() {
    const counts = new Map();
    for (const entry of this.entries) {
      const day = startOfDay(new Date(entry.createdAt));
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }

    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    const months = document.createElement('div');
    months.className = 'calendar-months';
    scroller.append(months);

    const now = new Date();
    const earliest = this.entries.length
      ? new Date(Math.min(...this.entries.map((entry) => entry.createdAt)))
      : now;
    let cursor = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 1);

    while (cursor <= last) {
      months.append(this.monthGrid(cursor, counts));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }

    this.container.append(scroller);
    // Land on the current month.
    scroller.scrollTop = scroller.scrollHeight;
  }

  monthGrid(month, counts) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.className = 'month-title';
    title.textContent = monthLabel(month);
    section.append(title);

    const grid = document.createElement('div');
    grid.className = 'month-grid';

    for (let blank = 0; blank < month.getDay(); blank += 1) {
      const spacer = document.createElement('div');
      spacer.className = 'day-cell is-blank';
      grid.append(spacer);
    }

    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const key = date.getTime();
      const count = counts.get(key) ?? 0;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'day-cell';
      // Four intensity steps: empty / 1 / 2–3 / 4+.
      cell.dataset.level = String(count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3);
      cell.textContent = String(day);
      if (count > 0) {
        // Calendar is for *finding*; the list is for reading.
        cell.addEventListener('click', () => {
          this.scrollTargetDay = key;
          this.onSelectDay?.('list');
        });
      } else {
        cell.disabled = true; // Days with no entries are inert.
      }
      grid.append(cell);
    }

    section.append(grid);
    return section;
  }

  // MARK: - Map

  renderMap() {
    const located = this.entries.filter((entry) => entry.location);
    const element = document.createElement('div');
    this.container.append(element);

    this.map = new MiniMap(element, {
      points: located.map((entry) => ({
        id: entry.id,
        latitude: entry.location.latitude,
        longitude: entry.location.longitude,
      })),
      onSelect: (ids) => this.showMapEntries(ids),
    });

    if (located.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'map-attribution';
      empty.style.cssText = 'left:0;right:auto;bottom:auto;top:0;padding:6px 8px';
      empty.textContent = 'No located entries yet';
      element.append(empty);
    }
  }

  /** Tapping a pin or cluster lists the entries at that spot. */
  showMapEntries(ids) {
    const set = new Set(ids);
    const entries = this.entries
      .filter((entry) => set.has(entry.id))
      .sort((a, b) => b.createdAt - a.createdAt);

    openSheet((sheet) => {
      sheet.setTitle('');
      sheet.body.replaceChildren();
      for (const entry of entries) {
        sheet.body.append(entryRow(entry, { onSelect: (item) => this.openEntry(item) }));
      }
    });
  }
}
