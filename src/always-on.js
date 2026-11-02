'use strict';

// Always-on rooms: rooms the server owner pins open. The definition (name, type, optional Live TV
// channel, stable invite link) is saved to DATA_PATH/always-on.json and the room is recreated at
// startup; sync.js keeps the live Room object and resets it instead of closing it when it empties.

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dataPath = process.env.DATA_PATH || '/data';
const FILE     = path.join(dataPath, 'always-on.json');

const defs = new Map();   // id -> definition

function persist() {
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(Array.from(defs.values()), null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[AlwaysOn] Failed to write always-on.json:', err.message);
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(list)) list.forEach(d => d && d.id && defs.set(d.id, d));
    console.log(`[AlwaysOn] Loaded ${defs.size} always-on room(s)`);
  } catch (err) {
    console.error('[AlwaysOn] Failed to read always-on.json:', err.message);
  }
}
load();

/**
 * @param {{ name: string, roomType: 'livetv'|'movie'|'tv', channel?: {channel, channelTitle, channelId}|null, createdBy?: string }} fields
 */
function add({ name, roomType, channel, createdBy }) {
  const def = {
    id: uuidv4(),
    inviteToken: uuidv4(),     // stable: the link never changes, however often the room resets
    name, roomType,
    channel: channel || null,  // Live TV only: tuned when someone arrives
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
  };
  defs.set(def.id, def);
  persist();
  return def;
}

function remove(id) {
  const ok = defs.delete(id);
  if (ok) persist();
  return ok;
}

const get  = id => defs.get(id) || null;
const list = () => Array.from(defs.values());

module.exports = { add, remove, get, list };
