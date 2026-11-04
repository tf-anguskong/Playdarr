// /api/tv — "Send from your phone" pairing for the Android TV app (see tvlink.js). Public: the TV calls it before
// anyone has signed in, and the phone that scans the QR code needn't be signed in either.
const express = require('express');
const rateLimit = require('express-rate-limit');
const tvlink = require('../tvlink');
const { sanitizeText } = require('../sanitize');

const router = express.Router();

const limiter = (max, windowMin = 15) => rateLimit({
  windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
const createLimiter = limiter(20);    // a TV asks for a fresh code every 10 minutes at most
const pollLimiter   = limiter(600);   // ~every 2 s for the life of a code
const sendLimiter   = limiter(30);    // the phone side; also what makes guessing codes pointless

// POST /api/tv/pair → { code, secret, expiresAt }
router.post('/pair', createLimiter, (req, res) => {
  const p = tvlink.create();
  if (!p) return res.status(503).json({ error: 'Too many TVs are pairing right now, try again in a minute' });
  res.json(p);
});

// GET /api/tv/pair/:code — TV polls with header X-Pair-Secret → { pending } | { text, name? } | 404
router.get('/pair/:code', pollLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const r = tvlink.take(req.params.code, req.get('X-Pair-Secret'));
  if (!r) return res.status(404).json({ error: 'Pairing expired' });
  res.json(r);
});

// HEAD-like check for the phone page: does this code exist?
router.get('/pair/:code/check', sendLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: tvlink.exists(req.params.code) });
});

/**
 * An invite sent to a TV must be for *this* server: a bare code, or a link whose host is this server's (the host
 * the phone opened the page on, or APP_URL's). The TV checks the same against the server it's connected to.
 * Returns an error message, or null when it's fine.
 */
function wrongServer(text, req) {
  if (!/[/:.]/.test(text)) return null;                       // a bare invite code
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { return "That doesn't look like a Playdarr invite link"; }
  if (!url.pathname.startsWith('/join/')) return "That isn't a Playdarr invite link (they look like …/join/…)";
  const ours = new Set([String(req.get('host') || '').toLowerCase()]);
  try { if (process.env.APP_URL) ours.add(new URL(process.env.APP_URL).host.toLowerCase()); } catch { /* bad APP_URL */ }
  if (!ours.has(url.host.toLowerCase())) {
    return `That invite is for ${url.host}, not this server (${req.get('host')}). Ask for an invite to this server, or connect the TV to ${url.host} first.`;
  }
  return null;
}

// POST /api/tv/pair/:code { text, name? } — the phone sends an invite link (or code) to the TV
router.post('/pair/:code', sendLimiter, express.json({ limit: '4kb' }), (req, res) => {
  const text = sanitizeText(String(req.body?.text || '')).trim();
  const name = sanitizeText(String(req.body?.name || '')).trim();
  if (!text) return res.status(400).json({ error: 'Paste the invite link first' });
  const mismatch = wrongServer(text, req);
  if (mismatch) return res.status(400).json({ error: mismatch });
  if (!tvlink.send(req.params.code, text, name || null)) {
    return res.status(404).json({ error: "That code has expired or doesn't exist. Check the TV for the current one." });
  }
  res.json({ ok: true });
});

module.exports = router;
