const { randomUUID: uuidv4 } = require('crypto');
const axios = require('axios');
const { clearRoomManifest, prewarmManifest } = require('./routes/stream');
const { startRelay, startHdhr, hdhrEnabled, stopRelay, getRelay, getDvr } = require('./live-relay');
const plex = require('./plex');
const { sanitizeText } = require('./sanitize');
const notifier = require('./notifier');
const voting = require('./voting');
const alwaysOn = require('./always-on');
const settings = require('./settings');

const rooms        = new Map(); // roomId -> Room
const inviteTokens = new Map(); // inviteToken -> roomId
const socketToRoom = new Map(); // socketId -> Room

let _io = null; // set in setupSync, used by createScheduledRoom
let _enabledRoomTypes = { movie: true, tv: true, youtube: true, livetv: false };

async function fetchYoutubeTitle(videoId) {
  try {
    const res = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: 5000
    });
    return res.data?.title || null;
  } catch {
    return null;
  }
}

function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split(/[?#]/)[0] || null;
    if (u.hostname === 'youtube.com' || u.hostname === 'www.youtube.com') {
      return u.searchParams.get('v') || null;
    }
  } catch {}
  return null;
}

class Room {
  constructor({ hostId, hostName, hostPicture, name }) {
    this.id             = uuidv4();
    this.inviteToken    = uuidv4();
    this.name           = (name || `${hostName}'s Room`).slice(0, 60);
    this.hostId         = hostId;
    this.hostName       = hostName;
    this.hostPicture    = hostPicture || null;
    this.hostIsGuest    = false;
    this.hostSocketId   = null;
    this.awaitingHost   = false;
    this.countdownTimer     = null;
    this.intermissionTimer  = null;
    this.intermissionEndsAt = null;
    this.settings       = { playbackLocked: false, reactionsEnabled: true };
    this.roomType       = 'movie'; // 'movie' | 'youtube' | 'tv' | 'livetv'
    this.liveTvChannel      = null;  // e.g. '7.1'
    this.liveTvChannelTitle = null;  // e.g. 'KIRO/CBS'
    this.liveTvChannelId    = null;  // DVR channel ID for re-tuning
    this.liveTvSubKey       = null;  // Plex MediaSubscription key for current tune
    this.retuning           = false; // guard against concurrent retunes
    this.movieKey       = null;
    this.movieTitle     = null;
    this.partId         = null;
    this.youtubeVideoId = null;
    this.tvShowKey      = null;
    this.tvShowTitle    = null;
    this.tvEpisodeList  = []; // [{ ratingKey, title, index, parentIndex }]
    this.tvEpisodeIndex = 0;
    this.playing        = false;
    this.position       = 0;
    this.lastUpdate     = Date.now();
    this.viewers        = new Map(); // socketId -> viewer info
  }

  currentPosition() {
    if (!this.playing) return this.position;
    return this.position + (Date.now() - this.lastUpdate) / 1000;
  }

  state() {
    return {
      id: this.id, name: this.name,
      hostId: this.hostId, hostName: this.hostName,
      roomType: this.roomType,
      movieKey: this.movieKey, movieTitle: this.movieTitle, partId: this.partId,
      youtubeVideoId: this.youtubeVideoId,
      tvShowTitle: this.tvShowTitle || null,
      hasNextEpisode: this.roomType === 'tv' && this.tvEpisodeIndex < this.tvEpisodeList.length - 1,
      liveTvChannel:      this.liveTvChannel,
      liveTvChannelTitle: this.liveTvChannelTitle,
      liveTuning: this.roomType === 'livetv' ? (this.liveTuning || null) : null,
      liveTvProgram: this.roomType === 'livetv' ? (this.liveTvProgram || null) : null,
      liveDvr: this.roomType === 'livetv' ? (getDvr(this.id)?.info() || null) : null,
      liveBufferSec: this.roomType === 'livetv' ? (this.liveTvSource === 'hdhr' ? HDHR_START_BEHIND_SEC : LIVE_START_BEHIND_SEC) : null,
      pauseCooldownSec: this.roomType === 'livetv' ? pauseCooldownMs() / 1000 : 0,
      playing: this.playing,
      position: this.currentPosition(),
      lastUpdate: Date.now(),
      settings: this.settings,
      intermissionEndsAt: this.intermissionEndsAt || null
    };
  }

  summary(admin = false) {
    return {
      id: this.id, name: this.name,
      hostName: this.persistentId && this.awaitingHost ? 'always on' : this.hostName,
      alwaysOn: !!this.persistentId,
      roomType: this.roomType,
      movieTitle: this.movieTitle,
      viewerCount: this.viewers.size,
      hasMovie: !!this.movieKey,
      youtubeVideoId: this.youtubeVideoId,
      liveTvChannel: this.liveTvChannel || this.pendingChannel?.channel || null,
      // Who is in the room — only sent to the server owner's sockets, who can kick from the lobby
      ...(admin ? {
        viewers: Array.from(this.viewers.values()).map(v => ({
          socketId: v.socketId, name: v.name, isGuest: !!v.isGuest, isHost: !!v.isHost, isAdmin: !!v.isAdmin
        }))
      } : {})
    };
  }

  broadcast(io, event, data) {
    this.viewers.forEach((_, sid) => io.to(sid).emit(event, data));
  }

  broadcastViewers(io) {
    const now        = Date.now();
    const currentPos = this.playing ? this.currentPosition() : null;
    const viewers = Array.from(this.viewers.values()).map(v => {
      let drift = null;
      if (currentPos !== null && v.reportedTime != null && v.reportedAt != null) {
        const estimated = v.reportedTime + (now - v.reportedAt) / 1000;
        drift = Math.round((estimated - currentPos) * 10) / 10;
      }
      return { ...v, drift, buffering: v.buffering || false };
    });
    this.broadcast(io, 'viewers', viewers);
  }

  broadcastState(io) {
    this.broadcast(io, 'state', this.state());
  }
}

// Resolve an invite token to a room (used by auth route)
function getRoomByInviteToken(token) {
  const roomId = inviteTokens.get(token);
  return roomId ? rooms.get(roomId) : null;
}

const roomListFor = (admin) => Array.from(rooms.values()).map(r => r.summary(admin));

// The server owner's sockets sit in the 'admins' socket.io room and get the detailed list.
function broadcastRoomList(io) {
  io.except('admins').emit('room-list', roomListFor(false));
  io.to('admins').emit('room-list', roomListFor(true));
}

/** Close a room immediately and send everyone in it back to the lobby. */
function closeRoom(io, room, reason) {
  if (room.persistentId) {
    // An always-on room never goes away: everyone is sent out and the room goes back to waiting
    room.broadcast(io, 'room-closed', { reason });
    room.viewers.forEach((_, sid) => socketToRoom.delete(sid));
    room.viewers.clear();
    resetPersistentRoom(io, room);
    return;
  }
  if (room.countdownTimer)    clearTimeout(room.countdownTimer);
  if (room.intermissionTimer) clearTimeout(room.intermissionTimer);
  if (room.closeTimer)        clearTimeout(room.closeTimer);
  if (room.resyncTimer)       clearTimeout(room.resyncTimer);
  room.broadcast(io, 'room-closed', { reason });
  room.viewers.forEach((_, sid) => socketToRoom.delete(sid));
  stopRelay(room.id);
  inviteTokens.delete(room.inviteToken);
  rooms.delete(room.id);
  broadcastRoomList(io);
}

// ── Always-on rooms (owner-only; see always-on.js) ──────────────────────────────

/**
 * Put an always-on room back to its waiting state once it's empty: no host (the next Plex user to
 * arrive becomes host), settings and votes cleared, and — for Live TV — the recording stopped so the
 * tuner and encoder are free. The pinned channel is re-tuned when someone arrives ("tune on first join").
 */
