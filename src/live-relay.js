'use strict';

/**
 * Server-side HLS relay for live TV.
 *
 * Instead of proxying Plex directly to clients (which causes session expiry
 * at ~4 min), the server fetches HLS segments from Plex continuously and
 * records them to disk as a per-room DVR (LiveDvr, capped at DVR_MAX_SEC).
 * Clients connect to /api/stream/live/:roomId/index.m3u8 and play from the DVR,
 * so the host can pause/rewind and every viewer shares one timeline.
 *
 * Benefits:
 *   • Plex sees constant active segment consumption → session never expires
 *   • Keepalive pings + segment fetching together prevent DVR subscription TTL
 *   • Client URL is stable across retuning (same /live/:roomId/index.m3u8)
 *   • Room is the only Plex client — no per-viewer session management
 */

const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const { parseVideoArgs } = require('./ffmpeg-args');

const PLEX_BASE_URL = process.env.LIVETV_PLEX_HOST  || process.env.PLEX_URL   || '';
const PLEX_TOKEN    = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const CLIENT_ID     = process.env.PLEX_CLIENT_ID    || 'playdarr-app';

const POLL_MS      = 2000;   // variant playlist poll interval
const KEEPALIVE_MS = 3000;   // DVR subscription keepalive interval (~2.6s in native Plex)
const SEG_TIMEOUT  = 15000;  // max ms to wait for a segment download
const READY_SEGS   = 3;      // segments needed before relay is considered ready
const MAX_PENDING  = 10;     // segments a warming relay holds before it is promoted
const DVR_MAX_SEC  = 3600;   // DVR window kept per room (1 hour)
// Resolved to a full path: res.sendFile refuses a drive-less "\data\…" on Windows (local dev without DATA_PATH),
// which made every segment fail and the player wait forever at "Starting playback…"
const DVR_ROOT     = path.resolve(process.env.DATA_PATH || '/data', 'dvr');
const DVR_EPOCH_MS = Date.UTC(2020, 0, 1); // synthetic PROGRAM-DATE-TIME origin; clients derive DVR time from it
const STALL_THRESH        = 2;       // consecutive poll errors before triggering onStall (fallback)
const PROACTIVE_RETUNE_MS = 200_000; // 3:20 — proactive retune before 4-min DVR session expiry

// ── DVR store ──────────────────────────────────────────────
// One per room; outlives individual Plex sessions (retunes append with a
// discontinuity). A channel change creates a fresh one.
class LiveDvr {
  constructor(roomId) {
    this.roomId  = roomId;
    // Unique dir: a channel change builds the new DVR while the old one is still being served.
    this.dir     = path.join(DVR_ROOT, `${roomId}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.entries = [];       // { idx, file, dur, start, disc, cc }
    this.nextIdx = 0;
    this.total   = 0;        // seconds recorded since DVR start (absolute DVR time)
    this.cc      = 0;        // running discontinuity counter
    this.lastArrivalMs = 0;  // when the newest segment was fetched from Plex
  }

  append(buf, dur, disc, arrivedAt) {
    const idx  = this.nextIdx++;
    const file = `s${idx}.ts`;
    fs.writeFileSync(path.join(this.dir, file), buf);
    this._record(idx, file, dur, disc, arrivedAt);
  }

  /** Record a segment file that an encoder already wrote into this DVR's directory as `s<idx>.ts`. */
  adopt(file, dur, disc) {
    const idx = parseInt(file.slice(1), 10);
    if (!/^s\d+\.ts$/.test(file) || !Number.isFinite(idx)) return;
    this.nextIdx = idx + 1;
    this._record(idx, file, dur, disc, Date.now());
  }

  _record(idx, file, dur, disc, arrivedAt) {
    if (disc) this.cc++;
    this.entries.push({ idx, file, dur, start: this.total, disc: !!disc, cc: this.cc });
    this.total += dur;
    this.lastArrivalMs = arrivedAt || Date.now();
    if (idx < 3 || idx % 5 === 0) {
      let size = '?';
      try { size = fs.statSync(path.join(this.dir, file)).size; } catch { /* trimmed already */ }
      console.log(`[DVR] ${this.roomId}: +${file} ${dur.toFixed(2)}s (${size} B) total=${this.total.toFixed(1)}s cc=${this.cc}${disc ? ' DISC' : ''}`);
    }
    while (this.entries.length > 1 && this.total - this.entries[0].start > DVR_MAX_SEC) {
      const old = this.entries.shift();
      fs.unlink(path.join(this.dir, old.file), () => {});
    }
  }

  /** { start, edge } in absolute DVR seconds. */
  info() {
    return { start: this.entries.length ? this.entries[0].start : 0, edge: this.total };
  }

  getPlaylist() {
    if (!this.entries.length) return null;
    const first = this.entries[0];
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...this.entries.map(e => e.dur)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${first.idx}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${first.cc - (first.disc ? 1 : 0)}`,
    ];
    for (const e of this.entries) {
      if (e.disc) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(DVR_EPOCH_MS + e.start * 1000).toISOString()}`);
      lines.push(`#EXTINF:${e.dur.toFixed(3)},`);
      lines.push(`/api/stream/live/${this.roomId}/${e.file}`);
    }
    return lines.join('\n') + '\n';
  }

  /** Absolute path of a recorded segment, or null if trimmed / unknown. */
  segmentPath(name) {
    if (!/^s\d+\.ts$/.test(name)) return null;
    const idx = parseInt(name.slice(1), 10);
    return this.entries.some(e => e.idx === idx) ? path.join(this.dir, name) : null;
  }

  destroy() {
    this.entries = [];
    fs.rm(this.dir, { recursive: true, force: true }, () => {});
  }
}

