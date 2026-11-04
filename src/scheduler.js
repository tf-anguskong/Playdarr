'use strict';

const fs   = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { addLocalDays } = require('./timeutil');
const { RECURRENCE } = require('./ical');

// JavaScript timers are 32-bit signed integers — delays > this overflow.
// We re-arm the timer in chunks when needed.
const MAX_SAFE_TIMEOUT = 2147483647; // ~24.8 days in ms

const dataPath = process.env.DATA_PATH || '/data';
const FILE     = path.join(dataPath, 'scheduled.json');

// In-memory store: id -> scheduled room object
const store = new Map();

let _openRoomCallback = null;

// A recurring night that was missed by more than this (server was down) is skipped, not opened late.
const MISSED_GRACE_MS = 6 * 3600 * 1000;

// ── Persistence ───────────────────────────────────────────

function serialize(scheduled) {
  const { _timer, ...rest } = scheduled;
  return rest;
}

function persist() {
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(Array.from(store.values()).map(serialize), null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[Scheduler] Failed to write scheduled.json:', err.message);
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = fs.readFileSync(FILE, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && item.id) store.set(item.id, item);
    }
    console.log(`[Scheduler] Loaded ${store.size} scheduled room(s) from disk`);
  } catch (err) {
    console.error('[Scheduler] Failed to read scheduled.json:', err.message);
  }
}

// ── Timer management ──────────────────────────────────────

function armTimer(scheduled) {
  const delay = new Date(scheduled.scheduledFor).getTime() - Date.now();

  if (delay <= 0) {
    // Already past — fire immediately after the current call stack unwinds
    setImmediate(() => fire(scheduled.id));
    return;
  }

  if (delay > MAX_SAFE_TIMEOUT) {
    // Re-arm after MAX_SAFE_TIMEOUT ms and try again
    scheduled._timer = setTimeout(() => armTimer(scheduled), MAX_SAFE_TIMEOUT);
    return;
  }

  scheduled._timer = setTimeout(() => fire(scheduled.id), delay);
}

/** Move a recurring night to its next occurrence after `after` (same local wall-clock time). */
function advance(scheduled, after = Date.now()) {
  const step = RECURRENCE[scheduled.recurrence].days;
  let next = new Date(scheduled.scheduledFor);
  do { next = addLocalDays(next, step, scheduled.timezone || 'UTC'); } while (next.getTime() <= after);
  scheduled.scheduledFor = next.toISOString();
  scheduled.remindersSent = {};
  scheduled.occurrence = (scheduled.occurrence || 1) + 1;
  // The pre-picked movie was for the first night only
  scheduled.movieKey = scheduled.movieTitle = scheduled.partId = null;
}

function fire(id) {
  const scheduled = store.get(id);
  if (!scheduled) return; // already removed

  const overdue = Date.now() - new Date(scheduled.scheduledFor).getTime();
  // What the room is opened from — a snapshot, since a recurring record is advanced right below
  const snapshot = serialize(scheduled);

  if (scheduled.recurrence) {
    advance(scheduled);
    persist();
    armTimer(scheduled);
    if (overdue > MISSED_GRACE_MS) {
      console.log(`[Scheduler] Skipped missed occurrence of "${scheduled.name}" (${Math.round(overdue / 3600000)}h overdue)`);
      return;
    }
  } else {
    // One-off: remove from store before calling callback
    store.delete(id);
    persist();
  }

  console.log(`[Scheduler] Firing scheduled room "${snapshot.name}" (id=${id})`);

  if (_openRoomCallback) {
    try {
      _openRoomCallback(snapshot);
    } catch (err) {
      console.error('[Scheduler] openRoomCallback threw:', err.message);
    }
  }
}

// ── Public API ────────────────────────────────────────────

/**
 * Initialise the scheduler.
 * Must be called once at startup, after setupSync.
 * @param {function} openRoomCallback - called with (scheduledRoom) when a room fires
 */
function init(openRoomCallback) {
  _openRoomCallback = openRoomCallback;
  load();
  // Arm timers for all loaded entries
  for (const scheduled of store.values()) {
    armTimer(scheduled);
  }
}

/**
 * Create a new scheduled room.
 * @param {{ name, scheduledFor, timezone, createdBy: {id, name} }} fields
 * @returns {object} the new scheduled room record
 */
function createScheduled(fields) {
  const { name, scheduledFor, timezone, movieKey, movieTitle, partId, createdBy, recurrence } = fields;
  const scheduled = {
    id:           uuidv4(),
    inviteToken:  uuidv4(),
    name:         (name || 'Watch Party').slice(0, 60),
    scheduledFor, // ISO string
    timezone:     timezone || process.env.DEFAULT_TIMEZONE || 'UTC',
    movieKey:     movieKey  || null,
    movieTitle:   movieTitle || null,
    partId:       partId    || null,
    createdBy,    // { id, name }
    recurrence:   RECURRENCE[recurrence] ? recurrence : null, // 'weekly' | 'biweekly' | null
    occurrence:   1,
    remindersSent: {},  // `${webhookId}` -> scheduledFor it was sent for, so a reminder fires once per night
    createdAt:    new Date().toISOString()
  };
  store.set(scheduled.id, scheduled);
  persist();
  armTimer(scheduled);
  console.log(`[Scheduler] Scheduled room "${scheduled.name}" for ${scheduled.scheduledFor} (id=${scheduled.id})`);
  return serialize(scheduled);
}

/**
 * Delete a scheduled room by id. Returns true if found and deleted.
 */
function deleteScheduled(id) {
  const scheduled = store.get(id);
  if (!scheduled) return false;
  if (scheduled._timer) clearTimeout(scheduled._timer);
  store.delete(id);
  persist();
  console.log(`[Scheduler] Deleted scheduled room "${scheduled.name}" (id=${id})`);
  return true;
}

/**
 * Skip the next occurrence of a recurring night. Returns the updated record, or null if not recurring.
 */
function skipNext(id) {
  const scheduled = store.get(id);
  if (!scheduled || !scheduled.recurrence) return null;
  if (scheduled._timer) clearTimeout(scheduled._timer);
  advance(scheduled, new Date(scheduled.scheduledFor).getTime());
  persist();
  armTimer(scheduled);
  console.log(`[Scheduler] Skipped next occurrence of "${scheduled.name}" → ${scheduled.scheduledFor}`);
  return serialize(scheduled);
}

/** Remember that a webhook's reminder was sent for this occurrence. */
function markReminded(id, webhookId) {
  const scheduled = store.get(id);
  if (!scheduled) return;
  (scheduled.remindersSent || (scheduled.remindersSent = {}))[webhookId] = scheduled.scheduledFor;
  persist();
}

/**
 * Get a scheduled room by id.
 */
function getScheduled(id) {
  return store.get(id) || null;
}

/**
 * Look up a scheduled room by invite token.
 */
function getByInviteToken(token) {
  for (const s of store.values()) {
    if (s.inviteToken === token) return s;
  }
  return null;
}

/**
 * List all scheduled rooms (sorted by scheduledFor ascending).
 */
function listScheduled() {
  return Array.from(store.values())
    .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor))
    .map(serialize);
}

module.exports = { init, createScheduled, deleteScheduled, skipNext, markReminded, getScheduled, getByInviteToken, listScheduled };