function resetPersistentRoom(io, room) {
  for (const k of ['countdownTimer', 'intermissionTimer', 'closeTimer', 'resyncTimer']) {
    if (room[k]) clearTimeout(room[k]);
    room[k] = null;
  }
  room.intermissionEndsAt = null;
  room.vote = null;
  room.bannedIds = null;
  room._tuneGen = (room._tuneGen || 0) + 1;   // any tune still in flight belongs to the previous occupants
  room.lastPauseAt = 0;
  room.settings = { playbackLocked: false, reactionsEnabled: true };
  room.hostId = null; room.hostName = 'always on'; room.hostPicture = null;
  room.hostIsGuest = false; room.hostSocketId = null; room.awaitingHost = true;
  room.playing = false; room.position = 0; room.lastUpdate = Date.now();

  if (room.roomType === 'livetv') {
    stopRelay(room.id);
    clearRoomManifest(room.id);
    room.liveTvChannel = room.liveTvChannelTitle = room.liveTvChannelId = room.liveTvSubKey = room.liveTvSource = null;
    room.liveTuning = null; room.liveTvProgram = null; room._tuningInProgress = false; room.retuning = false;
    room.movieKey = null;
    const ch = room.persistentChannel;
    room.pendingChannel = ch ? { ...ch } : null;
  }
  console.log(`[AlwaysOn] "${room.name}" is empty — waiting for someone to arrive`);
  broadcastRoomList(io);
}

/** Create (or find) the live room for an always-on definition. */
function createPersistentRoom(def) {
  for (const r of rooms.values()) if (r.persistentId === def.id) return r;
  const room = new Room({ hostId: null, hostName: 'always on', hostPicture: null, name: def.name });
  room.inviteToken       = def.inviteToken;
  room.roomType          = def.roomType;
  room.awaitingHost      = true;
  room.persistentId      = def.id;
  room.persistentChannel = def.channel || null;
  room.pendingChannel    = def.channel ? { ...def.channel } : null;
  rooms.set(room.id, room);
  inviteTokens.set(room.inviteToken, room.id);
  if (_io) broadcastRoomList(_io);
  console.log(`[AlwaysOn] "${room.name}" (${room.roomType}) is open`);
  return room;
}

/** Recreate every saved always-on room (called once at startup, after setupSync). */
function restorePersistentRooms() {
  for (const def of alwaysOn.list()) {
    if (!_enabledRoomTypes[def.roomType]) {
      console.warn(`[AlwaysOn] "${def.name}" not opened — ${def.roomType} rooms are turned off`);
      continue;
    }
    createPersistentRoom(def);
  }
}

/** The live room for a definition id, or null. */
function getPersistentRoom(defId) {
  for (const r of rooms.values()) if (r.persistentId === defId) return r;
  return null;
}

/** Stop keeping a room open: it closes for real. */
function removePersistentRoom(defId) {
  const room = getPersistentRoom(defId);
  if (!room || !_io) return false;
  room.persistentId = null;
  closeRoom(_io, room, 'This always-on room was removed');
  return true;
}

/** Point a room at a movie (host pick, or the winner of a vote). */
// A playback position from a client: a finite, non-negative number of seconds, else null
const validPosition = p => (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p < 7 * 86400 ? p : null);

function applyMovie(io, room, movieKey, movieTitle, partId) {
  clearRoomManifest(room.id); // Evict cached manifest so next request starts fresh
  room.movieKey = movieKey; room.movieTitle = movieTitle; room.partId = partId;
  room.playing = false; room.position = 0; room.lastUpdate = Date.now();
  console.log(`[Room] "${room.name}" → "${movieTitle}"`);
  room.broadcastState(io);
  broadcastRoomList(io);
}

// ── Movie vote helpers ──
const viewerUserIds = room => [...new Set(Array.from(room.viewers.values()).map(v => v.id))];

function broadcastVoteProgress(io, room) {
  if (room.vote?.status !== 'voting') return;
  room.broadcast(io, 'vote-progress', voting.progress(room.vote, viewerUserIds(room)));
}

/** Once everyone still in the room has swiped the whole deck, reveal the result. */
function maybeFinalizeVote(io, room) {
  const vote = room.vote;
  if (!vote || vote.status !== 'voting') return;
  const { done, total } = voting.progress(vote, viewerUserIds(room));
  if (total > 0 && done === total) {
    room.broadcast(io, 'vote-result', { id: vote.id, ...voting.finalize(vote) });
  } else {
    broadcastVoteProgress(io, room);
  }
}

/** Remove one viewer from their room. `ban` also stops that account rejoining this room. */
function removeViewer(io, room, targetSocketId, byUser, { ban = false } = {}) {
  const target = room.viewers.get(targetSocketId);
  if (!target) return false;
  io.to(targetSocketId).emit('kicked', { byAdmin: !!byUser.isAdmin });
  room.viewers.delete(targetSocketId);
  socketToRoom.delete(targetSocketId);
  maybeFinalizeVote(io, room);
  if (ban && target.id) (room.bannedIds || (room.bannedIds = new Set())).add(target.id);
  room.broadcastViewers(io);
  broadcastRoomList(io);
  console.log(`[Room] ${byUser.name}${byUser.isAdmin ? ' (admin)' : ''} kicked "${target.name}" from "${room.name}"${ban ? ' (blocked from rejoining)' : ''}`);
  return true;
}


// Per-socket rate limiter — sliding window
function makeSocketRateLimiter(maxCalls, windowMs) {
  const history = new Map(); // socketId -> timestamp[]
  return {
    allow(socketId) {
      const now = Date.now();
      const times = (history.get(socketId) || []).filter(t => now - t < windowMs);
      if (times.length >= maxCalls) return false;
      times.push(now);
      history.set(socketId, times);
      return true;
    },
    delete(socketId) { history.delete(socketId); }
  };
}

const chatLimiter          = makeSocketRateLimiter(3, 2000);  // 3 msgs / 2s
// How far behind the newest recorded segment a freshly tuned room starts. That head start is
// the buffer that hides the pause while a retune (every ~3:20) swaps in a new Plex session.
const LIVE_START_BEHIND_SEC = 8;
// With the HDHomeRun source, how far behind the newest recorded video a room plays. That distance
// IS the playback buffer (the player can only buffer what the DVR already holds), so a larger value
// rides out encoder / network hiccups at the cost of more delay from the broadcast and a longer
// start-up wait (the DVR has to record this much first). Tunable with LIVETV_BUFFER_SEC.
const bufferFromEnv = () => Math.max(4, Math.min(60, parseInt(process.env.LIVETV_BUFFER_SEC, 10) || 10));
let HDHR_START_BEHIND_SEC = bufferFromEnv();
settings.onChange('bufferSec', () => { HDHR_START_BEHIND_SEC = bufferFromEnv(); });

// How many Live TV rooms may be streaming at once. Each one holds a tuner and an encoder, so this is the
// server's Live TV capacity. LIVETV_MAX_ROOMS (a whole number, 1 or more); default 2.
const maxRoomsFromEnv = () => {
  const raw = process.env.LIVETV_MAX_ROOMS;
  const n = parseInt(raw, 10);
  if (raw !== undefined && raw !== '' && !(Number.isInteger(n) && n >= 1)) {
    console.warn(`[LiveTV] LIVETV_MAX_ROOMS="${raw}" is not a whole number of 1 or more — using 2`);
    return 2;
  }
  return Number.isInteger(n) && n >= 1 ? n : 2;
};
let LIVETV_MAX_ROOMS = maxRoomsFromEnv();
console.log(`[LiveTV] Live TV capacity: ${LIVETV_MAX_ROOMS} room${LIVETV_MAX_ROOMS === 1 ? '' : 's'} at a time`);
settings.onChange('maxLiveTvRooms', () => {
  LIVETV_MAX_ROOMS = maxRoomsFromEnv();
  console.log(`[LiveTV] Live TV capacity changed: ${LIVETV_MAX_ROOMS} room${LIVETV_MAX_ROOMS === 1 ? '' : 's'} at a time`);
});

