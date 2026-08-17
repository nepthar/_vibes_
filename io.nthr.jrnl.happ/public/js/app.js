import { api, AuthError, deviceId, getToken, hasToken, setToken } from './api.js';
import { TypewriterEditor } from './editor.js';
import { entryStamp, timeLabel } from './format.js';
import { icon, paintIcons } from './icons.js';
import { LocationService } from './location.js';
import { uploadPicked } from './media.js';
import { openJournalPicker, openLocationPicker } from './pickers.js';
import { ReadView } from './read.js';
import { Session, isBlank } from './session.js';
import { LocalStore } from './store.js';
import { closeSheet } from './sheet.js';

/**
 * App root: write, list, calendar, and map are four views behind one
 * segmented control. The app opens on write with the caret ready.
 */

const $ = (id) => document.getElementById(id);
const dom = {
  auth: $('auth'),
  authForm: $('auth-form'),
  authUsername: $('auth-username'),
  authPassword: $('auth-password'),
  authToken: $('auth-token'),
  authSub: $('auth-sub'),
  authError: $('auth-error'),
  authSubmit: $('auth-submit'),
  authToggle: $('auth-toggle'),
  authSwitchLead: $('auth-switch-lead'),
  shell: $('shell'),
  write: $('write'),
  writing: $('writing'),
  surface: $('surface'),
  stamp: $('stamp'),
  editor: $('editor'),
  locationButton: $('location-button'),
  mediaInput: $('media-input'),
  menu: $('app-menu'),
  read: $('read'),
  readBody: $('read-body'),
  saveHint: $('save-hint'),
};

/** Idle this long before the "entry saves in…" chrome hint appears. */
const SAVE_HINT_IDLE_MS = 15_000;
/** Below this remaining time, the hint counts down in seconds. */
const SAVE_HINT_SECONDS_MS = 30_000;

paintIcons();
/** Appends trailing text to a block list, extending its last text run. */
function appendText(blocks, text) {
  if (!text) return blocks;
  const copy = blocks.map((block) => ({ ...block }));
  const last = copy[copy.length - 1];
  if (last?.kind === 'text') last.text += text;
  else copy.push({ kind: 'text', text });
  return copy;
}

/** An on-screen keyboard shrinks the visual viewport; the shell follows it. */
function trackViewport() {
  const viewport = window.visualViewport;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
  document.documentElement.append(probe);

  let safeTop = 0;
  const apply = () => {
    // iOS can report 0 before the first layout. Writing that over the CSS
    // `100dvh` fallback would collapse the shell to nothing.
    const height = viewport?.height || window.innerHeight;
    if (height > 0) {
      document.documentElement.style.setProperty('--app-height', `${height}px`);
      document.documentElement.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    }
    // iOS zeroes env(safe-area-inset-top) while the keyboard is up; keep the
    // largest value we've seen so the header doesn't slide under the status bar.
    const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    if (inset > safeTop) {
      safeTop = inset;
      document.documentElement.style.setProperty('--safe-top', `${safeTop}px`);
    }
  };
  apply();
  viewport?.addEventListener('resize', apply);
  viewport?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
}

// MARK: - Sign in / account setup

/**
 * One card, three screens. `login` is the door. `token` takes the account
 * token the operator minted, and `setup` is where the name that token carries
 * gets a password — a new account if there is none under that name yet, a
 * reset of the existing one if there is. The person never types the username:
 * it came with the token, and setup only shows it.
 */
let mode = 'login';

/** The token being redeemed, as `/account/lookup` reported it. */
let pending = null;

function showAuth(message = '') {
  dom.shell.hidden = true;
  dom.auth.hidden = false;
  pending = null;
  setAuthMode('login');
  dom.authError.textContent = message;
}

