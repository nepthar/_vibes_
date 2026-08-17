import { blockFromFigure, mediaFigure, parseMediaUrl } from './media.js';

/**
 * The typewriter writing surface.
 *
 * The line containing the caret is pinned two-thirds of the way down the
 * writing area; as new lines are typed, existing text scrolls up while the
 * caret line stays put. Typewriter mode is purely a *scroll* behavior — the
 * editing itself is completely ordinary: click anywhere to move the caret,
 * select, cut/copy/paste, undo.
 *
 * Content is a list of blocks: each direct child of the editor is either
 * a line of text or a media figure, which serializes 1:1 to the block model
 * the API stores.
 */

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE']);
const STAMP_MARGIN = 9;

const isMedia = (node) => node.nodeType === 1 && node.classList?.contains('media');
const isLine = (node) => node.nodeType === 1 && BLOCK_TAGS.has(node.nodeName);

const isEmptyLine = (line) =>
  line.childNodes.length === 0 ||
  (line.childNodes.length === 1 && line.firstChild.nodeName === 'BR');

function lineElement(text = '') {
  const line = document.createElement('div');
  if (text) line.textContent = text;
  else line.append(document.createElement('br'));
  return line;
}

export class TypewriterEditor {
  constructor({ scroller, surface, stamp, editor, onChange, onBeforeInput }) {
    this.scroller = scroller;
    this.surface = surface;
    this.stampElement = stamp;
    this.editor = editor;
    this.onChange = onChange ?? (() => {});
    /** Returns true if it cleared the surface, so this input starts fresh. */
    this.onBeforeInput = onBeforeInput ?? (() => false);

    this.ensureStructure();
    this.bind();
    this.layout();
  }

  // MARK: - Wiring