/**
 * Live TV rooms currently *streaming* — recording or mid-tune. Those are the ones using a tuner and CPU.
 * A Live TV room that is merely open (an empty always-on room, or one with no channel picked yet) is free,
 * so it doesn't count. `except` leaves one room out, so a channel change in a room that's already
 * streaming isn't treated as taking a second slot.
 */
// Force resync (host): pause everyone at the host's position, then resume them together after a short countdown.
const RESYNC_SECONDS = 2;
const RESYNC_COOLDOWN_MS = 10_000;   // so it can't be spammed (each one pauses the room)

// Live TV: how long must pass between pauses (rapid play/pause thrashes the recording and breaks the stream).
// LIVETV_PAUSE_COOLDOWN_SEC, default 10, 0 = off. Read on use so the admin Settings page applies it immediately.
const pauseCooldownMs = () => {
  const n = parseInt(process.env.LIVETV_PAUSE_COOLDOWN_SEC, 10);
  return (Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : 10) * 1000;
};

function liveTvInUse(except = null) {
  let n = 0;
  for (const r of rooms.values()) {
    if (r.roomType !== 'livetv' || r === except) continue;
    if (r._tuningInProgress || getDvr(r.id) || getRelay(r.id)) n++;
  }
  return n;
}
const liveTvCapacity = () => ({ max: LIVETV_MAX_ROOMS, inUse: liveTvInUse() });
const liveTvFullMessage = (inUse) =>
  `Live TV is full right now (${inUse} of ${LIVETV_MAX_ROOMS} room${LIVETV_MAX_ROOMS === 1 ? '' : 's'} in use). Try again when one ends.`;
const SEGMENT_SECS = 2;
const reactionLimiter      = makeSocketRateLimiter(5, 2000);  // 5 reactions / 2s
const seekLimiter          = makeSocketRateLimiter(15, 2000); // 15 seeks / 2s (scrubbing)
const playPauseLimiter     = makeSocketRateLimiter(10, 2000); // 10 play/pause / 2s
const positionLimiter      = makeSocketRateLimiter(5, 1000);  // 5 position reports / 1s
const bufferingLimiter     = makeSocketRateLimiter(10, 2000); // 10 buffering events / 2s

/**
 * Load a Plex item into a brand-new room (the lobby's "recently added" cards). The browser only says
 * which item; the title, part and episode list are all looked up server-side.
 * kind 'movie' → a movie ratingKey; kind 'tv' → an episode ratingKey.
 */
async function preloadRoom(room, { kind, ratingKey } = {}) {
  if (!/^\d+$/.test(String(ratingKey))) throw new Error('bad ratingKey');
  const item = await plex.getMovieDetails(String(ratingKey));
  const partId = item?.Media?.[0]?.Part?.[0]?.id;
  if (!item || partId == null) throw new Error('item has no playable media');

  if (kind === 'movie') {
    if (item.type !== 'movie') throw new Error('not a movie');
    room.movieKey = String(item.ratingKey); room.movieTitle = item.title; room.partId = String(partId);
    return item.title;
  }
  if (kind === 'tv') {
    if (item.type !== 'episode') throw new Error('not an episode');
    const episodes = await plex.getShowChildren(String(item.parentRatingKey));
    const list = episodes.map(e => ({ ratingKey: String(e.ratingKey), title: e.title, index: e.index, parentIndex: e.parentIndex }));
    const idx = list.findIndex(e => e.ratingKey === String(item.ratingKey));
    room.tvShowKey      = String(item.grandparentRatingKey);
    room.tvShowTitle    = item.grandparentTitle;
    room.tvEpisodeList  = list;
    room.tvEpisodeIndex = idx >= 0 ? idx : 0;
    room.movieKey       = String(item.ratingKey);
    room.movieTitle     = formatEpisodeTitle(item.grandparentTitle, list[room.tvEpisodeIndex] || item);
    room.partId         = String(partId);
    return item.grandparentTitle;
  }
  throw new Error('unknown kind');
}

/**
 * Lobby "on now" card → a Live TV room. The channel is looked up in the guide server-side (the browser
 * can't make us tune an arbitrary id) and tuned once the host's watch page connects, because the
 * tuning overlay needs a viewer on the other end. No channel = an empty Live TV room (pick one inside).
 */
async function preloadLiveTv(room, { channel } = {}) {
  if (channel == null || channel === '') return 'Live TV';
  const { channels } = await require('./livetv-manager').getGuide();
  const ch = channels.find(c => c.number === String(channel));
  if (!ch) throw new Error('unknown channel');
  room.pendingChannel = { channel: ch.number, channelTitle: ch.title, channelId: ch.channelId };
  return `${ch.number} ${ch.title}`.trim();
}

/**
 * Tune a Live TV room to a channel: start the recording (HDHomeRun or Plex), then point the room at it.
 * Shared by the host's channel picker and the lobby's "on now" cards (which tune once the host arrives).
 * Returns an error string for the caller to show, or nothing on success. Failures after the tune starts
 * are also broadcast to the room as 'livetv-tune-failed'.
 */
async function tuneRoomChannel(io, room, { channel, channelTitle, channelId }) {
  // Validate channelId is not empty (Plex may return numeric or string IDs)
  if (!channelId || !String(channelId).trim()) return 'Invalid channelId';

  // Prevent concurrent tune requests (rate limit on channel switching)
  if (room._tuningInProgress) return 'Channel change in progress';

  // Capacity: this room taking a slot must not push the server past LIVETV_MAX_ROOMS. (No await between this
  // check and setting _tuningInProgress, so two rooms can't both squeeze in.)
  const others = liveTvInUse(room);
  if (others >= LIVETV_MAX_ROOMS) {
    const message = liveTvFullMessage(others);
    room.broadcast(io, 'livetv-tune-failed', { message });
    return message;
  }
  room._tuningInProgress = true;
  room.lastPauseAt = 0;
  const gen = room._tuneGen || 0;
  // True once the room was closed, or reset (always-on) while we were still tuning
  const stale = () => rooms.get(room.id) !== room || (room._tuneGen || 0) !== gen;

  // Tell everyone a channel is being tuned so their players can show progress while the DVR
  // records its first seconds. recorded/needed are DVR seconds (needed is null = unknown).
  const tuneNeeded = hdhrEnabled() ? HDHR_START_BEHIND_SEC + SEGMENT_SECS : null;
  const setTuning = (recorded) => {
    room.liveTuning = {
      channel: String(channel || '').slice(0, 20),
      title: sanitizeText((channelTitle || channel || '').slice(0, 60)),
      recorded, needed: tuneNeeded,
    };
    room.broadcast(io, 'livetv-tuning', room.liveTuning);
  };
  setTuning(0);

  clearRoomManifest(room.id);
  try {
    if (hdhrEnabled()) {
      // Straight from the HDHomeRun via ffmpeg — Plex is only used for the guide.
      await startHdhr(room.id, { channel, readySec: tuneNeeded, onProgress: (rec) => { if (!stale()) setTuning(rec); } });
      if (stale()) { stopRelay(room.id); return; }
      room.liveTvChannel      = String(channel || '').slice(0, 20);
      room.liveTvChannelTitle = sanitizeText((channelTitle || channel || '').slice(0, 60));
      room.liveTvChannelId    = channelId;
      room.liveTvSubKey       = null;
      room.liveTvSource       = 'hdhr';
      room.movieKey           = `hdhr-${room.liveTvChannel}`;
      const d = getDvr(room.id)?.info() || { start: 0, edge: 0 };
      room.position   = Math.max(d.start, d.edge - HDHR_START_BEHIND_SEC);
      room.playing    = true;
      room.lastUpdate = Date.now();
      room.liveTvProgram = null;
      room.broadcastState(io);
      refreshLiveTvProgram(room, io);
      console.log(`[Room] "${room.name}" → Live TV channel ${room.liveTvChannel} via HDHomeRun`);
      return;
    }
    room.liveTvSource = 'plex';
    const liveTvManager = require('./livetv-manager');
    const { ratingKey, subKey, sessionKey } = await liveTvManager.tuneChannel(channelId);
    if (stale()) return;
    room.liveTvChannel      = String(channel || '').slice(0, 20);
    room.liveTvChannelTitle = sanitizeText((channelTitle || channel || '').slice(0, 60));
    room.liveTvChannelId    = channelId;
    room.liveTvSubKey       = subKey;
    room.movieKey           = String(ratingKey);

    // Start server-side relay — records Plex segments into a fresh per-room DVR
    // (a channel change discards the previous one). Clients connect to
    // /api/stream/live/:roomId/index.m3u8.
    await startRelay(room.id, { ratingKey: String(ratingKey), liveSessionKey: sessionKey || null, onStall: () => doRetune(room, io), fresh: true, readySegs: LIVE_START_BEHIND_SEC + 2 });
    if (stale()) { stopRelay(room.id); return; }

    // Start a couple of segments behind the newest so playback has buffer ahead of it.
    const dvr = getDvr(room.id)?.info() || { start: 0, edge: 0 };
    room.position   = Math.max(dvr.start, dvr.edge - LIVE_START_BEHIND_SEC);
    room.playing    = true;
    room.lastUpdate = Date.now();

    room.liveTvProgram = null;
    room.broadcastState(io);
    refreshLiveTvProgram(room, io);
    console.log(`[Room] "${room.name}" → Live TV channel ${room.liveTvChannel} (ratingKey=${ratingKey}, sub ${subKey})`);
  } catch (err) {
    if (err.cancelled || stale()) return;   // the room went away mid-tune: nothing to report
    console.error(`[Room] Failed to tune channel ${channel}:`, err.message);
    room.broadcast(io, 'livetv-tune-failed', { message: err.message });
    return `Failed to tune channel: ${err.message}`;
  } finally {
    // Only the current occupants' tune may clear these (a reset starts a new generation)
    if ((room._tuneGen || 0) === gen) {
      room._tuningInProgress = false;
      room.liveTuning = null;
    }
  }
}