function setAuthMode(next) {
  mode = next;
  const asking = mode === 'token'; // asking for the account token
  const setting = mode === 'setup'; // setting the password it leads to

  dom.authUsername.hidden = asking;
  dom.authUsername.required = !asking;
  // In setup the name is the token's, not a choice — shown, not editable.
  dom.authUsername.readOnly = setting;
  dom.authUsername.value = setting ? pending.username : '';
  dom.authPassword.hidden = asking;
  dom.authPassword.required = !asking;
  dom.authPassword.value = '';
  dom.authPassword.autocomplete = setting ? 'new-password' : 'current-password';
  dom.authToken.hidden = !asking;
  dom.authToken.required = asking;
  // The token stays in the field through setup; it is what redeems it.
  if (!setting) dom.authToken.value = '';

  if (asking) {
    dom.authSub.textContent = 'Enter the account token you were given.';
    dom.authSubmit.textContent = 'Continue';
    dom.authSwitchLead.textContent = 'Already set up?';
    dom.authToggle.textContent = 'Sign in';
  } else if (setting) {
    dom.authSub.textContent = pending.exists
      ? 'This resets the account: a new password, and every signed-in device signed out. Entries are untouched.'
      : 'Choose a password and the account is yours.';
    dom.authSubmit.textContent = pending.exists ? 'Reset account' : 'Create account';
    dom.authSwitchLead.textContent = 'Wrong token?';
    dom.authToggle.textContent = 'Start over';
  } else {
    dom.authSub.textContent = 'Sign in with the username and password you made.';
    dom.authSubmit.textContent = 'Sign in';
    dom.authSwitchLead.textContent = 'Have an account token?';
    dom.authToggle.textContent = 'Set up an account';
  }
  dom.authError.textContent = '';

  // Programmatic focus on iOS pans the visual viewport; with overflow:hidden
  // on the document that pan can leave the user staring at blank paper.
  // The keyboard will not rise without a tap anyway.
  if (!window.matchMedia('(pointer: coarse)').matches) {
    const field = asking ? dom.authToken : setting ? dom.authPassword : dom.authUsername;
    field.focus({ preventScroll: true });
  }
}

// From sign-in the link opens setup; from either setup step it goes back one:
// the password screen to the token it came from, the token screen to sign-in.
dom.authToggle.addEventListener('click', () => {
  const next = mode === 'token' ? 'login' : 'token';
  pending = null;
  setAuthMode(next);
});

dom.authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.authSubmit.disabled = true;
  dom.authError.textContent = '';
  const accountToken = dom.authToken.value.trim();
  try {
    if (mode === 'token') {
      // The token names the account; setup only has a password left to ask for.
      pending = await api.accountToken(accountToken);
      setAuthMode('setup');
      return;
    }
    const password = dom.authPassword.value;
    const result =
      mode === 'setup'
        ? await api.setUpAccount(accountToken, password)
        : await api.login(dom.authUsername.value.trim(), password);
    setToken(result.token);
    dom.auth.hidden = true;
    await start();
  } catch (error) {
    dom.authError.textContent = error.message;
  } finally {
    dom.authSubmit.disabled = false;
  }
});

// MARK: - The app

