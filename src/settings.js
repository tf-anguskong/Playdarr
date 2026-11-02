'use strict';

// Admin-editable settings, layered on top of the environment.
//
// Precedence for each setting: a value defined in .env (the process environment when the server started)
// always wins and is shown locked in the admin UI; otherwise a value saved here (DATA_PATH/settings.json)
// is applied; otherwise the built-in default. Saved values are written into process.env at startup and on
// change, so the rest of the app keeps reading process.env exactly as before. Modules that cached a value
// at load register an onChange hook to pick up edits without a restart.
//
// The UI only ever sees the stable ids and friendly text below — never the variable names — and secrets are
// never sent to the browser at all (only whether they're configured).
//
// NOTE: this module must be required before anything else reads process.env (server.js does it right after dotenv).

const fs   = require('fs');
const path = require('path');

const dataPath = process.env.DATA_PATH || '/data';
const FILE     = path.join(dataPath, 'settings.json');

const sel = (...pairs) => pairs.map(([value, label]) => ({ value, label }));
const BITRATE = /^\d{1,5}(\.\d+)?[kKmM]?$/;

const GROUPS = [
  { id: 'rooms', title: 'Room types', blurb: 'Which kinds of rooms people can start from the lobby. Rooms that are already open keep running.' },
  { id: 'scheduling', title: 'Scheduling' },
  { id: 'tuner', title: 'Live TV · source', blurb: 'Where Live TV video and the channel guide come from.' },
  { id: 'capacity', title: 'Live TV · capacity & playback', blurb: 'Keep Live TV within what your tuners and server can handle.' },
  { id: 'quality', title: 'Live TV · picture quality' },
  { id: 'hardware', title: 'Live TV · hardware encoding', blurb: 'Encode on a graphics chip instead of the CPU (Linux only).' },
  { id: 'server', title: 'Server connection', blurb: 'These are read-only here. Change them in your .env file, then recreate the container.', readOnly: true },
];