class LiveRelay {
  constructor(roomId, { ratingKey, liveSessionKey, onStall, dvr, committing, readySegs }) {
    this.roomId       = roomId;
    this.dvr          = dvr;
    this.committing   = !!committing; // false while warming alongside the live relay
    this.readySegs    = readySegs || READY_SEGS;
    this.nextDisc     = false;        // flag the next recorded segment as a discontinuity
    this.pending      = [];           // { buf, dur, arrivedAt } held until promote()
    this.fetched      = 0;
    this.kaOk         = 0;
    this.kaFail       = 0;
    this.ratingKey    = String(ratingKey);
    this.liveSessionKey = liveSessionKey || null; // /livetv/sessions/{uuid}
    this.onStall      = onStall || null;          // called after STALL_THRESH consecutive errors

    // Unique IDs for this relay's Plex session.
    // sessionId must be unique per relay instance — reusing the same ID across a
    // warm-swap causes Plex to treat the new relay as a duplicate client and
    // kill the shared transcode session, breaking both old and new relays.
    this.sessionId  = `mn-relay-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.playbackId = crypto.randomUUID();
    this.bgId       = crypto.randomUUID();

    this.variantUrl = null;
    this.seen       = new Set();   // all segment names ever fetched (dedup)
    this.targetDur  = 3;           // fallback segment duration (updated from playlist)
    this.running        = false;
    this.pollTimer      = null;
    this.kaTimer        = null;
    this.proactiveTimer = null;
    this.startMs        = Date.now();
    this.consecErrors   = 0;       // consecutive poll errors (reset on success)
  }

  // ── Start ──────────────────────────────────────────────────
  async start() {
    this.running = true;
    const masterUrl  = this._buildMasterUrl();
    const masterText = await this._fetchText(masterUrl);
    const baseDir    = `${PLEX_BASE_URL}/video/:/transcode/universal/`;
    this.variantUrl  = this._pickVariant(masterText, baseDir);
    console.log(`[Relay] ${this.roomId}: started (ratingKey=${this.ratingKey})`);
    this._poll();
    this._startKeepalive();
    // Proactively retune before the DVR session expires (~4 min TTL)
    if (this.onStall) {
      this.proactiveTimer = setTimeout(() => {
        if (this.running) {
          console.log(`[Relay] ${this.roomId}: proactive retune at ${Math.round((Date.now() - this.startMs) / 1000)}s`);
          this.onStall();
        }
      }, PROACTIVE_RETUNE_MS);
    }
  }

  // Build start.m3u8 URL with all required Plex params
  _buildMasterUrl() {
    const params = {
      'X-Plex-Token'              : PLEX_TOKEN,
      'X-Plex-Client-Identifier'  : CLIENT_ID,
      'X-Plex-Session-Identifier' : this.sessionId,
      'X-Plex-Product'            : 'Playdarr',
      'X-Plex-Platform'           : 'Chrome',
      'X-Plex-Platform-Version'   : '120.0',
      'X-Plex-Device'             : 'Windows',
      'X-Plex-Device-Name'        : 'Playdarr',
      'X-Plex-Playback-Session-Id': this.playbackId,
      'X-Plex-Session-Id'         : this.bgId,
      hasMDE                      : '1',
      path                        : `/library/metadata/${this.ratingKey}`,
      videoResolution             : '1920x1080',
      maxVideoBitrate             : '8000',
      videoCodec                  : 'h264',
      audioCodec                  : 'aac',
      protocol                    : 'hls',
      copyts                      : '1',
      mediaIndex                  : '0',
      partIndex                   : '0',
      fastSeek                    : '1',
    };
    // Build query string manually — axios encodes '/' as '%2F' in query params,
    // but Plex requires literal slashes in the 'path' parameter.
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${k === 'path' ? v : encodeURIComponent(v)}`)
      .join('&');
    return `${PLEX_BASE_URL}/video/:/transcode/universal/start.m3u8?${qs}`;
  }

  // ── Segment polling loop ───────────────────────────────────
  _poll() {
    if (!this.running) return;
    this._doOnePoll()
      .then(() => { this.consecErrors = 0; })
      .catch(err => {
        this.consecErrors++;
        console.warn(`[Relay] ${this.roomId}: poll error (${this.consecErrors}/${STALL_THRESH}) — ${err.message}`);
        if (err.response?.status === 404 && !this.diagLogged) { this.diagLogged = true; this._logPlexState(err); }
        if (this.consecErrors === STALL_THRESH && this.onStall) {
          console.warn(`[Relay] ${this.roomId}: stall threshold reached — triggering retune`);
          this.onStall();
        }
      })
      .finally(() => {
        if (this.running) this.pollTimer = setTimeout(() => this._poll(), POLL_MS);
      });
  }

  async _doOnePoll() {
    const text = await this._fetchText(this.variantUrl);
    const segs = this._parseSegs(text, this.variantUrl);

    for (const { name, url, dur } of segs) {
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      try {
        const buf = await this._fetchBin(url);
        if (!this.running) return; // stopped (swapped out) while downloading
        const seg = { buf, dur: dur || this.targetDur, arrivedAt: Date.now() };
        this.fetched++;
        if (this.fetched <= 3) console.log(`[Relay] ${this.roomId}: fetched ${name} (${buf.length} B, ${seg.dur}s) committing=${this.committing}`);
        if (this.committing) {
          this.dvr.append(seg.buf, seg.dur, this.nextDisc, seg.arrivedAt);
          this.nextDisc = false;
        } else {
          this.pending.push(seg);
          if (this.pending.length > MAX_PENDING) this.pending.shift();
        }
      } catch (e) {
        console.warn(`[Relay] ${this.roomId}: segment ${name} failed — ${e.message}`);
      }
    }
  }

  // One-off diagnostics when Plex stops serving this relay's session: what Plex says about it,
  // how long it lived, and which transcode / live sessions Plex still has. Read-only.
  async _logPlexState(err) {
    const age = Math.round((Date.now() - this.startMs) / 1000);
    console.warn(`[Relay] ${this.roomId}: session ${this.sessionId} (ratingKey ${this.ratingKey}) died after ${age}s; ` +
      `segments fetched=${this.fetched}, keepalive ok/fail=${this.kaOk}/${this.kaFail}, 404 body=${JSON.stringify(String(err.response?.data || '')).slice(0, 160)}`);
    const get = async (p) => {
      try {
        const r = await axios.get(`${PLEX_BASE_URL}${p}`, { headers: { 'X-Plex-Token': PLEX_TOKEN, Accept: 'application/json' }, timeout: 5000 });
        return r.data?.MediaContainer || {};
      } catch (e) { return { error: e.response?.status || e.message }; }
    };
    const t = await get('/transcode/sessions');
    const tl = (t.TranscodeSession || []).map(x => `${String(x.key).slice(0, 12)}:${x.progress != null ? Math.round(x.progress) + '%' : '?'}:${x.speed ?? '?'}x`);
    const l = await get('/livetv/sessions');
    const ll = (l.Metadata || []).map(x => `${x.ratingKey}:${x.title || ''}`.slice(0, 40));
    console.warn(`[Relay] ${this.roomId}: plex transcode sessions=${t.error ? 'ERR ' + t.error : JSON.stringify(tl)} livetv sessions=${l.error ? 'ERR ' + l.error : JSON.stringify(ll)}`);
  }

  // ── DVR subscription keepalive ─────────────────────────────
  // Mirrors what the native Plex web client sends to prevent the ~4 min
  // DVR subscription TTL from expiring.
  _startKeepalive() {
    this.kaOk = 0; this.kaFail = 0;
    this.kaTimer = setInterval(() => {
      const elapsed = Date.now() - this.startMs;
      const key = this.liveSessionKey || `/library/metadata/${this.ratingKey}`;

      axios.get(`${PLEX_BASE_URL}/:/timeline`, {
        params: {
          'X-Plex-Token'              : PLEX_TOKEN,
          'X-Plex-Client-Identifier'  : CLIENT_ID,
          'X-Plex-Session-Identifier' : this.sessionId,
          'X-Plex-Session-Id'         : this.bgId,
          'X-Plex-Playback-Session-Id': this.playbackId,
          ratingKey: this.ratingKey,
          key,
          state   : 'playing',
          time    : elapsed,
          hasMDE  : 1,
        }
      }).then(() => { this.kaOk++; }).catch(e => {
        this.kaFail++;
        if (this.kaFail <= 3) console.warn(`[Relay] ${this.roomId}: timeline keepalive failed — ${e.response?.status || e.message}`);
      });

      axios.get(`${PLEX_BASE_URL}/status/sessions/background`, {
        params: {
          'X-Plex-Token'              : PLEX_TOKEN,
          'X-Plex-Client-Identifier'  : CLIENT_ID,
          'X-Plex-Session-Id'         : this.bgId,
          'X-Plex-Playback-Session-Id': this.playbackId,
        }
      }).catch(() => {});
    }, KEEPALIVE_MS);
  }

  // ── Public accessors ───────────────────────────────────────
  /** True once enough segments are fetched to start playback without gaps. */
  isReady() {
    return this.fetched >= this.readySegs;
  }

  /**
   * Take over recording into the DVR from a relay that is being replaced.
   * Segments this relay fetched before `cutoffMs` cover content the old relay
   * already recorded, so they are dropped; the rest follow a discontinuity.
   */
  promote(cutoffMs) {
    const keep = this.pending.filter(sg => sg.arrivedAt > cutoffMs);
    this.pending = [];
    this.committing = true;
    keep.forEach((sg, i) => this.dvr.append(sg.buf, sg.dur, i === 0, sg.arrivedAt));
    // Nothing newer than the cutoff yet: flag the next segment instead.
    if (!keep.length) this.nextDisc = true;
  }

  // ── Stop ───────────────────────────────────────────────────
  stop() {
    this.running = false;
    if (this.pollTimer)      { clearTimeout(this.pollTimer);       this.pollTimer      = null; }
    if (this.kaTimer)        { clearInterval(this.kaTimer);        this.kaTimer        = null; }
    if (this.proactiveTimer) { clearTimeout(this.proactiveTimer);  this.proactiveTimer = null; }
    this.pending = [];
    this.seen.clear();
    // Best-effort stop of the Plex transcode session so it doesn't idle on the server
    axios.get(`${PLEX_BASE_URL}/video/:/transcode/universal/stop`, {
      params: { 'X-Plex-Token': PLEX_TOKEN, session: this.sessionId }
    }).catch(() => {});
    console.log(`[Relay] ${this.roomId}: stopped`);
  }

  // ── HTTP helpers ───────────────────────────────────────────
  async _fetchText(url) {
    const r = await axios.get(url, {
      headers: { 'X-Plex-Token': PLEX_TOKEN },
      timeout: 10000,
    });
    return typeof r.data === 'string' ? r.data : String(r.data);
  }

  async _fetchBin(url) {
    const r = await axios.get(url, {
      headers: { 'X-Plex-Token': PLEX_TOKEN },
      responseType: 'arraybuffer',
      timeout: SEG_TIMEOUT,
    });
    return Buffer.from(r.data);
  }

  // ── Manifest parsing ───────────────────────────────────────
  /** Choose highest-bandwidth variant from the master playlist. */
  _pickVariant(masterText, baseDir) {
    const lines = masterText.split('\n');
    let best = { bw: -1, uri: null }, pendingBw = 0;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-STREAM-INF:')) {
        const m = t.match(/BANDWIDTH=(\d+)/i);
        pendingBw = m ? +m[1] : 0;
      } else if (t && !t.startsWith('#')) {
        if (pendingBw >= best.bw) best = { bw: pendingBw, uri: t };
        pendingBw = 0;
      }
    }
    if (!best.uri) throw new Error('No variant stream in master playlist');
    return this._resolve(best.uri, baseDir);
  }

  /** Parse segment entries from a variant playlist. */
  _parseSegs(text, fromUrl) {
    const dirUrl = fromUrl.substring(0, fromUrl.lastIndexOf('/') + 1);
    const lines  = text.split('\n');
    const out    = [];
    let extinf   = false;
    let curDur   = 0;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-TARGETDURATION:')) {
        const d = parseFloat(t.split(':')[1]);
        if (!isNaN(d)) this.targetDur = d;
      } else if (t.startsWith('#EXTINF:')) {
        extinf = true;
        const d = parseFloat(t.slice(8));
        curDur = isNaN(d) ? 0 : d;
      } else if (extinf && t && !t.startsWith('#')) {
        extinf = false;
        // Strip query string for dedup key (tokens may vary); use path only
        const stripped = t.split('?')[0];
        const name     = stripped.split('/').pop();
        const url      = this._resolve(stripped, dirUrl);
        out.push({ name, url, dur: curDur });
      } else if (t && !t.startsWith('#')) {
        extinf = false;
      }
    }
    return out;
  }

  _resolve(uri, baseDir) {
    if (uri.startsWith('http')) return uri;
    if (uri.startsWith('/'))    return PLEX_BASE_URL + uri;
    return baseDir + uri;
  }
}

