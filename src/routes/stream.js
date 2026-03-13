const express = require('express');
const router = express.Router();
const axios = require('axios');

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const CLIENT_ID = process.env.PLEX_CLIENT_ID || 'movienight-app';

// ── M3U8 URL rewriting ─────────────────────────────────────
// Rewrites Plex-internal URLs so all HLS traffic routes through
// our proxy. baseDir is the directory of the m3u8 being rewritten,
// needed to resolve relative segment paths (no leading slash).

function rewritePlexUrl(url, baseDir) {
  try {
    let plexPath;
    if (url.startsWith('http')) {
      const u = new URL(url);
      u.searchParams.delete('X-Plex-Token');
      plexPath = u.pathname + (u.search && u.search !== '?' ? u.search : '');
    } else if (url.startsWith('/')) {
      const u = new URL(`http://x${url}`);
      u.searchParams.delete('X-Plex-Token');
      plexPath = u.pathname + (u.search && u.search !== '?' ? u.search : '');
    } else if (baseDir) {
      // Relative path — resolve against the directory of the parent m3u8
      plexPath = baseDir + url;
    } else {
      return url;
    }
    return `/api/stream/proxy${plexPath}`;
  } catch {
    return url;
  }
}

function rewriteM3u8(content, baseDir) {
  return content
    .replace(/URI="([^"]+)"/g, (_, url) => `URI="${rewritePlexUrl(url, baseDir)}"`)
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return rewritePlexUrl(t, baseDir);
    })
    .join('\n');
}

// ── HLS transcode start ────────────────────────────────────
// Each user gets a session keyed to their user ID so they can
// seek independently while Socket.io keeps them in sync.
router.get('/hls/:ratingKey/master.m3u8', async (req, res) => {
  const { ratingKey } = req.params;
  const userId = String(req.session.user.id).replace(/\W/g, '').slice(0, 12);
  const sessionId = `mn-${userId}-${ratingKey}`;

  try {
    const params = {
      'X-Plex-Token': PLEX_TOKEN,
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Session-Identifier': sessionId,
      'X-Plex-Product': 'Movie Night',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Platform-Version': '120.0',
      'X-Plex-Device': 'Windows',
      'X-Plex-Device-Name': 'Movie Night',
      'X-Plex-Version': '1.0.0',
      hasMDE: '1',
      path: `/library/metadata/${ratingKey}`,
      videoResolution: '1920x1080',
      maxVideoBitrate: '8000',
      videoCodec: 'h264',
      audioCodec: 'aac',
      protocol: 'hls',
      copyts: '1',
      mediaIndex: '0',
      partIndex: '0',
      fastSeek: '1'
    };

    // Build query string manually — axios encodes '/' as '%2F' in param values,
    // but Plex requires literal slashes in the 'path' parameter.
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${k === 'path' ? v : encodeURIComponent(v)}`)
      .join('&');

    const transcodeUrl = `${PLEX_URL}/video/:/transcode/universal/start.m3u8?${qs}`;
    console.log('[HLS] Requesting:', transcodeUrl.replace(PLEX_TOKEN, 'REDACTED'));

    const plexRes = await axios.get(transcodeUrl, {
      headers: {
        Accept: 'application/x-mpegURL',
        'X-Plex-Client-Identifier': CLIENT_ID,
        'X-Plex-Product': 'Movie Night',
        'X-Plex-Platform': 'Chrome',
        'X-Plex-Device-Name': 'Movie Night',
        'X-Plex-Token': PLEX_TOKEN
      }
    });

    console.log('[HLS] Plex response status:', plexRes.status);
    console.log('[HLS] Plex content-type:', plexRes.headers['content-type']);
    console.log('[HLS] Plex body (first 500):', String(plexRes.data).slice(0, 500));

    // Base dir = directory portion of the start.m3u8 URL, for resolving relative paths
    const baseDir = '/video/:/transcode/universal/';

    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewriteM3u8(plexRes.data, baseDir));
  } catch (err) {
    console.error('[HLS] Start error:', err.response?.status, err.message);
    console.error('[HLS] Plex response body:', JSON.stringify(err.response?.data)?.slice(0, 500));
    res.status(500).send('HLS error');
  }
});

// ── General Plex proxy (HLS segments & sub-manifests) ──────
router.get('/proxy/*', async (req, res) => {
  const plexPath = '/' + req.params[0];
  const looksLikeM3u8 =
    plexPath.endsWith('.m3u8') || plexPath.includes('/index.m3u8');

  try {
    const response = await axios({
      method: 'GET',
      url: `${PLEX_URL}${plexPath}`,
      params: { ...req.query, 'X-Plex-Token': PLEX_TOKEN },
      responseType: 'stream',
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    const ct = response.headers['content-type'] || '';
    const isM3u8 =
      looksLikeM3u8 || ct.includes('mpegURL') || ct.includes('m3u8');

    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');

    if (isM3u8) {
      // Buffer, rewrite internal URLs, send
      // Base dir = directory of this m3u8 path, for resolving relative segment URLs
      const baseDir = plexPath.substring(0, plexPath.lastIndexOf('/') + 1);
      const chunks = [];
      response.data.on('data', c => chunks.push(c));
      response.data.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        res.send(rewriteM3u8(text, baseDir));
      });
    } else {
      // Stream directly (TS segments, etc.)
      response.data.pipe(res);
      req.on('close', () => response.data.destroy());
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.response?.status || 500).send('Proxy error');
    }
  }
});

// ── Thumbnail proxy ────────────────────────────────────────
router.get('/thumb/:ratingKey', async (req, res) => {
  try {
    const detailRes = await axios.get(
      `${PLEX_URL}/library/metadata/${req.params.ratingKey}`,
      {
        params: { 'X-Plex-Token': PLEX_TOKEN },
        headers: { Accept: 'application/json' }
      }
    );
    const thumb = detailRes.data.MediaContainer.Metadata[0]?.thumb;
    if (!thumb) return res.status(404).send('No thumbnail');

    const imgRes = await axios({
      method: 'GET',
      url: `${PLEX_URL}/photo/:/transcode`,
      params: { url: thumb, width: 300, height: 450, 'X-Plex-Token': PLEX_TOKEN },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.data.pipe(res);
  } catch {
    res.status(404).send('Thumbnail not found');
  }
});

module.exports = router;
