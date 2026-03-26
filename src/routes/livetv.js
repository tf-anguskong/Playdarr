'use strict';

const express  = require('express');
const path     = require('path');
const livetv   = require('../livetv-manager');

const router = express.Router();
const VALID_HLS_FILE = /^(index\.m3u8|seg\d+\.ts)$/;

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

// GET /api/livetv/hls/:file
router.get('/hls/:file', (req, res) => {
  const file = req.params.file;
  if (!VALID_HLS_FILE.test(file)) return res.status(400).json({ error: 'Invalid file' });
  res.sendFile(path.join(livetv.getHlsDir(), file), (err) => {
    if (err && !res.headersSent) {
      res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'File not found' });
    }
  });
});

module.exports = router;