function formatEpisodeTitle(showTitle, ep) {
  if (!ep) return showTitle || 'Unknown';
  const s = ep.parentIndex != null ? `S${String(ep.parentIndex).padStart(2, '0')}` : '';
  const e = ep.index != null ? `E${String(ep.index).padStart(2, '0')}` : '';
  const se = (s || e) ? `${s}${e} · ` : '';
  return `${showTitle ? showTitle + ' · ' : ''}${se}${ep.title || ''}`;
}

// ── Live TV "now playing" — program title for the room's channel, from the Plex guide ──
async function refreshLiveTvProgram(room, io) {
  if (room.roomType !== 'livetv' || !room.liveTvChannel) return;
  try {
    const { channels } = await require('./livetv-manager').getGuide();
    const program = channels.find(c => c.number === room.liveTvChannel)?.nowPlaying || null;
    if (program !== (room.liveTvProgram || null)) {
      room.liveTvProgram = program;
      room.broadcast(io, 'livetv-program', { program });
    }
  } catch { /* guide unavailable — keep whatever we had */ }
}

// ── Live TV retune — restarts the server-side relay with a fresh Plex session ──
async function doRetune(room, io) {
  if (!room.liveTvChannelId || room.liveTvSource === 'hdhr') return; // HDHomeRun source restarts itself
  if (room.retuning) return; // prevent concurrent retunes (e.g. proactive + stall firing together)
  room.retuning = true;
  const liveTvManager = require('./livetv-manager');
  try {
    const oldSubKey = room.liveTvSubKey;
    clearRoomManifest(room.id);

    // Plex dedupes a second tune on the same channel to the SAME recording item (same
    // ratingKey) even with a new client id, and that item stops serving after ~4 minutes —
    // new sessions on it 400/404. So the old subscription has to be stopped first to get a
    // fresh item (same order as the proven bust path in routes/stream.js). The DVR already
    // holds the video the clients are playing, so the gap while the new item spins up is
    // covered by their buffer; the old relay's last segments are already recorded.
    if (oldSubKey) await liveTvManager.stopSubscription(oldSubKey).catch(() => {});
    const { ratingKey, subKey, sessionKey } = await liveTvManager.tuneChannel(room.liveTvChannelId);
    room.liveTvSubKey = subKey;
    room.movieKey     = String(ratingKey);

    // Warm-swap: new relay buffers alongside the still-valid old relay.
    // Clients never see a 503 gap.
    await startRelay(room.id, { ratingKey: String(ratingKey), liveSessionKey: sessionKey || null, onStall: () => doRetune(room, io) });

    room.broadcastState(io);
    console.log(`[Room] "${room.name}" → Retuned ${room.liveTvChannel} → ratingKey=${ratingKey} (sub ${subKey})`);
    room._retuneFails = 0;
  } catch (err) {
    room._retuneFails = (room._retuneFails || 0) + 1;
    console.error(`[Room] Retune failed for ${room.liveTvChannel} (attempt ${room._retuneFails}):`, err.message);
    // The relay only reports a stall once, so a failed retune has to schedule its own retry.
    if (room._retuneFails < 5 && rooms.has(room.id)) setTimeout(() => doRetune(room, io), 3000);
  } finally {
    room.retuning = false;
  }
}