// ── HDHomeRun source ───────────────────────────────────────
// Pulls the channel straight from the tuner box and has ffmpeg turn it into H.264/AAC
// segments written directly into the room's DVR directory. No Plex session involved, so
// nothing expires: if ffmpeg dies or the feed stalls it is simply restarted, and the
// restart is recorded as a discontinuity.
// Read on use (not at load) so the admin Settings page can change the tuner without a restart
const hdhrIp   = () => process.env.HDHR_IP || '';
const hdhrPort = () => process.env.HDHR_PORT || '5004';
const SEG_SECS  = 2;

/** True when an HDHomeRun is configured and the source hasn't been forced back to Plex. */
function hdhrEnabled() {
  return !!hdhrIp() && (process.env.LIVETV_SOURCE || 'hdhr').toLowerCase() !== 'plex';
}

// Intel / AMD iGPU (VAAPI) encode. Opt-in with LIVETV_HWACCEL=vaapi (aliases: intel, amd — VAAPI is
// vendor-neutral, libva picks the right driver); needs /dev/dri passed into the container (Linux
// hosts — see docker-compose.vaapi.yml). Deinterlacing stays on the CPU (cheap); the expensive
// part, the H.264 encode, moves to the GPU. If no render device is found, or ffmpeg keeps failing
// with it, we fall back to software x264.
const GPU_VENDORS = { '0x8086': 'Intel', '0x1002': 'AMD' };
let vaapiChoice;
// The render device is looked up once and cached; forget it when the admin changes the GPU settings
require('./settings').onChange(['hwaccel', 'vaapiDevice'], () => { vaapiChoice = undefined; });   // undefined = not looked up yet; null = none; else { device, vendor }