class App {
  constructor(state, store) {
    this.userId = state.user.id;
    this.username = state.user.username;
    this.journals = state.journals;
    this.activeJournalId = state.activeJournalId;
    this.store = store;
    this.mode = null;
    this.entries = [];
    const logoutLabel = document.querySelector('[data-logout-user]');
    if (logoutLabel) logoutLabel.textContent = `Log out ${this.username}`;

    this.session = new Session({
      deviceId,
      policy: state.policy,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    this.session.onCurrentChanged = () => {
      this.updateStamp();
      this.updateLocationButton();
      this.updateWriteTabIcon();
      this.scheduleSaveHint();
    };
    this.session.onCommitted = (entry, reason) => this.commit(entry, reason);

    this.location = new LocationService();
    this.location.remembered = state.user.rememberedGranularity;
    this.location.onPermissionChange = () => this.updateLocationButton();
    this.location.onPendingChange = () => {
      this.updateStamp();
      this.updateLocationButton();
    };
    this.location.onRememberedChange = (level) =>
      api.setPreferences({ rememberedGranularity: level }).catch(() => {});
    this.location.onEntryUpdated = (entry) => this.entryUpdated(entry);
    // Writing in progress keeps its location in the session and carries it
    // into the commit; only a geocode landing after the commit hits the server.
    this.location.applyLocation = async (entry, location) => {
      if (entry.id === this.session.entryId) {
        this.session.setLocation(location);
        return { ...entry, location };
      }
      const { entry: updated } = await api.resolveEntryLocation(entry.id, location);
      await this.store?.put(updated);
      return updated;
    };

    this.editor = new TypewriterEditor({
      scroller: dom.writing,
      surface: dom.surface,
      stamp: dom.stamp,
      editor: dom.editor,
      onChange: (contents) => this.noteInput(contents),
      onBeforeInput: () => this.finishIfStale(),
    });

    this.readView = new ReadView(dom.readBody, {
      locationService: this.location,
      onEntryResolved: (entry) => this.entryUpdated(entry),
      onReadingChange: (reading) => this.setListTabIcon(reading),
      onSetPublished: (entry, published) => this.setPublished(entry, published),
    });
    this.readView.onSelectDay = (view) => this.setView(view);

    this.bind();
    // Resume writing that was in progress when the page was last open.
    const draft = this.session.adopt(state.draft);
    this.editor.setContents(draft?.blocks ?? []);
    this.refreshChrome();
    this.setView('write');
    this.refreshEntries();
    this.flushUnsynced();
  }

  /** The entry being written, in the shape the rest of the app expects. */
  get draft() {
    const current = this.session.current;
    return current
      ? { id: current.entryId, createdAt: current.startedAt, location: current.location }
      : null;
  }

  get activeJournal() {
    return this.journals.find((journal) => journal.id === this.activeJournalId);
  }

  // MARK: - Chrome

  refreshChrome() {
    const name = this.activeJournal?.name ?? 'personal';
    for (const label of document.querySelectorAll('[data-journal-name]')) {
      label.textContent = name;
    }
    this.updateStamp();
    this.updateLocationButton();
    this.updateWriteTabIcon();
    this.scheduleSaveHint();
  }

  /**
   * Time, then the long-form date — and the place once the entry is tagged
   * and its name resolves: "3:45 PM · Thursday, August 13th, 2026 ~ Jefferson Park, CO".
   */
  updateStamp() {
    const date = this.draft ? new Date(this.draft.createdAt) : new Date();
    const place =
      this.draft?.location?.displayName ?? this.location.pendingLocation?.displayName;
    this.editor.setStamp({
      time: timeLabel(date),
      line: entryStamp(date, place),
    });
  }

  updateLocationButton() {
    const denied = this.location.denied;
    const tagged = !!this.draft?.location || !!this.location.pendingLocation;
    const symbol = denied ? 'location-slash' : tagged ? 'location-fill' : 'location';
    dom.locationButton.innerHTML = icon(symbol);
    dom.locationButton.dataset.state = denied ? 'denied' : tagged ? 'tagged' : 'untagged';
  }

  bind() {
    dom.locationButton.addEventListener('click', () => {
      this.readView.closeEntry();
      openLocationPicker({
        service: this.location,
        entry: this.draft,
        onChange: (entry) => {
          if (entry) this.entryUpdated(entry);
          this.updateStamp();
          this.updateLocationButton();
        },
      });
    });

    this.bindMenu();

    dom.mediaInput.addEventListener('change', async () => {
      const files = [...dom.mediaInput.files];
      dom.mediaInput.value = '';
      if (!files.length) return;
      this.editor.insertMedia(await uploadPicked(files));
      this.session.postDraft();
    });

    for (const segment of document.querySelectorAll('.segment')) {
      segment.addEventListener('click', () => {
        if (segment.dataset.view === 'write' && this.canFinishFromWriteTab()) {
          this.finish();
          return;
        }
        this.setView(segment.dataset.view);
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.closeMenu()) return;
      this.readView.closeEntry();
    });

    // Coming back to the tab: ask straight away rather than waiting a tick,
    // since the deadline may well have passed while it was hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return this.session.postDraft();
      this.finishIfStale();
      this.flushUnsynced();
    });
  }