function setupSync(io, enabledRoomTypes) {
  _io = io;
  if (enabledRoomTypes) _enabledRoomTypes = enabledRoomTypes;

  // Periodic sync heartbeat — keeps clients corrected during normal playback
  // without waiting for a play/pause/seek event to trigger a state broadcast.
  setInterval(() => {
    rooms.forEach(room => {
      if (room.playing && room.viewers.size > 1 && room.roomType !== 'livetv') {
        room.broadcastState(io);
        room.broadcastViewers(io);
      }
    });
  }, 5000);

  // Programs change on the hour / half hour; keep each live TV room's title current.
  setInterval(() => rooms.forEach(room => refreshLiveTvProgram(room, io)), 60000);

  // Faster heartbeat for live TV rooms — tighter sync tolerance needs more frequent updates.
  // Plex session keepalives are handled by stream.js; this just calibrates position + broadcasts.
  setInterval(() => {
    rooms.forEach(room => {
      if (room.roomType !== 'livetv') return;
      // Calibrate room position from host's reported playback time.
      // This makes currentPosition() return a smooth, deterministic value
      // that advances at real-time speed — same as movie/TV sync.
      const hostViewer = room.viewers.get(room.hostSocketId);
      // Only while playing and the report is fresh — a paused host stops reporting,
      // and its stale time must not drag the room position backwards.
      if (room.playing && hostViewer?.reportedTime != null && hostViewer.reportedAt != null
          && Date.now() - hostViewer.reportedAt < 3000) {
        room.position   = hostViewer.reportedTime;
        room.lastUpdate = hostViewer.reportedAt;
      }
      if (room.playing && room.viewers.size > 1) {
        room.broadcastState(io);
        room.broadcastViewers(io);
      }
    });
  }, 1000);

  io.on('connection', (socket) => {
    const user = socket.user;

    // Every handler below runs untrusted client payloads. Socket.io dispatches them on process.nextTick,
    // so one throw (e.g. `emit('play', null)` hitting `({ position })`) is an uncaught exception that
    // kills the server and every in-memory room. Give handlers an object instead of null/undefined,
    // and log (never rethrow) anything they throw or reject with.
    const rawOn = socket.on.bind(socket);
    socket.on = (event, handler) => rawOn(event, (...args) => {
      if (!args.length) args = [undefined];
      args = args.map(a => (a === null || a === undefined || typeof a !== 'object' ? (typeof a === 'function' ? a : {}) : a));
      if (event === 'disconnect' || event === 'disconnecting') args = [];
      const fail = err => console.error(`[Socket] "${event}" from ${user?.name || '?'} failed:`, err?.message || err);
      try {
        const r = handler(...args);
        if (r && typeof r.catch === 'function') r.catch(fail);
      } catch (err) { fail(err); }
    });

    const isAdmin = !!user.isAdmin && !user.isGuest;
    if (isAdmin) socket.join('admins');
    socket.emit('room-list', roomListFor(isAdmin));

    // ── Admin: close any room (server owner only) ──────────
    socket.on('admin-close-room', ({ roomId } = {}) => {
      if (!isAdmin) return;
      const room = rooms.get(roomId);
      if (!room) return;
      console.log(`[Admin] ${user.name} closed room "${room.name}"`);
      closeRoom(io, room, 'Closed by the server owner');
    });

    // ── Admin: kick anyone from any room, and block them from rejoining it ──
    socket.on('admin-kick', ({ targetSocketId } = {}) => {
      if (!isAdmin || targetSocketId === socket.id) return;
      const room = socketToRoom.get(targetSocketId);
      const target = room?.viewers.get(targetSocketId);
      if (!room || !target || target.isAdmin) return;
      if (targetSocketId === room.hostSocketId) {
        return socket.emit('error-msg', 'That is the room host — close the room instead');
      }
      removeViewer(io, room, targetSocketId, user, { ban: true });
    });

    // ── Create room (Plex users only) ──────────────────────
    socket.on('create-room', async ({ name, roomType, youtubeUrl, preload } = {}) => {
      if (user.isGuest) return socket.emit('error-msg', 'Guests cannot create rooms');
      name = sanitizeText((name || '').trim().slice(0, 60)) || undefined;

      const VALID_TYPES = Object.keys(_enabledRoomTypes).filter(t => _enabledRoomTypes[t]);
      // A preloaded title (lobby "recently added") decides the room type itself
      if (preload) roomType = { tv: 'tv', livetv: 'livetv' }[preload.kind] || 'movie';
      const type = VALID_TYPES.includes(roomType) ? roomType : (VALID_TYPES[0] || 'movie');
      if (preload && type !== roomType) return socket.emit('error-msg', 'That room type is turned off');
      // Courtesy check so nobody builds a Live TV room that can't tune; the real gate is in tuneRoomChannel
      if (type === 'livetv' && liveTvInUse() >= LIVETV_MAX_ROOMS) {
        return socket.emit('error-msg', liveTvFullMessage(liveTvInUse()));
      }
      let youtubeVideoId = null;
      if (type === 'youtube') {
        youtubeVideoId = extractYoutubeId(youtubeUrl || '');
        if (!youtubeVideoId) return socket.emit('error-msg', 'Invalid YouTube URL');
      }

      const room = new Room({ hostId: user.id, hostName: user.displayName || user.name, hostPicture: user.picture, name });
      room.roomType = type;
      room.youtubeVideoId = youtubeVideoId;
      if (youtubeVideoId) room.movieTitle = await fetchYoutubeTitle(youtubeVideoId);
      if (preload) {
        try {
          const title = preload.kind === 'livetv' ? await preloadLiveTv(room, preload) : await preloadRoom(room, preload);
          if (!name) room.name = sanitizeText(String(title).slice(0, 60));   // "Resident Evil", not "Tyler's Room"
        } catch (err) {
          console.error('[Room] preload failed:', err.message);
          return socket.emit('error-msg', 'Could not load that title from Plex');
        }
      }
      room.hostSocketId = socket.id;
      room.viewers.set(socket.id, {
        socketId: socket.id, id: user.id, name: user.displayName || user.name, picture: user.picture || null, isGuest: false, isHost: true, isAdmin
      });

      rooms.set(room.id, room);
      inviteTokens.set(room.inviteToken, room.id);
      socketToRoom.set(socket.id, room);

      socket.emit('room-created', { roomId: room.id, inviteToken: room.inviteToken });
      broadcastRoomList(io);
      notifier.notify('room.created', {
        name: room.name, createdBy: user.displayName || user.name,
        url: `${(process.env.APP_URL || '').replace(/\/$/, '')}/join/${room.inviteToken}`,
      });
      console.log(`[Room] ${user.name} created "${room.name}" (${room.id})`);
    });

    // ── Join room from watch page ──────────────────────────
    // Allowed if: host, OR guest who arrived via a valid invite token (stored in session)
    socket.on('join-room', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return socket.emit('room-error', 'Room not found');
      if (room.bannedIds?.has(user.id) && !isAdmin) {
        return socket.emit('room-error', 'You have been removed from this room by the server owner');
      }

      // Always-on room whose host just left (still inside the grace window): unless that's the host coming
      // back, they're gone — reset now so this person is welcomed as the new host, not stranded as a viewer.
      if (room.persistentId && room.closeTimer && !(!room.hostIsGuest && !user.isGuest && user.id === room.hostId)) {
        clearTimeout(room.closeTimer); room.closeTimer = null;
        resetPersistentRoom(io, room);
      }

      // A room waiting for its host: the first person in becomes the host.
      // - Scheduled room: Plex users only. Guests wait until a Plex user has opened the room.
      // - Always-on room: open to whoever arrives first, a guest holding the invite link included —
      //   the point of an always-on room is that people can walk in and start it.
      if (room.awaitingHost) {
        const guestMayOpen = room.persistentId && user.inviteToken === room.inviteToken;
        if (user.isGuest && !guestMayOpen) {
          return socket.emit('room-error', 'Waiting for the host to arrive. Please try again shortly.');
        }
        room.awaitingHost  = false;
        room.hostId        = user.isGuest ? null : user.id;
        room.hostName      = user.displayName || user.name;
        room.hostPicture   = user.picture || null;
        room.hostIsGuest   = !!user.isGuest;
        room.hostSocketId  = socket.id;
        console.log(`[Room] "${room.name}" (${room.persistentId ? 'always-on' : 'scheduled'}) — first joiner "${user.name}"${user.isGuest ? ' (guest)' : ''} became host`);
      }

      const isHost         = socket.id === room.hostSocketId ||
                             (!room.hostIsGuest && !user.isGuest && user.id === room.hostId);
      const hasValidInvite = user.inviteToken === room.inviteToken;
      // Plex users can join any room (they're all authenticated against the same server).
      // Guests must arrive via an invite link, which stores the token in their session.
      const isPlexViewer   = !user.isGuest && !isHost;

      if (!isHost && !hasValidInvite && !isPlexViewer) {
        return socket.emit('room-error', 'Access denied — use the invite link to join');
      }

      if (isHost) {
        room.hostSocketId = socket.id;
        // Cancel any pending close timer from a previous disconnect
        if (room.closeTimer) {
          clearTimeout(room.closeTimer);
          room.closeTimer = null;
          console.log(`[Room] Host reconnected to "${room.name}" — close cancelled`);
        }
      }

      room.viewers.set(socket.id, {
        socketId: socket.id, id: user.id, name: user.displayName || user.name, picture: user.picture || null,
        isGuest: user.isGuest || false, isHost, isAdmin
      });
      socketToRoom.set(socket.id, room);

      socket.emit('room-state', { ...room.state(), isHost, isAdmin, inviteToken: isHost ? room.inviteToken : null });
      room.broadcastViewers(io);
      broadcastRoomList(io);   // the lobby's viewer count / host name change when someone arrives
      if (isHost && room.pendingChannel) {
        const pending = room.pendingChannel;
        room.pendingChannel = null;
        tuneRoomChannel(io, room, pending).catch(() => {});   // progress/failure reach everyone via livetv-tuning events
      }
      if (room.vote) {
        socket.emit('vote-started', voting.publicState(room.vote, user.id));
        if (room.vote.status === 'done') socket.emit('vote-result', { id: room.vote.id, ...room.vote.result });
        else maybeFinalizeVote(io, room);
      }
      console.log(`[Room] ${user.name} joined "${room.name}"`);
    });

    // ── Select movie (host only) ───────────────────────────
    // The browser only names the item; title and part are looked up in Plex (preloadRoom), so a host
    // (who may be a guest in an always-on room) can't inject a title or point the room at another file.
    socket.on('select-movie', async ({ movieKey } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      const picked = {};
      try { await preloadRoom(picked, { kind: 'movie', ratingKey: movieKey }); }
      catch (err) { return socket.emit('error-msg', 'Could not load that movie from Plex'); }
      if (room.hostSocketId !== socket.id) return;   // host changed while Plex answered
      applyMovie(io, room, picked.movieKey, picked.movieTitle, picked.partId);
    });

    // ── Movie vote: swipe through a filtered deck, most-liked movie wins ──────────
    // The host controls it (filters, start, reveal, cancel, and playing the winner); everyone swipes.
    socket.on('vote-start', async (filters) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'movie') return socket.emit('error-msg', 'Voting is for movie rooms');
      try {
        const { candidates, matched, filters: clean } = await voting.drawDeck(filters);
        if (candidates.length < voting.MIN_DECK) {
          return socket.emit('vote-error', `Only ${candidates.length} movie${candidates.length === 1 ? '' : 's'} match those filters — loosen them a little`);
        }
        room.vote = voting.create(candidates, clean, matched);
        console.log(`[Vote] "${room.name}" started with ${candidates.length} of ${matched} matching movies`);
        // Per-user payload: a refreshed page gets its own earlier swipes back
        room.viewers.forEach((v, sid) => io.to(sid).emit('vote-started', voting.publicState(room.vote, v.id)));
        broadcastVoteProgress(io, room);
      } catch (err) {
        console.error('[Vote] deck error:', err.message);
        socket.emit('vote-error', 'Could not load the movie library');
      }
    });

    socket.on('vote-cast', ({ voteId, ratingKey, yes } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room?.vote || room.vote.id !== voteId) return;
      if (!voting.cast(room.vote, user.id, user.displayName || user.name, String(ratingKey), yes)) return;
      maybeFinalizeVote(io, room);
    });

    socket.on('vote-reveal', () => {
      const room = socketToRoom.get(socket.id);
      if (!room?.vote || room.vote.status !== 'voting' || room.hostSocketId !== socket.id) return;
      room.broadcast(io, 'vote-result', { id: room.vote.id, ...voting.finalize(room.vote) });
    });

    socket.on('vote-cancel', () => {
      const room = socketToRoom.get(socket.id);
      if (!room?.vote || room.hostSocketId !== socket.id) return;
      room.vote = null;
      room.broadcast(io, 'vote-closed', { reason: 'cancelled' });
    });

    // Play one of the deck's movies — normally the winner, but the host may pick a runner-up
    socket.on('vote-play', ({ ratingKey } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room?.vote || room.vote.status !== 'done' || room.hostSocketId !== socket.id) return;
      const pick = voting.findCandidate(room.vote, String(ratingKey));
      if (!pick) return;
      room.vote = null;
      room.broadcast(io, 'vote-closed', { reason: 'picked' });
      applyMovie(io, room, pick.ratingKey, pick.title, pick.partId);
    });

    // ── Select TV episode (host only, TV rooms) ────────────
    // Only the episode key is taken from the browser; show, title, part and the episode list come from Plex.
    socket.on('select-show', async ({ episodeRatingKey } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'tv') return;
      const picked = {};
      try {
        await preloadRoom(picked, { kind: 'tv', ratingKey: episodeRatingKey });
      } catch (err) {
        console.error('[Room] select-show error:', err.message);
        return socket.emit('error-msg', 'Failed to load episode list');
      }
      if (room.hostSocketId !== socket.id) return;
      clearRoomManifest(room.id);
      Object.assign(room, picked);   // tvShowKey/Title, tvEpisodeList/Index, movieKey, movieTitle, partId
      room.playing    = false;
      room.position   = 0;
      room.lastUpdate = Date.now();
      console.log(`[Room] "${room.name}" → TV "${room.movieTitle}"`);
      room.broadcastState(io);
      broadcastRoomList(io);
    });

    // ── Episode ended — advance to next (host only, TV rooms) ──
    socket.on('episode-ended', async () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'tv' || !room.tvEpisodeList.length) return;

      const nextIndex = room.tvEpisodeIndex + 1;
      if (nextIndex >= room.tvEpisodeList.length) {
        console.log(`[Room] "${room.name}" — TV season complete, no more episodes`);
        return;
      }

      const nextEp = room.tvEpisodeList[nextIndex];
      try {
        const details = await plex.getMovieDetails(nextEp.ratingKey);
        const part = details.Media?.[0]?.Part?.[0];
        if (!part) {
          console.warn(`[Room] episode-ended: no part found for ${nextEp.ratingKey}`);
          return;
        }
        clearRoomManifest(room.id);
        room.tvEpisodeIndex = nextIndex;
        room.movieKey       = String(nextEp.ratingKey);
        room.partId         = String(part.id);
        room.movieTitle     = formatEpisodeTitle(room.tvShowTitle, nextEp);
        room.playing        = false;
        room.position       = 0;
        room.lastUpdate     = Date.now();
        console.log(`[Room] "${room.name}" → next episode "${room.movieTitle}"`);
        room.broadcastState(io);
        broadcastRoomList(io);
      } catch (err) {
        console.error('[Room] episode-ended error:', err.message);
      }
    });

    // ── Set YouTube video (host only, YouTube rooms) ───────
    socket.on('set-youtube', async ({ youtubeUrl }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'youtube') return;
      const videoId = extractYoutubeId(youtubeUrl || '');
      if (!videoId) return;
      room.youtubeVideoId = videoId;
      room.movieTitle = await fetchYoutubeTitle(videoId);
      room.playing = false; room.position = 0; room.lastUpdate = Date.now();
      console.log(`[Room] \"${room.name}\" → YouTube ${videoId} \"${room.movieTitle || 'unknown'}\"`);
      room.broadcastState(io);
      broadcastRoomList(io);
    });

    // ── Select live TV channel (host only, livetv rooms) ──
    socket.on('select-livetv-channel', async ({ channel, channelTitle, channelId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      if (!channelId) return;
      const err = await tuneRoomChannel(io, room, { channel, channelTitle, channelId });
      if (err) socket.emit('error-message', err);
    });

    // ── Re-tune live TV when session dies (host only) ──────
    // Triggered by the client when the HLS stream fails unrecoverably.
    // The DVR ratingKey has expired; we need to re-tune to get a fresh one.
    socket.on('retune-livetv', async () => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      if (!room.liveTvChannelId) return;
      await doRetune(room, io);
    });

    // ── Playback (anyone in room, unless locked) ───────────
    socket.on('play', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (room.resyncTimer) return;   // a resync is counting down; it will resume everyone itself
      if (!playPauseLimiter.allow(socket.id)) return;
      if (room.settings.playbackLocked && socket.id !== room.hostSocketId) return;
      room.position = validPosition(position) ?? room.currentPosition();
      room.playing = true; room.lastUpdate = Date.now();
      room.broadcastState(io);
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: '▶ resumed',
        isSystem: true,
        videoTime: Math.floor(room.position)
      });
    });

    socket.on('pause', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (room.resyncTimer) return;
      if (!playPauseLimiter.allow(socket.id)) return;
      if (room.settings.playbackLocked && socket.id !== room.hostSocketId) return;
      // Live TV: no pause spam. A pause that comes too soon after the last one is refused and the pauser's
      // player resumes (the room never actually paused, so nothing changes for anyone else).
      if (room.roomType === 'livetv' && room.playing) {
        const wait = (room.lastPauseAt || 0) + pauseCooldownMs() - Date.now();
        if (wait > 0) { socket.emit('pause-denied', { waitSec: Math.ceil(wait / 1000) }); return; }
      }
      if (room.roomType === 'livetv') room.lastPauseAt = Date.now();
      room.position = validPosition(position) ?? room.currentPosition();
      room.playing = false; room.lastUpdate = Date.now();
      room.broadcastState(io);
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: '⏸ paused',
        isSystem: true,
        videoTime: Math.floor(room.position)
      });
    });

    socket.on('seek', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (room.resyncTimer) return;
      if (room.settings.playbackLocked && socket.id !== room.hostSocketId) return;
      if (!seekLimiter.allow(socket.id)) return;
      if (validPosition(position) == null) return;
      room.position = position; room.lastUpdate = Date.now();
      room.broadcastState(io);
    });

    // ── Chat ───────────────────────────────────────────────
    socket.on('chat', (data) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!chatLimiter.allow(socket.id)) return;
      const trimmed = sanitizeText(((data && data.text) || '').trim().slice(0, 300));
      if (!trimmed) return;
      const videoTime = (typeof data.videoTime === 'number' && isFinite(data.videoTime)
        && data.videoTime >= 0 && data.videoTime < 86400)
        ? Math.floor(data.videoTime)
        : null;
      // @name (or @everyone) tags viewers in this room; the client highlights and notifies them
      const mentions = [];
      const lower = trimmed.toLowerCase();
      const mentionedAt = (name) => {
        const needle = '@' + name.toLowerCase();
        for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
          const after = lower[i + needle.length];
          if ((i === 0 || /\s|[(\[]/.test(lower[i - 1])) && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) return true;
        }
        return false;
      };
      if (mentionedAt('everyone') || mentionedAt('all')) {
        for (const v of room.viewers.values()) mentions.push(v.socketId);
      } else {
        for (const v of room.viewers.values()) if (v.name && mentionedAt(v.name)) mentions.push(v.socketId);
      }
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: trimmed,
        isGuest: user.isGuest || false,
        videoTime,
        mentions
      });
    });

    // ── Reactions ──────────────────────────────────────────
    socket.on('reaction', ({ emoji }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!room.settings.reactionsEnabled) return;
      if (!reactionLimiter.allow(socket.id)) return;
      const allowed = ['👍','❤️','😂','😱','😮','👏'];
      if (!allowed.includes(emoji)) return;
      const picture = room.viewers.get(socket.id)?.picture || user.picture || null;
      console.log(`[Reaction] ${user.displayName || user.name} (${user.isGuest ? 'guest' : 'plex'}) picture=${picture ? String(picture).slice(0, 90) : 'none'}`);
      room.broadcast(io, 'reaction', { emoji, name: user.displayName || user.name, picture });
    });

    // ── Room settings (host only) ──────────────────────────
    socket.on('update-settings', (s) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (typeof s.playbackLocked  === 'boolean') room.settings.playbackLocked  = s.playbackLocked;
      if (typeof s.reactionsEnabled === 'boolean') room.settings.reactionsEnabled = s.reactionsEnabled;
      room.broadcast(io, 'room-settings', room.settings);
    });

    // ── Kick viewer (host, or the server owner in any room they are in) ──
    // The server owner can never be kicked, and a non-host admin can't kick the host (close the room instead).
    socket.on('kick-viewer', ({ targetSocketId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || (room.hostSocketId !== socket.id && !isAdmin)) return;
      if (!room.viewers.has(targetSocketId)) return;
      if (targetSocketId === socket.id) return;
      if (room.viewers.get(targetSocketId).isAdmin) return;
      if (targetSocketId === room.hostSocketId) return;
      removeViewer(io, room, targetSocketId, user, { ban: isAdmin });
    });

    // ── Countdown (host only) ──────────────────────────────
    // ── Force resync (host only) ───────────────────────────
    // Parks everyone at the host's current position (paused), then resumes them together after RESYNC_SECONDS.
    socket.on('force-resync', () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.movieKey && !room.youtubeVideoId) return socket.emit('resync-denied', { reason: 'nothing-playing' });
      if (room.countdownTimer || room.intermissionTimer || room.resyncTimer) return socket.emit('resync-denied', { reason: 'busy' });
      const wait = (room.lastResyncAt || 0) + RESYNC_COOLDOWN_MS - Date.now();
      if (wait > 0) return socket.emit('resync-denied', { reason: 'cooldown', waitSec: Math.ceil(wait / 1000) });
      room.lastResyncAt = Date.now();

      // Where "now" is: Live TV trusts the host's own player (its latest report), everything else the room clock
      let position = room.currentPosition();
      if (room.roomType === 'livetv' && room.playing) {
        const hv = room.viewers.get(room.hostSocketId);
        if (hv?.reportedTime != null && hv.reportedAt != null && Date.now() - hv.reportedAt < 3000) {
          position = hv.reportedTime + (Date.now() - hv.reportedAt) / 1000;
        }
      }

      room.position = position; room.playing = false; room.lastUpdate = Date.now();
      room.broadcastState(io);
      room.broadcast(io, 'resync', { seconds: RESYNC_SECONDS, position, by: user.displayName || user.name });
      room.broadcast(io, 'chat', { name: user.displayName || user.name, text: '🔄 forced a resync', isSystem: true, videoTime: Math.floor(position) });
      console.log(`[Room] "${room.name}" — ${user.name} forced a resync at ${position.toFixed(1)}s`);

      room.resyncTimer = setTimeout(() => {
        room.resyncTimer = null;
        if (!rooms.has(room.id)) return;
        room.playing = true; room.lastUpdate = Date.now();   // position stays where everyone was parked
        room.broadcastState(io);
      }, RESYNC_SECONDS * 1000);
    });

    socket.on('start-countdown', ({ seconds } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }

      const SECONDS = (Number.isInteger(seconds) && seconds >= 1 && seconds <= 99) ? seconds : 10;
      const endsAt  = Date.now() + SECONDS * 1000;
      room.broadcast(io, 'countdown', { endsAt });

      room.countdownTimer = setTimeout(() => {
        room.countdownTimer = null;
        room.position  = room.currentPosition();
        room.playing   = true;
        room.lastUpdate = Date.now();
        room.broadcastState(io);
      }, SECONDS * 1000);
    });

    socket.on('cancel-countdown', () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
      room.broadcast(io, 'countdown-cancelled');
    });

    // ── Intermission (host only) ───────────────────────────
    socket.on('start-intermission', ({ minutes } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;

      const MINS     = (Number.isInteger(minutes) && minutes >= 1 && minutes <= 120) ? minutes : 10;
      const DURATION = MINS * 60 * 1000;
      const endsAt   = Date.now() + DURATION;

      // Clear any existing intermission
      if (room.intermissionTimer) { clearTimeout(room.intermissionTimer); room.intermissionTimer = null; }

      // Pause playback
      room.position   = room.currentPosition();
      room.playing    = false;
      room.lastUpdate = Date.now();
      room.intermissionEndsAt = endsAt;

      room.broadcastState(io);
      room.broadcast(io, 'intermission-started', { endsAt });

      room.intermissionTimer = setTimeout(() => {
        room.intermissionTimer  = null;
        room.intermissionEndsAt = null;
        room.playing    = true;
        room.lastUpdate = Date.now();
        room.broadcastState(io);
        room.broadcast(io, 'intermission-ended');
        console.log(`[Room] Intermission ended in "${room.name}" — resuming`);
      }, DURATION);

      console.log(`[Room] Intermission started in "${room.name}" for ${MINS} min`);
    });

    socket.on('cancel-intermission', () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.intermissionTimer) return;
      clearTimeout(room.intermissionTimer);
      room.intermissionTimer  = null;
      room.intermissionEndsAt = null;
      room.broadcast(io, 'intermission-cancelled');
      console.log(`[Room] Intermission cancelled in "${room.name}"`);
    });

    // ── Transfer host ──────────────────────────────────────
    socket.on('transfer-host', ({ targetSocketId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.viewers.has(targetSocketId)) return;

      const oldHostViewer = room.viewers.get(socket.id);
      const newHostViewer = room.viewers.get(targetSocketId);

      if (oldHostViewer) oldHostViewer.isHost = false;
      newHostViewer.isHost = true;

      room.hostId       = newHostViewer.isGuest ? null : newHostViewer.id;
      room.hostName     = newHostViewer.name;
      room.hostPicture  = newHostViewer.picture;
      room.hostIsGuest  = newHostViewer.isGuest;
      room.hostSocketId = targetSocketId;

      if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; }

      io.to(socket.id).emit('lost-host');
      io.to(targetSocketId).emit('became-host', { inviteToken: room.inviteToken });

      room.broadcastViewers(io);
      broadcastRoomList(io);
      console.log(`[Room] Host transferred from "${user.name}" to "${newHostViewer.name}" in "${room.name}"`);
    });

    // ── Position report (for drift display) ───────────────
    socket.on('position-report', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!positionLimiter.allow(socket.id)) return;
      const viewer = room.viewers.get(socket.id);
      if (!viewer) return;
      if (typeof position !== 'number' || !isFinite(position) || position < 0) return;
      viewer.reportedTime = position;
      viewer.reportedAt   = Date.now();
    });

    // ── Buffering state ────────────────────────────────────
    socket.on('buffering-state', ({ buffering }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!bufferingLimiter.allow(socket.id)) return;
      const viewer = room.viewers.get(socket.id);
      if (!viewer) return;
      viewer.buffering = !!buffering;
      room.broadcastViewers(io);
    });

    // ── Disconnect ─────────────────────────────────────────
    socket.on('disconnect', () => {
      chatLimiter.delete(socket.id);
      reactionLimiter.delete(socket.id);
      seekLimiter.delete(socket.id);
      const room = socketToRoom.get(socket.id);
      socketToRoom.delete(socket.id);
      if (!room) return;

      room.viewers.delete(socket.id);
      maybeFinalizeVote(io, room);

      if (room.hostSocketId === socket.id) {
        if (room.countdownTimer) {
          clearTimeout(room.countdownTimer); room.countdownTimer = null;
          room.broadcast(io, 'countdown-cancelled');
        }
        if (room.intermissionTimer) {
          clearTimeout(room.intermissionTimer); room.intermissionTimer = null;
          room.intermissionEndsAt = null;
        }

        // If viewers remain, auto-migrate host rather than closing the room.
        if (room.viewers.size > 0) {
          // Prefer a non-guest viewer; otherwise take any remaining viewer.
          let candidate = null;
          for (const [sid, v] of room.viewers) {
            if (!v.isGuest) { candidate = [sid, v]; break; }
            if (!candidate) candidate = [sid, v];
          }
          if (candidate) {
            const [newSid, newViewer] = candidate;
            newViewer.isHost      = true;
            room.hostId           = newViewer.isGuest ? null : newViewer.id;
            room.hostName         = newViewer.name;
            room.hostPicture      = newViewer.picture;
            room.hostIsGuest      = newViewer.isGuest;
            room.hostSocketId     = newSid;
            if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; }
            io.to(newSid).emit('became-host', { inviteToken: room.inviteToken });
            room.broadcastViewers(io);
            broadcastRoomList(io);
            console.log(`[Room] "${room.name}" — host "${user.name}" left, auto-migrated to "${newViewer.name}"`);
            return;
          }
        }

        if (room.persistentId) {
          // Always-on: never close. A short grace so a page refresh doesn't tear the stream down.
          console.log(`[AlwaysOn] Host "${user.name}" left "${room.name}" — resetting shortly unless they return`);
          if (room.closeTimer) clearTimeout(room.closeTimer);
          room.closeTimer = setTimeout(() => {
            room.closeTimer = null;
            if (rooms.has(room.id) && room.viewers.size === 0) resetPersistentRoom(io, room);
          }, 10000);
          return;
        }

        if (room.hostIsGuest) {
          // Guest hosts cannot reconnect — close the room immediately
          console.log(`[Room] Guest host "${user.name}" disconnected from "${room.name}" — closing`);
          room.broadcast(io, 'room-closed', { reason: 'Host left the room' });
          stopRelay(room.id);
          inviteTokens.delete(room.inviteToken);
          rooms.delete(room.id);
          broadcastRoomList(io);
        } else {
          // Give the Plex host a grace window to reconnect (e.g. lobby → watch navigation).
          // If they rejoin before the timer fires it will be cancelled.
          console.log(`[Room] Host "${user.name}" disconnected from "${room.name}" — waiting to see if they reconnect…`);
          room.closeTimer = setTimeout(() => {
            if (!rooms.has(room.id)) return; // already cleaned up
            console.log(`[Room] "${room.name}" closed — host did not reconnect`);
            room.broadcast(io, 'room-closed', { reason: 'Host left the room' });
            stopRelay(room.id);
            inviteTokens.delete(room.inviteToken);
            rooms.delete(room.id);
            broadcastRoomList(io);
            }, 30000);
        }
      } else {
        room.broadcastViewers(io);
        console.log(`[Room] ${user.name} left "${room.name}"`);
        broadcastRoomList(io);
      }
    });
  });
}