/** The render node to encode on: LIVETV_VAAPI_DEVICE if set, else the first Intel/AMD node in /dev/dri. */
function vaapiDevice() {
  if (vaapiChoice !== undefined) return vaapiChoice;
  vaapiChoice = null;
  const vendorOf = node => {
    try { return fs.readFileSync(`/sys/class/drm/${node}/device/vendor`, 'utf8').trim(); } catch { return ''; }
  };
  if (process.env.LIVETV_VAAPI_DEVICE) {
    const device = process.env.LIVETV_VAAPI_DEVICE;
    if (fs.existsSync(device)) vaapiChoice = { device, vendor: GPU_VENDORS[vendorOf(path.basename(device))] || 'GPU' };
  } else {
    let nodes = [];
    try { nodes = fs.readdirSync('/dev/dri').filter(n => /^renderD\d+$/.test(n)).sort(); } catch { /* no /dev/dri */ }
    // Prefer a node we know is Intel/AMD (skips e.g. an NVIDIA card that VAAPI can't use); if sysfs
    // isn't readable, take the first node and let ffmpeg find out.
    const known = nodes.find(n => GPU_VENDORS[vendorOf(n)]);
    const node = known || (nodes.length && !nodes.some(n => vendorOf(n)) ? nodes[0] : null);
    if (node) vaapiChoice = { device: `/dev/dri/${node}`, vendor: GPU_VENDORS[vendorOf(node)] || 'GPU' };
  }
  if (vaapiChoice) console.log(`[HDHR] VAAPI encode device ${vaapiChoice.device} (${vaapiChoice.vendor})`);
  return vaapiChoice;
}
function vaapiRequested() { return ['vaapi', 'intel', 'amd'].includes((process.env.LIVETV_HWACCEL || '').toLowerCase()); }
function vaapiAvailable() { return vaapiRequested() && !!vaapiDevice(); }

