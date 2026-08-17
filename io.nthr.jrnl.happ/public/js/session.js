import { api, uuid } from './api.js';

/**
 * The entry lifecycle, owned by the client.
 *
 * The client decides when an entry begins and when it is finished, against its
 * own clock — for a journal the user's wall clock is the right authority. It
 * still commits directly when awake, and on every scratch post it also sends
 * `finalizeIn` so the server can finalize the same deadline if the tab never
 * comes back.
 *
 * The order that matters: the staleness check runs *before* the next keystroke
 * is accepted. So a tab that was suspended for an hour commits what was written
 * before it slept and opens a fresh entry, and the new keystroke lands in the
 * new entry. Nothing ever has to be pulled apart afterwards.
 */
export class Session {
  constructor({ deviceId, policy, timeZone }) {
    this.deviceId = deviceId;
    this.finishAfterMs = policy.finishAfterMs;
    this.debounceMs = policy.draftDebounceMs;
    this.timeZone = timeZone;
    this.current = null;

    /** Fired when the entry under the caret changes identity. */
    this.onCurrentChanged = () => {};
    /** Fired with the committed entry, for the archive and the surface. */
    this.onCommitted = () => {};
  }

  /** Resumes writing in progress reported by the server on boot. */
  adopt(draft) {
    if (!draft) return null;
    this.current = {
      entryId: draft.entryId,
      journalId: draft.journalId,
      blocks: draft.blocks,
      location: draft.location,
      startedAt: draft.startedAt,
      timeZone: draft.timeZoneId,
      lastInputAt: draft.clientTime,
    };
    this.scheduleFinish();
    return this.current;
  }

  get entryId() {
    return this.current?.entryId ?? null;
  }

  /** True once the entry has gone longer than the policy without input. */
  isStale() {
    if (!this.current) return false;
    return Date.now() - this.current.lastInputAt >= this.finishAfterMs;
  }

  /**
   * Commits the entry in progress if it has gone quiet for longer than the
   * policy allows. Call this before accepting input, on waking, and from the
   * timer — it is the whole of the 5-minute rule.
   */
  async finishIfStale() {
    if (!this.isStale()) return false;
    await this.finish();
    return true;
  }

  /**
   * Records what is on the writing surface. The entry is created on the first
   * real input and never for merely opening the page.
   */
  noteInput(blocks, journalId) {
    if (!this.current) {
      if (isBlank(blocks)) return null;
      this.current = {
        entryId: uuid(),
        journalId,
        blocks,
        location: null,
        startedAt: Date.now(),
        timeZone: this.timeZone,
        lastInputAt: Date.now(),
      };
      this.onCurrentChanged(this.current);
    } else {
      this.current.blocks = blocks;
      this.current.lastInputAt = Date.now();
    }
    this.scheduleDraftPost();
    this.scheduleFinish();
    return this.current;
  }

  setLocation(location) {
    if (!this.current) return;
    this.current.location = location;
    this.scheduleDraftPost();
    this.onCurrentChanged(this.current);
  }

  reassign(journalId) {
    if (!this.current) return;
    this.current.journalId = journalId;
    this.scheduleDraftPost();
  }

  // MARK: - Scratch space

  scheduleDraftPost() {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.postDraft(), this.debounceMs);
  }

  /**
   * Best-effort. A commit carries the entry's whole content, so nothing here
   * is ever needed to produce a journal entry — losing a post costs at most
   * the last few seconds of typing if the page dies in the meantime.
   * `finalizeIn` slides the server-side deadline forward with every update.
   */
  async postDraft() {
    clearTimeout(this.draftTimer);
    if (!this.current) return;
    const { entryId, journalId, blocks, location, startedAt, timeZone, lastInputAt } = this.current;
    try {
      await api.updateDraft({
        deviceId: this.deviceId,
        entryId,
        journalId,
        contents: blocks,
        location,
        startedAt,
        timeZone,
        clientTime: lastInputAt,
        finalizeIn: Math.ceil(this.finishAfterMs / 1000),
      });
    } catch {
      // Offline or refused; the next keystroke tries again.
    }
  }

  // MARK: - Committing

  /** The timer is a convenience — `finishIfStale` is what actually decides. */
  scheduleFinish() {
    clearTimeout(this.finishTimer);
    if (!this.current) return;
    const delay = Math.max(0, this.current.lastInputAt + this.finishAfterMs - Date.now());
    this.finishTimer = setTimeout(() => this.finishIfStale(), delay + 50);
  }

  /**
   * Commits the entry to the journal: the client's id, the client's timestamps,
   * and the whole content in one self-contained request. Nothing depends on
   * what the scratch slot happens to hold, and a retry is a no-op.
   */
  async finish(reason = 'idle') {
    const entry = this.current;
    clearTimeout(this.finishTimer);
    clearTimeout(this.draftTimer);
    this.current = null;
    if (!entry || isBlank(entry.blocks)) {
      // An empty entry is never saved; just let go of the slot.
      if (entry) api.discardDraft(this.deviceId).catch(() => {});
      this.onCurrentChanged(null);
      return null;
    }

    const committed = {
      id: entry.entryId,
      journalId: entry.journalId,
      blocks: entry.blocks,
      location: entry.location,
      createdAt: entry.startedAt,
      lastInteractionAt: entry.lastInputAt,
      timeZoneId: entry.timeZone,
    };
    this.onCurrentChanged(null);
    // Hand it over before the network is involved: the entry is real now, and
    // read mode should show it whether or not the server has heard yet. The
    // reason travels with it because a rollover has already cleared the
    // surface to make room for the keystroke that triggered it.
    await this.onCommitted(committed, reason);
    return committed;
  }
}

/**
 * Empty (and near-empty) drafts are never saved. A draft qualifies only with a
 * media block or at least three non-whitespace characters of text.
 */
export const isBlank = (blocks) => {
  let nonWhitespace = 0;
  for (const block of blocks) {
    if (block.kind === 'media') return false;
    if (block.kind === 'text') {
      for (const char of block.text) {
        if (!/\s/.test(char)) {
          nonWhitespace += 1;
          if (nonWhitespace >= 3) return false;
        }
      }
    }
  }
  return true;
};
