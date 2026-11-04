const express = require('express');
const axios = require('axios');
const { randomUUID: uuidv4 } = require('crypto');
const router = express.Router();
const { getRoomByInviteToken } = require('../sync');
const { encryptToken, decryptToken } = require('../tokenCrypto');
const { sanitizeText } = require('../sanitize');
const wordfilter = require('../wordfilter');
const users = require('../users');

if (!process.env.PLEX_CLIENT_ID) {
  throw new Error('PLEX_CLIENT_ID env var must be set (use a unique stable identifier for your app)');
}
const CLIENT_ID = process.env.PLEX_CLIENT_ID;
const PLEX_PRODUCT = 'Playdarr';
const PLEX_API    = 'https://plex.tv/api/v2';

// Cache the server's machine identifier so we only fetch it once
let cachedMachineId = null;
async function getServerMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const res = await axios.get(`${process.env.PLEX_URL}/identity`, {
    headers: { Accept: 'application/json' },
    timeout: 5000
  });
  cachedMachineId = res.data?.MediaContainer?.machineIdentifier;
  return cachedMachineId;
}

const plexHeaders = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': CLIENT_ID,
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Version': '1.0.0'
};

// Step 1: Redirect to Plex OAuth
router.get('/plex', async (req, res) => {
  // The PIN is bound to this browser's session cookie, and the Plex redirect lands on APP_URL — so the
  // flow has to start on APP_URL's host too, or the cookie set here won't be there on the way back.
  // (Redirect once only, guarded by ?h=1, so a proxy that rewrites Host can't cause a loop.)
  try {
    const appHost = process.env.APP_URL && new URL(process.env.APP_URL).host;
    if (appHost && req.get('host') !== appHost && !req.query.h) {
      return res.redirect(`${process.env.APP_URL.replace(/\/$/, '')}/auth/plex?h=1`);
    }
  } catch { /* malformed APP_URL: carry on, the callback URL below will be wrong anyway */ }
  try {
    const pinRes = await axios.post(`${PLEX_API}/pins`, null, {
      headers: plexHeaders,
      params: { strong: true }
    });
    const { id, code } = pinRes.data;

    const callbackUrl = encodeURIComponent(`${process.env.APP_URL}/auth/plex/callback/${id}`);
    // Only the browser that started this sign-in may finish it. Without this, anyone who called the
    // callback with someone else's (sequential, guessable) PIN id after they approved it got their session.
    req.session.plexPinId = String(id);
    await new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));
    res.redirect(
      `https://app.plex.tv/auth#?clientID=${encodeURIComponent(CLIENT_ID)}` +
      `&code=${code}&forwardUrl=${callbackUrl}` +
      `&context[device][product]=${encodeURIComponent(PLEX_PRODUCT)}`
    );
  } catch (err) {
    console.error('[Auth] Plex PIN error:', err.message);
    res.redirect('/login?error=plex');
  }
});

// Step 2: Plex OAuth callback
router.get('/plex/callback/:pinId', async (req, res) => {
  const pinId = req.params.pinId;
  if (!/^\d+$/.test(pinId) || !req.session?.plexPinId || req.session.plexPinId !== pinId) {
    console.warn(`[Auth] Callback for PIN ${String(pinId).slice(0, 20)} not started by this browser — refused`);
    return res.redirect('/login?error=auth');
  }
  delete req.session.plexPinId;   // one use
  try {
    const { authToken } = (await axios.get(`${PLEX_API}/pins/${pinId}`, { headers: plexHeaders })).data;
    console.log(`[Auth] authToken present: ${!!authToken}`);
    if (!authToken) return res.redirect('/login?error=no_token');

    // True when this Plex account *owns* the server Playdarr is connected to (plex.tv marks it `owned`).
    let isAdmin = false;
    try {
      const [machineId, resourcesRes] = await Promise.all([
        getServerMachineId(),
        axios.get(`${PLEX_API}/resources`, {
          headers: { ...plexHeaders, 'X-Plex-Token': authToken },
          params: { includeHttps: 1 },
          timeout: 8000
        })
      ]);
      const serverResource = resourcesRes.data.find(r => r.clientIdentifier === machineId);
      if (!serverResource) {
        console.error(`[Auth] User token has no access to server ${machineId}`);
        return res.redirect('/login?error=access');
      }
      isAdmin = serverResource.owned === true;
    } catch (e) {
      console.error('[Auth] Server access check failed:', e.code, e.message, e.response?.status);
      return res.redirect('/login?error=access');
    }

    const plexUser = (await axios.get(`${PLEX_API}/user`, {
      headers: { ...plexHeaders, 'X-Plex-Token': authToken }
    })).data;

    req.session.regenerate(regenErr => {
      if (regenErr) {
        console.error('[Auth] Session regenerate error:', regenErr);
        return res.redirect('/login?error=auth');
      }
      const name = plexUser.friendlyName || plexUser.username || plexUser.email;
      const known = users.touch({ id: plexUser.id, name, picture: plexUser.thumb }, { login: true });
      req.session.user = {
        id: String(plexUser.id),
        name,
        displayName: known.nickname || undefined,   // the nickname they chose on an earlier visit
        email: plexUser.email,
        picture: plexUser.thumb,
        plexToken: encryptToken(authToken),
        isGuest: false,
        isAdmin
      };
      if (isAdmin) console.log(`[Auth] ${req.session.user.name} signed in as server owner (admin)`);
      req.session.save(err => {
        if (err) console.error('[Auth] Session save error:', err);
        res.redirect('/');
      });
    });
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect('/login?error=auth');
  }
});

// Guest join via invite link — called from /join/:inviteToken page
router.post('/guest-join', express.json(), (req, res) => {
  const { name, inviteToken, roomId } = req.body || {};
  const trimmedName = sanitizeText((name || '').trim().slice(0, 40));
  if (!trimmedName) return res.status(400).json({ error: 'Name is required' });
  if (!wordfilter.isClean(trimmedName)) return res.status(400).json({ error: wordfilter.NAME_REFUSED });
  if (!inviteToken || !roomId) return res.status(400).json({ error: 'Invalid invite' });

  // Validate that the invite token actually maps to the claimed roomId
  const room = getRoomByInviteToken(inviteToken);
  if (!room || room.id !== roomId) {
    return res.status(403).json({ error: 'Invalid or expired invite' });
  }

  // Fresh session id for the new identity (no fixation; drops whatever the old session held)
  req.session.regenerate(regenErr => {
    if (regenErr) return res.status(500).json({ error: 'Session error' });
    req.session.user = {
      id: `guest-${uuidv4()}`,
      name: trimmedName,
      picture: null,
      isGuest: true,
      inviteToken  // stored so socket join-room can validate it
    };
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ ok: true, roomId });
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