// Video filter chain: deinterlace, then (optionally) upscale low-resolution channels, then (for VAAPI) upload.
// LIVETV_UPSCALE=720|1080 raises any source shorter than that to that height (HD channels are left alone)
// with Lanczos scaling, followed by a light sharpen (LIVETV_SHARPEN, default 0.5, 0 = off).
// It can't add real detail, but it looks cleaner than the browser stretching a 480-line picture.
function videoFilter(hw) {
  const chain = ['yadif=mode=0:parity=-1:deint=1'];
  const target = parseInt(process.env.LIVETV_UPSCALE, 10);
  if (target >= 480 && target <= 2160) {
    chain.push(`scale=-2:'max(ih,${target})':flags=lanczos`);
    const sharpen = process.env.LIVETV_SHARPEN === undefined ? 0.5 : parseFloat(process.env.LIVETV_SHARPEN);
    if (sharpen > 0) chain.push(`unsharp=5:5:${Math.min(sharpen, 2).toFixed(2)}:5:5:0`);
  }
  if (hw) chain.push('format=nv12', 'hwupload');
  return chain.join(',');
}

// Overridable for other hardware encoders, e.g. LIVETV_VIDEO_ARGS="-c:v h264_nvenc -preset p4 -b:v 6M".
// Only allow-listed encoder options get through (ffmpeg-args.js); anything else falls back to the default encoder.
let warnedArgs = null;
function customVideoArgs() {
  const raw = process.env.LIVETV_VIDEO_ARGS;
  if (!raw || !raw.trim()) return null;
  try { return parseVideoArgs(raw); }
  catch (err) {
    if (warnedArgs !== raw) { warnedArgs = raw; console.warn(`[HDHR] Ignoring LIVETV_VIDEO_ARGS: ${err.message}`); }
    return null;
  }
}