// type: bool | int | number | select | text | info | secret.  `env` is the underlying variable (server-side only).
// `restart: true` = read once at startup, so a saved change applies after a restart.
const DEFS = [
  // ── Room types ──
  { id: 'roomMovie',   group: 'rooms', env: 'ROOM_TYPE_MOVIE',   type: 'bool', default: true,  label: 'Movie rooms',   description: 'Let people start rooms that play a movie from your Plex library.' },
  { id: 'roomTv',      group: 'rooms', env: 'ROOM_TYPE_TV',      type: 'bool', default: true,  label: 'TV show rooms', description: 'Let people start rooms that play TV episodes from your Plex library.' },
  { id: 'roomYoutube', group: 'rooms', env: 'ROOM_TYPE_YOUTUBE', type: 'bool', default: true,  label: 'YouTube rooms', description: 'Let people start rooms that watch a YouTube video together.' },
  { id: 'roomLivetv',  group: 'rooms', env: 'ROOM_TYPE_LIVETV',  type: 'bool', default: false, label: 'Live TV rooms', description: 'Let people watch live channels together. Needs an HDHomeRun tuner (or Plex DVR) and a Plex channel guide.' },

  // ── Scheduling ──
  { id: 'defaultTimezone', group: 'scheduling', env: 'DEFAULT_TIMEZONE', type: 'text', default: '', maxLength: 60, placeholder: 'America/New_York',
    label: 'Default time zone', description: 'The time zone pre-selected when someone schedules a watch night. Uses UTC when empty.',
    validate: v => { try { Intl.DateTimeFormat(undefined, { timeZone: v }); } catch { throw new Error('That is not a recognised time zone (try something like America/New_York)'); } } },

  // ── Live TV source ──
  { id: 'hdhrIp', group: 'tuner', env: 'HDHR_IP', type: 'text', default: '', maxLength: 253, placeholder: '192.168.1.115',
    label: 'HDHomeRun address', description: "Network address of your HDHomeRun tuner. Leave empty to tune through Plex's DVR instead.",
    validate: v => { if (!/^[A-Za-z0-9.\-]+$/.test(v)) throw new Error('Enter a host name or IP address, for example 192.168.1.115'); } },
  { id: 'hdhrPort', group: 'tuner', env: 'HDHR_PORT', type: 'int', default: 5004, min: 1, max: 65535,
    label: 'HDHomeRun port', description: 'The streaming port on the tuner. It is almost always 5004.' },
  { id: 'liveTvSource', group: 'tuner', env: 'LIVETV_SOURCE', type: 'select', default: '',
    options: sel(['', 'Automatic'], ['hdhr', 'HDHomeRun tuner'], ['plex', "Plex's DVR"]),
    label: 'Live TV source', description: "Where video comes from. Automatic uses the HDHomeRun when an address is set, and Plex's DVR otherwise." },
  { id: 'guideHost', group: 'tuner', env: 'LIVETV_PLEX_HOST', type: 'text', default: '', maxLength: 200, restart: true, placeholder: 'http://192.168.1.225:32400',
    label: 'Channel guide server', description: 'Address of the Plex server that supplies the channel guide, if it is a different server from your main one.',
    validate: v => { let u; try { u = new URL(v); } catch { throw new Error('Enter a full address such as http://192.168.1.225:32400'); } if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://'); } },

  // ── Capacity ──
  { id: 'maxLiveTvRooms', group: 'capacity', env: 'LIVETV_MAX_ROOMS', type: 'int', default: 2, min: 1, max: 32,
    label: 'Most Live TV rooms at once', description: 'How many Live TV rooms can stream at the same time. Each one uses a tuner and an encoder, so keep this at or below your tuner count.' },
  { id: 'pauseCooldown', group: 'capacity', env: 'LIVETV_PAUSE_COOLDOWN_SEC', type: 'int', default: 10, min: 0, max: 120, unit: 'seconds',
    label: 'Live TV pause cooldown', description: 'How long to wait before a Live TV room can be paused again. Stops rapid play/pause from disrupting the stream. 0 turns it off.' },
  { id: 'bufferSec', group: 'capacity', env: 'LIVETV_BUFFER_SEC', type: 'int', default: 10, min: 4, max: 60, unit: 'seconds',
    label: 'Live TV playback buffer', description: 'How far behind live each room plays. Higher is smoother but adds delay and a longer start-up.' },

  // ── Picture quality ──
  { id: 'upscale', group: 'quality', env: 'LIVETV_UPSCALE', type: 'select', default: '',
    options: sel(['', 'Off'], ['720', 'Up to 720p'], ['1080', 'Up to 1080p']),
    label: 'Upscale low-resolution channels', description: 'Scale standard-definition channels up to this height. HD channels are left alone. Uses some extra CPU.' },
  { id: 'sharpen', group: 'quality', env: 'LIVETV_SHARPEN', type: 'number', default: 0.5, min: 0, max: 2, step: 0.1,
    label: 'Sharpening', description: 'How strongly to sharpen upscaled video. 0 turns it off. Only used when upscaling is on.' },
  { id: 'x264Preset', group: 'quality', env: 'LIVETV_X264_PRESET', type: 'select', default: 'veryfast',
    options: sel(['ultrafast', 'Fastest, lowest quality'], ['superfast', 'Superfast'], ['veryfast', 'Very fast (default)'], ['faster', 'Faster'], ['fast', 'Fast'], ['medium', 'Medium, best quality']),
    label: 'CPU encoder speed', description: 'Quality versus CPU use when encoding on the processor. Slower looks better but needs more CPU.' },
  { id: 'maxBitrate', group: 'quality', env: 'LIVETV_MAX_BITRATE', type: 'text', default: '8M', maxLength: 10, placeholder: '8M',
    label: 'Peak video bitrate', description: 'The highest video bitrate the encoder may use, for example 8M.',
    validate: v => { if (!BITRATE.test(v)) throw new Error('Use a number with an optional K or M, for example 8M'); } },

  // ── Hardware encoding ──
  { id: 'hwaccel', group: 'hardware', env: 'LIVETV_HWACCEL', type: 'select', default: '',
    options: sel(['', 'Off (use the CPU)'], ['vaapi', 'Intel / AMD graphics']),
    label: 'Hardware encoding', description: 'Encode on an Intel or AMD graphics chip instead of the CPU. Needs the GPU passed into the container; falls back to the CPU automatically if it fails.' },
  { id: 'vaapiDevice', group: 'hardware', env: 'LIVETV_VAAPI_DEVICE', type: 'text', default: '', maxLength: 60, placeholder: '/dev/dri/renderD128',
    label: 'Graphics device', description: 'Which graphics device to encode on. Leave empty to pick the first Intel or AMD one automatically.',
    validate: v => { if (!/^\/dev\/dri\/[A-Za-z0-9_-]+$/.test(v)) throw new Error('Use a device path such as /dev/dri/renderD128'); } },
  { id: 'vaapiBitrate', group: 'hardware', env: 'LIVETV_VAAPI_BITRATE', type: 'text', default: '6M', maxLength: 10, placeholder: '6M',
    label: 'Hardware video bitrate', description: 'The target bitrate when encoding on the graphics chip, for example 6M.',
    validate: v => { if (!BITRATE.test(v)) throw new Error('Use a number with an optional K or M, for example 6M'); } },
  { id: 'videoArgs', group: 'hardware', env: 'LIVETV_VIDEO_ARGS', type: 'text', default: '', maxLength: 300, advanced: true, placeholder: '-c:v h264_nvenc -preset p4 -b:v 6M',
    label: 'Custom encoder options (advanced)', description: 'Replace the video encoder options completely, for example to use an NVIDIA GPU. Leave empty unless you know you need it.',
    validate: v => { if (/[\r\n;|&`$<>]/.test(v)) throw new Error('Those characters are not allowed'); } },

  // ── Server connection (read-only) ──
  { id: 'plexUrl',     group: 'server', env: 'PLEX_URL',      type: 'info', urlHost: true, label: 'Plex server address', description: 'Where Playdarr reaches your Plex server. Use its address on your own network, not your public domain.' },
  { id: 'publicUrl',   group: 'server', env: 'APP_URL',       type: 'info', label: 'Public address', description: 'The address people use to reach Playdarr. It builds sign-in redirects, invite links and Discord messages.' },
  { id: 'secureCookies', group: 'server', env: 'COOKIE_SECURE', type: 'info', boolInfo: true, label: 'Secure cookies', description: 'On when Playdarr is served over HTTPS. Sign-in will loop if this does not match how you serve the site.' },
  { id: 'port',        group: 'server', env: 'PORT',          type: 'info', fallback: '3000', label: 'Port', description: 'The port Playdarr listens on inside the container.' },
  { id: 'appId',       group: 'server', env: 'PLEX_CLIENT_ID', type: 'info', label: 'App identifier', description: 'The identifier Playdarr presents to Plex when people sign in.' },
  { id: 'plexToken',   group: 'server', env: 'PLEX_TOKEN',    type: 'secret', label: 'Plex access token', description: 'Lets Playdarr talk to your Plex server. Never shown.' },
  { id: 'guideToken',  group: 'server', env: 'LIVETV_PLEX_TOKEN', type: 'secret', label: 'Channel guide token', description: 'Used when the channel guide is on a different Plex server. Never shown.' },
  { id: 'sessionSecret', group: 'server', env: 'SESSION_SECRET', type: 'secret', label: 'Session secret', description: 'Signs the login cookies. Never shown.' },
];

const byId = new Map(DEFS.map(d => [d.id, d]));

// ── State ──────────────────────────────────────────────────
const lockedByEnv = new Set();   // ids whose variable was already defined (i.e. in .env) at startup
let overrides = {};              // id -> saved string value
const listeners = new Map();     // id -> [fn]

const defined = v => v !== undefined && v !== '';

function persist() {
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(overrides, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[Settings] Failed to write settings.json:', err.message);
  }
}

const editable = d => d.type !== 'info' && d.type !== 'secret';

(function init() {
  for (const d of DEFS) if (defined(process.env[d.env])) lockedByEnv.add(d.id);
  try {
    if (fs.existsSync(FILE)) {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const [id, value] of Object.entries(saved || {})) {
        const d = byId.get(id);
        if (!d || !editable(d) || typeof value !== 'string') continue;
        overrides[id] = value;
        if (!lockedByEnv.has(id)) process.env[d.env] = value;   // .env wins
      }
      const n = Object.keys(overrides).length;
      if (n) console.log(`[Settings] Applied ${n} saved setting(s)${lockedByEnv.size ? ' (anything defined in .env takes precedence)' : ''}`);
    }
  } catch (err) {
    console.error('[Settings] Failed to read settings.json:', err.message);
  }
})();

// ── Values ─────────────────────────────────────────────────
function parse(d, raw) {
  if (!defined(raw)) return d.default;
  switch (d.type) {
    case 'bool': { const s = String(raw).toLowerCase(); return s === 'true' ? true : s === 'false' ? false : d.default; }
    case 'int': { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : d.default; }
    case 'number': { const n = parseFloat(raw); return Number.isFinite(n) ? n : d.default; }
    default: return String(raw);
  }
}

/** Turn untrusted input into the string stored in the environment. Throws a friendly Error. '' means "back to default". */
function normalize(d, input) {
  if (d.type === 'bool') {
    if (typeof input === 'boolean') return input ? 'true' : 'false';
    throw new Error('Turn this on or off');
  }
  const s = String(input ?? '').trim();
  if (s === '') return '';
  if (d.type === 'int' || d.type === 'number') {
    const n = Number(s);
    if (!Number.isFinite(n) || (d.type === 'int' && !Number.isInteger(n))) throw new Error(d.type === 'int' ? 'Enter a whole number' : 'Enter a number');
    if (n < d.min || n > d.max) throw new Error(`Enter a value from ${d.min} to ${d.max}`);
    return String(n);
  }
  if (d.type === 'select') {
    if (!d.options.some(o => o.value === s)) throw new Error('Pick one of the listed options');
    return s;
  }
  if (s.length > (d.maxLength || 200)) throw new Error(`Keep this under ${d.maxLength || 200} characters`);
  if (d.validate) d.validate(s);
  return s;
}

/** The URL minus any embedded credentials, for display. */
function safeUrl(v) {
  try { const u = new URL(v); return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return v; }
}

function view(d) {
  const raw = process.env[d.env];
  const source = lockedByEnv.has(d.id) ? 'env' : (overrides[d.id] !== undefined ? 'ui' : 'default');
  const base = { id: d.id, label: d.label, description: d.description, type: d.type, source, restart: !!d.restart, advanced: !!d.advanced };
  if (d.type === 'secret') return { ...base, configured: defined(raw), readOnly: true };
  if (d.type === 'info') {
    let value = defined(raw) ? raw : (d.fallback || '');
    if (d.urlHost) value = safeUrl(value);
    if (d.boolInfo) value = String(raw).toLowerCase() === 'true' ? 'On' : 'Off';
    return { ...base, value, readOnly: true };
  }
  const locked = source === 'env';
  return {
    ...base, value: parse(d, raw), default: d.default, locked,
    ...(d.options ? { options: d.options } : {}),
    ...(d.min !== undefined ? { min: d.min, max: d.max } : {}), ...(d.step ? { step: d.step } : {}),
    ...(d.unit ? { unit: d.unit } : {}), ...(d.placeholder ? { placeholder: d.placeholder } : {}),
    ...(d.maxLength ? { maxLength: d.maxLength } : {}),
  };
}

/** Everything for the Settings page, grouped. */
const list = () => GROUPS.map(g => ({ id: g.id, title: g.title, blurb: g.blurb || null, readOnly: !!g.readOnly, settings: DEFS.filter(d => d.group === g.id).map(view) }));

const get = id => { const d = byId.get(id); return d ? view(d) : null; };

function fire(id) {
  for (const fn of listeners.get(id) || []) {
    try { fn(); } catch (err) { console.error(`[Settings] change hook for "${id}" failed:`, err.message); }
  }
}

function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }

/** Save a setting from the admin UI. An empty value goes back to the default. Returns the updated view. */
function set(id, input) {
  const d = byId.get(id);
  if (!d || !editable(d)) throw fail('Unknown setting', 404);
  if (lockedByEnv.has(id)) throw fail('This is set in your .env file, so it can’t be changed here', 409);
  const value = normalize(d, input);
  if (value === '' && d.type !== 'bool') return reset(id);
  overrides[id] = value;
  process.env[d.env] = value;
  persist();
  fire(id);
  return view(d);
}

/** Drop the saved value so the default applies again. */
function reset(id) {
  const d = byId.get(id);
  if (!d || !editable(d)) throw fail('Unknown setting', 404);
  if (lockedByEnv.has(id)) throw fail('This is set in your .env file, so it can’t be changed here', 409);
  delete overrides[id];
  delete process.env[d.env];
  persist();
  fire(id);
  return view(d);
}

/** Run `fn` whenever any of these settings changes (for modules that cached a value at startup). */
function onChange(ids, fn) {
  for (const id of [].concat(ids)) {
    if (!byId.has(id)) throw new Error(`Unknown setting "${id}"`);
    if (!listeners.has(id)) listeners.set(id, []);
    listeners.get(id).push(fn);
  }
}

/** The friendly label for an id (for audit logging). */
const labelOf = id => byId.get(id)?.label || id;

module.exports = { list, get, set, reset, onChange, labelOf };
