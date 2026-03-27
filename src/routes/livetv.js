'use strict';

const express  = require('express');
const livetv   = require('../livetv-manager');

const router = express.Router();

// GET /api/livetv/guide
router.get('/guide', async (req, res) => {
  try {
    res.json(await livetv.getGuide());
  } catch {
    res.status(500).json({ error: 'Failed to fetch guide', channels: [] });
  }
});

// POST /api/livetv/channel — called internally from sync.js
router.post('/channel', (req, res) => {
  const { channel } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel required' });
  livetv.switchChannel(String(channel));
  res.json({ channel });
});

// GET /api/livetv/webrtc/capabilities
router.get('/webrtc/capabilities', (req, res) => {
  try {
    res.json(livetv.getRouterCapabilities());
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/livetv/webrtc/transport
router.post('/webrtc/transport', async (req, res) => {
  try {
    const params = await livetv.createWebRtcTransport(req.session.id);
    res.json(params);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/livetv/webrtc/transport/connect
router.post('/webrtc/transport/connect', async (req, res) => {
  const { dtlsParameters } = req.body || {};
  if (!dtlsParameters) return res.status(400).json({ error: 'dtlsParameters required' });
  try {
    await livetv.connectWebRtcTransport(req.session.id, dtlsParameters);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/livetv/webrtc/consume
router.post('/webrtc/consume', async (req, res) => {
  const { rtpCapabilities } = req.body || {};
  if (!rtpCapabilities) return res.status(400).json({ error: 'rtpCapabilities required' });
  try {
    const consumers = await livetv.createConsumers(req.session.id, rtpCapabilities);
    res.json(consumers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