function videoArgs(hw) {
  const custom = customVideoArgs();
  if (custom) return custom;
  if (hw) {
    return [
      '-c:v', 'h264_vaapi', '-profile:v', 'high', '-b:v', process.env.LIVETV_VAAPI_BITRATE || '6M',
      '-maxrate', process.env.LIVETV_MAX_BITRATE || '8M', '-bufsize', '16M',
    ];
  }
  return [
    '-c:v', 'libx264', '-preset', process.env.LIVETV_X264_PRESET || 'veryfast', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-crf', '23', '-maxrate', process.env.LIVETV_MAX_BITRATE || '8M', '-bufsize', '16M',
  ];
}

class HdhrSource {
  constructor(roomId, { channel, dvr }) {
    this.roomId  = roomId;
    this.channel = channel;
    this.dvr     = dvr;
    this.running = false;
    this.proc    = null;
    this.timer   = null;      // restart timer
    this.watchdog = null;
    this.failures = 0;        // consecutive runs that died without producing a segment
    this.spawnedAt = 0;
    this.lastSegAt = 0;
    this.nextDisc  = false;
    this.stderrLines = 0;
    this.useHw = vaapiAvailable();   // flips to false if the GPU path keeps failing
    if (vaapiRequested() && !this.useHw) console.warn('[HDHR] LIVETV_HWACCEL is set but no Intel/AMD render device found in /dev/dri — using software x264');
  }

