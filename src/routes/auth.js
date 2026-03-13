const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const CLIENT_ID   = process.env.PLEX_CLIENT_ID || 'movienight-app';
const PLEX_PRODUCT = 'Movie Night';
const PLEX_API    = 'https://plex.tv/api/v2';

const plexHeaders = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': CLIENT_ID,
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Version': '1.0.0'
};

// Step 1: Redirect to Plex OAuth
router.get('/plex', async (req, res) => {
  try {
    const pinRes = await axios.post(`${PLEX_API}/pins`, null, {
      headers: plexHeaders,
      params: { strong: true }
    });
    const { id, code } = pinRes.data;
    console.log(`[Auth] Created PIN id=${id}`);

    const callbackUrl = encodeURIComponent(`${process.env.APP_URL}/auth/plex/callback/${id}`);
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
  console.log(`[Auth] Callback for PIN ${pinId}`);
  try {
    const { authToken } = (await axios.get(`${PLEX_API}/pins/${pinId}`, { headers: plexHeaders })).data;
    console.log(`[Auth] authToken present: ${!!authToken}`);
    if (!authToken) return res.redirect('/login?error=no_token');

    try {
      await axios.get(`${process.env.PLEX_URL}/`, {
        params: { 'X-Plex-Token': authToken },
        headers: { Accept: 'application/json' },
        timeout: 5000
      });
    } catch (e) {
      console.error('[Auth] Server access check failed:', e.code, e.message, e.response?.status);
      return res.redirect('/login?error=access');
    }

    const plexUser = (await axios.get(`${PLEX_API}/user`, {
      headers: { ...plexHeaders, 'X-Plex-Token': authToken }
    })).data;

    req.session.user = {
      id: String(plexUser.id),
      name: plexUser.friendlyName || plexUser.username || plexUser.email,
      email: plexUser.email,
      picture: plexUser.thumb,
      plexToken: authToken,
      isGuest: false
    };
    req.session.save(err => {
      if (err) console.error('[Auth] Session save error:', err);
      res.redirect('/');
    });
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect('/login?error=auth');
  }
});

// Guest join via invite link — called from /join/:inviteToken page
router.post('/guest-join', express.json(), (req, res) => {
  const { name, inviteToken, roomId } = req.body || {};
  const trimmedName = (name || '').trim().slice(0, 40);
  if (!trimmedName) return res.status(400).json({ error: 'Name is required' });
  if (!inviteToken || !roomId) return res.status(400).json({ error: 'Invalid invite' });

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

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