  bind() {
    /**
     * The entry may have gone quiet long enough to be finished — a suspended
     * tab, a laptop that slept. Deciding that *here*, before the DOM is
     * touched, means the old entry commits with exactly what was written and
     * this keystroke starts a genuinely new one. Afterwards there would be two
     * entries' text on one surface with no reliable way to tell them apart.
     */
    this.editor.addEventListener('beforeinput', (event) => {
      if (!this.onBeforeInput()) return;
      event.preventDefault();
      // The surface is now empty; put this input into the fresh entry by hand.
      if (typeof event.data === 'string' && event.data) this.insertText(event.data);
    });

    this.editor.addEventListener('input', () => {
      this.ensureStructure();
      this.onChange(this.contents);
      this.align(true);
    });

    // Plain text only: the block model stores paragraph runs, not markup.
    this.editor.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      const linked = parseMediaUrl(text);
      if (linked) {
        this.insertMedia([
          {
            kind: 'media',
            url: linked.url,
            mediaType: linked.mediaType,
            pixelWidth: 0,
            pixelHeight: 0,
            duration: null,
          },
        ]);
        return;
      }
      this.insertText(text);
    });
    this.editor.addEventListener('drop', (event) => event.preventDefault());

    // When the caret moves, the view scrolls so its line settles at the
    // typewriter position — but not while the user is scrolling to review.
    document.addEventListener('selectionchange', () => {
      if (this.isUserScrolling || !this.hasFocus) return;
      this.align(true);
    });

    let scrollTimer = 0;
    this.scroller.addEventListener(
      'scroll',
      () => {
        if (this.isProgrammaticScroll) return;
        this.isUserScrolling = true;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          this.isUserScrolling = false;
        }, 250);
      },
      { passive: true }
    );

    // A media block reaching its final height moves the caret's line with it.
    this.editor.addEventListener('media-settled', () => this.align(false));

    const relayout = () => this.layout();
    window.addEventListener('resize', relayout);
    window.visualViewport?.addEventListener('resize', relayout);
  }

  get hasFocus() {
    return this.editor.contains(document.activeElement) || document.activeElement === this.editor;
  }

  // MARK: - Layout

  /**
   * The top padding places the *first* line of a fresh entry at the typewriter
   * line with the surface unscrolled; the bottom padding keeps the last line
   * from ever sitting below it. The stamp occupies the space just above the
   * first line, scrolling up with the entry like a heading.
   */
  layout() {
    const height = this.scroller.clientHeight;
    if (height <= 0) return;
    const lineHeight = parseFloat(getComputedStyle(this.editor).lineHeight) || 29;
    this.lineHeight = lineHeight;
    // Two-thirds of the way down the writing area (the remaining third sits
    // below the caret — on a phone, that's the space above the keyboard).
    this.gap = height / 3;
    const stampBlock = this.stampElement.offsetHeight + STAMP_MARGIN;

    this.surface.style.paddingTop = `${Math.max(0, height - this.gap - lineHeight - stampBlock)}px`;
    this.surface.style.paddingBottom = `${this.gap}px`;

    // The viewport a media block is capped to, so one asset can never make the
    // screen unusable.
    this.mediaCap = Math.max(120, height - this.gap - 24);
    this.surface.style.setProperty('--media-cap', `${Math.round(this.mediaCap)}px`);
    this.align(false);
  }

  /** The caret's rect, falling back to its line box on an empty line. */
  caretRect() {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!this.editor.contains(range.startContainer)) return null;

    const collapsed = range.cloneRange();
    collapsed.collapse(false);
    const rects = collapsed.getClientRects();
    if (rects.length) return rects[rects.length - 1];

    let node = collapsed.startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    const rect = node?.getBoundingClientRect();
    return rect && rect.height > 0 ? rect : null;
  }

  /** Settles the caret's line at the typewriter position. */
  align(animated) {
    const rect = this.caretRect();
    if (!rect) return;
    const bounds = this.scroller.getBoundingClientRect();
    const caretBottom = rect.bottom - bounds.top + this.scroller.scrollTop;
    const target = Math.max(0, caretBottom - (this.scroller.clientHeight - this.gap));
    if (Math.abs(this.scroller.scrollTop - target) < 1) return;

    this.isProgrammaticScroll = true;
    this.scroller.scrollTo({ top: target, behavior: animated ? 'smooth' : 'auto' });
    // Release after the smooth scroll settles, so it isn't read as user input.
    clearTimeout(this.programmaticTimer);
    this.programmaticTimer = setTimeout(
      () => {
        this.isProgrammaticScroll = false;
      },
      animated ? 320 : 0
    );
  }

  // MARK: - Content

  /** Every top-level node is a line or a media figure; an empty editor holds one line. */
  ensureStructure() {
    let pending = null;
    for (const node of [...this.editor.childNodes]) {
      if (isMedia(node) || isLine(node)) {
        pending = null;
        continue;
      }
      // Bare text or inline markup (from a paste or a select-all delete) is
      // folded into a line, moving the nodes so the caret rides along.
      if (!pending) {
        pending = document.createElement('div');
        node.before(pending);
      }
      pending.append(node);
    }
    if (!this.editor.firstChild) this.editor.append(lineElement());
  }

  /** Serializes the surface into the entry's ordered block list. */
  get contents() {
    const blocks = [];
    let buffer = '';
    let started = false;

    const flush = () => {
      if (buffer !== '') blocks.push({ kind: 'text', text: buffer });
      buffer = '';
    };
    const inline = (node) => {
      if (node.nodeType === 3) buffer += node.data;
      else if (node.nodeName === 'BR') buffer += '\n';
      else node.childNodes.forEach(inline);
    };

    for (const child of this.editor.childNodes) {
      if (isMedia(child)) {
        flush();
        blocks.push(blockFromFigure(child));
        // Media is its own paragraph: the text after it starts a fresh run.
        started = false;
        continue;
      }
      if (isLine(child)) {
        if (started) buffer += '\n';
        if (!isEmptyLine(child)) inline(child);
      } else {
        inline(child);
      }
      started = true;
    }
    flush();
    return blocks;
  }

  setContents(blocks) {
    this.editor.replaceChildren();
    for (const block of blocks ?? []) {
      if (block.kind === 'media') {
        this.editor.append(mediaFigure(block, { editable: true, capPx: this.mediaCap }));
        continue;
      }
      for (const line of String(block.text ?? '').split('\n')) {
        this.editor.append(lineElement(line));
      }
    }
    this.ensureStructure();
    this.caretToEnd();
    this.align(false);
  }

  /**
   * Same shape as a read-mode entry header: time in `.entry-time`, then the
   * long-form date (and place, once tagged) in `.entry-place`.
   */
  setStamp({ time, line }) {
    const key = `${time}\0${line ?? ''}`;
    if (this.stampKey === key) return;
    this.stampKey = key;

    const timeEl = document.createElement('span');
    timeEl.className = 'entry-time';
    timeEl.textContent = time;
    this.stampElement.replaceChildren(timeEl);
    if (line) {
      const dot = document.createElement('span');
      dot.className = 'entry-place';
      dot.textContent = '·';
      const place = document.createElement('span');
      place.className = 'entry-place';
      place.textContent = line;
      this.stampElement.append(dot, place);
    }
    this.layout();
  }

  /**
   * The entry under the caret changed without the user asking — the 5-minute
   * mark passed mid-sentence and the writing continued into a new entry. A
   * brief pulse on the stamp is the whole announcement; interrupting someone
   * mid-thought with anything louder would be worse than the surprise.
   */
  markNewEntry() {
    this.stampElement.classList.remove('is-new');
    void this.stampElement.offsetWidth; // restart the animation
    this.stampElement.classList.add('is-new');
  }

  // MARK: - Caret and insertion

  focus({ toEnd = false } = {}) {
    if (!this.hasFocus) this.editor.focus({ preventScroll: true });
    if (toEnd || !document.getSelection()?.rangeCount) this.caretToEnd();
  }

  caretToEnd() {
    const last = this.editor.lastElementChild;
    if (!last) return;
    const range = document.createRange();
    if (isMedia(last)) {
      range.setStartAfter(last);
    } else {
      range.selectNodeContents(last);
    }
    range.collapse(false);
    this.setSelection(range);
  }

  setSelection(range) {
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  currentRange() {
    const selection = document.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (this.editor.contains(range.startContainer)) return range;
    }
    this.caretToEnd();
    return document.getSelection()?.getRangeAt(0) ?? null;
  }

  /** The top-level line or figure the caret sits in. */
  lineOf(node) {
    let current = node;
    while (current && current.parentNode !== this.editor) current = current.parentNode;
    return current;
  }

  insertText(text) {
    let range = this.currentRange();
    if (!range) return;

    // A blank line holds a placeholder <br>. Dropping it first stops the text
    // landing beside it, which would serialize as a leading empty line.
    const line = this.lineOf(range.startContainer);
    if (line && !isMedia(line) && isEmptyLine(line)) {
      line.replaceChildren();
      range = document.createRange();
      range.setStart(line, 0);
      range.collapse(true);
      this.setSelection(range);
    }
    range.deleteContents();

    const [first, ...rest] = text.split('\n');
    const head = document.createTextNode(first);
    range.insertNode(head);

    const caret = document.createRange();
    caret.setStartAfter(head);
    caret.collapse(true);

    if (rest.length) {
      // A multi-line paste splits the caret's line: the remainder moves to the
      // end of the last pasted line.
      const line = this.lineOf(head);
      const tail = this.extractTail(caret, line);
      let anchor = line;
      for (const piece of rest) {
        const element = lineElement(piece);
        anchor.after(element);
        anchor = element;
      }
      const offset = anchor.childNodes.length;
      if (tail.hasChildNodes()) {
        if (isEmptyLine(anchor)) anchor.replaceChildren(tail);
        else anchor.append(tail);
      }
      caret.setStart(anchor, Math.min(offset, anchor.childNodes.length));
      caret.collapse(true);
    }

    this.setSelection(caret);
    this.ensureStructure();
    this.onChange(this.contents);
    this.align(true);
  }

  /** Everything after the caret on its line, lifted out for a split. */
  extractTail(range, line) {
    if (!line || isMedia(line)) return document.createDocumentFragment();
    const tail = document.createRange();
    tail.setStart(range.endContainer, range.endOffset);
    tail.setEnd(line, line.childNodes.length);
    return tail.extractContents();
  }

  /**
   * Inserts picked media at the caret, each item as its own paragraph — text
   * flows before and after, never beside.
   */
  insertMedia(picks) {
    if (!picks?.length) return;
    this.focus();
    const range = this.currentRange();
    if (!range) return;

    const line = this.lineOf(range.startContainer) ?? this.editor.lastElementChild;
    const tail = this.extractTail(range, line);

    const after = lineElement();
    if (tail.hasChildNodes()) {
      after.replaceChildren(tail);
    }
    if (line && !isMedia(line) && !line.hasChildNodes()) {
      line.append(document.createElement('br'));
    }

    let anchor = line ?? this.editor.lastElementChild;
    for (const pick of picks) {
      const figure = mediaFigure(pick, { editable: true, capPx: this.mediaCap });
      anchor.after(figure);
      anchor = figure;
    }
    anchor.after(after);

    const selection = document.getSelection();
    const caret = document.createRange();
    caret.setStart(after, 0);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);

    this.ensureStructure();
    this.onChange(this.contents);
    this.align(true);
  }

  /**
   * The live timer closed the entry: the text drifts up and fades, then
   * the surface comes back as a fresh blank entry.
   */
  clearAnimated(onDone) {
    if (this.contents.length === 0) {
      this.setContents([]);
      onDone?.();
      return;
    }
    this.surface.classList.add('is-clearing');
    setTimeout(() => {
      this.setContents([]);
      onDone?.();
      this.surface.classList.remove('is-clearing');
      this.surface.classList.add('is-restored');
      this.surface.style.opacity = '0';
      requestAnimationFrame(() => {
        this.surface.style.opacity = '';
        setTimeout(() => this.surface.classList.remove('is-restored'), 260);
      });
    }, 450);
  }
}
