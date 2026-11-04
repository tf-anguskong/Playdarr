// "Send from your phone" for the Android TV app.
//
// Typing an invite link with a TV remote is painful, so the TV asks for a short pairing code, shows it with a QR
// code for <server>/tv/<code>, and polls. Whoever opens that page on a phone pastes the invite link (and optionally
// a name) and presses Send; the TV's next poll picks it up and the pairing is gone.
//
// - The code only lets you *send text to that TV* for 10 minutes. The TV treats what arrives exactly as if it had
//   been typed into its invite box, so nothing sent this way gets more access than typing it would.
// - Only the TV that made the pairing can read it: polling needs the `secret` it was handed, which never appears in
//   the QR code or the page.
// - Everything is in memory; a restart just means the TV asks for a new code.
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX_PAIRINGS = 500;              // a ceiling so nobody can fill memory with pairings
const MAX_TEXT = 500;
const MAX_NAME = 40;
// No 0/O, 1/I/L, so a code read off a TV screen is easy to type
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;

const pairings = new Map();   // code → { secret, expiresAt, text, name }

function sweep() {
  const now = Date.now();
  for (const [code, p] of pairings) if (p.expiresAt <= now) pairings.delete(code);
}
setInterval(sweep, 60 * 1000).unref();

const normalizeCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);

function newCode() {
  for (let i = 0; i < 20; i++) {
    let code = '';
    const bytes = crypto.randomBytes(CODE_LEN);
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    if (!pairings.has(code)) return code;
  }
  throw new Error('Could not allocate a pairing code');
}

/** A new pairing for a TV: `code` goes on screen, `secret` stays with the TV for polling. */
function create() {
  sweep();
  if (pairings.size >= MAX_PAIRINGS) return null;
  const code = newCode();
  const secret = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  pairings.set(code, { secret, expiresAt, text: null, name: null });
  return { code, secret, expiresAt };
}

/** Whether a code is live (the phone page checks before showing the form). */
function exists(code) {
  const p = pairings.get(normalizeCode(code));
  return !!p && p.expiresAt > Date.now();
}

/** The phone sends text to a pairing. false when the code is unknown or expired. */
function send(code, text, name) {
  const p = pairings.get(normalizeCode(code));
  if (!p || p.expiresAt <= Date.now()) return false;
  p.text = String(text || '').trim().slice(0, MAX_TEXT);
  p.name = name ? String(name).trim().slice(0, MAX_NAME) : null;
  return true;
}

/**
 * The TV polls with its secret. Returns null (unknown / expired / wrong secret), { pending: true }, or the text
 * once, after which the pairing is removed.
 */
function take(code, secret) {
  const key = normalizeCode(code);
  const p = pairings.get(key);
  if (!p || p.expiresAt <= Date.now()) return null;
  const a = Buffer.from(String(secret || ''));
  const b = Buffer.from(p.secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (p.text == null) return { pending: true };
  pairings.delete(key);
  return { text: p.text, name: p.name };
}

module.exports = { create, exists, send, take, normalizeCode, CODE_LEN, TTL_MS };
