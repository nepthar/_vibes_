import { icon } from './icons.js';

/**
 * Overlay dialogs: a centered modal for the journal and location pickers,
 * and a bottom sheet for the map entry list — tap-outside / Escape to
 * dismiss, plus a push/back stack for the Place picker's second screen.
 */

const root = document.getElementById('sheet-root');
let current = null;

export function closeSheet() {
  if (!current) return;
  const { scrim, onClose } = current;
  current = null;
  scrim.classList.remove('is-open');
  document.removeEventListener('keydown', onEscape, true);
  setTimeout(() => scrim.remove(), 300);
  onClose?.();
}

function onEscape(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeSheet();
  }
}

/**
 * Opens an overlay. `render(sheet)` fills the body and may call `sheet.push()`
 * to replace the contents with a sub-screen that has a back button.
 * `presentation: 'modal'` centers a panel; the default is a bottom sheet.
 */
export function openSheet(render, { onClose, presentation = 'sheet' } = {}) {
  closeSheet();

  const isModal = presentation === 'modal';
  const panelClass = isModal ? 'modal' : 'sheet';
  const scrim = document.createElement('div');
  scrim.className = isModal ? 'scrim scrim-modal' : 'scrim';
  scrim.innerHTML = `
    <div class="${panelClass}" role="dialog" aria-modal="true">
      ${isModal ? '' : '<div class="sheet-grabber"></div>'}
      <div class="sheet-head"></div>
      <div class="sheet-body"></div>
    </div>`;

  const sheetElement = scrim.querySelector(`.${panelClass}`);
  const head = scrim.querySelector('.sheet-head');
  const body = scrim.querySelector('.sheet-body');
  const stack = [];

  const controller = {
    element: sheetElement,
    body,
    close: closeSheet,
    /**
     * Replaces the contents with a titled sub-screen (the Place picker).
     * `onBack` rebuilds the screen being left — the previous markup can't just
     * be stashed and restored, because its rows carry click handlers.
     */
    push(title, renderScreen, onBack) {
      stack.push(onBack);
      head.innerHTML = `
        <div class="sheet-title">
          <button class="sheet-back">${icon('chevron-left')}<span>Back</span></button>
          <span></span>
        </div>`;
      head.querySelector('.sheet-title span:last-child').textContent = title;
      head.querySelector('.sheet-back').addEventListener('click', () => controller.pop());
      body.replaceChildren();
      body.scrollTop = 0;
      renderScreen(controller);
    },
    pop() {
      if (stack.length === 0) return closeSheet();
      const restore = stack.pop();
      head.innerHTML = '';
      body.replaceChildren();
      body.scrollTop = 0;
      restore?.(controller);
    },
    setTitle(title) {
      head.innerHTML = title ? `<div class="sheet-title"><span>${title}</span></div>` : '';
    },
  };

  scrim.addEventListener('pointerdown', (event) => {
    if (event.target === scrim) closeSheet();
  });
  document.addEventListener('keydown', onEscape, true);

  root.append(scrim);
  current = { scrim, onClose };
  render(controller);

  // Let the element land before animating in.
  requestAnimationFrame(() => scrim.classList.add('is-open'));
  return controller;
}

/** A tappable row: title, optional subtitle, optional trailing text/mark. */
export function row({ title, subtitle, trailing, checked, accent, onSelect }) {
  const element = document.createElement('button');
  element.className = 'row';
  element.type = 'button';
  element.innerHTML = `
    <span class="row-main">
      <span class="row-title"></span>
      ${subtitle ? '<span class="row-sub"></span>' : ''}
    </span>
    ${trailing ? '<span class="row-trailing"></span>' : ''}
    ${checked ? `<span class="row-check">${icon('check')}</span>` : ''}
    ${accent ? `<span class="row-accent">${icon(accent)}</span>` : ''}`;

  element.querySelector('.row-title').textContent = title;
  if (subtitle) element.querySelector('.row-sub').textContent = subtitle;
  if (trailing) element.querySelector('.row-trailing').textContent = trailing;
  if (onSelect) element.addEventListener('click', onSelect);
  return element;
}

export function rowGroup(rows) {
  const group = document.createElement('div');
  group.className = 'rows';
  rows.filter(Boolean).forEach((element) => group.append(element));
  return group;
}

export function note(text) {
  const element = document.createElement('p');
  element.className = 'row-note';
  element.textContent = text;
  return element;
}