  start() {
    this.running = true;
    this._spawn();
    this.watchdog = setInterval(() => {
      // ffmpeg alive but no segment for a while → the feed hung; kill it and let the exit handler restart it
      const quietSince = Math.max(this.lastSegAt, this.spawnedAt);
      if (this.proc && Date.now() - quietSince > 15000) {
        console.warn(`[HDHR] ${this.roomId}: no segment for 15s — restarting ffmpeg`);
        this.proc.kill('SIGKILL');
      }
    }, 5000);
  }

  _spawn() {
    if (!this.running) return;
    const url = `http://${hdhrIp()}:${hdhrPort()}/auto/v${this.channel}`;
    // A restart after earlier segments marks a discontinuity (timestamps start over).
    this.nextDisc = this.dvr.entries.length > 0;
    const hw = this.useHw && !customVideoArgs();
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      ...(hw ? ['-vaapi_device', vaapiDevice().device] : []),
      '-fflags', '+genpts+discardcorrupt', '-analyzeduration', '2000000', '-probesize', '5000000',
      '-i', url,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', videoFilter(hw),
      ...videoArgs(hw),
      '-force_key_frames', `expr:gte(t,n_forced*${SEG_SECS})`, '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
      '-f', 'segment', '-segment_time', String(SEG_SECS), '-segment_format', 'mpegts',
      '-segment_start_number', String(this.dvr.nextIdx),
      '-segment_list', 'pipe:1', '-segment_list_type', 'csv',
      path.join(this.dvr.dir, 's%d.ts'),
    ];
    console.log(`[HDHR] ${this.roomId}: ffmpeg start ch ${this.channel} enc=${hw ? 'vaapi' : (customVideoArgs() ? 'custom' : 'x264')} (seg #${this.dvr.nextIdx}${this.nextDisc ? ', after restart' : ''})`);
    this.spawnedAt = Date.now();
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let produced = 0;
    this.proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const [file, start, end] = line.split(',');
        const dur = parseFloat(end) - parseFloat(start);
        if (!file || !(dur > 0.2)) continue;
        this.dvr.adopt(file, dur, this.nextDisc);
        this.nextDisc = false;
        this.lastSegAt = Date.now();
        produced++;
        this.failures = 0;
      }
    });
    this.proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim().split('\n');
      for (const l of text) {
        if (this.stderrLines++ < 12) console.warn(`[HDHR] ${this.roomId}: ffmpeg: ${l.slice(0, 200)}`);
      }
    });
    this.proc.on('error', err => console.error(`[HDHR] ${this.roomId}: could not run ffmpeg — ${err.message}`));
    this.proc.on('exit', (code, sig) => {
      this.proc = null;
      if (!this.running) return;
      if (!produced) this.failures++;
      if (this.useHw && this.failures >= 2) {
        console.warn(`[HDHR] ${this.roomId}: VAAPI encode failed ${this.failures}x with no output — falling back to software x264`);
        this.useHw = false;
      }
      const delay = Math.min(1000 * 2 ** Math.min(this.failures, 4), 15000);
      console.warn(`[HDHR] ${this.roomId}: ffmpeg exited (${sig || code}) after ${produced} segments — restarting in ${delay}ms`);
      this.timer = setTimeout(() => this._spawn(), delay);
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    if (this.proc) { this.proc.kill('SIGKILL'); this.proc = null; }
    console.log(`[HDHR] ${this.roomId}: stopped`);
  }
}

// ── Registry ───────────────────────────────────────────────
const relays = new Map(); // roomId → active LiveRelay
const dvrs   = new Map(); // roomId → LiveDvr

