const { randomUUID: uuidv4 } = require('crypto');
const axios = require('axios');
const { clearRoomManifest, prewarmManifest } = require('./routes/stream');
const { startRelay, startHdhr, hdhrEnabled, stopRelay, getRelay, getDvr, splitLayout, SPLIT_MAX } = require('./live-relay');
const plex = require('./plex');
const { sanitizeText } = require('./sanitize');
const wordfilter = require('./wordfilter');
const users = require('./users');
const gifs = require('./gifs');
const uploads = require('./uploads');
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
    // Every channel on screen, in tile order: [{ channel, title, channelId }]. One entry normally; 2–4 is
    // split view. liveTvChannel / Title / Id above always mirror the first one (lobby, link previews).
    this.liveTvChannels     = [];
    this.liveTvPrograms     = [];    // what's on each of them (guide), same order
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
    this.chatSeq        = 0;
    this.chatHistory    = [];        // last CHAT_HISTORY messages (see chat())
    this.mutedIds       = null;      // Set of user ids the host/owner muted in chat, until the room closes
    this.uploads        = new Map(); // chat image id -> { by: userId, w, h, posted } (files: uploads.js)
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
      // Changes whenever the set of channels does (the player reloads the stream on it)
      liveTvKey: this.liveTvChannels.length ? this.liveTvChannels.map(c => c.channel).join('+') : this.liveTvChannel,
      liveTvSplit: this.roomType === 'livetv' ? splitState(this) : null,
      liveTvSplitMax: this.roomType === 'livetv' ? liveSplitMax() : 0,
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
      liveTvChannel: this.liveTvChannel || this.pendingChannels?.[0]?.channel || null,
      liveTvChannelCount: this.liveTvChannels.length || this.pendingChannels?.length || 0,
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

  // Every chat line goes through here: it gets an id and a send time, and the last CHAT_HISTORY are kept so a
  // late joiner (or a refreshed page) sees the conversation so far, and replies/deletes can find their message.
  chat(io, msg) {
    const m = { id: ++this.chatSeq, at: Date.now(), ...msg };
    if (!m.isSystem) {   // "▶ resumed" lines would crowd real messages out of the history
      this.chatHistory.push(m);
      if (this.chatHistory.length > CHAT_HISTORY) this.chatHistory.shift();
    }
    this.broadcast(io, 'chat', m);
    return m;
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
      return { ...v, drift, buffering: v.buffering || false, muted: !!this.mutedIds?.has(String(v.id)) };
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
  if (room.unclaimedTimer)    clearTimeout(room.unclaimedTimer);
  room.broadcast(io, 'room-closed', { reason });
  room.viewers.forEach((_, sid) => socketToRoom.delete(sid));
  stopRelay(room.id);
  clearRoomManifest(room.id);   // end its Plex transcode; the keepalive would hold it open for hours
  uploads.removeRoom(room.id);
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
  room.mutedIds = null;
  room.chatHistory = [];
  room.uploads.clear();
  uploads.removeRoom(room.id);
  room._tuneGen = (room._tuneGen || 0) + 1;   // any tune still in flight belongs to the previous occupants
  room.lastPauseAt = 0;
  room.settings = { playbackLocked: false, reactionsEnabled: true };
  room.hostId = null; room.hostName = 'always on'; room.hostPicture = null;
  room.hostIsGuest = false; room.hostSocketId = null; room.awaitingHost = true;
  room.playing = false; room.position = 0; room.lastUpdate = Date.now();

  if (room.roomType === 'livetv') {
    stopRelay(room.id);
    clearRoomManifest(room.id);
    setLiveChannels(room, []);
    room.liveTvSubKey = room.liveTvSource = null;
    room.liveTuning = null; room._tuningInProgress = false; room.retuning = false;
    room.movieKey = null;
    room.pendingChannels = room.persistentChannels.map(c => ({ ...c }));
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
  // Pinned channels (several = split view), tuned when the first person arrives. Older definitions have one `channel`.
  room.persistentChannels = alwaysOn.channelsOf(def);
  room.pendingChannels    = room.persistentChannels.map(c => ({ ...c }));
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
const typingLimiter        = makeSocketRateLimiter(1, 1500);  // "is typing…" pings
const chatReactLimiter     = makeSocketRateLimiter(8, 4000);  // reactions on chat messages
// The reaction emojis — the same six for the floating video reactions and for reactions on chat messages
const REACTIONS = ['👍', '❤️', '😂', '😱', '😮', '👏'];
const CHAT_HISTORY = 100;   // messages a room keeps for late joiners
const CHAT_MAX     = 500;   // characters per message

// Chat text keeps its line breaks (other control characters become spaces); runs of blank lines collapse
function cleanChat(str) {
  return String(str || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, CHAT_MAX);
}
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

// How many Live TV channels may be streaming at once, across all rooms (a split-view room counts each tile).
// Each one holds a tuner and its share of the encoder, so this is the
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
console.log(`[LiveTV] Live TV capacity: ${LIVETV_MAX_ROOMS} channel${LIVETV_MAX_ROOMS === 1 ? "" : "s"} at a time`);
settings.onChange('maxLiveTvRooms', () => {
  LIVETV_MAX_ROOMS = maxRoomsFromEnv();
  console.log(`[LiveTV] Live TV capacity changed: ${LIVETV_MAX_ROOMS} channel${LIVETV_MAX_ROOMS === 1 ? "" : "s"} at a time`);
});
// Either limit changes how many tiles a room may add: tell open Live TV rooms (their hosts' "+ Add" button).
// Registered after the hook above, so LIVETV_MAX_ROOMS is already updated when this runs.
settings.onChange(['maxLiveTvRooms', 'splitMax'], () => {
  if (_io) rooms.forEach(r => { if (r.roomType === 'livetv') r.broadcastState(_io); });
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

// Live TV capacity is counted in *channels* (each holds a tuner and its share of the encoder): a normal room
// holds one, a split-view room one per tile. LIVETV_MAX_ROOMS is the most channels streaming at once.
/** Tuners a Live TV room holds right now (mid-tune: what that tune was allowed to take). */
function liveTvSlots(r) {
  if (r.roomType !== 'livetv') return 0;
  if (r._tuningInProgress) return r._tuningSlots || 1;
  return (getDvr(r.id) || getRelay(r.id)) ? Math.max(1, r.liveTvChannels.length) : 0;
}
function liveTvInUse(except = null) {
  let n = 0;
  for (const r of rooms.values()) if (r !== except) n += liveTvSlots(r);
  return n;
}
const liveTvCapacity = () => ({ max: LIVETV_MAX_ROOMS, inUse: liveTvInUse() });
const liveTvFullMessage = (inUse, wanted = 1) => wanted > 1
  ? `Not enough Live TV tuners free for ${wanted} channels (${inUse} of ${LIVETV_MAX_ROOMS} in use).`
  : `Live TV is full right now (${inUse} of ${LIVETV_MAX_ROOMS} tuner${LIVETV_MAX_ROOMS === 1 ? '' : 's'} in use). Try again when one ends.`;

/** Most channels one room may tile (split view). Needs the HDHomeRun source; capped by capacity. */
// LIVETV_SPLIT_MAX (admin Settings → "Live TV split view": 1 = off, 2–4) is read on use, so a change applies at once.
const splitSetting = () => { const n = parseInt(process.env.LIVETV_SPLIT_MAX, 10); return n >= 1 && n <= SPLIT_MAX ? n : SPLIT_MAX; };
const liveSplitMax = () => hdhrEnabled() ? Math.min(SPLIT_MAX, LIVETV_MAX_ROOMS, splitSetting()) : 1;
const splitLimitMessage = () => liveSplitMax() === 1
  ? (hdhrEnabled() ? 'Split view is turned off on this server' : 'Split view needs the HDHomeRun tuner source')
  : `At most ${liveSplitMax()} channels can be shown at once`;

/** Point a room at a set of channels ([{ channel, channelTitle|title, channelId }]); [] clears it. */
function setLiveChannels(room, list) {
  room.liveTvChannels = list.map(c => ({
    channel: String(c.channel || '').slice(0, 20),
    title: sanitizeText(String(c.channelTitle || c.title || c.channel || '').slice(0, 60)),
    channelId: c.channelId,
  }));
  const first = room.liveTvChannels[0];
  room.liveTvChannel      = first ? first.channel : null;
  room.liveTvChannelTitle = first ? first.title : null;
  room.liveTvChannelId    = first ? first.channelId : null;
  room.liveTvPrograms     = room.liveTvChannels.map(() => null);
  room.liveTvProgram      = null;
}

/** Split view for state(): each tile's channel, what's on, and where it sits (fractions of the picture). */
function splitState(room) {
  const n = room.liveTvChannels.length;
  if (n < 2) return null;
  const full = splitLayout(1)[0];
  return splitLayout(n).map((t, i) => ({
    slot: i,
    channel: room.liveTvChannels[i].channel,
    title: room.liveTvChannels[i].title,
    program: room.liveTvPrograms[i] || null,
    x: t.x / full.w, y: t.y / full.h, w: t.w / full.w, h: t.h / full.h,
  }));
}

/** The room's channels in the shape tuneRoomChannels takes. */
const currentChannelList = room => room.liveTvChannels.map(c => ({ channel: c.channel, channelTitle: c.title, channelId: c.channelId }));
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
  room.pendingChannels = [{ channel: ch.number, channelTitle: ch.title, channelId: ch.channelId }];
  return `${ch.number} ${ch.title}`.trim();
}

/**
 * Tune a Live TV room to a channel: start the recording (HDHomeRun or Plex), then point the room at it.
 * Shared by the host's channel picker and the lobby's "on now" cards (which tune once the host arrives).
 * Returns an error string for the caller to show, or nothing on success. Failures after the tune starts
 * are also broadcast to the room as 'livetv-tune-failed'.
 */
function tuneRoomChannel(io, room, { channel, channelTitle, channelId }) {
  return tuneRoomChannels(io, room, [{ channel, channelTitle, channelId }]);
}

/**
 * Tune a Live TV room to one channel, or (split view, HDHomeRun only) 2–liveSplitMax() channels tiled into
 * one picture, each with its own audio track. Any change to the set re-records everything into a fresh DVR.
 */
async function tuneRoomChannels(io, room, list) {
  if (!Array.isArray(list) || !list.length) return 'No channel given';
  // Validate channelIds are not empty (Plex may return numeric or string IDs)
  if (list.some(c => !c || !c.channelId || !String(c.channelId).trim())) return 'Invalid channelId';
  const split = list.length > 1;
  if (split && !hdhrEnabled()) return 'Split view needs the HDHomeRun tuner source';
  if (list.length > liveSplitMax()) return splitLimitMessage();

  // Prevent concurrent tune requests (rate limit on channel switching)
  if (room._tuningInProgress) return 'Channel change in progress';

  // Capacity: this room's channels must not push the server past LIVETV_MAX_ROOMS. (No await between this
  // check and setting _tuningInProgress, so two rooms can't both squeeze in.)
  const others = liveTvInUse(room);
  if (others + list.length > LIVETV_MAX_ROOMS) {
    const message = liveTvFullMessage(others, list.length);
    room.broadcast(io, 'livetv-tune-failed', { message });
    return message;
  }
  // Normally the old recording keeps playing until the new one is ready (a seamless switch). That holds
  // the old tuners as well as the new ones, so when there aren't enough for both — the usual case for
  // split view — the old recording is stopped first and the room shows the tuning overlay meanwhile.
  const held = liveTvSlots(room);
  // Split view swapping a channel without changing how many tiles there are keeps the recording (rewind
  // still reaches back before the swap); startHdhr stops the old source itself in that case.
  const keepDvr = split && hdhrEnabled() && room.liveTvSource === 'hdhr' && held > 0 && room.liveTvChannels.length === list.length;
  const overlap = !keepDvr && others + held + list.length <= LIVETV_MAX_ROOMS;
  room._tuningInProgress = true;
  room._tuningSlots = overlap ? held + list.length : list.length;
  room.lastPauseAt = 0;
  const gen = room._tuneGen || 0;
  // True once the room was closed, or reset (always-on) while we were still tuning
  const stale = () => rooms.get(room.id) !== room || (room._tuneGen || 0) !== gen;
  const label = list.map(c => String(c.channel || '').slice(0, 20)).join(' + ');

  // Tell everyone a channel is being tuned so their players can show progress while the DVR
  // records its first seconds. recorded/needed are DVR seconds (needed is null = unknown).
  const tuneNeeded = hdhrEnabled() ? HDHR_START_BEHIND_SEC + SEGMENT_SECS : null;
  const setTuning = (recorded) => {
    room.liveTuning = {
      channel: label.slice(0, 60),
      title: sanitizeText(list.map(c => c.channelTitle || c.channel || '').join(' + ').slice(0, 120)),
      recorded, needed: tuneNeeded,
    };
    room.broadcast(io, 'livetv-tuning', room.liveTuning);
  };
  setTuning(0);

  clearRoomManifest(room.id);
  let stoppedOld = keepDvr;
  if (!overlap && held && !keepDvr) { stopRelay(room.id); stoppedOld = true; }
  try {
    if (hdhrEnabled()) {
      // Straight from the HDHomeRun via ffmpeg — Plex is only used for the guide.
      const names = list.map(c => `${c.channel} ${c.channelTitle || ''}`.trim());
      await startHdhr(room.id, { channels: list.map(c => c.channel), names, keepDvr, readySec: tuneNeeded, onProgress: (rec) => { if (!stale()) setTuning(rec); } });
      if (stale()) { stopRelay(room.id); return; }
      setLiveChannels(room, list);
      room.liveTvSubKey       = null;
      room.liveTvSource       = 'hdhr';
      room.movieKey           = `hdhr-${room.liveTvChannels.map(c => c.channel).join('+')}`;
      const d = getDvr(room.id)?.info() || { start: 0, edge: 0 };
      room.position   = Math.max(d.start, d.edge - HDHR_START_BEHIND_SEC);
      room.playing    = true;
      room.lastUpdate = Date.now();
      room.broadcastState(io);
      refreshLiveTvProgram(room, io);
      console.log(`[Room] "${room.name}" → Live TV channel${split ? 's' : ''} ${label} via HDHomeRun${split ? ' (split view)' : ''}`);
      return;
    }
    const [{ channel, channelTitle, channelId }] = list;
    room.liveTvSource = 'plex';
    const liveTvManager = require('./livetv-manager');
    const { ratingKey, subKey, sessionKey } = await liveTvManager.tuneChannel(channelId);
    if (stale()) return;
    setLiveChannels(room, [{ channel, channelTitle, channelId }]);
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

    room.broadcastState(io);
    refreshLiveTvProgram(room, io);
    console.log(`[Room] "${room.name}" → Live TV channel ${room.liveTvChannel} (ratingKey=${ratingKey}, sub ${subKey})`);
  } catch (err) {
    if (err.cancelled || stale()) return;   // the room went away mid-tune: nothing to report
    console.error(`[Room] Failed to tune channel ${label}:`, err.message);
    if (stoppedOld) {
      // The old recording is gone too: the room has nothing on now (the host picks again)
      stopRelay(room.id);
      setLiveChannels(room, []);
      room.movieKey = null; room.liveTvSource = null; room.liveTvSubKey = null;
      room.playing = false; room.position = 0; room.lastUpdate = Date.now();
      room.liveTuning = null;
      room.broadcastState(io);
    }
    room.broadcast(io, 'livetv-tune-failed', { message: err.message });
    return `Failed to tune channel: ${err.message}`;
  } finally {
    // Only the current occupants' tune may clear these (a reset starts a new generation)
    if ((room._tuneGen || 0) === gen) {
      room._tuningInProgress = false;
      room._tuningSlots = 0;
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
    const nowOn = num => channels.find(c => c.number === num)?.nowPlaying || null;
    const program = nowOn(room.liveTvChannel);
    // Split view: what's on in every tile (programs[0] is the same as program)
    const programs = room.liveTvChannels.map(c => nowOn(c.channel));
    if (program !== (room.liveTvProgram || null) || programs.some((p, i) => p !== (room.liveTvPrograms[i] || null))) {
      room.liveTvProgram = program;
      room.liveTvPrograms = programs;
      room.broadcast(io, 'livetv-program', { program, programs });
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
      if (name && !wordfilter.isClean(name)) return socket.emit('error-msg', 'Please pick a room name without offensive words.');

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
      }, { room });
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
        if (room.unclaimedTimer) { clearTimeout(room.unclaimedTimer); room.unclaimedTimer = null; }
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
      socket.emit('chat-history', room.chatHistory);
      if (room.mutedIds?.has(String(user.id))) socket.emit('chat-muted', { muted: true });
      room.broadcastViewers(io);
      broadcastRoomList(io);   // the lobby's viewer count / host name change when someone arrives
      if (isHost && room.pendingChannels?.length) {
        // A pinned split bigger than today's limit (Settings, or fewer tuners) tunes the channels that fit
        const pending = room.pendingChannels.slice(0, liveSplitMax());
        room.pendingChannels = null;
        tuneRoomChannels(io, room, pending).catch(() => {});   // progress/failure reach everyone via livetv-tuning events
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
    // The browser only names the channel; its id and title come from the guide. (The id goes into a Plex URL when
    // Live TV runs through Plex's DVR, so a browser-supplied one could point the tune at any Plex path.)
    socket.on('select-livetv-channel', async ({ channel, channelId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      let ch;
      try {
        const { channels } = await require('./livetv-manager').getGuide();
        ch = channels.find(c => c.number === String(channel)) || (channelId != null && channels.find(c => c.channelId === String(channelId)));
      } catch { return socket.emit('error-msg', 'The channel guide is unavailable right now'); }
      if (!ch) return socket.emit('error-msg', 'Unknown channel');
      if (room.hostSocketId !== socket.id) return;   // host changed while the guide loaded
      const err = await tuneRoomChannel(io, room, { channel: ch.number, channelTitle: ch.title, channelId: ch.channelId });
      if (err) socket.emit('error-msg', err);
    });

    // ── Split view (host only, livetv rooms, HDHomeRun) ──
    // Put a channel in tile `slot` (0-based; slot = current count adds a tile), or take a tile away.
    // Either one re-records every tile, since they're all one ffmpeg picture. The channel is looked up in
    // the guide server-side, so the browser can't make us tune something that isn't there.
    socket.on('livetv-set-slot', async ({ slot, channel }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      const list = currentChannelList(room);
      if (!Number.isInteger(slot) || slot < 0 || slot > list.length) return;
      if (slot >= liveSplitMax()) return socket.emit('error-msg', splitLimitMessage());
      let ch;
      try { ch = (await require('./livetv-manager').getGuide()).channels.find(c => c.number === String(channel)); }
      catch { return socket.emit('error-msg', 'The channel guide is unavailable right now'); }
      if (!ch) return socket.emit('error-msg', 'Unknown channel');
      if (list.some((c, i) => i !== slot && c.channel === ch.number)) return socket.emit('error-msg', 'That channel is already on screen');
      if (list[slot]?.channel === ch.number) return;
      list[slot] = { channel: ch.number, channelTitle: ch.title, channelId: ch.channelId };
      const err = await tuneRoomChannels(io, room, list);
      if (err) socket.emit('error-msg', err);
    });

    socket.on('livetv-remove-slot', async ({ slot }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      const list = currentChannelList(room);
      if (list.length < 2 || !Number.isInteger(slot) || slot < 0 || slot >= list.length) return;
      list.splice(slot, 1);
      const err = await tuneRoomChannels(io, room, list);
      if (err) socket.emit('error-msg', err);
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

    // ── Playback (anyone in room, unless locked; Live TV: the host only) ───────────
    // The page never sends these from a Live TV guest, but the rule has to hold for a hand-made client too.
    const mayControl = room => socket.id === room.hostSocketId || (room.roomType !== 'livetv' && !room.settings.playbackLocked);

    socket.on('play', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (room.resyncTimer) return;   // a resync is counting down; it will resume everyone itself
      if (!playPauseLimiter.allow(socket.id)) return;
      if (!mayControl(room)) return;
      room.position = validPosition(position) ?? room.currentPosition();
      room.playing = true; room.lastUpdate = Date.now();
      room.broadcastState(io);
      room.chat(io, {
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
      if (!mayControl(room)) return;
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
      room.chat(io, {
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
      if (!mayControl(room)) return;
      if (!seekLimiter.allow(socket.id)) return;
      if (validPosition(position) == null) return;
      room.position = position; room.lastUpdate = Date.now();
      room.broadcastState(io);
    });

    // ── Chat ───────────────────────────────────────────────
    // { text, gif?, replyTo?, videoTime? }. A GIF is named by its Giphy id only; the server looks it up (gifs.js),
    // so a browser can't put an arbitrary image URL in front of everyone.
    socket.on('chat', async (data) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (room.mutedIds?.has(String(user.id))) return socket.emit('chat-muted', { muted: true });
      if (!chatLimiter.allow(socket.id)) return;
      const trimmed = wordfilter.clean(cleanChat(typeof data.text === 'string' ? data.text : ''));
      let gif = null;
      if (data.gif) {
        gif = await gifs.lookup(String(data.gif));
        if (!gif) return socket.emit('error-msg', 'That GIF could not be posted.');
        if (socketToRoom.get(socket.id) !== room) return;   // left while Giphy answered
      }
      // An image this person uploaded to this room (POST /api/chat/upload) and hasn't posted yet
      let image = null;
      if (data.image) {
        const up = room.uploads.get(String(data.image));
        if (!up || up.by !== String(user.id) || up.posted) return socket.emit('error-msg', 'That image could not be posted.');
        if (!uploads.allowedFor(user)) return socket.emit('error-msg', 'Image uploads are turned off.');
        up.posted = true;
        image = { id: String(data.image), w: up.w, h: up.h };
      }
      if (!trimmed && !gif && !image) return;
      const quoted = data.replyTo != null && room.chatHistory.find(m => m.id === Number(data.replyTo) && !m.deleted);
      const replyTo = quoted ? { id: quoted.id, name: quoted.name, text: quoted.text ? quoted.text.slice(0, 140) : (quoted.gif ? 'GIF' : quoted.image ? 'Image' : '') } : null;
      typingStopped(room);
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
      room.chat(io, {
        name: user.displayName || user.name,
        fromId: String(user.id),
        fromAdmin: isAdmin,
        text: trimmed,
        gif,
        image,
        replyTo,
        isGuest: user.isGuest || false,
        videoTime,
        mentions
      });
    });

    // Delete a message: your own, or anyone's if you're the host or the server owner (a host can't remove the owner's)
    socket.on('chat-delete', ({ id }) => {
      const room = socketToRoom.get(socket.id);
      const msg = room?.chatHistory.find(m => m.id === Number(id));
      if (!msg || msg.deleted) return;
      const mine = msg.fromId === String(user.id);
      const mod = isAdmin || (room.hostSocketId === socket.id && !msg.fromAdmin);
      if (!mine && !mod) return;
      if (msg.image) { uploads.remove(room.id, msg.image.id); room.uploads.delete(msg.image.id); }
      msg.deleted = true; msg.text = ''; msg.gif = null; msg.image = null; msg.replyTo = null; msg.mentions = []; msg.reactions = null;
      msg.deletedBy = mine ? null : (user.displayName || user.name);
      for (const m of room.chatHistory) if (m.replyTo?.id === msg.id) m.replyTo.text = '';   // quotes of it go blank too
      room.broadcast(io, 'chat-deleted', { id: msg.id, by: msg.deletedBy });
      if (!mine) console.log(`[Room] ${user.displayName || user.name} deleted a message by ${msg.name} in "${room.name}"`);
    });

    // React to a chat message with one of REACTIONS; sending the same one again takes it back.
    // msg.reactions = { emoji: [{ id, name }] } — names so people can see who reacted.
    socket.on('chat-react', ({ id, emoji }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || !REACTIONS.includes(emoji)) return;
      if (room.mutedIds?.has(String(user.id))) return socket.emit('chat-muted', { muted: true });
      if (!chatReactLimiter.allow(socket.id)) return;
      const msg = room.chatHistory.find(m => m.id === Number(id));
      if (!msg || msg.deleted || msg.isSystem) return;
      const uid = String(user.id);
      const rx = msg.reactions || (msg.reactions = {});
      const list = rx[emoji] || (rx[emoji] = []);
      const i = list.findIndex(r => r.id === uid);
      if (i >= 0) list.splice(i, 1); else list.push({ id: uid, name: user.displayName || user.name });
      if (!list.length) delete rx[emoji];
      room.broadcast(io, 'chat-reactions', { id: msg.id, reactions: rx });
    });

    // "… is typing" — relayed to everyone else in the room, throttled; the browser times it out
    socket.on('typing', () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.mutedIds?.has(String(user.id)) || !typingLimiter.allow(socket.id)) return;
      room.viewers.forEach((_, sid) => { if (sid !== socket.id) io.to(sid).emit('typing', { sid: socket.id, name: user.displayName || user.name }); });
    });
    function typingStopped(room) {
      room.viewers.forEach((_, sid) => { if (sid !== socket.id) io.to(sid).emit('typing', { sid: socket.id, stop: true }); });
    }

    // Mute someone in chat (host or server owner). Lasts until the room closes, keyed by user id so a refresh
    // doesn't undo it. The owner can't be muted, and only the owner can mute the host.
    socket.on('mute-viewer', ({ targetSocketId, muted }) => {
      const room = socketToRoom.get(socket.id);
      const target = room?.viewers.get(targetSocketId);
      if (!room || !target || targetSocketId === socket.id || target.isAdmin) return;
      if (!isAdmin && room.hostSocketId !== socket.id) return;
      const id = String(target.id);
      if (muted) (room.mutedIds || (room.mutedIds = new Set())).add(id);
      else room.mutedIds?.delete(id);
      const by = user.displayName || user.name;
      room.viewers.forEach((v, sid) => { if (String(v.id) === id) io.to(sid).emit('chat-muted', { muted: !!muted, by }); });
      room.broadcastViewers(io);
      console.log(`[Room] ${by} ${muted ? 'muted' : 'unmuted'} ${target.name} in "${room.name}"`);
    });

    // ── Reactions ──────────────────────────────────────────
    socket.on('reaction', ({ emoji }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!room.settings.reactionsEnabled) return;
      if (!reactionLimiter.allow(socket.id)) return;
      if (!REACTIONS.includes(emoji)) return;
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

    // ── Rename someone in the room ─────────────────────────
    // The server owner can rename anyone (a Plex user's rename becomes their nickname everywhere, like the admin
    // People page); a host can rename guests in their own room (a guest's name only lives in their session).
    socket.on('rename-viewer', ({ targetSocketId, name }) => {
      const room = socketToRoom.get(socket.id);
      const target = room?.viewers.get(targetSocketId);
      if (!room || !target) return;
      const amHost = room.hostSocketId === socket.id;
      if (!isAdmin && !amHost) return socket.emit('error-msg', 'Only the host can rename people.');
      if (!isAdmin && !target.isGuest) return socket.emit('error-msg', 'Only the server owner can rename Plex users.');
      if (target.isAdmin && !isAdmin) return;
      const clean = sanitizeText(String(name || '').trim().slice(0, 40));
      if (!clean) return socket.emit('error-msg', 'Enter a name.');
      if (!wordfilter.isClean(clean)) return socket.emit('error-msg', wordfilter.NAME_REFUSED);
      if (!target.isGuest) users.setNickname(target.id, clean);
      console.log(`[Room] ${user.displayName || user.name} renamed ${target.name} → ${clean} in "${room.name}"`);
      applyRename(target.id, clean, user.displayName || user.name);
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
      room.chat(io, { name: user.displayName || user.name, text: '🔄 forced a resync', isSystem: true, videoTime: Math.floor(position) });
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
      typingLimiter.delete(socket.id);
      chatReactLimiter.delete(socket.id);
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
          closeRoom(io, room, 'Host left the room');   // also clears its timers and chat images
        } else {
          // Give the Plex host a grace window to reconnect (e.g. lobby → watch navigation).
          // If they rejoin before the timer fires it will be cancelled.
          console.log(`[Room] Host "${user.name}" disconnected from "${room.name}" — waiting to see if they reconnect…`);
          room.closeTimer = setTimeout(() => {
            room.closeTimer = null;
            if (rooms.get(room.id) !== room) return; // already cleaned up
            console.log(`[Room] "${room.name}" closed — host did not reconnect`);
            closeRoom(io, room, 'Host left the room');
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
const UNCLAIMED_ROOM_MS = 6 * 3600 * 1000;   // how long a scheduled room waits for its first Plex user

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

  // Nobody turned up: don't leave the room in the lobby until the next restart. (Once someone has hosted it,
  // it closes the usual way, when the host leaves.)
  room.unclaimedTimer = setTimeout(() => {
    room.unclaimedTimer = null;
    if (rooms.get(room.id) !== room || !room.awaitingHost || !_io) return;
    console.log(`[Scheduler] Room "${room.name}" closed — nobody arrived to host it`);
    closeRoom(_io, room, 'Nobody arrived to host this watch night');
  }, UNCLAIMED_ROOM_MS);
  room.unclaimedTimer.unref();

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

/**
 * Show a new name for someone everywhere they're connected right now: their open sockets (and the sessions behind
 * them, so a reload keeps it), every room's viewer list, and a room's host name. Plex users' nicknames are already
 * in the registry by the time this runs (the registry wins on their next connection anyway); a guest's name lives
 * only in their session, which this saves. `by` (optional) is who renamed them, for a system line in the room chat.
 */
function applyRename(userId, name, by = null) {
  if (!_io) return;
  userId = String(userId);
  let oldName = null;
  for (const s of _io.sockets.sockets.values()) {
    const u = s.user;
    if (!u || String(u.id) !== userId) continue;
    oldName = oldName || u.displayName || u.name;
    if (u.isGuest) u.name = name; else u.displayName = name || undefined;
    const sess = s.request.session;
    if (sess?.user && String(sess.user.id) === userId) {
      if (u.isGuest) sess.user.name = name; else sess.user.displayName = name || undefined;
      sess.save?.(() => {});
    }
  }
  for (const room of rooms.values()) {
    let touched = false;
    for (const v of room.viewers.values()) {
      if (String(v.id) !== userId) continue;
      const shown = name || _io.sockets.sockets.get(v.socketId)?.user?.name || v.name;
      oldName = oldName || v.name;
      v.name = shown;
      if (v.isHost) room.hostName = shown;
      touched = true;
    }
    if (!touched) continue;
    room.broadcastViewers(_io);
    if (by && oldName && name) room.chat(_io, { name: by, text: `✏️ renamed ${oldName} to ${name}`, isSystem: true });
  }
}

/**
 * May this session user use room `roomId`'s chat images? They must be in the room right now (a guest's invite also
 * has to be for it), and for uploading, not muted. Returns the room or null.
 */
function chatRoomFor(user, roomId, { upload = false } = {}) {
  const room = rooms.get(roomId);
  if (!room || !user) return null;
  if (user.isGuest && room.inviteToken !== user.inviteToken) return null;
  const here = [...room.viewers.values()].some(v => String(v.id) === String(user.id));
  if (!here) return null;
  if (upload && room.mutedIds?.has(String(user.id))) return null;
  return room;
}

/** Note a freshly stored upload against its room, so only its uploader can post it (once). */
function registerUpload(room, userId, info) {
  room.uploads.set(info.id, { by: String(userId), w: info.w, h: info.h, posted: false });
  // Never posted (closed the tab, cancelled): don't keep it around
  setTimeout(() => {
    const up = room.uploads.get(info.id);
    if (up && !up.posted) { room.uploads.delete(info.id); uploads.remove(room.id, info.id); }
  }, 15 * 60 * 1000).unref();
}

/** Which room types the server has turned on (for the admin API). */
const enabledRoomTypes = () => ({ ..._enabledRoomTypes });

module.exports = {
  setupSync, getRoomByInviteToken, createScheduledRoom, getRoom, adminCloseRoom, onlineUserIds, applyRename,
  chatRoomFor, registerUpload,
  createPersistentRoom, restorePersistentRooms, getPersistentRoom, removePersistentRoom, enabledRoomTypes,
  liveTvCapacity,
};