  bindMenu() {
    const menu = dom.menu;
    for (const button of document.querySelectorAll('[data-app-menu]')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!menu.hidden && this.menuAnchor === button) this.closeMenu();
        else this.openMenu(button);
      });
    }

    menu.addEventListener('click', (event) => {
      const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
      if (!action) return;
      this.closeMenu();
      if (action === 'media') this.addMedia();
      else if (action === 'journals') this.showJournalPicker();
      else if (action === 'logout') this.signOut();
    });

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (menu.hidden) return;
        if (event.target.closest('#app-menu') || event.target.closest('[data-app-menu]')) return;
        this.closeMenu();
      },
      true
    );
  }

  openMenu(anchor) {
    this.readView.closeEntry();
    this.menuAnchor?.setAttribute('aria-expanded', 'false');
    const rect = anchor.getBoundingClientRect();
    dom.menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    dom.menu.style.left = `${Math.round(rect.left)}px`;
    dom.menu.hidden = false;
    this.menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
  }

  closeMenu() {
    if (dom.menu.hidden) return false;
    dom.menu.hidden = true;
    this.menuAnchor?.setAttribute('aria-expanded', 'false');
    this.menuAnchor = null;
    return true;
  }

  addMedia() {
    if (this.mode !== 'write') this.setView('write');
    dom.mediaInput.click();
  }

  setListTabIcon(reading) {
    const tab = document.querySelector('[data-view="list"]');
    if (!tab) return;
    const name = reading ? 'arrow-left-top' : 'list';
    tab.dataset.icon = name;
    tab.setAttribute('aria-label', reading ? 'Back to list' : 'List');
    tab.innerHTML = icon(name);
  }

  /** Pencil while idle or browsing; checkmark only on write with a real draft. */
  updateWriteTabIcon() {
    const tab = document.querySelector('[data-view="write"]');
    if (!tab) return;
    const finishing = this.canFinishFromWriteTab();
    const name = finishing ? 'check' : 'pencil';
    tab.dataset.icon = name;
    tab.setAttribute('aria-label', finishing ? 'Finish entry' : 'Write');
    tab.title = finishing ? 'Finish entry' : 'Write';
    tab.innerHTML = icon(name);
  }

  /** Finish affordance only while writing a non-empty draft. */
  canFinishFromWriteTab() {
    return (
      this.mode === 'write' &&
      !!this.session?.current &&
      !isBlank(this.session.current.blocks)
    );
  }

  // MARK: - Views

  setView(view) {
    this.closeMenu();
    this.readView.closeEntry();
    if (this.mode === view) {
      if (view === 'write') this.editor.focus();
      return;
    }

    const leavingWrite = this.mode === 'write';
    this.mode = view;
    dom.shell.dataset.mode = view;
    dom.write.hidden = view !== 'write';
    dom.read.hidden = view === 'write';
    for (const segment of document.querySelectorAll('.segment')) {
      const on = segment.dataset.view === view;
      segment.classList.toggle('is-selected', on);
      segment.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.updateWriteTabIcon();

    if (view === 'write') {
      this.editor.layout();
      this.editor.focus();
      this.scheduleSaveHint();
      return;
    }

    this.hideSaveHint();
    dom.editor.blur();
    this.readView.setView(view);
    if (leavingWrite) {
      this.session.postDraft();
      this.refreshEntries();
    }
  }

  /**
   * Renders from the local copy first — so opening the app, or switching to
   * the calendar or map, never waits on the network — then reconciles with the
   * server, which remains the source of truth.
   */
  async refreshEntries() {
    const journalId = this.activeJournalId;
    const cached = (await this.store?.entriesFor(journalId)) ?? [];
    if (cached.length && journalId === this.activeJournalId) {
      this.entries = cached;
      this.readView.setEntries(cached);
    }

    try {
      const { entries } = await api.entries(journalId);
      await this.store?.merge(entries);
      // Anything committed here but not yet acknowledged is still ours to keep.
      const pending = ((await this.store?.unsynced()) ?? []).filter(
        (entry) => entry.journalId === journalId
      );
      const merged = [...entries, ...pending.filter((p) => !entries.some((e) => e.id === p.id))]
        .sort((a, b) => b.createdAt - a.createdAt);
      if (journalId !== this.activeJournalId) return;
      this.entries = merged;
      this.readView.setEntries(merged);
    } catch (error) {
      this.handleError(error);
    }
  }

  /** A resolved location can land on the open entry or on a closed one. */
  entryUpdated(entry) {
    if (!entry) return;
    if (this.session.entryId === entry.id) {
      this.updateStamp();
      this.updateLocationButton();
    }
    const index = this.entries.findIndex((existing) => existing.id === entry.id);
    if (index >= 0) {
      this.entries[index] = entry;
      if (this.mode !== 'write') this.readView.setEntries(this.entries);
    }
  }

  /** Owner flipped a list row between public and private. */
  async setPublished(entry, published) {
    try {
      const { entry: updated } = await api.setPublished(entry.id, published);
      await this.store?.put(updated);
      this.entryUpdated(updated);
    } catch (error) {
      this.handleError(error);
    }
  }

  // MARK: - Journals

  showJournalPicker() {
    openJournalPicker({
      journals: this.journals,
      activeId: this.activeJournalId,
      onSelect: (journal) => this.switchJournal(journal.id),
      onCreate: async (name) => {
        const { journal, journals } = await api.createJournal(name);
        this.journals = journals;
        await this.switchJournal(journal.id);
      },
    });
  }

  /**
   * One shared active-journal context for both modes. An open entry moves to
   * the newly selected journal — one open entry, one journal, last selection
   * wins until it closes.
   */
  async switchJournal(journalId) {
    this.activeJournalId = journalId;
    this.refreshChrome();
    if (this.mode !== 'write') this.refreshEntries();
    try {
      this.session.reassign(journalId);
      await api.setPreferences({ activeJournalId: journalId });
      this.refreshChrome();
    } catch (error) {
      this.handleError(error);
    }
  }

  // MARK: - The entry lifecycle
  //
  // The client owns it. The session decides when an entry begins and when it
  // is finished; the server is told the result. The save-hint tick also polls
  // for a due finish, so a throttled one-shot timer cannot leave a stale draft
  // on screen.

  /**
   * Runs before the surface accepts input. If the entry has gone quiet past
   * the policy — a suspended tab, a sleeping laptop — it is committed *now*,
   * so the keystroke about to arrive lands in a genuinely new entry rather
   * than being appended to one that should already be in the journal.
   */
  finishIfStale() {
    if (!this.session.isStale()) return false;
    // Not awaited: this runs inside `beforeinput`, and what has to happen
    // before the keystroke is the synchronous part — the session letting go of
    // the entry and the surface emptying. The network can catch up after.
    this.session.finish('rollover');
    this.editor.setContents([]);
    this.editor.markNewEntry();
    this.updateStamp();
    this.updateLocationButton();
    return true;
  }

  noteInput(contents) {
    const before = this.session.entryId;
    const current = this.session.noteInput(contents, this.activeJournalId);
    if (current && current.entryId !== before) {
      this.updateStamp();
      // Auto-tag at the remembered granularity — also the first time the
      // browser is asked for the position.
      this.location.autoTag(this.draft).catch(() => {});
    }
    this.updateWriteTabIcon();
    this.scheduleSaveHint();
  }

  /**
   * After a quiet stretch while writing, fade the always-present countdown
   * from paper to the journal-name color. Typing fades it back to paper;
   * the string itself stays so the chrome layout does not jump. The same
   * one-second tick also finishes a draft whose idle deadline has passed —
   * browsers throttle lone setTimeouts, especially on mobile.
   */
  scheduleSaveHint() {
    clearTimeout(this.saveHintDelay);
    clearInterval(this.saveHintTick);
    this.saveHintDelay = null;
    this.saveHintTick = null;
    dom.saveHint.classList.remove('is-visible');

    if (this.mode !== 'write') {
      dom.saveHint.textContent = '';
      return;
    }
    const current = this.session?.current;
    if (!current || isBlank(current.blocks)) {
      dom.saveHint.textContent = '';
      return;
    }

    this.paintSaveHint();
    this.saveHintTick = setInterval(() => this.paintSaveHint(), 1000);

    const idleFor = Date.now() - current.lastInputAt;
    const wait = Math.max(0, SAVE_HINT_IDLE_MS - idleFor);
    this.saveHintDelay = setTimeout(() => this.revealSaveHint(), wait);
  }

  revealSaveHint() {
    if (this.mode !== 'write') return;
    const current = this.session?.current;
    if (!current || isBlank(current.blocks)) return;
    if (Date.now() - current.lastInputAt < SAVE_HINT_IDLE_MS) return;

    this.paintSaveHint();
    dom.saveHint.classList.add('is-visible');
  }

  paintSaveHint() {
    const current = this.session?.current;
    if (this.mode !== 'write' || !current || isBlank(current.blocks)) {
      this.hideSaveHint();
      return;
    }

    const remaining = current.lastInputAt + this.session.finishAfterMs - Date.now();
    if (remaining <= 0 || this.session.isStale()) {
      this.hideSaveHint();
      this.finish();
      return;
    }

    dom.saveHint.textContent =
      remaining < SAVE_HINT_SECONDS_MS
        ? `~ entry saves in ${Math.max(1, Math.ceil(remaining / 1000))}s`
        : `~ entry saves in ${Math.max(1, Math.ceil(remaining / 60_000))}min`;
  }

  hideSaveHint() {
    clearTimeout(this.saveHintDelay);
    clearInterval(this.saveHintTick);
    this.saveHintDelay = null;
    this.saveHintTick = null;
    dom.saveHint.classList.remove('is-visible');
    dom.saveHint.textContent = '';
  }

  /**
   * An entry is finished. It goes into the local journal immediately so read
   * mode shows it at once, then to the server; if that fails it stays queued
   * and is retried, so writing is never lost to a dropped connection.
   */
  async commit(entry, reason = 'idle') {
    const record = {
      id: entry.id,
      journalId: entry.journalId,
      createdAt: entry.createdAt,
      lastInteractionAt: entry.lastInteractionAt,
      timeZoneId: entry.timeZoneId,
      blocks: entry.blocks,
      location: entry.location,
    };

    await this.store?.put(record, { synced: false });
    this.mergeEntry(record);
    // A rollover has already emptied the surface to receive the keystroke that
    // caused it; clearing again here would wipe what the user just typed.
    if (reason !== 'rollover') this.editor.clearAnimated();
    this.updateStamp();
    this.updateLocationButton();

    try {
      const { entry: saved } = await api.commitEntry(record);
      await this.store?.put(saved);
      this.mergeEntry(saved);
    } catch (error) {
      if (error instanceof AuthError) return this.handleError(error);
      // Left unsynced; `flushUnsynced` will try again.
    }
  }

  /** Commits on demand rather than waiting the policy out. */
  finish() {
    return this.session.finish();
  }

  /** Retries entries the server has not acknowledged. */
  async flushUnsynced() {
    const pending = (await this.store?.unsynced()) ?? [];
    for (const record of pending) {
      try {
        const { entry } = await api.commitEntry(record);
        await this.store?.put(entry);
        this.mergeEntry(entry);
      } catch (error) {
        if (error instanceof AuthError) return this.handleError(error);
        return; // Still offline; try again next time round.
      }
    }
  }

  /** Folds one entry into the in-memory list read mode is showing. */
  mergeEntry(entry) {
    if (entry.journalId !== this.activeJournalId) return;
    const index = this.entries.findIndex((existing) => existing.id === entry.id);
    if (index >= 0) this.entries[index] = entry;
    else this.entries.unshift(entry);
    this.entries.sort((a, b) => b.createdAt - a.createdAt);
    this.readView.setEntries(this.entries);
  }

  // MARK: - Session

  signOut() {
    // Don't wait: a hung draft post or a blocked IndexedDB delete is what
    // used to leave the journal on screen. Token is gone; reload shows sign-in.
    this.session.postDraft().catch(() => {});
    api.logout();
    try {
      this.store?.db.close();
    } catch {
      // Already closed or unavailable.
    }
    LocalStore.destroy(this.userId).catch(() => {});
    setToken(null);
    location.reload();
  }

  handleError(error) {
    if (error instanceof AuthError) {
      closeSheet();
      showAuth('Your session expired — sign in again.');
      return;
    }
    console.warn(error);
  }
}

// MARK: - Boot

async function start() {
  const state = await api.state();
  dom.auth.hidden = true;
  dom.shell.hidden = false;

  const store = await LocalStore.open(state.user.id);
  const app = new App(state, store);
  window.jrnl = app; // A handle for debugging; nothing depends on it.

  // Whatever is on the surface goes out on the way off the page, so closing
  // the tab mid-sentence costs nothing.
  addEventListener('pagehide', () => {
    const current = app.session.current;
    if (!current) return;
    const payload = JSON.stringify({
      deviceId,
      entryId: current.entryId,
      journalId: current.journalId,
      contents: app.editor.contents,
      location: current.location,
      startedAt: current.startedAt,
      timeZone: current.timeZone,
      clientTime: Date.now(),
    });
    // `fetch` with keepalive survives the page going away; sendBeacon cannot
    // carry the Authorization header.
    fetch('/api/current', {
      method: 'PUT',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      body: payload,
    }).catch(() => {});
  });
}

try {
  trackViewport();

  if (hasToken()) {
    start().catch((error) => {
      if (error instanceof AuthError) showAuth();
      else showAuth(error.message);
    });
  } else {
    showAuth();
  }
} catch (error) {
  showAuth(error instanceof Error ? error.message : 'Something went wrong');
}
