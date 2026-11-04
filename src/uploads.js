'use strict';

// Images people paste or upload into a room's chat.
//
// Every upload is decoded and re-encoded with sharp before it is stored: that proves it really is an image
// (whatever the browser claimed), caps its size, drops metadata such as phone GPS tags, and means the server only
// ever serves its own WebP output — never the bytes someone sent. Files live under
// DATA_PATH/chat-uploads/<roomId>/<id>.webp, are only served to people in that room (server.js), and are deleted
// with their message, when the room closes or resets, and at startup (rooms don't survive a restart).
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const sharp  = require('sharp');

const ROOT       = path.join(process.env.DATA_PATH || '/data', 'chat-uploads');
const MAX_BYTES  = 8 * 1024 * 1024;     // what a browser may send
const MAX_SIDE   = 1600;                // longest side after resizing
const MAX_PIXELS = 50 * 1000 * 1000;    // refuse decompression bombs before decoding
const FORMATS    = new Set(['jpeg', 'png', 'webp', 'gif']);   // never SVG (it can carry script)
const ID_RE      = /^[a-f0-9]{24}$/;
const ROOM_RE    = /^[0-9a-f-]{36}$/;

sharp.cache(false);   // a few uploads now and then; don't hold decoded images in memory

const dirFor = roomId => path.join(ROOT, roomId);
const fileFor = (roomId, id) => path.join(dirFor(roomId), `${id}.webp`);

/** Who may upload, from the admin setting: 'all' | 'plex' | 'off'. */
function mode() {
  const m = String(process.env.CHAT_UPLOADS || 'all').toLowerCase();
  return ['all', 'plex', 'off'].includes(m) ? m : 'all';
}
const allowedFor = user => !!user && (mode() === 'all' || (mode() === 'plex' && !user.isGuest));

/**
 * Validate, re-encode and store an image. Returns { id, w, h, bytes }.
 * Throws an Error with a friendly message (err.userMessage) when the file isn't an acceptable image.
 */
async function save(roomId, buffer) {
  if (!ROOM_RE.test(roomId)) throw friendly('Unknown room.');
  if (!buffer?.length) throw friendly('That file is empty.');
  if (buffer.length > MAX_BYTES) throw friendly('Images can be up to 8 MB.');
  let meta;
  try { meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata(); }
  catch { throw friendly('That file isn’t an image Playdarr can show (use PNG, JPEG, WebP or GIF).'); }
  if (!FORMATS.has(meta.format)) throw friendly('Use a PNG, JPEG, WebP or GIF image.');

  const animated = (meta.pages || 1) > 1 && (meta.format === 'gif' || meta.format === 'webp');
  const out = await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated })
    .rotate()                                         // honour the camera's orientation before EXIF is dropped
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => { throw friendly('That image could not be processed.'); });

  const id = crypto.randomBytes(12).toString('hex');
  await fs.promises.mkdir(dirFor(roomId), { recursive: true });
  await fs.promises.writeFile(fileFor(roomId, id), out.data);
  const h = animated && out.info.pageHeight ? out.info.pageHeight : out.info.height;
  return { id, w: out.info.width, h, bytes: out.data.length };
}

function friendly(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

/** Absolute path of a stored image, or null if the ids are malformed or it doesn't exist. */
function pathOf(roomId, id) {
  if (!ROOM_RE.test(roomId) || !ID_RE.test(id)) return null;
  const p = fileFor(roomId, id);
  return fs.existsSync(p) ? p : null;
}

function remove(roomId, id) {
  if (!ROOM_RE.test(roomId) || !ID_RE.test(id)) return;
  fs.promises.unlink(fileFor(roomId, id)).catch(() => {});
}

function removeRoom(roomId) {
  if (!ROOM_RE.test(roomId)) return;
  fs.promises.rm(dirFor(roomId), { recursive: true, force: true }).catch(() => {});
}

// Rooms (and their chat) live in memory, so anything on disk at startup belongs to nobody
function clearAll() {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (err) { console.warn('[Uploads] could not clear old chat images:', err.message); }
}

module.exports = { MAX_BYTES, mode, allowedFor, save, pathOf, remove, removeRoom, clearAll };
