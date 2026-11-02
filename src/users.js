'use strict';

// Who has signed in, and the nickname each person chose. Persisted in DATA_PATH/users.json so a
// nickname survives signing out, expired sessions and server restarts. This registry — not the
// session — is the source of truth for nicknames: server.js applies it on every request/connection.
// Only Plex accounts are recorded (guests get a throwaway identity per invite and aren't "people").
// No email addresses are stored.

const fs   = require('fs');
const path = require('path');

const dataPath = process.env.DATA_PATH || '/data';
const FILE     = path.join(dataPath, 'users.json');

const users = new Map();     // plex user id -> record
let saveTimer = null;

function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(Array.from(users.values()), null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[Users] Failed to write users.json:', err.message);
  }
}
// lastSeen changes on every connection; batch the writes
function persistSoon() {
  if (!saveTimer) saveTimer = setTimeout(persistNow, 5000).unref();
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(list)) list.forEach(u => u && u.id && users.set(String(u.id), u));
    console.log(`[Users] Loaded ${users.size} user(s)`);
  } catch (err) {
    console.error('[Users] Failed to read users.json:', err.message);
  }
}
load();

const now = () => new Date().toISOString();

/**
 * Note that this Plex account was seen. Creates the record on first sight (adopting a nickname the
 * session already carries, for people who set one before this registry existed) and refreshes
 * name/avatar/lastSeen. Returns the record.
 */
function touch({ id, name, picture, displayName }, { login = false } = {}) {
  id = String(id);
  let u = users.get(id);
  let isNew = false;
  if (!u) {
    u = { id, name, picture: picture || null, nickname: displayName || null, firstSeen: now(), lastSeen: now(), logins: 0 };
    users.set(id, u);
    isNew = true;
  }
  if (name) u.name = name;
  if (picture) u.picture = picture;
  u.lastSeen = now();
  if (login) u.logins = (u.logins || 0) + 1;
  if (isNew || login) persistNow(); else persistSoon();   // lastSeen-only updates can wait
  return u;
}

const get = id => users.get(String(id)) || null;

/** Set (or clear, with a falsy value) someone's nickname. */
function setNickname(id, nickname) {
  const u = users.get(String(id));
  if (!u) return null;
  u.nickname = nickname || null;
  persistNow();   // a nickname is the thing people would notice losing
  return u;
}

// Flush any batched lastSeen updates when Docker stops the container
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { if (saveTimer) persistNow(); process.exit(0); });
}

/** Everyone, most recently seen first. */
const list = () => Array.from(users.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

module.exports = { touch, get, setNickname, list };