/**
 * Create a room from a scheduled room record.
 * Called by the scheduler when the scheduled time arrives.
 * The room is registered in the rooms/inviteTokens maps and the pre-shared
 * inviteToken is preserved so outstanding invite links continue to work.
 */
function createScheduledRoom(scheduled) {
  const room = new Room({
    hostId:      null,
    hostName:    scheduled.createdBy.name,
    hostPicture: null,
    name:        scheduled.name
  });

  // A recurring night reuses its invite link; if last time's room is somehow still open, keep it
  const existing = inviteTokens.get(scheduled.inviteToken);
  if (existing && rooms.has(existing)) return rooms.get(existing);

  // Preserve the pre-shared invite token
  room.inviteToken  = scheduled.inviteToken;
  room.awaitingHost = true;

  // Pre-load the movie if one was chosen at scheduling time
  if (scheduled.movieKey) {
    room.movieKey   = scheduled.movieKey;
    room.movieTitle = scheduled.movieTitle;
    room.partId     = scheduled.partId;
  }

  rooms.set(room.id, room);
  inviteTokens.set(room.inviteToken, room.id);

  if (_io) broadcastRoomList(_io);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

/** Close a room from outside the socket layer (admin panel / API). Returns false if it doesn't exist. */
function adminCloseRoom(roomId, reason = 'Closed by the server owner') {
  const room = rooms.get(roomId);
  if (!room || !_io) return false;
  closeRoom(_io, room, reason);
  return true;
}

/** Plex user ids with at least one open socket (lobby or room) right now. */
function onlineUserIds() {
  const ids = new Set();
  if (_io) for (const s of _io.sockets.sockets.values()) if (s.user && !s.user.isGuest) ids.add(String(s.user.id));
  return ids;
}

/** Which room types the server has turned on (for the admin API). */
const enabledRoomTypes = () => ({ ..._enabledRoomTypes });

module.exports = {
  setupSync, getRoomByInviteToken, createScheduledRoom, getRoom, adminCloseRoom, onlineUserIds,
  createPersistentRoom, restorePersistentRooms, getPersistentRoom, removePersistentRoom, enabledRoomTypes,
  liveTvCapacity,
};