// Anything on disk from a previous run belongs to rooms that no longer exist.
try { fs.rmSync(DVR_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }

/**
 * Start (or restart) the relay for a room.
 *
 * opts.fresh — true for a channel change: the old DVR is discarded and a new one
 * started. Otherwise (retune) the new relay warms up beside the live one, then
 * takes over recording into the same DVR with a discontinuity.
 */
async function startRelay(roomId, opts) {
  const { fresh, ...relayOpts } = opts;
  let existing = relays.get(roomId);
  let dvr = dvrs.get(roomId);

  // A channel change records into a brand-new DVR. The old relay keeps running until
  // the new one is connected — stopping it first makes Plex reject the new session.
  const replacing = fresh || !dvr;
  const oldDvr = dvr;
  const target = replacing ? new LiveDvr(roomId) : dvr;
  const readySegs = relayOpts.readySegs || READY_SEGS;
  delete relayOpts.readySegs;
  const relay = new LiveRelay(roomId, { ...relayOpts, dvr: target, committing: replacing || !existing, readySegs });
  try {
    await relay.start();
  } catch (err) {
    if (replacing) target.destroy();
    relay.stop();
    throw err;
  }

  // Wait until the new relay has enough segments to serve without gaps.
  const ready = await new Promise(resolve => {
    const t = setInterval(() => {
      if (relay.isReady()) { clearInterval(t); resolve(true); }
    }, 200);
    setTimeout(() => { clearInterval(t); resolve(false); }, 6000 + readySegs * 1500);
  });
  if (!ready) {
    // Never swap in a relay that isn't delivering — keep whatever was running.
    console.warn(`[Relay] ${roomId}: new relay not ready (${relay.fetched}/${readySegs} segments) — abandoning`);
    relay.stop();
    if (replacing) target.destroy();
    throw new Error('New relay did not start producing segments');
  }

  if (replacing) {
    dvrs.set(roomId, target);
    relays.set(roomId, relay);
    if (existing) existing.stop();
    if (oldDvr) oldDvr.destroy();
  } else if (existing) {
    relay.promote(target.lastArrivalMs);
    relays.set(roomId, relay);
    existing.stop();
  } else {
    relay.promote(0);
    relays.set(roomId, relay);
  }
  return relay;
}


/**
 * Start recording a channel straight from the HDHomeRun into a fresh DVR (replaces any
 * previous relay/DVR for the room). Resolves once `readySec` seconds are recorded.
 */
// A tune that is still waiting for its first seconds of video. Registered so that closing or resetting the
// room in that window (stopRelay) cancels it, instead of leaving ffmpeg holding a tuner for a room nobody is in.
const pendingTunes = new Map();   // roomId -> { src, dvr, cancelled }

async function startHdhr(roomId, { channel, readySec, onProgress }) {
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(String(channel))) throw new Error('Invalid channel number');
  const oldRelay = relays.get(roomId);
  const oldDvr   = dvrs.get(roomId);

  const dvr = new LiveDvr(roomId);
  const src = new HdhrSource(roomId, { channel: String(channel), dvr });
  const pending = { src, dvr, cancelled: false };
  pendingTunes.set(roomId, pending);
  src.start();

  let lastTick = -1;
  const ready = await new Promise(resolve => {
    const t = setInterval(() => {
      if (pending.cancelled) { clearInterval(t); resolve(false); return; }
      const tick = Math.floor(Math.min(dvr.total, readySec) * 2); // report in half-second steps
      if (tick !== lastTick) { lastTick = tick; onProgress && onProgress(Math.min(dvr.total, readySec), readySec); }
      if (dvr.total >= readySec) { clearInterval(t); resolve(true); }
    }, 200);
    setTimeout(() => { clearInterval(t); resolve(false); }, 25000);
  });
  if (pendingTunes.get(roomId) === pending) pendingTunes.delete(roomId);
  if (pending.cancelled) {   // stopRelay already stopped ffmpeg and removed the recording
    const err = new Error('Tune cancelled');
    err.cancelled = true;
    throw err;
  }
  if (!ready) {
    src.stop();
    dvr.destroy();
    throw new Error('HDHomeRun produced no video (tuner busy or channel unavailable?)');
  }

  dvrs.set(roomId, dvr);
  relays.set(roomId, src);
  if (oldRelay) oldRelay.stop();
  if (oldDvr) oldDvr.destroy();
  return src;
}

/** Stop the relay and delete the DVR for a room. */
function stopRelay(roomId) {
  const pend = pendingTunes.get(roomId);
  if (pend) { pend.cancelled = true; pend.src.stop(); pend.dvr.destroy(); pendingTunes.delete(roomId); }
  const relay = relays.get(roomId);
  if (relay) { relay.stop(); relays.delete(roomId); }
  const dvr = dvrs.get(roomId);
  if (dvr) { dvr.destroy(); dvrs.delete(roomId); }
}

/** Get the active relay for a room, or null. */
function getRelay(roomId) {
  return relays.get(roomId) || null;
}

/** Get the DVR for a room, or null. */
function getDvr(roomId) {
  return dvrs.get(roomId) || null;
}

module.exports = { startRelay, startHdhr, hdhrEnabled, stopRelay, getRelay, getDvr };
