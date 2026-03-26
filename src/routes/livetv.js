'use strict';

const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');

const router = express.Router();

const LIVETV_API = process.env.LIVETV_API_URL || 'http://livetv-streamer:8080';
const HLS_PATH   = process.env.LIVETV_HLS_PATH || '/livetv/hls';

// Only allow index.m3u8 and seg*.ts — no path traversal
const VALID_HLS_FILE = /^(index\.m3u8|seg\d+\.ts)$/;

// GET /api/livetv/guide — proxy guide from streamer
router.get('/guide', async (req, res) => {
  try {
    const { data } = await axios.get(`${LIVETV_API}/api/guide`, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    console.error('[LiveTV] guide fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch guide', channels: [] });
  }
});

// POST /api/livetv/channel — host-only channel switch (enforced in sync.js via socket)
// This HTTP endpoint is for direct calls from sync.js server-side
router.post('/channel', async (req, res) => {
  const { channel } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel required' });
  try {
    const { data } = await axios.post(`${LIVETV_API}/api/channel`, { channel }, { timeout: 5000 });
    res.json(data);
  } catch (err) {
    console.error('[LiveTV] channel switch error:', err.message);
    res.status(502).json({ error: 'Failed to switch channel' });
  }
});

// GET /api/livetv/hls/:file — serve HLS files from shared volume
router.get('/hls/:file', (req, res) => {
  const file = req.params.file;
  if (!VALID_HLS_FILE.test(file)) {
    return res.status(400).json({ error: 'Invalid file' });
  }
  const filePath = path.join(HLS_PATH, file);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Segment not found' });
      } else {
        res.status(500).json({ error: 'Failed to serve file' });
      }
    }
  });
});

module.exports = router;
