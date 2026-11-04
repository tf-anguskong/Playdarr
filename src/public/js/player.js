'use strict';

const socket   = io();
const roomId   = location.pathname.split('/').pop();

const video       = document.getElementById('video-player');
const noMovie     = document.getElementById('no-movie');
const noMovieText = document.getElementById('no-movie-text');
const titleEl     = document.getElementById('movie-title');
const roomNameEl  = document.getElementById('room-name');
const viewersList = document.getElementById('viewers-list');
const syncDot     = document.getElementById('sync-dot');
const syncText    = document.getElementById('sync-text');

let isSyncing        = false;
let syncTimer        = null;
let currentKey          = null;
let currentLiveTvChannel = null; // channel number/id — stable across retune (unlike movieKey/ratingKey)
let activeLiveTvChannel = null;  // channel number for guide highlighting
let hlsInstance      = null;
let isHost           = false;
let isAdmin          = false;   // Plex server owner: can kick anyone and close the room
let roomType         = 'movie';
let roomSettings     = { playbackLocked: false, reactionsEnabled: true };
let sidebarCollapsed = false;
let unreadChats      = 0;
let lastKnownState   = null;

// ── Guide state ────────────────────────────────────────────
let guideOpen        = false;
let guideExpanded    = false;
let guideChannels    = [];
let guideFetchedAt   = 0;
const GUIDE_CLIENT_TTL = 10_000;  // don't re-ask the server more than every 10s

// ── YouTube state ──────────────────────────────────────────
let ytApiLoaded   = false;
let ytApiReady    = false;
let ytPlayer      = null;
let ytVideoId     = null;
let pendingYtInit = null;

const autoplayOnLoad = new URLSearchParams(location.search).has('autoplay');

// Escapes for text *and* attribute values (quotes included)
function esc(s = '') {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Join room ──────────────────────────────────────────────
socket.on('connect', () => socket.emit('join-room', { roomId }));

function setHostUI(on, inviteToken) {
  const isYt     = roomType === 'youtube';
  const isTv     = roomType === 'tv';
  const isLiveTv = roomType === 'livetv';
  const movieBtn     = document.getElementById('choose-movie-btn');
  const episodeBtn   = document.getElementById('choose-episode-btn');
  const channelBtn   = document.getElementById('choose-channel-btn');
  if (movieBtn)   movieBtn.style.display   = (on && !isYt && !isTv && !isLiveTv) ? 'block' : 'none';
  if (episodeBtn) episodeBtn.style.display = (on && isTv) ? 'block' : 'none';
  // In split view each tile has its own Change / Remove in the sidebar instead
  if (channelBtn) channelBtn.style.display = (on && isLiveTv && !liveSplit) ? 'block' : 'none';
  document.getElementById('yt-controls-section').style.display   = (on && isYt)  ? 'block' : 'none';
  document.getElementById('countdown-section').style.display     = (on && !isLiveTv) ? 'block' : 'none';
  document.getElementById('intermission-section').style.display  = (on && !isLiveTv) ? 'block' : 'none';
  document.getElementById('room-controls-section').style.display = on ? 'block' : 'none';
  const resyncBtn = document.getElementById('resync-btn');
  if (resyncBtn) resyncBtn.style.display = on ? 'block' : 'none';
  if (on && inviteToken) setupInviteLink(inviteToken);
  if (!on) document.getElementById('invite-section').style.display = 'none';
  if (isLiveTv) renderSplitUi();
}

function applyRoomSettings(settings) {
  roomSettings = { ...roomSettings, ...settings };
  const locked = roomSettings.playbackLocked;
  if (roomType === 'movie' || roomType === 'tv') {
    // When locked, hide native controls for guests so they can't seek/pause.
    // Hosts always keep native controls. A custom volume overlay fills the gap.
    video.controls = !locked || isHost;
    const volOverlay = document.getElementById('volume-overlay');
    if (volOverlay) volOverlay.style.display = (locked && !isHost) ? 'flex' : 'none';
  } else if (roomType === 'livetv') {
    // Live TV plays from the server DVR: the host has native controls (pause, seek,
    // rewind) and guests follow. Guests get the volume overlay instead.
    video.controls = isHost;
    video.style.cursor = '';
    const volOverlay = document.getElementById('volume-overlay');
    if (volOverlay) volOverlay.style.display = isHost ? 'none' : 'flex';
  }
  document.getElementById('reaction-bar').style.display = roomSettings.reactionsEnabled ? '' : 'none';
  if (isHost) {
    const lockEl = document.getElementById('toggle-lock-playback');
    const reactEl = document.getElementById('toggle-reactions');
    if (lockEl) lockEl.checked = !!locked;
    if (reactEl) reactEl.checked = !!roomSettings.reactionsEnabled;
  }
}

socket.on('room-state', (state) => {
  isHost = state.isHost;
  if (video.playbackRate !== 1) video.playbackRate = 1;   // a (re)join starts from normal speed
  isAdmin = !!state.isAdmin;
  const closeBtn = document.getElementById('admin-close-room-btn');
  if (closeBtn) closeBtn.style.display = isAdmin ? 'block' : 'none';
  roomType = state.roomType || 'movie';
  roomNameEl.textContent = state.name || '';

  // For LiveTV, reset currentKey to ensure fresh stream load from Playdarr proxy
  // This prevents stale connections from previous rooms/sessions
  if (roomType === 'livetv') {
    currentKey = null;
    currentLiveTvChannel = null;
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  }
  setHostUI(isHost, state.inviteToken);
  if (state.settings) applyRoomSettings(state.settings);
  applyState(state);
  // Resume intermission overlay if one is active when joining
  if (state.intermissionEndsAt && state.intermissionEndsAt > Date.now()) {
    showIntermissionOverlay(state.intermissionEndsAt);
  }
});

socket.on('room-settings', applyRoomSettings);

// Refusals from the server (e.g. a rename the word filter or permissions rejected)
socket.on('error-msg', (msg) => {
  if (typeof msg !== 'string' || !msg) return;
  // A failed Live TV tune is already written under the (hidden) player — no second copy as a toast
  if (lastTuneFail?.message && msg.includes(lastTuneFail.message) && Date.now() - lastTuneFail.at < 3000 && noMovie.style.display !== 'none') return;
  showNotif(`⚠️ ${msg}`);
});
let lastTuneFail = null;   // { message, at } of the latest 'livetv-tune-failed'

socket.on('kicked', ({ byAdmin } = {}) => {
  leavePip();
  alert(`You have been removed from this room by the ${byAdmin ? 'server owner' : 'host'}.`);
  window.location.href = '/';
});

document.getElementById('admin-close-room-btn')?.addEventListener('click', () => {
  if (confirm('Close this room for everyone in it?')) socket.emit('admin-close-room', { roomId });
});

socket.on('state', applyState);

// Server restarted the relay (retune or channel change) — reload the HLS player.
socket.on('livetv-reload', () => {
  if (roomType !== 'livetv') return;
  const st = lastKnownState;
  const t = liveTarget();   // arrival-anchored (see liveState), not the client-vs-server wall-clock difference
  loadLiveTvRelay(t != null ? t : (st ? st.position : null), !st || st.playing);
});

socket.on('room-error', (msg) => {
  leavePip();
  alert(msg + '\n\nRedirecting to lobby.');
  window.location.href = '/';
});

socket.on('room-closed', ({ reason }) => {
  leavePip();
  alert(reason || 'Room closed.');
  window.location.href = '/';
});

// ── Invite link (host only) ────────────────────────────────
function setupInviteLink(inviteToken) {
  const inviteSection = document.getElementById('invite-section');
  if (!inviteSection) return;

  const url = `${location.origin}/join/${inviteToken}`;
  inviteSection.style.display = 'block';

  document.getElementById('copy-invite-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copy-invite-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy Invite Link', 2000);
    });
  });
}

// ── Sync indicator ─────────────────────────────────────────
function setSyncing(v) {
  syncDot.className = `sync-dot ${v ? 'syncing' : 'synced'}`;
  syncText.textContent = v ? 'Syncing…' : 'Synced';
}
function releaseSyncLock() {
  if (roomType === 'livetv') liveLog('sync lock release scheduled');
  syncTimer = setTimeout(() => { isSyncing = false; setSyncing(false); }, 400);
}

// ── Apply server state ─────────────────────────────────────
function applyState(state) {
  lastKnownState = state;
  if (state.roomType === 'youtube') {
    video.style.display = 'none';
    applyYtState(state);
    return;
  }
  if (state.roomType === 'livetv') {
    applyLiveTvState(state);
    return;
  }
  // Hide YouTube player if switching room types
  document.getElementById('yt-player-container').style.display = 'none';
  document.getElementById('livetv-info').style.display = 'none';
  document.getElementById('guide-toggle-btn').style.display = 'none';
  closeGuide();

  if (!state.movieKey) {
    video.style.display = 'none';
    noMovie.style.display = 'block';
    titleEl.textContent = state.roomType === 'tv' ? 'No episode selected' : 'No movie selected';
    noMovieText.textContent = state.roomType === 'tv'
      ? 'Waiting for host to choose an episode…'
      : 'Waiting for host to choose a movie…';
    return;
  }

  noMovie.style.display = 'none';
  video.style.display = 'block';
  titleEl.textContent = state.movieTitle || 'Now Playing';

  // Anchor the room clock to when this update ARRIVED (client clock only). state.position is already extrapolated to
  // the moment the server sent it, so adding (Date.now() - state.lastUpdate) would fold any difference between the
  // client's and the server's wall clocks straight into the sync error.
  const projected = movieTarget();   // where the previous anchor said the room should be right now
  movieState = state;
  movieStateAt = performance.now();
  const targetTime = state.position;   // the room's position at this instant
  // A deliberate jump of the room clock (someone scrubbed, a resync) must be followed at once, so lift the seek gap
  if (projected != null && Math.abs(targetTime - projected) > 1.5) movieSeekAt = -1e9;

  // New movie — full reload
  if (state.movieKey !== currentKey) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    currentKey = state.movieKey;
    loadHls(state.movieKey, targetTime, state.playing);
    return;
  }

  // Sync play/pause state
  if (state.playing && video.paused) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    tryPlay();
    releaseSyncLock();
  } else if (!state.playing && !video.paused) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    video.currentTime = targetTime;
    video.pause();
    releaseSyncLock();
    return;
  }

  if (!state.playing) {
    // Paused: park at the room's position (e.g. someone scrubbed while we were already paused)
    if (Math.abs(video.currentTime - targetTime) > 0.5) {
      isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
      video.currentTime = targetTime;
      releaseSyncLock();
    }
    return;
  }
  // Playing: the chase loop below keeps this viewer on the room clock, continuously
}

// ── Movie / TV sync: everyone chases the room clock ────────────────────────────────────────
// The server holds the clock (position + time since the last play/pause/seek). Every viewer — host included, since
// anyone may scrub — steers onto it with a gentle, proportional playback-rate change checked four times a second,
// and only hard-seeks when far off. A seek costs a rebuffer on a transcoded stream, so the threshold is generous and
// automatic seeks are spaced out: a viewer who stalls for a few seconds would otherwise seek forward, stall again,
// and chase the room in circles.
// Hysteresis (start correcting past 0.15 s, stop inside 0.05 s) and 1 % rate steps keep speed changes rare, which
// matters because every speed change is audible as a faint pitch wobble.
let movieState = null;
let movieStateAt = 0;
const movieTarget = () => (movieState ? (movieState.playing ? movieState.position + (performance.now() - movieStateAt) / 1000 : movieState.position) : null);
const MOVIE_SEEK_SEC = 5;
const MOVIE_SEEK_GAP_MS = 8000;
let movieCorrecting = false;
let movieRateAt = -1e9;
let movieSeekAt = -1e9;
setInterval(() => {
  if (roomType !== 'movie' && roomType !== 'tv') return;
  if (!movieState || !movieState.playing || video.paused) { movieCorrecting = false; resetPlaybackRate('not playing'); return; }
  if (isSyncing || video.readyState < 3) return;
  const target = movieTarget();
  if (target == null) return;
  const drift = video.currentTime - target;   // + = ahead of the room
  const abs = Math.abs(drift);

  if (abs > MOVIE_SEEK_SEC && performance.now() - movieSeekAt > MOVIE_SEEK_GAP_MS) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    video.currentTime = target;
    releaseSyncLock();
    movieSeekAt = performance.now();
    movieCorrecting = false;
    return;
  }
  if (!movieCorrecting && abs > 0.15) movieCorrecting = true;
  else if (movieCorrecting && abs < 0.05) movieCorrecting = false;

  let rate = 1;
  if (movieCorrecting) rate = 1 - Math.max(-0.08, Math.min(0.08, drift * 0.4));
  rate = Math.round(rate * 100) / 100;
  const now = performance.now();
  if (Math.abs(video.playbackRate - rate) >= 0.01 && (rate === 1 || now - movieRateAt > 1000)) {
    video.playbackRate = rate;
    movieRateAt = now;
  }
}, 250);

// ── HLS loader ─────────────────────────────────────────────
function showPlayOverlay() {
  const overlay = document.getElementById('play-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hidePlayOverlay() {
  const overlay = document.getElementById('play-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Make the entire overlay clickable — the native video spinner can intercept
// clicks on the button specifically, so we catch clicks on the whole overlay.
// Re-sync to current authoritative position so guests who clicked late don't
// start from where the manifest was loaded rather than where the movie is now.
document.getElementById('play-overlay')?.addEventListener('click', () => {
  hidePlayOverlay();
  if (lastKnownState && lastKnownState.playing) {
    // The room clock anchored to when its last update arrived — not (Date.now() - state.lastUpdate), which would
    // mix the client's and server's wall clocks
    const catchUpTo = roomType === 'livetv' ? liveTarget()
      : (roomType === 'movie' || roomType === 'tv') ? movieTarget()
      : lastKnownState.position;
    isSyncing = true;
    if (catchUpTo != null && roomType !== 'livetv') video.currentTime = catchUpTo;
    else if (catchUpTo != null) liveSeekAbs(catchUpTo);
  }
  video.play().catch(console.warn);
  releaseSyncLock();
});

function tryPlay() {
  return video.play().then(() => {
    hidePlayOverlay();
  }).catch(() => {
    // Autoplay blocked — retry muted (browsers always allow muted autoplay)
    video.muted = true;
    return video.play().then(() => {
      hidePlayOverlay();
      // Unmute on first user interaction
      const unmute = () => { video.muted = false; document.removeEventListener('click', unmute); document.removeEventListener('keydown', unmute); };
      document.addEventListener('click', unmute, { once: false });
      document.addEventListener('keydown', unmute, { once: false });
    }).catch(() => {
      showPlayOverlay();
    });
  });
}

function loadHls(ratingKey, targetTime, shouldPlay) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  hidePlayOverlay();
  const src = `/api/stream/hls/${roomId}/${ratingKey}/master.m3u8`;

  // Show the overlay proactively unless this is a fresh join navigation,
  // where the browser may allow autoplay and we want seamless playback.
  if (shouldPlay && !autoplayOnLoad) showPlayOverlay();

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    // startPosition: -1 lets HLS.js read the stream layout before seeking.
    // Jumping straight to targetTime on a shared mid-session Plex stream causes
    // buffer append errors due to codec init / segment boundary mismatches.
    // We seek to targetTime ourselves once the manifest is parsed.
    hlsInstance = new Hls({ startPosition: -1, enableWorker: true });
    hlsInstance.loadSource(src);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.currentTime = targetTime;
      if (shouldPlay) {
        video.play().then(() => {
          hidePlayOverlay();
          releaseSyncLock();
        }).catch(() => {
          if (!autoplayOnLoad) showPlayOverlay(); // guests use native controls as fallback
        });
      } else {
        releaseSyncLock();
      }
    });
    let networkRetried = false;
    hlsInstance.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn('[HLS] Media error, attempting recovery:', d.details);
        hlsInstance.recoverMediaError();
      } else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !networkRetried) {
        // Network error — Plex session likely expired. Bust the server-side
        // manifest cache and destroy+recreate the HLS instance so we start
        // completely fresh rather than trying to recover on a broken instance.
        networkRetried = true;
        console.warn('[HLS] Network error, busting manifest and restarting:', d.details);
        const offsetMs = Math.floor((video.currentTime || 0) * 1000);
        const bustSrc = `${src}?bust=1&offset=${offsetMs}`;
        setTimeout(() => {
          if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
          hlsInstance = new Hls({ startPosition: -1, enableWorker: true });
          hlsInstance.loadSource(bustSrc);
          hlsInstance.attachMedia(video);
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            video.currentTime = offsetMs / 1000;
            video.play().catch(() => {});
          });
          hlsInstance.on(Hls.Events.ERROR, (__, d2) => {
            if (!d2.fatal) return;
            console.error('[HLS] Fatal after bust:', d2.type, d2.details);
            hidePlayOverlay();
            noMovieText.textContent = `Stream error: ${d2.details} — try refreshing.`;
            noMovie.style.display = 'block';
            video.style.display = 'none';
            currentKey = null; // allow next state sync to retry the stream
          });
        }, 2000);
      } else {
        console.error('[HLS] Fatal:', d.type, d.details);
        hidePlayOverlay();
        noMovieText.textContent = `Stream error: ${d.details} — try refreshing.`;
        noMovie.style.display = 'block';
        video.style.display = 'none';
        currentKey = null; // allow next state sync to retry the stream
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = targetTime;
      if (shouldPlay) {
        video.play().then(() => {
          hidePlayOverlay();
          releaseSyncLock();
        }).catch(() => {
          if (!autoplayOnLoad) showPlayOverlay();
        });
      } else {
        releaseSyncLock();
      }
    }, { once: true });
  }
}

// ── Live TV player (server DVR → HLS) ────────────────────────
// Connects to /api/stream/live/:roomId/index.m3u8 — the per-room DVR the server
// records from Plex. Every segment carries a PROGRAM-DATE-TIME derived from the
// DVR clock, so each client can convert its own video.currentTime to and from
// "DVR seconds", the shared timeline the room position is expressed in.
const DVR_EPOCH_MS = Date.UTC(2020, 0, 1);

// Batch client-side Live TV debug lines to the server so they land in the docker logs.
const liveLogQueue = [];
let liveLogTimer = null;
function liveLog(msg) {
  console.log('[LiveTV]', msg);
  liveLogQueue.push(`${(performance.now() / 1000).toFixed(1)}s ${msg}`);
  if (!liveLogTimer) liveLogTimer = setTimeout(() => {
    liveLogTimer = null;
    const lines = liveLogQueue.splice(0);
    fetch('/api/stream/live-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }), keepalive: true
    }).catch(() => {});
  }, 500);
}
let liveTlOffset = null; // DVR seconds minus video.currentTime for this client

const fragDvrStart = f => (f.programDateTime - DVR_EPOCH_MS) / 1000; // DVR seconds at fragment start
function liveAbs(t = video.currentTime) { return liveTlOffset == null ? null : t + liveTlOffset; }
function liveSeekAbs(abs) { if (liveTlOffset != null) video.currentTime = abs - liveTlOffset; }
function liveDetails() {
  return hlsInstance && (hlsInstance.latestLevelDetails || hlsInstance.levels?.[hlsInstance.currentLevel]?.details) || null;
}
/** Newest recorded DVR second this client knows about (from its last playlist load). */
function liveEdgeAbs() {
  const frags = liveDetails()?.fragments;
  const last = frags?.[frags.length - 1];
  return last && last.programDateTime != null ? fragDvrStart(last) + last.duration : null;
}

function loadLiveTvRelay(targetAbs, shouldPlay) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  liveTlOffset = null;
  tuningArmed = true;
  liveLog(`load relay: target=${targetAbs == null ? 'null' : targetAbs.toFixed(1)} play=${shouldPlay} host=${isHost} hls=${Hls.isSupported()}`);
  hidePlayOverlay();
  document.getElementById('yt-player-container').style.display = 'none';
  video.style.display = 'block';
  noMovie.style.display = 'none';

  const src = `/api/stream/live/${roomId}/index.m3u8`;

  if (Hls.isSupported()) {
    // Loading starts normally; once the first playlist arrives we know how this
    // client's timeline maps to DVR seconds and restart loading at the target.
    // Never auto-jump to the live edge — the host decides where the room is.
    try {
      // hls.js rejects liveMaxLatencyDurationCount unless liveSyncDurationCount is set and smaller.
      hlsInstance = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: Infinity,
        maxLiveSyncPlaybackRate: 1,
        backBufferLength: 600,
      });
    } catch (err) {
      liveLog(`Hls init failed: ${err.message}`);
      return;
    }
    let started = false;
    hlsInstance.loadSource(src);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => liveLog('manifest parsed'));
    // Split view: once the channels' audio tracks are known, switch to the one this viewer picked
    hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => applySplitAudio());
    hlsInstance.on(Hls.Events.LEVEL_LOADED, (_, data) => {
      const frags = data.details.fragments;
      const first = frags[0], last = frags[frags.length - 1];
      if (!started) liveLog(`level loaded: ${frags.length} frags, first.start=${first?.start} first.pdt=${first?.programDateTime}`);
      if (!first || first.programDateTime == null) { if (!started) liveLog('no programDateTime on fragments — cannot map DVR timeline'); return; }
      liveTlOffset = fragDvrStart(first) - first.start;
      if (started) return;
      started = true;
      const lo = fragDvrStart(first);
      const hi = fragDvrStart(last) + last.duration - 3;
      const abs = Math.min(Math.max(targetAbs ?? hi, lo), Math.max(lo, hi));
      console.log(`[LiveTV] DVR ${lo.toFixed(1)}–${(hi + 3).toFixed(1)}s, starting at ${abs.toFixed(1)}s`);
      liveLog(`startLoad at client t=${(abs - liveTlOffset).toFixed(1)} offset=${liveTlOffset.toFixed(1)}`);
      hlsInstance.startLoad(abs - liveTlOffset);
      if (shouldPlay) tryPlay();
      releaseSyncLock();
    });
    hlsInstance.on(Hls.Events.FRAG_LOADED, (_, d) => { if (!window.__liveFragLogged) { window.__liveFragLogged = 0; } if (window.__liveFragLogged++ < 3) liveLog(`frag loaded sn=${d.frag.sn} start=${d.frag.start}`); });
    hlsInstance.on(Hls.Events.BUFFER_APPENDED, () => { if (!window.__liveBufLogged) { window.__liveBufLogged = 1; liveLog('first buffer appended'); } });
    hlsInstance.on(Hls.Events.FRAG_CHANGED, (_, data) => {
      const f = data.frag;
      if (f && f.programDateTime != null) liveTlOffset = fragDvrStart(f) - f.start;
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      liveHlsErrors++;
      liveLog(`hls ${data.fatal ? 'FATAL' : 'error'}: ${data.type} / ${data.details}${data.response ? ' http ' + data.response.code : ''}`);
      if (!data.fatal) return;
      console.error('[LiveTV] HLS fatal error:', data.type, data.details);
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hlsInstance.recoverMediaError(); return; }
      // Tell the server to retune — it will restart the relay and emit livetv-reload
      if (isHost) socket.emit('retune-livetv');
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari): no PROGRAM-DATE-TIME access, so the DVR timeline is unavailable;
    // play from the playlist's default start without position sync.
    video.src = src;
    video.addEventListener('loadedmetadata', () => {
      applySplitAudio();
      releaseSyncLock();
      tryPlay();
    }, { once: true });
  }
}

// Guests nudge video.playbackRate (a few percent) to stay in sync. Only the guest sync loop ever puts it back to 1,
// so anything that stops that loop — becoming the host, a paused room, a rejoin — must do it explicitly, or the
// room plays at e.g. 0.93x indefinitely (slowed, pitch-shifted, warbly audio until the page is refreshed).
function resetPlaybackRate(why) {
  if (video.playbackRate === 1) return;
  if (roomType === 'livetv') liveLog(`playbackRate ${video.playbackRate.toFixed(3)} → 1 (${why})`);
  video.playbackRate = 1;
}

// Latest server state and when it arrived (client clock), for continuous drift correction.
let liveState = null;
let liveStateAt = 0;
function liveTarget() {
  if (!liveState) return null;
  return liveState.playing ? liveState.position + (performance.now() - liveStateAt) / 1000 : liveState.position;
}

// Guests: every 250ms compare against the host-calibrated room position and steer.
// Small drift is closed by a gentle, proportional playback-rate change (imperceptible);
// only a large gap triggers a seek.
// Like the movie loop: hysteresis (start correcting past 0.15 s, stop inside 0.05 s), 1 % rate steps and at most
// one speed change a second, because Chrome time-stretches audio at any rate but 1 and every change is audible.
// Every path that doesn't steer puts the rate back to 1 — a seek, buffering or a lost timeline must never leave a
// guest at e.g. 0.93x (warbly audio until a refresh).
let liveDriftLogAt = 0;
let liveCorrecting = false;
let liveRateAt = -1e9;
setInterval(() => {
  if (roomType !== 'livetv') return;
  if (isHost) { liveCorrecting = false; resetPlaybackRate('host does not chase anyone'); return; }
  if (!liveState || !liveState.playing || video.paused) { liveCorrecting = false; resetPlaybackRate('paused'); return; }
  if (isSyncing || video.readyState < 3) { liveCorrecting = false; resetPlaybackRate(isSyncing ? 'syncing' : 'buffering'); return; }
  const target = liveTarget(), pos = liveAbs();
  if (target == null || pos == null) { liveCorrecting = false; resetPlaybackRate('no timeline'); return; }
  const drift = pos - target; // + = ahead of the host
  const abs = Math.abs(drift);
  if (abs > 1.5) {
    liveCorrecting = false;
    resetPlaybackRate('seek');
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    liveSeekAbs(target);
    releaseSyncLock();
    liveLog(`drift ${drift.toFixed(2)}s — seek`);
    return;
  }
  if (!liveCorrecting && abs > 0.15) liveCorrecting = true;
  else if (liveCorrecting && abs < 0.05) liveCorrecting = false;
  let rate = liveCorrecting ? 1 - Math.max(-0.08, Math.min(0.08, drift * 0.4)) : 1;
  rate = Math.round(rate * 100) / 100;
  const now = performance.now();
  if (Math.abs(video.playbackRate - rate) >= 0.01 && (rate === 1 || now - liveRateAt > 1000)) {
    video.playbackRate = rate;
    liveRateAt = now;
  }
  if (performance.now() - liveDriftLogAt > 15000) {
    liveDriftLogAt = performance.now();
    liveLog(`sync drift=${drift.toFixed(2)}s rate=${rate.toFixed(3)}`);
  }
}, 250);

// Live TV health line every 60 s (host and guests) into the server log as [LiveClient …], so a playback problem
// someone hears (e.g. slowed or warbly audio) can be matched to the player's state at that moment: speed, buffer
// ahead/behind, holes in the audio/video buffers, audio track, dropped frames and hls.js errors so far.
let liveHlsErrors = 0;
setInterval(() => {
  if (roomType !== 'livetv' || !hlsInstance || video.style.display === 'none') return;
  const holes = kind => { try { const b = hlsInstance.bufferController?.sourceBuffer?.[kind]; return b ? b.buffered.length : '-'; } catch { return '?'; } };
  const b = video.buffered, t = video.currentTime;
  const ahead = b.length ? (b.end(b.length - 1) - t).toFixed(0) : 0, behind = b.length ? (t - b.start(0)).toFixed(0) : 0;
  const q = video.getVideoPlaybackQuality?.();
  liveLog(`health ${new Date().toLocaleTimeString()} ${isHost ? 'host' : 'guest'} rate=${video.playbackRate} pitch=${video.preservesPitch !== false} `
    + `${video.paused ? 'paused' : 'playing'} rs=${video.readyState} buf=-${behind}/+${ahead}s ranges a=${holes('audio')} v=${holes('video')} `
    + `audio=${liveSplit ? splitAudioIndex() + 1 + '/' + liveSplit.length : '1'} drop=${q ? q.droppedVideoFrames + '/' + q.totalVideoFrames : '?'} hlsErr=${liveHlsErrors}`);
}, 60000);

// What's on air for the room's channel (from the Plex guide), shown beside the LIVE readout.
function setLiveProgram(program) {
  const el = document.getElementById('livetv-program');
  if (!el) return;
  el.textContent = program ? `· ${program}` : '';
  el.title = program || '';
}
socket.on('livetv-program', ({ program, programs } = {}) => {
  if (liveSplit && Array.isArray(programs)) {
    liveSplit.forEach((t, i) => { t.program = programs[i] || null; });
    renderSplitUi();
    setLiveProgram(liveSplit[splitAudioIndex()].program);
  } else setLiveProgram(program);
});

// ── Live TV split view ─────────────────────────────────────
// Several channels tiled into one picture (the server encodes it; see live-relay.js). Everyone shares the video;
// each viewer picks which channel they *hear*. hls.js sees the channels as alternate audio tracks in tile order.
// The choice is the viewer's own: it never goes to the server, and it's remembered per room by channel number.
let liveSplit        = null;   // state.liveTvSplit: [{ slot, channel, title, program, x, y, w, h }] or null
let liveSplitMax     = 1;      // most tiles this room may have (1 = split view unavailable)
let liveHasChannel   = false;
let splitAudioChannel = null;  // channel number this viewer is listening to
let splitAudioSlot    = 0;     // ...and which tile it was in (to follow the tile if the host replaces its channel)
const SPLIT_AUDIO_KEY = `livetv-split-audio:${roomId}`;
const savedSplitChannel = () => { try { return localStorage.getItem(SPLIT_AUDIO_KEY); } catch { return null; } };
const saveSplitChannel  = ch => { try { localStorage.setItem(SPLIT_AUDIO_KEY, ch); } catch { /* private mode */ } };

/** Which tile's audio is on (falls back to the first tile). */
function splitAudioIndex() {
  const i = liveSplit ? liveSplit.findIndex(t => t.channel === splitAudioChannel) : -1;
  return i >= 0 ? i : 0;
}

function applySplitState(state) {
  liveSplit      = Array.isArray(state.liveTvSplit) && state.liveTvSplit.length > 1 ? state.liveTvSplit : null;
  liveSplitMax   = state.liveTvSplitMax || 1;
  liveHasChannel = !!state.movieKey;
  if (liveSplit && !liveSplit.some(t => t.channel === splitAudioChannel)) {
    // Keep listening to the same channel while it's on screen. On arrival: the one remembered for this room.
    // If the host replaced the tile you were hearing: that tile's new channel (else tile 1).
    const saved = savedSplitChannel();
    if (splitAudioChannel == null && liveSplit.some(t => t.channel === saved)) splitAudioChannel = saved;
    else splitAudioChannel = (liveSplit[splitAudioSlot] || liveSplit[0]).channel;
  }
  if (liveSplit) splitAudioSlot = splitAudioIndex();
  applySplitAudio();
  renderSplitUi();
}

/** Switch to tile `slot`'s audio. */
function setSplitAudio(slot, { announce = false } = {}) {
  const tile = liveSplit && liveSplit[slot];
  if (!tile) return;
  splitAudioChannel = tile.channel;
  splitAudioSlot = slot;
  saveSplitChannel(tile.channel);
  applySplitAudio();
  renderSplitUi();
  setLiveProgram(tile.program);
  if (announce) showNotif(`🔊 ${tile.channel} ${tile.title || ''}`.trim());
}

/** Point the player at the chosen tile's audio track (hls.js, or Safari's native audioTracks). */
function applySplitAudio() {
  if (!liveSplit) return;
  const i = splitAudioIndex();
  if (hlsInstance) {
    if (hlsInstance.audioTracks.length > i && hlsInstance.audioTrack !== i) hlsInstance.audioTrack = i;
  } else if (video.audioTracks && video.audioTracks.length > i) {
    for (let k = 0; k < video.audioTracks.length; k++) video.audioTracks[k].enabled = k === i;
  }
}

/** Sidebar list of tiles, and the labels over the picture. */
function renderSplitUi() {
  const box = document.getElementById('livetv-split');
  const overlay = document.getElementById('split-tiles');
  if (!box || !overlay) return;
  const channelBtn = document.getElementById('choose-channel-btn');
  if (channelBtn) channelBtn.style.display = (isHost && roomType === 'livetv' && !liveSplit) ? 'block' : 'none';

  const count = liveSplit ? liveSplit.length : (liveHasChannel ? 1 : 0);
  const canAdd = isHost && liveHasChannel && count < liveSplitMax;
  if (!liveSplit && !canAdd) { box.style.display = 'none'; box.innerHTML = ''; }
  else {
    box.style.display = 'block';
    const on = splitAudioIndex();
    const rows = liveSplit ? liveSplit.map((t, i) => `
      <div class="split-row${i === on ? ' on' : ''}">
        <button type="button" class="split-pick" data-slot="${i}" title="Listen to this channel${liveSplit.length > 1 ? ` (key ${i + 1})` : ''}">
          <span class="split-ico" aria-hidden="true">${i === on ? '🔊' : i + 1}</span>
          <span class="split-name"><b>${esc(t.channel)}</b> ${esc(t.title || '')}${t.program ? `<span class="split-prog">${esc(t.program)}</span>` : ''}</span>
        </button>
        ${isHost ? `<button type="button" class="split-act" data-change="${i}" title="Change this channel">✎</button>
        <button type="button" class="split-act" data-remove="${i}" title="Take this channel off the screen">✕</button>` : ''}
      </div>`).join('') : '';
    box.innerHTML = `
      <div class="split-head"><span>Split view</span>${liveSplit ? `<span class="split-hint">keys 1–${liveSplit.length} switch audio</span>` : ''}</div>
      ${rows}
      ${canAdd ? `<button type="button" class="split-add" data-add="${count}">+ Add a channel${liveSplit ? '' : ' (split screen)'}</button>` : ''}`;
  }

  overlay.innerHTML = liveSplit ? liveSplit.map((t, i) => `
    <div class="split-tile${i === splitAudioIndex() ? ' on' : ''}" data-tile="${i}">
      <button type="button" class="split-chip" data-slot="${i}" title="Listen to this channel">
        ${i === splitAudioIndex() ? '🔊' : `<span class="split-key">${i + 1}</span>`} ${esc(t.channel)} ${esc(t.title || '')}
      </button>
    </div>`).join('') : '';
  positionSplitTiles();
}

// Clicks in the sidebar list and on the picture's labels
document.getElementById('livetv-split')?.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.slot != null) setSplitAudio(Number(b.dataset.slot));
  else if (b.dataset.change != null) openChannelPicker(Number(b.dataset.change));
  else if (b.dataset.add != null) openChannelPicker(Number(b.dataset.add));
  else if (b.dataset.remove != null) socket.emit('livetv-remove-slot', { slot: Number(b.dataset.remove) });
});
document.getElementById('split-tiles')?.addEventListener('click', e => {
  const b = e.target.closest('.split-chip');
  if (b) setSplitAudio(Number(b.dataset.slot));
});

// Keys 1–4 switch audio — they also work with the video fullscreen, where the labels can't be shown
document.addEventListener('keydown', e => {
  if (!liveSplit || roomType !== 'livetv' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= liveSplit.length) { e.preventDefault(); setSplitAudio(n - 1, { announce: true }); }
});

/** Lay the labels over the tiles: the picture is letterboxed inside the <video> box (object-fit: contain). */
function positionSplitTiles() {
  const overlay = document.getElementById('split-tiles');
  if (!overlay) return;
  const show = !!liveSplit && video.style.display !== 'none' && video.videoWidth > 0;
  overlay.style.display = show ? 'block' : 'none';
  if (!show) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const bw = video.clientWidth, bh = video.clientHeight;
  const scale = Math.min(bw / vw, bh / vh);
  const pw = vw * scale, ph = vh * scale;
  const left = video.offsetLeft + (bw - pw) / 2, top = video.offsetTop + (bh - ph) / 2;
  // Keep labels clear of the Guide / reactions / PiP row along the top of the player
  const topRow = parseFloat(getComputedStyle(overlay).getPropertyValue('--split-clear')) || 0;
  overlay.querySelectorAll('.split-tile').forEach(el => {
    const t = liveSplit[Number(el.dataset.tile)];
    if (!t) return;
    el.style.left = `${left + t.x * pw}px`; el.style.top = `${top + t.y * ph}px`;
    el.style.width = `${t.w * pw}px`; el.style.height = `${t.h * ph}px`;
    const chip = el.querySelector('.split-chip');
    if (chip) chip.style.marginTop = `${Math.max(0, topRow - (top + t.y * ph))}px`;
  });
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(positionSplitTiles).observe(video);
['loadedmetadata', 'resize'].forEach(ev => video.addEventListener(ev, positionSplitTiles));

function applyLiveTvState(state) {
  document.getElementById('yt-player-container').style.display = 'none';
  applySplitState(state);
  setLiveProgram(liveSplit ? liveSplit[splitAudioIndex()].program : state.liveTvProgram);
  if (state.liveTuning) showTuning(state.liveTuning);

  const guideBtn = document.getElementById('guide-toggle-btn');
  if (guideBtn) guideBtn.style.display = 'block';

  if (!state.movieKey) {
    video.style.display = 'none';
    noMovie.style.display = 'block';
    noMovieText.textContent = 'Waiting for host to choose a channel…';
    titleEl.textContent = 'Live TV';
    document.getElementById('livetv-info').style.display = 'none';
    return;
  }

  noMovie.style.display = 'none';
  video.style.display = 'block';
  video.controls = isHost;
  const volOverlay = document.getElementById('volume-overlay');
  if (volOverlay) volOverlay.style.display = isHost ? 'none' : 'flex';

  const splitTitle = liveSplit ? liveSplit.map(t => t.title || t.channel).join(' + ') : null;
  titleEl.textContent = splitTitle || state.liveTvChannelTitle || state.liveTvChannel;

  // Update sidebar channel info
  const liveTvInfo = document.getElementById('livetv-info');
  const liveTvChannelTitle = document.getElementById('livetv-channel-title');
  if (liveTvInfo) liveTvInfo.style.display = 'block';
  if (liveTvChannelTitle) liveTvChannelTitle.textContent = liveSplit ? `${liveSplit.length} channels` : (state.liveTvChannelTitle || '');

  // Track the active channel number for guide highlighting
  activeLiveTvChannel = state.liveTvChannel || null;

  // Always keep currentKey in sync with the server's ratingKey
  currentKey = state.movieKey || currentKey;

  // Target (DVR seconds). state.position is already extrapolated to the moment the server
  // sent it, so only time since *receipt* is added — using state.lastUpdate would fold the
  // difference between the client's and server's wall clocks straight into the sync error.
  liveState  = state;
  liveStateAt = performance.now();
  const targetTime = liveTarget();

  // Only reload the HLS player when the channel itself changes (not on retune,
  // which keeps the same DVR — the relay URL and timeline are stable).
  // liveTvKey names every channel on screen, so a split-view change to any tile reloads too.
  const liveKey = state.liveTvKey || state.liveTvChannel;
  if (state.movieKey && liveKey !== currentLiveTvChannel) {
    currentLiveTvChannel = liveKey;
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    loadLiveTvRelay(targetTime, state.playing);
    return;
  }
  if (liveTlOffset == null) return; // playlist not loaded yet; the initial seek handles it

  // Sync play/pause state
  if (state.playing && video.paused) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    tryPlay();
    releaseSyncLock();
  } else if (!state.playing && !video.paused) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    video.pause();
    releaseSyncLock();
  }

  // Drift correction for guests runs continuously in liveDriftLoop() below.

  if (guideOpen) renderGuide(); // re-highlight active channel
}

// ── Live TV Guide panel ────────────────────────────────────
function openGuide() {
  guideOpen = true;
  const panel = document.getElementById('guide-panel');
  panel.classList.add('open');
  document.getElementById('guide-toggle-btn').style.opacity = '1';
  loadGuide();
}

function closeGuide() {
  guideOpen = false;
  guideExpanded = false;
  const panel = document.getElementById('guide-panel');
  if (panel) panel.classList.remove('open', 'expanded');
  const expandBtn = document.getElementById('guide-expand-btn');
  if (expandBtn) expandBtn.title = 'Expand';
}

function toggleGuideExpand() {
  guideExpanded = !guideExpanded;
  const panel = document.getElementById('guide-panel');
  panel.classList.toggle('expanded', guideExpanded);
  document.getElementById('guide-expand-btn').title = guideExpanded ? 'Collapse' : 'Expand';
}

async function loadGuide() {
  const list = document.getElementById('guide-channel-list');
  if (!list) return;
  const now = Date.now();
  // Show what we have straight away, but re-ask the server each time the picker opens (it caches
  // and expires programs itself), so "now playing" is never stale for long.
  if (guideChannels.length) renderGuide();
  if (guideChannels.length && now - guideFetchedAt < GUIDE_CLIENT_TTL) return;
  if (!guideChannels.length) list.innerHTML = '<div class="loading" style="padding:1rem">Loading guide…</div>';
  try {
    const { channels } = await fetch('/api/livetv/guide').then(r => r.json());
    guideChannels  = channels || [];
    guideFetchedAt = now;
    renderGuide();
  } catch {
    list.innerHTML = '<div class="loading" style="padding:1rem">Failed to load guide.</div>';
  }
}

function renderGuide() {
  const list = document.getElementById('guide-channel-list');
  if (!list) return;
  if (!guideChannels.length) {
    list.innerHTML = '<div class="loading" style="padding:1rem">No channels found.</div>';
    return;
  }
  // Split view: every channel on screen is "on air"; clicking one of them switches your audio to it, and the
  // host clicking any other channel replaces the tile they're listening to.
  const tileOf = num => liveSplit ? liveSplit.findIndex(t => t.channel === num) : -1;
  list.innerHTML = guideChannels.map(ch => {
    const tile      = tileOf(ch.number);
    const isActive  = liveSplit ? tile >= 0 : ch.number === activeLiveTvChannel;
    const clickable = isHost || tile >= 0;
    return `
      <div class="guide-channel-item${isActive ? ' active' : ''}${clickable ? ' clickable' : ''}"
           data-channel="${esc(ch.number)}" data-title="${esc(ch.title || ch.number)}" data-channelid="${esc(ch.channelId || '')}">
        <span class="guide-channel-num">${esc(ch.number)}</span>
        <div class="guide-channel-info">
          <span class="guide-channel-name">${esc(ch.title || ch.number)}</span>
          ${ch.nowPlaying ? `<span class="guide-channel-program">${esc(ch.nowPlaying)}</span>` : ''}
        </div>
        ${isActive ? `<span class="guide-now-playing">${liveSplit ? (tile === splitAudioIndex() ? '🔊 Tile ' : 'Tile ') + (tile + 1) : 'On Air'}</span>` : ''}
      </div>
    `;
  }).join('');
  list.querySelectorAll('.guide-channel-item.clickable').forEach(item => {
    item.addEventListener('click', () => {
      const tile = tileOf(item.dataset.channel);
      if (tile >= 0) { setSplitAudio(tile); renderGuide(); return; }
      if (!isHost) return;
      if (liveSplit) socket.emit('livetv-set-slot', { slot: splitAudioIndex(), channel: item.dataset.channel });
      else socket.emit('select-livetv-channel', {
        channel:      item.dataset.channel,
        channelTitle: item.dataset.title,
        channelId:    item.dataset.channelid
      });
      closeGuide();
    });
  });
}

document.getElementById('guide-toggle-btn')?.addEventListener('click', () => {
  guideOpen ? closeGuide() : openGuide();
});
document.getElementById('guide-close-btn')?.addEventListener('click', closeGuide);
document.getElementById('guide-expand-btn')?.addEventListener('click', toggleGuideExpand);

// ── Sidebar collapse ───────────────────────────────────────
const sidebar   = document.querySelector('.sidebar');
const expandTab = document.getElementById('sidebar-expand-tab');
const chatBadge = document.getElementById('chat-badge');

function collapseSidebar() {
  sidebarCollapsed = true;
  sidebar.classList.add('collapsed');
  expandTab.style.display = 'flex';
}

function expandSidebar() {
  sidebarCollapsed = false;
  sidebar.classList.remove('collapsed');
  expandTab.style.display = 'none';
  unreadChats = 0;
  chatBadge.style.display = 'none';
  chatBadge.textContent = '';
}

document.getElementById('sidebar-toggle').addEventListener('click', collapseSidebar);
document.getElementById('sidebar-expand-btn').addEventListener('click', expandSidebar);

// ── Toast notifications ────────────────────────────────────
function showNotif(text) {
  const area = document.getElementById('notif-area');
  const el   = document.createElement('div');
  el.className   = 'notif-toast';
  el.textContent = text;
  area.appendChild(el);
  setTimeout(() => {
    el.classList.add('notif-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4000);
}

// ── Position reporting (for drift indicator) ───────────────
setInterval(() => {
  let pos = null;
  if ((roomType === 'movie' || roomType === 'tv' || roomType === 'livetv') && currentKey && !video.paused && !video.ended) {
    pos = roomType === 'livetv' ? liveAbs() : video.currentTime;
  } else if (roomType === 'youtube' && ytPlayer && ytVideoId) {
    if (ytPlayer.getPlayerState?.() === YT.PlayerState.PLAYING) {
      pos = ytPlayer.getCurrentTime?.();
    }
  }
  if (pos != null && isFinite(pos)) socket.emit('position-report', { position: pos });
}, 1000);

// ── Buffering state reporting ──────────────────────────────
video.addEventListener('waiting', () => socket.emit('buffering-state', { buffering: true }));
video.addEventListener('playing', () => socket.emit('buffering-state', { buffering: false }));

// ── TV: auto-advance to next episode when current ends ─────
video.addEventListener('ended', () => {
  if (roomType === 'tv' && isHost) {
    socket.emit('episode-ended');
  }
});

// ── YouTube IFrame API ─────────────────────────────────────
function loadYouTubeApi() {
  if (ytApiLoaded) return;
  ytApiLoaded = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
  if (pendingYtInit) {
    const p = pendingYtInit; pendingYtInit = null;
    createYtPlayer(p.videoId, p.targetTime, p.shouldPlay);
  }
};

function initYtPlayer(videoId, targetTime, shouldPlay) {
  loadYouTubeApi();
  if (!ytApiReady) {
    pendingYtInit = { videoId, targetTime, shouldPlay };
    return;
  }
  createYtPlayer(videoId, targetTime, shouldPlay);
}

function ensureYtDiv() {
  const container = document.getElementById('yt-player-container');
  let div = document.getElementById('yt-player');
  if (!div) {
    div = document.createElement('div');
    div.id = 'yt-player';
    container.appendChild(div);
  }
  return div;
}

function createYtPlayer(videoId, targetTime, shouldPlay) {
  const container = document.getElementById('yt-player-container');
  container.style.display = 'block';
  noMovie.style.display = 'none';
  video.style.display = 'none';

  if (ytPlayer && ytVideoId === videoId) {
    // Same video — just sync position/state
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    if (shouldPlay) ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
    releaseSyncLock();
    return;
  }

  if (ytPlayer) {
    ytPlayer.destroy();
    ytPlayer = null;
  }

  ytVideoId = videoId;
  ensureYtDiv();

  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { rel: 0, modestbranding: 1 },
    events: {
      onReady(e) {
        isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
        e.target.seekTo(targetTime, true);
        if (shouldPlay) e.target.playVideo();
        else e.target.pauseVideo();
        releaseSyncLock();
      },
      onStateChange: onYtStateChange
    }
  });
}

function onYtStateChange(event) {
  if (isSyncing) return;
  const s = event.data;
  if (s === YT.PlayerState.PLAYING) {
    if (roomSettings.playbackLocked && !isHost) {
      isSyncing = true; ytPlayer.pauseVideo(); releaseSyncLock(); return;
    }
    socket.emit('play', { position: ytPlayer.getCurrentTime() });
  } else if (s === YT.PlayerState.PAUSED) {
    if (roomSettings.playbackLocked && !isHost) return;
    socket.emit('pause', { position: ytPlayer.getCurrentTime() });
  }
}

function applyYtState(state) {
  titleEl.textContent = state.movieTitle || (state.youtubeVideoId ? 'YouTube' : 'No video selected');

  if (!state.youtubeVideoId) {
    document.getElementById('yt-player-container').style.display = 'none';
    noMovieText.textContent = 'Waiting for host to set a YouTube video…';
    noMovie.style.display = 'block';
    return;
  }

  noMovie.style.display = 'none';
  // state.position is already the room's position at the moment the update was sent; adding
  // (Date.now() - state.lastUpdate) would mix the client's and server's wall clocks (skew becomes sync error)
  const targetTime = state.position;

  if (state.youtubeVideoId !== ytVideoId || !ytPlayer) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    initYtPlayer(state.youtubeVideoId, targetTime, state.playing);
    return;
  }

  const ytState   = ytPlayer.getPlayerState?.();
  const ytPlaying = ytState === YT.PlayerState.PLAYING;

  if (state.playing && !ytPlaying) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    ytPlayer.playVideo();
    releaseSyncLock();
  } else if (!state.playing && ytPlaying) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    ytPlayer.pauseVideo();
    releaseSyncLock();
  }

  if (!state.playing) return;

  const drift = (ytPlayer.getCurrentTime?.() || 0) - targetTime;
  if (Math.abs(drift) > 5) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    releaseSyncLock();
  }
}

// ── YouTube host controls ──────────────────────────────────
document.getElementById('yt-url-btn')?.addEventListener('click', setYoutubeUrl);
document.getElementById('yt-url-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') setYoutubeUrl();
});

function setYoutubeUrl() {
  const url    = document.getElementById('yt-url-input')?.value.trim();
  const errEl  = document.getElementById('yt-url-error');
  if (!url) { errEl.textContent = 'URL required'; errEl.style.display = 'block'; return; }
  try {
    const u = new URL(url);
    if (u.hostname !== 'youtu.be' && u.hostname !== 'youtube.com' && u.hostname !== 'www.youtube.com') {
      errEl.textContent = 'Must be a YouTube URL'; errEl.style.display = 'block'; return;
    }
  } catch { errEl.textContent = 'Invalid URL'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  socket.emit('set-youtube', { youtubeUrl: url });
  document.getElementById('yt-url-input').value = '';
}

// ── Viewers ────────────────────────────────────────────────
let lastViewers = [];

function renderViewers(viewers) {
  viewersList.innerHTML = viewers.map(v => {
    // Drift is vs the host's position. Live TV guests are steered tightly, so grade it more strictly.
    const driftHtml = v.drift != null
      ? (() => {
          const abs = Math.abs(v.drift);
          const [okMax, warnMax] = roomType === 'livetv' ? [0.5, 1.5] : [1, 3];
          const cls = abs < okMax ? 'drift-ok' : abs < warnMax ? 'drift-warn' : 'drift-bad';
          const sign = v.drift > 0 ? '+' : '';
          return `<span class="drift-badge ${cls}">${sign}${v.drift.toFixed(1)}s</span>`;
        })()
      : '';
    const bufHtml = v.buffering ? '<span class="buffering-dot" title="Buffering…"></span>' : '';
    return `
      <div class="viewer-item" data-name="${esc(v.name)}">
        ${v.picture
          ? `<img src="${esc(v.picture)}" alt="${esc(v.name)}">`
          : `<div class="viewer-avatar-placeholder">${esc(v.name[0]?.toUpperCase() || '?')}</div>`
        }
        <span class="viewer-name-wrap">${esc(v.name)}${v.isHost ? ' 👑' : ''}${v.isGuest ? ' <span class="guest-tag">guest</span>' : ''}</span>
        ${bufHtml}${driftHtml}
        ${v.isAdmin ? ' <span class="admin-badge" title="Plex server owner">admin</span>' : ''}
        ${v.muted ? '<span class="muted-badge" title="Muted in chat">🔇</span>' : ''}
        ${v.socketId !== socket.id && !v.isAdmin && (isAdmin || (isHost && !v.isHost))
          ? `<button class="btn-make-host btn-mute" data-sid="${esc(v.socketId)}" data-muted="${v.muted ? '1' : ''}" title="${v.muted ? 'Let them chat again' : 'Stop them sending chat messages in this room'}">${v.muted ? 'Unmute' : 'Mute'}</button>` : ''}
        ${v.socketId !== socket.id && !v.isAdmin && (isAdmin || (isHost && v.isGuest))
          ? `<button class="btn-make-host btn-rename" data-sid="${esc(v.socketId)}" data-name="${esc(v.name)}" title="${v.isGuest ? 'Rename this guest' : 'Change their nickname everywhere'}">Rename</button>` : ''}
        ${(isHost || isAdmin) && !v.isHost && !v.isAdmin ? `
          ${isHost ? `<button class="btn-make-host" data-sid="${esc(v.socketId)}">Host</button>` : ''}
          <button class="btn-kick" data-sid="${esc(v.socketId)}">Kick</button>
        ` : ''}
      </div>
    `;
  }).join('');

  viewersList.querySelectorAll('.btn-rename').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = prompt(`New name for ${btn.dataset.name}:`, btn.dataset.name);
      if (name === null || !name.trim() || name.trim() === btn.dataset.name) return;
      socket.emit('rename-viewer', { targetSocketId: btn.dataset.sid, name: name.trim() });
    });
  });
  viewersList.querySelectorAll('.btn-mute').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('mute-viewer', { targetSocketId: btn.dataset.sid, muted: !btn.dataset.muted }));
  });
  if (isHost || isAdmin) {
    viewersList.querySelectorAll('.btn-make-host:not(.btn-rename):not(.btn-mute)').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('transfer-host', { targetSocketId: btn.dataset.sid }));
    });
    viewersList.querySelectorAll('.btn-kick').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Kick this viewer from the room?')) {
          socket.emit('kick-viewer', { targetSocketId: btn.dataset.sid });
        }
      });
    });
  }
}

socket.on('viewers', (viewers) => {
  if (sidebarCollapsed && lastViewers.length > 0) {
    const prevIds = new Set(lastViewers.map(v => v.socketId));
    const currIds = new Set(viewers.map(v => v.socketId));
    viewers.forEach(v => { if (!prevIds.has(v.socketId)) showNotif(`👋 ${v.name} joined`); });
    lastViewers.forEach(v => { if (!currIds.has(v.socketId)) showNotif(`👋 ${v.name} left`); });
  }
  lastViewers = viewers;
  renderViewers(viewers);
});

socket.on('became-host', ({ inviteToken }) => {
  isHost = true;
  resetPlaybackRate('became host');
  setHostUI(true, inviteToken);
  renderViewers(lastViewers);
  // If intermission is active, expose the cancel button to the new host
  const iOverlay = document.getElementById('intermission-overlay');
  if (iOverlay && iOverlay.style.display !== 'none') {
    document.getElementById('cancel-intermission-btn').style.display = 'block';
  }
});

socket.on('lost-host', () => {
  isHost = false;
  resetPlaybackRate('lost host');
  setHostUI(false);
  renderViewers(lastViewers);
});

// ── Playback → server ──────────────────────────────────────
// Live TV positions are DVR seconds; only the host drives playback there.
const playbackPos = () => roomType === 'livetv' ? liveAbs() : video.currentTime;
const livetvGuest = () => roomType === 'livetv' && !isHost;

video.addEventListener('play', () => {
  if (isSyncing) return;
  if (livetvGuest()) return;
  if (roomSettings.playbackLocked && !isHost) {
    // Immediately revert — don't let the video run while server-state says paused
    isSyncing = true; video.pause(); releaseSyncLock(); return;
  }
  const pos = playbackPos();
  if (pos != null) socket.emit('play', { position: pos });
});
// Live TV: pauses can't be spammed (the server enforces a cooldown between them). If the host pauses again too
// soon, keep playing and say why — undone straight away here rather than waiting for the server to refuse it.
let lastPauseSentAt = -1e9;
const pauseCooldownMsLeft = () => Math.max(0, lastPauseSentAt + (liveState?.pauseCooldownSec ?? 10) * 1000 - performance.now());
function undoPause(waitSec) {
  isSyncing = true; video.play().catch(() => {}); releaseSyncLock();
  showNotif(`⏸ You can pause again in ${waitSec}s`);
}
socket.on('pause-denied', ({ waitSec } = {}) => {   // the server's word wins if the clocks disagree
  if (roomType !== 'livetv') return;
  lastPauseSentAt = performance.now() + (waitSec || 1) * 1000 - (liveState?.pauseCooldownSec ?? 10) * 1000;
  undoPause(waitSec || 1);
});

video.addEventListener('pause',  () => {
  if (isSyncing) return;
  // A viewer who can't steer the room (Live TV guest, guest in a locked room) can still pause their own copy from a
  // Picture-in-Picture window, where the native controls can't be hidden. Put them straight back on the room.
  if (followsOnly()) { if (roomIsPlaying() && !video.ended) resumeWithRoom(); return; }
  if (roomType === 'livetv' && liveState && liveState.playing) {
    const left = pauseCooldownMsLeft();
    if (left > 0) { undoPause(Math.ceil(left / 1000)); return; }
    lastPauseSentAt = performance.now();
  }
  const pos = playbackPos();
  if (pos != null) socket.emit('pause', { position: pos });
});
video.addEventListener('seeked', () => {
  if (isSyncing) return;
  if (livetvGuest()) return;
  if (roomSettings.playbackLocked && !isHost) return;
  const pos = playbackPos();
  if (pos != null) socket.emit('seek',  { position: pos });
});

// ── Picture in Picture ─────────────────────────────────────
// The PiP window shows this same <video>, so the room's play/pause/seek (applyState / applyLiveTvState) and the
// chase loops drive it exactly as they drive the page. What it adds is a play/pause button that can't be hidden, so:
// viewers who may steer the room (host, guests in an unlocked Movie/TV room) send it to the room like the native
// controls do; viewers who only follow get it bounced back onto the room (media-session handlers in Chromium, the
// 'pause' listener above everywhere else).
const followsOnly = () => livetvGuest() || (roomSettings.playbackLocked && !isHost && (roomType === 'movie' || roomType === 'tv'));
const roomIsPlaying = () => !!(roomType === 'livetv' ? liveState?.playing : movieState?.playing);
function resumeWithRoom() {
  isSyncing = true; clearTimeout(syncTimer);
  const t = roomType === 'livetv' ? liveTarget() : movieTarget();
  if (t != null) { if (roomType === 'livetv') liveSeekAbs(t); else video.currentTime = t; }
  video.play().catch(() => {});
  releaseSyncLock();
}

const pipBtn = document.getElementById('pip-btn');
const pipStandard = !!(document.pictureInPictureEnabled && !video.disablePictureInPicture);
const pipWebkit = !pipStandard && typeof video.webkitSupportsPresentationMode === 'function'
  && video.webkitSupportsPresentationMode('picture-in-picture');   // older iOS Safari
const inPip = () => document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';

function leavePip() {
  try {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
  } catch {}
}

function refreshPipBtn() {
  if (!pipBtn) return;
  const videoShown = video.style.display !== 'none' && roomType !== 'youtube';
  const show = (pipStandard || pipWebkit) && videoShown;
  pipBtn.style.display = show ? 'flex' : 'none';
  pipBtn.closest('.player-container')?.classList.toggle('has-pip', show);
  pipBtn.classList.toggle('is-active', inPip());
  pipBtn.title = inPip() ? 'Exit Picture in Picture' : 'Picture in Picture';
  if (!videoShown && inPip()) leavePip();   // nothing loaded any more (room reset, switched to YouTube)
}

pipBtn?.addEventListener('click', () => {
  if (inPip()) { leavePip(); return; }
  if (pipStandard) video.requestPictureInPicture().catch(err => showNotif(`Picture in Picture failed: ${err.message}`));
  else if (pipWebkit) video.webkitSetPresentationMode('picture-in-picture');
});
video.addEventListener('enterpictureinpicture', refreshPipBtn);
video.addEventListener('leavepictureinpicture', refreshPipBtn);
video.addEventListener('webkitpresentationmodechanged', refreshPipBtn);
new MutationObserver(refreshPipBtn).observe(video, { attributes: true, attributeFilter: ['style'] });
refreshPipBtn();

// Chromium's PiP window calls these instead of pausing the element itself. No seek handlers → no ±10 s buttons.
if ('mediaSession' in navigator) {
  const setHandler = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  setHandler('play', () => {
    if (followsOnly()) { if (roomIsPlaying()) resumeWithRoom(); return; }   // can't start a paused room
    video.play().catch(() => {});   // the 'play' listener tells the room
  });
  setHandler('pause', () => {
    if (followsOnly()) return;   // keep watching with the room
    video.pause();               // the 'pause' listener tells the room (and applies the Live TV cooldown)
  });
}

// ── Force resync ───────────────────────────────────────────
// Host: pause everyone and resume them together from the same spot. The server parks the room at the host's
// position and resumes it after a 2 s countdown; here every client seeks to that spot while paused (a Live TV
// guest otherwise only converges once playing) and shows the countdown.
const resyncBtn = document.getElementById('resync-btn');
const resyncOverlay = document.getElementById('resync-overlay');
let resyncReadyAt = 0, resyncBtnTick = null, resyncOverlayTick = null;

function setResyncCooldown(ms) {
  resyncReadyAt = performance.now() + ms;
  clearInterval(resyncBtnTick);
  const update = () => {
    const left = Math.ceil((resyncReadyAt - performance.now()) / 1000);
    if (left > 0) { resyncBtn.disabled = true; resyncBtn.textContent = `⟳ Force resync (${left}s)`; }
    else { resyncBtn.disabled = false; resyncBtn.textContent = '⟳ Force resync'; clearInterval(resyncBtnTick); }
  };
  update();
  if (ms > 0) resyncBtnTick = setInterval(update, 250);
}

resyncBtn?.addEventListener('click', () => {
  if (performance.now() < resyncReadyAt) return;
  socket.emit('force-resync');
  setResyncCooldown(10000);   // optimistic; the server's answer below corrects it
});

socket.on('resync-denied', ({ reason, waitSec } = {}) => {
  if (reason === 'cooldown') { setResyncCooldown((waitSec || 1) * 1000); showNotif(`⟳ You can resync again in ${waitSec || 1}s`); }
  else { setResyncCooldown(0); showNotif(reason === 'nothing-playing' ? '⟳ Nothing is playing yet' : '⟳ Hold on, something else is in progress'); }
});

socket.on('resync', ({ seconds = 2, position, by } = {}) => {
  closeGuide();
  isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
  try {
    if (roomType === 'youtube') {
      if (ytPlayer && ytPlayer.seekTo) { ytPlayer.seekTo(position, true); ytPlayer.pauseVideo(); }
    } else {
      video.pause();
      if (roomType === 'livetv') { if (liveTlOffset != null) liveSeekAbs(position); }
      else if (Number.isFinite(position)) video.currentTime = position;
    }
  } catch { /* the room-state that follows corrects any miss */ }
  releaseSyncLock();

  const endAt = performance.now() + seconds * 1000;
  document.getElementById('resync-by').textContent = by ? `${by} is resyncing everyone` : '';
  resyncOverlay.style.display = 'flex';
  clearInterval(resyncOverlayTick);
  const tick = () => {
    const left = Math.ceil((endAt - performance.now()) / 1000);
    document.getElementById('resync-count').textContent = Math.max(left, 1);
    if (performance.now() >= endAt + 400) { resyncOverlay.style.display = 'none'; clearInterval(resyncOverlayTick); }
  };
  tick();
  resyncOverlayTick = setInterval(tick, 100);
});

// ── Live TV tuning overlay ─────────────────────────────────
// Shown from the moment the host picks a channel until video is actually playing.
const tuningEl = document.getElementById('livetv-loading');
let tuningHideTimer = null;
let tuningArmed = false; // set when the new stream starts loading; its first 'playing' ends the overlay
function showTuning(t) {
  if (!tuningEl || !t) return;
  tuningEl.style.display = 'flex';
  document.getElementById('livetv-loading-title').textContent = [t.channel, t.title].filter(Boolean).join(' ');
  const known = t.needed > 0;
  const pct = known ? Math.min(100, Math.round(((t.recorded || 0) / t.needed) * 100)) : 0;
  document.getElementById('livetv-loading-step').textContent =
    !known ? 'Tuning…' :
    pct >= 100 ? 'Starting playback…' :
    (t.recorded || 0) < 0.5 ? 'Connecting to tuner…' :
    `Buffering ${Math.min(t.needed, Math.round(t.recorded))}s / ${t.needed}s`;
  const fill = document.getElementById('livetv-loading-fill');
  fill.style.width = known ? pct + '%' : '100%';
  fill.classList.toggle('indeterminate', !known);
  clearTimeout(tuningHideTimer);
  tuningHideTimer = setTimeout(hideTuning, 45000); // never leave it stuck
}
function hideTuning() {
  clearTimeout(tuningHideTimer);
  if (tuningEl) tuningEl.style.display = 'none';
}
socket.on('livetv-tuning', showTuning);
socket.on('livetv-tune-failed', ({ message } = {}) => {
  lastTuneFail = { message: String(message || ''), at: Date.now() };
  hideTuning();
  noMovieText.textContent = `Couldn't tune that channel${message ? ': ' + message : ''}`;
});

// Live TV video-element diagnostics (to the docker logs)
['waiting', 'playing', 'canplay', 'stalled', 'error', 'loadedmetadata'].forEach(ev => video.addEventListener(ev, () => {
  if (roomType === 'livetv' && ev === 'playing' && tuningArmed) { tuningArmed = false; hideTuning(); }
  if (roomType === 'livetv') liveLog(`video ${ev} t=${video.currentTime.toFixed(1)} paused=${video.paused} ready=${video.readyState}${ev === 'error' ? ' code=' + video.error?.code : ''}`);
}));

// Live TV: "behind live" readout + Go live button (host)
const liveBehindEl = document.getElementById('livetv-behind');
const goLiveBtn    = document.getElementById('livetv-golive');
const goLivePlayerBtn = document.getElementById('livetv-golive-player');
setInterval(() => {
  if (roomType !== 'livetv' || !liveBehindEl) return;
  const edge = liveEdgeAbs(), pos = liveAbs();
  if (edge == null || pos == null) { liveBehindEl.textContent = ''; return; }
  const behind = Math.max(0, edge - pos);
  // "Live" means within the room's normal buffer distance (+ a little slack), not right at the edge.
  const liveThresh = (liveState?.liveBufferSec ?? 4) + 8;
  liveBehindEl.textContent = behind < liveThresh ? 'LIVE' : `-${Math.floor(behind / 60)}:${String(Math.floor(behind % 60)).padStart(2, '0')} behind live`;
  liveBehindEl.classList.toggle('is-live', behind < liveThresh);
  const showGoLive = isHost && behind >= liveThresh;
  if (goLiveBtn) goLiveBtn.style.display = showGoLive ? 'inline-block' : 'none';
  if (goLivePlayerBtn) goLivePlayerBtn.style.display = showGoLive ? 'flex' : 'none';
}, 1000);
function goLive() {
  const edge = liveEdgeAbs();
  if (edge != null) liveSeekAbs(edge - (liveState?.liveBufferSec ?? 4)); // keep the room's buffer; 'seeked' tells the room
}
goLiveBtn?.addEventListener('click', goLive);
goLivePlayerBtn?.addEventListener('click', goLive);

// ── Movie browser modal (host only) ───────────────────────
document.getElementById('choose-movie-btn').addEventListener('click', () => {
  document.getElementById('movie-modal').style.display = 'flex';
  loadMovies();
});
document.getElementById('close-movie-modal').addEventListener('click', () => {
  document.getElementById('movie-modal').style.display = 'none';
});

async function loadMovies() {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading…</div>';

  const params = new URLSearchParams({
    search: document.getElementById('search-input').value.trim(),
    genre:  document.getElementById('genre-select').value,
    sort:   document.getElementById('sort-select').value
  });

  try {
    const { movies, genres, error } = await fetch(`/api/movies?${params}`).then(r => r.json());
    if (error) throw new Error(error);

    const sel = document.getElementById('genre-select');
    const cur = sel.value;
    if (genres?.length) {
      sel.innerHTML = '<option value="">All genres</option>' +
        genres.map(g => `<option value="${esc(g)}"${g === cur ? ' selected' : ''}>${esc(g)}</option>`).join('');
    }

    document.getElementById('movie-count').textContent =
      movies.length ? `${movies.length} movie${movies.length !== 1 ? 's' : ''}` : '';

    if (!movies.length) {
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">No movies found.</div>';
      return;
    }

    grid.innerHTML = movies.map(m => `
      <div class="movie-card" data-key="${m.ratingKey}">
        ${m.thumb
          ? `<img class="movie-poster" src="${esc(m.thumb)}" alt="${esc(m.title)}" loading="lazy">`
          : `<div class="movie-poster-placeholder">🎬</div>`
        }
        <div class="movie-info">
          <h3 title="${esc(m.title)}">${esc(m.title)}</h3>
          <span>${m.year || ''}${m.year && m.rating ? ' · ' : ''}${m.rating ? '★ ' + Number(m.rating).toFixed(1) : ''}</span>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => selectMovie(card.dataset.key));
    });
  } catch (err) {
    grid.innerHTML = `<div class="loading" style="grid-column:1/-1">Error: ${esc(err.message)}</div>`;
  }
}

async function selectMovie(ratingKey) {
  try {
    const movie = await fetch(`/api/movies/${ratingKey}`).then(r => r.json());
    if (!movie.partId) { alert('No stream found for this movie.'); return; }
    socket.emit('select-movie', { movieKey: movie.ratingKey, movieTitle: movie.title, partId: movie.partId });
    document.getElementById('movie-modal').style.display = 'none';
  } catch { alert('Failed to load movie details.'); }
}

let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadMovies, 300);
});
document.getElementById('genre-select').addEventListener('change', loadMovies);
document.getElementById('sort-select').addEventListener('change', loadMovies);

// ── Show browser modal (host only, TV rooms) ───────────────
let showBrowserShowKey   = null;
let showBrowserShowTitle = null;
let showBrowserSeasonKey = null;
let showSearchTimeout;

document.getElementById('choose-episode-btn').addEventListener('click', () => {
  showBrowserShowKey   = null;
  showBrowserShowTitle = null;
  showBrowserSeasonKey = null;
  setShowBrowserView('shows');
  document.getElementById('show-modal').style.display = 'flex';
  loadShows();
});

document.getElementById('close-show-modal').addEventListener('click', () => {
  document.getElementById('show-modal').style.display = 'none';
});

document.getElementById('show-modal-back').addEventListener('click', () => {
  if (showBrowserSeasonKey) {
    showBrowserSeasonKey = null;
    setShowBrowserView('seasons');
    loadSeasons(showBrowserShowKey);
  } else {
    showBrowserShowKey = null;
    setShowBrowserView('shows');
    loadShows();
  }
});

document.getElementById('show-search-input').addEventListener('input', () => {
  clearTimeout(showSearchTimeout);
  showSearchTimeout = setTimeout(loadShows, 300);
});

function setShowBrowserView(view) {
  document.getElementById('show-browser-shows').style.display   = view === 'shows'   ? '' : 'none';
  document.getElementById('show-browser-seasons').style.display  = view === 'seasons'  ? '' : 'none';
  document.getElementById('show-browser-episodes').style.display = view === 'episodes' ? '' : 'none';
  document.getElementById('show-modal-back').style.display = view === 'shows' ? 'none' : '';
  const titles = { shows: 'Choose a Show', seasons: showBrowserShowTitle || 'Seasons', episodes: showBrowserShowTitle || 'Episodes' };
  document.getElementById('show-modal-title').textContent = titles[view] || 'Choose a Show';
}

async function loadShows() {
  const grid   = document.getElementById('shows-grid');
  const search = document.getElementById('show-search-input').value.trim();
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading…</div>';
  try {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    const { shows, error } = await fetch(`/api/shows?${params}`).then(r => r.json());
    if (error) throw new Error(error);

    document.getElementById('show-count').textContent =
      shows.length ? `${shows.length} show${shows.length !== 1 ? 's' : ''}` : '';

    if (!shows.length) {
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">No shows found.</div>';
      return;
    }
    grid.innerHTML = shows.map(s => `
      <div class="movie-card" data-key="${s.ratingKey}" data-title="${esc(s.title)}">
        ${s.thumb
          ? `<img class="movie-poster" src="${esc(s.thumb)}" alt="${esc(s.title)}" loading="lazy">`
          : `<div class="movie-poster-placeholder">📺</div>`}
        <div class="movie-info">
          <h3 title="${esc(s.title)}">${esc(s.title)}</h3>
          <span>${s.year || ''}${s.year && s.leafCount ? ' · ' : ''}${s.leafCount ? s.leafCount + ' ep' : ''}</span>
        </div>
      </div>
    `).join('');
    grid.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => {
        showBrowserShowKey   = card.dataset.key;
        showBrowserShowTitle = card.dataset.title;
        setShowBrowserView('seasons');
        loadSeasons(showBrowserShowKey);
      });
    });
  } catch (err) {
    grid.innerHTML = `<div class="loading" style="grid-column:1/-1">Error: ${esc(err.message)}</div>`;
  }
}

async function loadSeasons(showKey) {
  const list = document.getElementById('seasons-list');
  list.innerHTML = '<div class="loading">Loading seasons…</div>';
  try {
    const { seasons, error } = await fetch(`/api/shows/${showKey}/seasons`).then(r => r.json());
    if (error) throw new Error(error);
    if (!seasons.length) { list.innerHTML = '<div class="loading">No seasons found.</div>'; return; }
    list.innerHTML = seasons.map(s => `
      <div class="episode-item" data-key="${s.ratingKey}">
        ${s.thumb ? `<img class="episode-thumb" src="${esc(s.thumb)}" alt="">` : '<div class="episode-thumb-placeholder">📺</div>'}
        <div class="episode-info">
          <span class="episode-title">${esc(s.title)}</span>
          <span class="episode-meta">${s.leafCount ? s.leafCount + ' episodes' : ''}</span>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.episode-item').forEach(item => {
      item.addEventListener('click', () => {
        showBrowserSeasonKey = item.dataset.key;
        setShowBrowserView('episodes');
        loadEpisodes(showBrowserSeasonKey);
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

async function loadEpisodes(seasonKey) {
  const list = document.getElementById('episodes-list');
  list.innerHTML = '<div class="loading">Loading episodes…</div>';
  try {
    const { episodes, error } = await fetch(`/api/shows/${seasonKey}/episodes`).then(r => r.json());
    if (error) throw new Error(error);
    if (!episodes.length) { list.innerHTML = '<div class="loading">No episodes found.</div>'; return; }
    list.innerHTML = episodes.map(e => {
      const epNum = e.parentIndex != null && e.index != null
        ? `S${String(e.parentIndex).padStart(2,'0')}E${String(e.index).padStart(2,'0')} · `
        : '';
      const dur = e.duration ? Math.round(e.duration / 60000) + ' min' : '';
      return `
        <div class="episode-item" data-key="${e.ratingKey}">
          ${e.thumb ? `<img class="episode-thumb" src="${esc(e.thumb)}" alt="">` : '<div class="episode-thumb-placeholder">📺</div>'}
          <div class="episode-info">
            <span class="episode-title">${epNum}${esc(e.title)}</span>
            <span class="episode-meta">${dur}</span>
          </div>
        </div>
      `;
    }).join('');
    list.querySelectorAll('.episode-item').forEach(item => {
      item.addEventListener('click', () => selectEpisode(item.dataset.key));
    });
  } catch (err) {
    list.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

async function selectEpisode(ratingKey) {
  try {
    const ep = await fetch(`/api/shows/episode/${ratingKey}`).then(r => r.json());
    if (!ep.partId) { alert('No stream found for this episode.'); return; }
    socket.emit('select-show', {
      showKey:         showBrowserShowKey,
      showTitle:       showBrowserShowTitle,
      seasonRatingKey: showBrowserSeasonKey,
      episodeRatingKey: ep.ratingKey,
      episodeTitle:    ep.title,
      partId:          ep.partId
    });
    document.getElementById('show-modal').style.display = 'none';
  } catch { alert('Failed to load episode details.'); }
}

// ── Live TV channel selector (host only) ──────────────────
// channelPickSlot: null = tune the room to one channel (ends split view); a number = put the pick in that tile
let channelPickSlot = null;
function openChannelPicker(slot = null) {
  channelPickSlot = slot;
  const title = document.getElementById('channel-modal-title');
  const count = liveSplit ? liveSplit.length : 1;
  if (title) title.textContent = slot == null ? 'Choose Channel'
    : slot >= count ? 'Add a channel to the screen' : `Change channel ${slot + 1}`;
  document.getElementById('channel-modal').style.display = 'flex';
  loadChannels();
}
document.getElementById('choose-channel-btn')?.addEventListener('click', () => openChannelPicker(null));

document.getElementById('cancel-channel')?.addEventListener('click', () => {
  document.getElementById('channel-modal').style.display = 'none';
});

async function loadChannels() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '<div class="loading">Loading channels…</div>';
  try {
    const { channels, error } = await fetch('/api/livetv/guide').then(r => r.json());
    if (!channels || !channels.length) {
      list.innerHTML = '<div class="loading">No channels found.</div>';
      return;
    }
    // Picking for a tile: channels already on screen can't go on twice
    const onScreen = new Set(channelPickSlot != null ? (liveSplit ? liveSplit.map(t => t.channel) : [activeLiveTvChannel]) : []);
    list.innerHTML = channels.map(ch => `
      <div class="episode-item${onScreen.has(ch.number) ? ' is-disabled' : ''}" data-channel="${esc(ch.number)}" data-title="${esc(ch.title || ch.number)}" data-channelid="${esc(ch.channelId || '')}" style="cursor:${onScreen.has(ch.number) ? 'default' : 'pointer'}">
        <div class="episode-info">
          <span class="episode-title">${esc(ch.number)} ${esc(ch.title || '')}${onScreen.has(ch.number) ? ' <span class="episode-meta">· on screen</span>' : ''}</span>
          ${ch.nowPlaying ? `<span class="episode-meta">${esc(ch.nowPlaying)}</span>` : ''}
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.episode-item:not(.is-disabled)').forEach(item => {
      item.addEventListener('click', () => {
        if (channelPickSlot != null) socket.emit('livetv-set-slot', { slot: channelPickSlot, channel: item.dataset.channel });
        else socket.emit('select-livetv-channel', {
          channel:      item.dataset.channel,
          channelTitle: item.dataset.title,
          channelId:    item.dataset.channelid
        });
        document.getElementById('channel-modal').style.display = 'none';
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="loading">Error loading channels.</div>`;
  }
}

socket.on('disconnect', () => { syncDot.className = 'sync-dot offline'; syncText.textContent = 'Disconnected'; });

// ── Chat ───────────────────────────────────────────────────
// Messages carry an id from the server (room.chat in sync.js), which replies, deletes and the history a late
// joiner gets all use. Consecutive messages from the same person are grouped; the list only follows new messages
// while you're at the bottom (otherwise a "New messages" button appears). The whole .chat-section can be popped
// out into its own window: the DOM nodes move there, so every listener below keeps working unchanged.
const chatSection  = document.querySelector('.chat-section');
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const chatJump     = document.getElementById('chat-jump');
const chatTyping   = document.getElementById('chat-typing');
const chatReplyBar = document.getElementById('chat-reply');
const chatLog      = new Map(); // id (or a local key for system lines) -> message, in arrival order, for export
let chatReplyTo    = null;      // message being replied to
let chatMuted      = false;
let chatNewBelow   = 0;
let lastChatMsg    = null;      // for grouping
let chatWin        = null;      // pop-out window, while open
const CHAT_GROUP_MS = 3 * 60 * 1000;

// Dialogs open in whichever window the chat is in
const chatUi = () => (chatWin && !chatWin.closed ? chatWin : window);

function formatVideoTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
const clockTime = at => new Date(at || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Escape a chat line, turn links into links, and highlight @mentions of people in the room (and @everyone / @all)
function chatHtml(text) {
  const names = lastViewers.map(v => v.name).filter(Boolean).concat(['everyone', 'all'])
    .sort((a, b) => b.length - a.length)
    .map(n => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let html = esc(text).replace(/\bhttps?:\/\/[^\s<]+/g, url => {
    const trail = /[).,!?:;'"]+$/.exec(url)?.[0] || '';
    const href = trail ? url.slice(0, -trail.length) : url;
    return `<a class="chat-link" href="${href}" target="_blank" rel="noopener noreferrer nofollow">${href}</a>${trail}`;
  });
  const re = new RegExp('(^|[\\s(\\[])(@(?:' + names.join('|') + '))(?![\\p{L}\\p{N}_])', 'giu');
  return html.replace(re, (m, pre, tag) => `${pre}<span class="chat-mention-tag">${tag}</span>`);
}

const chatAtBottom = () => chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 40;
function chatScrollToEnd() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
  chatNewBelow = 0; chatJump.style.display = 'none';
}
chatJump.addEventListener('click', chatScrollToEnd);
chatMessages.addEventListener('scroll', () => { if (chatAtBottom()) { chatNewBelow = 0; chatJump.style.display = 'none'; } });

const myUserId = () => lastViewers.find(v => v.socketId === socket.id)?.id;
// The host can remove anyone's message except the owner's; the owner can remove anyone's
const canDelete = m => !m.isSystem && !m.deleted && (String(m.fromId) === String(myUserId()) || isAdmin || (isHost && !m.fromAdmin));

function renderChatMsg(m, { quiet = false } = {}) {
  const key = m.id != null ? m.id : `s${chatLog.size}`;
  chatLog.set(key, m);
  const div = document.createElement('div');
  div.dataset.id = m.id ?? '';
  const ts = m.videoTime != null ? `<span class="chat-ts" title="Time in the video">[${esc(formatVideoTime(m.videoTime))}]</span>` : '';
  if (m.isSystem) {
    div.className = 'chat-msg chat-system';
    div.innerHTML = `${esc(m.name)} <span class="chat-system-action">${esc(m.text)}</span> ${ts}`;
    lastChatMsg = null;
  } else {
    const mentionsMe = Array.isArray(m.mentions) && m.mentions.includes(socket.id);
    const mine = m.fromId != null && String(m.fromId) === String(myUserId());
    const grouped = lastChatMsg && !m.replyTo && lastChatMsg.fromId === m.fromId && m.fromId != null
      && (m.at || 0) - (lastChatMsg.at || 0) < CHAT_GROUP_MS;
    div.className = 'chat-msg' + (grouped ? ' chat-grouped' : '') + (mentionsMe ? ' chat-msg-mention' : '') + (mine ? ' chat-mine' : '');
    div.innerHTML = chatMsgInner(m, ts);
    lastChatMsg = m;
    if (!quiet) chatNotify(m, mentionsMe);
  }
  const follow = chatAtBottom() || (m.fromId != null && String(m.fromId) === String(myUserId()));
  chatMessages.appendChild(div);
  if (quiet || follow) chatScrollToEnd();
  else { chatNewBelow++; chatJump.textContent = `↓ ${chatNewBelow} new message${chatNewBelow === 1 ? '' : 's'}`; chatJump.style.display = ''; }
  div.querySelector('.chat-gif, .chat-image')?.addEventListener('load', () => { if (follow || quiet) chatScrollToEnd(); }, { once: true });
}

function chatMsgInner(m, ts) {
  const head = `<div class="chat-head"><span class="chat-name">${esc(m.name)}</span>${m.isGuest ? ' <span class="guest-tag">guest</span>' : ''} ${ts}<time class="chat-time">${esc(clockTime(m.at))}</time></div>`;
  if (m.deleted) {
    return `${head}<div class="chat-text chat-deleted">${m.deletedBy ? `Removed by ${esc(m.deletedBy)}` : 'Message deleted'}</div>`;
  }
  const quote = m.replyTo
    ? `<button type="button" class="chat-quote" data-jump="${esc(m.replyTo.id)}" title="Show the original message"><b>↩ ${esc(m.replyTo.name)}</b> ${m.replyTo.text ? esc(m.replyTo.text) : '<i>message deleted</i>'}</button>`
    : '';
  const text = m.text ? `<div class="chat-text">${chatHtml(m.text)}</div>` : '';
  const gif = m.gif
    ? `<img class="chat-gif" src="${esc(m.gif.url)}" alt="${esc(m.gif.title)}" title="${esc(m.gif.title)}" width="${Number(m.gif.w) || 200}" height="${Number(m.gif.h) || 150}" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  const imgUrl = m.image ? `${location.origin}/api/chat/image/${encodeURIComponent(roomId)}/${encodeURIComponent(m.image.id)}.webp` : '';
  const image = m.image
    ? `<a class="chat-image-link" href="${esc(imgUrl)}" target="_blank" rel="noopener" title="Open full size"><img class="chat-image" src="${esc(imgUrl)}" alt="Image from ${esc(m.name)}" width="${Number(m.image.w) || 300}" height="${Number(m.image.h) || 200}" loading="lazy"></a>`
    : '';
  const actions = `<div class="chat-actions">
      ${chatMuted ? '' : '<button type="button" class="chat-act" data-act="react" title="React">☺</button>'}
      <button type="button" class="chat-act" data-act="reply" title="Reply">↩</button>
      ${canDelete(m) ? '<button type="button" class="chat-act" data-act="delete" title="Delete">🗑</button>' : ''}
    </div>`;
  return head + quote + image + text + gif + reactionsHtml(m) + actions;
}

// Reactions on a message: the same six emojis as the video reactions, one pill each with a count; yours is lit
const CHAT_REACTIONS = ['👍', '❤️', '😂', '😱', '😮', '👏'];
function reactionsHtml(m) {
  const rx = m.reactions || {};
  const me = String(myUserId());
  const pills = CHAT_REACTIONS.filter(e => rx[e]?.length).map(e => {
    const who = rx[e].map(r => r.name);
    const mine = rx[e].some(r => r.id === me);
    return `<button type="button" class="chat-rx${mine ? ' mine' : ''}" data-emoji="${esc(e)}" title="${esc(who.join(', '))}">${e} <span>${who.length}</span></button>`;
  }).join('');
  return `<div class="chat-reactions">${pills}</div>`;
}
socket.on('chat-reactions', ({ id, reactions } = {}) => {
  const m = chatLog.get(Number(id));
  if (!m) return;
  m.reactions = reactions || {};
  const el = chatMessages.querySelector(`.chat-msg[data-id="${Number(id)}"] .chat-reactions`);
  if (el) el.outerHTML = reactionsHtml(m);
});
function closeReactPicker() { chatMessages.querySelectorAll('.chat-rx-picker').forEach(p => p.remove()); }

function chatNotify(m, mentionsMe) {
  if (chatWin && !chatWin.closed) return;   // chat has its own window; it's on screen
  const preview = m.text ? (m.text.length > 55 ? m.text.slice(0, 55) + '…' : m.text) : (m.image ? 'sent an image' : 'sent a GIF');
  if (sidebarCollapsed) {
    unreadChats++;
    chatBadge.textContent = unreadChats > 99 ? '99+' : String(unreadChats);
    chatBadge.style.display = 'flex';
    showNotif(`${mentionsMe ? '🔔' : '💬'} ${m.name}: ${preview}`);
  } else if (mentionsMe && (document.hidden || window.matchMedia('(max-width: 760px)').matches)) {
    // tagged while the chat is off-screen (phone layout) or the tab is in the background
    showNotif(`🔔 ${m.name}: ${preview}`);
  }
}

socket.on('chat', (m) => { if (m && typeof m === 'object') { clearTyping(m.name); renderChatMsg(m); } });

// On (re)joining: the room's recent messages, replacing whatever was shown
socket.on('chat-history', (list) => {
  if (!Array.isArray(list)) return;
  chatMessages.innerHTML = ''; chatLog.clear(); lastChatMsg = null;
  list.forEach(m => renderChatMsg(m, { quiet: true }));
});

socket.on('chat-deleted', ({ id, by } = {}) => {
  const m = chatLog.get(Number(id));
  if (!m) return;
  Object.assign(m, { deleted: true, deletedBy: by || null, text: '', gif: null, image: null, replyTo: null, reactions: null });
  const el = chatMessages.querySelector(`.chat-msg[data-id="${Number(id)}"]`);
  if (el) el.innerHTML = chatMsgInner(m, el.querySelector('.chat-ts')?.outerHTML || '');
  chatMessages.querySelectorAll(`.chat-quote[data-jump="${Number(id)}"]`).forEach(q => { q.innerHTML = `<b>${q.querySelector('b')?.textContent || ''}</b> <i>message deleted</i>`; });
  if (chatReplyTo?.id === Number(id)) setReply(null);
});

// Reply / delete / jump-to-quoted
chatMessages.addEventListener('click', e => {
  const quote = e.target.closest('.chat-quote');
  if (quote) {
    const el = chatMessages.querySelector(`.chat-msg[data-id="${Number(quote.dataset.jump)}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('chat-flash'); setTimeout(() => el.classList.remove('chat-flash'), 1200); }
    return;
  }
  const pill = e.target.closest('.chat-rx, .chat-rx-opt');
  if (pill) {
    const id = Number(pill.closest('.chat-msg')?.dataset.id);
    if (!chatMuted && id) socket.emit('chat-react', { id, emoji: pill.dataset.emoji });
    closeReactPicker();
    return;
  }
  const act = e.target.closest('.chat-act');
  if (!act) { closeReactPicker(); return; }
  const m = chatLog.get(Number(act.closest('.chat-msg')?.dataset.id));
  if (!m) return;
  if (act.dataset.act === 'react') {
    const open = act.closest('.chat-msg').querySelector('.chat-rx-picker');
    closeReactPicker();
    if (!open) act.closest('.chat-msg').insertAdjacentHTML('beforeend',
      `<div class="chat-rx-picker">${CHAT_REACTIONS.map(e => `<button type="button" class="chat-rx-opt" data-emoji="${e}">${e}</button>`).join('')}</div>`);
    return;
  }
  if (act.dataset.act === 'reply') { setReply(m); chatInput.focus(); }
  if (act.dataset.act === 'delete') {
    const mine = String(m.fromId) === String(myUserId());
    if (mine || chatUi().confirm(`Remove this message from ${m.name}?`)) socket.emit('chat-delete', { id: m.id });
  }
});

function setReply(m) {
  chatReplyTo = m;
  chatReplyBar.style.display = m ? '' : 'none';
  if (m) document.getElementById('chat-reply-name').textContent = m.name;
}
document.getElementById('chat-reply-cancel').addEventListener('click', () => setReply(null));

// ── Typing indicator ──
const typingNow = new Map();   // sid -> { name, until }
function renderTyping() {
  const now = Date.now();
  for (const [sid, t] of typingNow) if (t.until < now) typingNow.delete(sid);
  const names = [...typingNow.values()].map(t => t.name);
  chatTyping.textContent = !names.length ? ''
    : names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : 'Several people are typing…';
}
function clearTyping(name) { for (const [sid, t] of typingNow) if (t.name === name) typingNow.delete(sid); renderTyping(); }
socket.on('typing', ({ sid, name, stop } = {}) => {
  if (stop) typingNow.delete(sid); else if (name) typingNow.set(sid, { name, until: Date.now() + 3500 });
  renderTyping();
});
setInterval(renderTyping, 1000);
let lastTypingSent = 0;
function pingTyping() {
  if (chatMuted || !chatInput.value.trim() || Date.now() - lastTypingSent < 2000) return;
  lastTypingSent = Date.now();
  socket.emit('typing', {});
}

// ── Muted by the host / owner ──
function setChatMuted(muted, by) {
  chatMuted = !!muted;
  chatInput.disabled = chatMuted;
  chatInput.placeholder = chatMuted ? 'You’ve been muted in this room' : 'Message…';
  document.getElementById('chat-send').disabled = chatMuted;
  document.getElementById('chat-gif-btn').disabled = chatMuted;
  document.getElementById('chat-attach-btn').disabled = chatMuted;
  if (chatMuted) { closeGifPanel(); setReply(null); clearAttachment(); }
}
socket.on('chat-muted', ({ muted, by } = {}) => {
  const was = chatMuted;
  setChatMuted(muted, by);
  if (muted && !was) showNotif(`🔇 ${by ? `${by} muted you` : 'You’re muted'} in this room's chat`);
  if (!muted && was) showNotif(`🔊 ${by ? `${by} unmuted you` : 'You can chat again'}`);
});

// ── Sending ──
function chatVideoTime() {
  if (roomType === 'youtube' && ytPlayer && ytVideoId) {
    const t = ytPlayer.getCurrentTime?.();
    if (typeof t === 'number' && isFinite(t)) return Math.floor(t);
  } else if ((roomType === 'movie' || roomType === 'tv') && currentKey) {
    return video.currentTime;
  }
  return null;
}
function sendChat(extra = {}) {
  const text = chatInput.value.trim();
  if (chatMuted) return;
  if (!extra.gif && attachment?.uploading) { showNotif('⏳ Still uploading your image…'); return; }
  const image = !extra.gif && attachment?.id ? attachment.id : null;
  if (!text && !extra.gif && !image) return;
  socket.emit('chat', { text: extra.gif ? '' : text, image, videoTime: chatVideoTime(), replyTo: chatReplyTo?.id ?? null, ...extra });
  if (!extra.gif) { chatInput.value = ''; autosizeChat(); clearAttachment(); }
  setReply(null);
}
document.getElementById('chat-send').addEventListener('click', () => sendChat());

// The message box grows with its text, up to a few lines
function autosizeChat() {
  chatInput.style.height = 'auto';
  const h = chatInput.scrollHeight + 2;
  chatInput.style.height = Math.min(h, 140) + 'px';
  chatInput.style.overflowY = h > 140 ? 'auto' : 'hidden';
}

// ── GIFs (only when the server has a Giphy key: /api/config says gifs: true) ──
const gifPanel = document.getElementById('gif-panel');
const gifGrid  = document.getElementById('gif-grid');
const gifSearch = document.getElementById('gif-search');
const gifBtn   = document.getElementById('chat-gif-btn');
let gifQuery = null, gifNext = 0, gifLoading = false, gifTimer = null;
fetch('/api/config').then(r => r.json()).then(c => {
  if (c.gifs) gifBtn.style.display = '';
  if (c.imageUploads) { document.getElementById('chat-attach-btn').style.display = ''; imageUploadsOn = true; }
}).catch(() => {});

function closeGifPanel() { gifPanel.style.display = 'none'; gifBtn.classList.remove('active'); }
gifBtn.addEventListener('click', () => {
  if (gifPanel.style.display !== 'none') return closeGifPanel();
  gifPanel.style.display = ''; gifBtn.classList.add('active');
  gifSearch.value = ''; loadGifs('', true); gifSearch.focus();
});
gifSearch.addEventListener('input', () => { clearTimeout(gifTimer); gifTimer = setTimeout(() => loadGifs(gifSearch.value.trim(), true), 350); });
gifSearch.addEventListener('keydown', e => { if (e.key === 'Escape') { closeGifPanel(); chatInput.focus(); } });
chatMessages.addEventListener('pointerdown', closeGifPanel);   // clicking back into the conversation closes the picker
gifGrid.addEventListener('scroll', () => {
  if (gifNext != null && !gifLoading && gifGrid.scrollTop + gifGrid.clientHeight > gifGrid.scrollHeight - 120) loadGifs(gifQuery, false);
});
async function loadGifs(q, fresh) {
  if (fresh) { gifQuery = q; gifNext = 0; gifGrid.innerHTML = '<div class="gif-msg">Loading…</div>'; }
  if (gifNext == null || gifLoading) return;
  gifLoading = true;
  try {
    const r = await fetch(`/api/gifs?q=${encodeURIComponent(q)}&offset=${gifNext}`);
    const data = await r.json();
    if (q !== gifQuery) return;   // a newer search took over
    if (!r.ok) throw new Error(data.error || 'GIF search failed');
    if (fresh) gifGrid.innerHTML = '';
    gifGrid.insertAdjacentHTML('beforeend', data.results.map(g =>
      `<button type="button" class="gif-opt" data-id="${esc(g.id)}" title="${esc(g.title)}"><img src="${esc(g.preview)}" alt="${esc(g.title)}" loading="lazy" referrerpolicy="no-referrer"></button>`).join(''));
    if (fresh && !data.results.length) gifGrid.innerHTML = '<div class="gif-msg">No GIFs found.</div>';
    gifNext = data.next;
  } catch (err) {
    if (fresh) gifGrid.innerHTML = `<div class="gif-msg">${esc(err.message)}</div>`;
    gifNext = null;
  } finally { gifLoading = false; }
}
gifGrid.addEventListener('click', e => {
  const b = e.target.closest('.gif-opt');
  if (!b) return;
  sendChat({ gif: b.dataset.id });
  closeGifPanel();
  chatInput.focus();
});

// ── Images people paste, drop or pick (only when /api/config says imageUploads) ──
// The file uploads as soon as it's attached (POST /api/chat/upload/:roomId → an id); sending the message names that
// id. Big photos are scaled down here first so a phone picture fits the 8 MB limit; GIFs and WebPs are sent as they
// are so animation survives. The server re-encodes everything anyway (uploads.js).
let imageUploadsOn = false;
let attachment = null;   // { id?, uploading, token }
const attachBox = document.getElementById('chat-attach');
const attachImg = document.getElementById('chat-attach-img');
const attachStatus = document.getElementById('chat-attach-status');
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function clearAttachment() {
  attachment = null;
  attachBox.style.display = 'none';
  attachImg.removeAttribute('src');
}
document.getElementById('chat-attach-cancel').addEventListener('click', clearAttachment);

async function shrinkIfLarge(file) {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size <= 4 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    return blob || file;
  } catch { return file; }
}

async function attachImage(file) {
  if (!imageUploadsOn || chatMuted || !file) return;
  if (!IMAGE_TYPES.includes(file.type)) { showNotif('⚠️ Use a PNG, JPEG, WebP or GIF image'); return; }
  closeGifPanel();
  const token = {};
  attachment = { uploading: true, token };
  attachBox.style.display = '';
  attachStatus.textContent = 'Uploading…';
  const reader = new FileReader();   // a data: preview (the page's security policy doesn't allow blob: images)
  reader.onload = () => { if (attachment?.token === token) attachImg.src = reader.result; };
  reader.readAsDataURL(file);
  try {
    const body = await shrinkIfLarge(file);
    if (body.size > 8 * 1024 * 1024) throw new Error('Images can be up to 8 MB.');
    const r = await fetch(`/api/chat/upload/${encodeURIComponent(roomId)}`, { method: 'POST', headers: { 'Content-Type': body.type || 'application/octet-stream' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Upload failed.');
    if (attachment?.token !== token) return;   // removed or replaced meanwhile
    attachment = { id: data.id, uploading: false, token };
    attachStatus.textContent = 'Ready — add a caption or press Enter';
    chatInput.focus();
  } catch (err) {
    if (attachment?.token !== token) return;
    clearAttachment();
    showNotif(`⚠️ ${err.message}`);
  }
}

const chatFile = document.getElementById('chat-file');
document.getElementById('chat-attach-btn').addEventListener('click', () => chatFile.click());
chatFile.addEventListener('change', () => { attachImage(chatFile.files[0]); chatFile.value = ''; });
chatInput.addEventListener('paste', e => {
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file && imageUploadsOn) { e.preventDefault(); attachImage(file); }
});
// Drop an image anywhere on the chat
chatSection.addEventListener('dragover', e => {
  if (!imageUploadsOn || chatMuted || ![...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) return;
  e.preventDefault(); chatSection.classList.add('chat-dragover');
});
chatSection.addEventListener('dragleave', e => { if (!chatSection.contains(e.relatedTarget)) chatSection.classList.remove('chat-dragover'); });
chatSection.addEventListener('drop', e => {
  chatSection.classList.remove('chat-dragover');
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
  if (!file || !imageUploadsOn) return;
  e.preventDefault(); attachImage(file);
});

// ── @mention picker ────────────────────────────────────────
const mentionBox = document.getElementById('mention-box');
let mentionItems = [];   // names currently offered
let mentionIdx   = 0;
let mentionStart = -1;   // index of the '@' being completed

function closeMentions() { mentionBox.style.display = 'none'; mentionItems = []; mentionStart = -1; }

function updateMentions() {
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  const before = chatInput.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return closeMentions();
  const q = m[2].toLowerCase();
  mentionStart = pos - m[2].length - 1;
  const others = [...new Set(lastViewers.filter(v => v.socketId !== socket.id && v.name).map(v => v.name))];
  const pool = others.concat(others.length ? ['everyone'] : []);
  mentionItems = pool.filter(n => n.toLowerCase().split(/\s+/).some(w => w.startsWith(q)) || n.toLowerCase().startsWith(q)).slice(0, 6);
  if (!mentionItems.length) return closeMentions();
  mentionIdx = Math.min(mentionIdx, mentionItems.length - 1);
  mentionBox.innerHTML = mentionItems.map((n, i) =>
    `<button type="button" class="mention-opt${i === mentionIdx ? ' active' : ''}" data-i="${i}">@${esc(n)}</button>`).join('');
  mentionBox.style.display = 'flex';
}

function pickMention(i) {
  const name = mentionItems[i];
  if (name == null || mentionStart < 0) return;
  const pos = chatInput.selectionStart ?? chatInput.value.length;
  chatInput.value = chatInput.value.slice(0, mentionStart) + '@' + name + ' ' + chatInput.value.slice(pos);
  const caret = mentionStart + name.length + 2;
  chatInput.setSelectionRange(caret, caret);
  closeMentions();
  chatInput.focus();
}

// pointerdown (not click) so the input keeps focus and blur doesn't close the picker first
mentionBox.addEventListener('pointerdown', e => {
  const b = e.target.closest('.mention-opt');
  if (!b) return;
  e.preventDefault();
  pickMention(Number(b.dataset.i));
});

chatInput.addEventListener('input', () => { mentionIdx = 0; updateMentions(); autosizeChat(); pingTyping(); });
chatInput.addEventListener('click', updateMentions);
chatInput.addEventListener('blur', () => setTimeout(closeMentions, 150));
chatInput.addEventListener('keydown', e => {
  if (mentionItems.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : mentionItems.length - 1)) % mentionItems.length;
      updateMentions();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionIdx); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return; }
  }
  if (e.key === 'Escape' && chatReplyTo) { setReply(null); return; }
  // Enter sends; Shift+Enter (or an IME composing text) makes a new line
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});

// Clicking someone's name in the Watching list tags them
viewersList.addEventListener('click', e => {
  const item = e.target.closest('.viewer-item');
  if (!item || e.target.closest('button')) return;
  const nm = item.dataset.name;
  if (!nm || nm === lastViewers.find(v => v.socketId === socket.id)?.name) return;
  const cur = chatInput.value;
  chatInput.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + '@' + nm + ' ';
  chatInput.focus();
});

document.getElementById('chat-export').addEventListener('click', () => {
  if (!chatLog.size) return;
  const room  = roomNameEl.textContent.trim() || 'Room';
  const title = titleEl.textContent.trim() || '';
  const date  = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const header = [
    `Playdarr Chat Export`,
    title ? `${room} — ${title}` : room,
    date,
    '─'.repeat(40),
    '',
  ].join('\n');
  const lines = [...chatLog.values()].map(({ name, text, gif, image, replyTo, deleted, isGuest, videoTime, isSystem, at }) => {
    const ts   = videoTime != null ? `[${formatVideoTime(Math.floor(videoTime))}] ` : `[${clockTime(at)}] `;
    const tag  = isGuest ? ' (guest)' : '';
    if (isSystem) return `${ts}* ${name} ${text}`;
    if (deleted) return `${ts}${name}${tag}: (deleted)`;
    const re = replyTo ? `(↩ ${replyTo.name}) ` : '';
    return `${ts}${name}${tag}: ${re}${text || ''}${gif ? `${text ? ' ' : ''}[GIF: ${gif.title} ${gif.url}]` : ''}${image ? `${text ? ' ' : ''}[Image]` : ''}`;
  });
  const blob = new Blob([header + lines.join('\n')], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  const safeName = (title || room).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'chat';
  a.download = `playdarr_${safeName}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Bigger chat: hide the other sidebar panels ──
const sidebarEl = document.querySelector('.sidebar');
function setChatFocus(on) {
  sidebarEl.classList.toggle('chat-focus', on);
  document.getElementById('chat-focus').title = on ? 'Show the other panels again' : 'Make chat bigger (hide the other panels)';
  try { localStorage.setItem('chatFocus', on ? '1' : ''); } catch {}
}
document.getElementById('chat-focus').addEventListener('click', () => {
  if (chatWin && !chatWin.closed) return;
  setChatFocus(!sidebarEl.classList.contains('chat-focus'));
});
try { if (localStorage.getItem('chatFocus')) setChatFocus(true); } catch {}

// ── Resizable sidebar (drag its edge; double-click resets) ──
const sidebarResizer = document.getElementById('sidebar-resizer');
const SIDEBAR_MIN = 220;
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(720, window.innerWidth * 0.6));
function setSidebarWidth(px, save) {
  if (px == null) { document.documentElement.style.removeProperty('--sidebar-w'); }
  else document.documentElement.style.setProperty('--sidebar-w', Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), px))) + 'px');
  if (save) try { localStorage.setItem('sidebarWidth', px == null ? '' : String(Math.round(px))); } catch {}
}
try { const w = parseInt(localStorage.getItem('sidebarWidth'), 10); if (w) setSidebarWidth(w, false); } catch {}
sidebarResizer.addEventListener('pointerdown', e => {
  e.preventDefault();
  sidebarResizer.setPointerCapture(e.pointerId);
  document.body.classList.add('sidebar-resizing');
  const left = sidebarEl.getBoundingClientRect().left;
  const move = ev => setSidebarWidth(ev.clientX - left, false);
  const up = ev => {
    sidebarResizer.removeEventListener('pointermove', move);
    document.body.classList.remove('sidebar-resizing');
    setSidebarWidth(ev.clientX - left, true);
  };
  sidebarResizer.addEventListener('pointermove', move);
  sidebarResizer.addEventListener('pointerup', up, { once: true });
});
sidebarResizer.addEventListener('dblclick', () => setSidebarWidth(null, true));

// ── Pop the chat out into its own window ──
const chatPoppedNote = document.getElementById('chat-popped-note');
function popOutChat() {
  if (chatWin && !chatWin.closed) { chatWin.focus(); return; }
  const w = window.open('', `playdarr-chat-${roomId}`, 'popup,width=400,height=680');
  if (!w) { showNotif('Allow pop-ups for this site to open chat in its own window'); return; }
  const roomName = roomNameEl.textContent.trim() || 'Room';
  w.document.open();
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="chat-popout-body"></body></html>');
  w.document.close();
  w.document.title = `Chat · ${roomName}`;
  // Same styles as the page (absolute URLs, since the new window has no address of its own)
  document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
    const c = w.document.createElement('link'); c.rel = 'stylesheet'; c.href = l.href; w.document.head.appendChild(c);
  });
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) { const c = w.document.createElement('link'); c.rel = 'icon'; c.href = fav.href; w.document.head.appendChild(c); }
  chatWin = w;
  chatPoppedNote.style.display = '';
  w.document.body.appendChild(w.document.adoptNode(chatSection));
  chatSection.classList.add('chat-popped');
  chatScrollToEnd();
  chatInput.focus();
  w.addEventListener('pagehide', popInChat);
}
function popInChat() {
  if (!chatWin) return;
  const w = chatWin;
  chatWin = null;
  chatSection.classList.remove('chat-popped');
  chatPoppedNote.after(document.adoptNode(chatSection));
  chatPoppedNote.style.display = 'none';
  chatScrollToEnd();
  if (!w.closed) w.close();
}
document.getElementById('chat-popout').addEventListener('click', () => (chatWin && !chatWin.closed ? popInChat() : popOutChat()));
document.getElementById('chat-popin').addEventListener('click', popInChat);
window.addEventListener('pagehide', () => { if (chatWin && !chatWin.closed) chatWin.close(); });

// ── Reactions ──────────────────────────────────────────────
const playerContainer = document.querySelector('.player-container');

document.getElementById('reaction-bar').addEventListener('click', e => {
  const btn = e.target.closest('.reaction-btn');
  if (btn) socket.emit('reaction', { emoji: btn.dataset.emoji });
});

socket.on('reaction', ({ emoji, name, picture }) => {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.title = name || '';
  const glyph = document.createElement('span');
  glyph.textContent = emoji;
  el.appendChild(glyph);
  // Who reacted: avatar (or initial for guests) at the bottom-left of the emoji
  let badge;
  if (picture) {
    badge = document.createElement('img');
    badge.src = picture;
    badge.alt = '';
    badge.referrerPolicy = 'no-referrer';
    badge.addEventListener('load', () => liveLog(`reaction avatar loaded for ${name}: ${badge.naturalWidth}x${badge.naturalHeight}`));
    badge.addEventListener('error', () => {
      liveLog(`reaction avatar FAILED for ${name}: ${String(picture).slice(0, 90)}`);
      const fb = document.createElement('span');
      fb.className = 'reaction-avatar reaction-avatar-initial';
      fb.textContent = (name || '?')[0].toUpperCase();
      badge.replaceWith(fb);
    });
  } else {
    badge = document.createElement('span');
    badge.textContent = (name || '?')[0].toUpperCase();
  }
  badge.classList.add('reaction-avatar');
  if (!picture) badge.classList.add('reaction-avatar-initial');
  el.appendChild(badge);
  el.style.left = (15 + Math.random() * 70) + '%';
  playerContainer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
});

// ── Countdown ──────────────────────────────────────────────
let countdownRafId   = null;
let countdownLastSec = -1;
let audioCtx         = null;

const countdownOverlay   = document.getElementById('countdown-overlay');
const countdownCanvas    = document.getElementById('countdown-canvas');
const cancelCountdownBtn = document.getElementById('cancel-countdown-btn');

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBeep(freq, dur) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.28, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch(e) {}
}

function drawCountdownFrame(remaining, sweepProgress) {
  const cw = countdownCanvas.width, ch = countdownCanvas.height;
  const cx = cw / 2, cy = ch / 2;
  const R  = Math.min(cw, ch) * 0.41;
  const ctx = countdownCanvas.getContext('2d');

  // Background
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, cw, ch);

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(225,225,225,0.9)';
  ctx.lineWidth = 4; ctx.stroke();

  // Crosshairs extending past circle
  ctx.strokeStyle = 'rgba(200,200,200,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - R * 1.18, cy); ctx.lineTo(cx + R * 1.18, cy);
  ctx.moveTo(cx, cy - R * 1.18); ctx.lineTo(cx, cy + R * 1.18);
  ctx.stroke();

  // Tick marks (12 positions)
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const maj   = i % 3 === 0;
    const inner = maj ? R * 0.76 : R * 0.87;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * R,     cy + Math.sin(angle) * R);
    ctx.strokeStyle = maj ? 'rgba(220,220,220,0.9)' : 'rgba(170,170,170,0.65)';
    ctx.lineWidth = maj ? 4 : 2; ctx.stroke();
  }

  // Sweep arm
  const sa = sweepProgress * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sa) * R * 0.84, cy + Math.sin(sa) * R * 0.84);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3; ctx.stroke();

  // Centre pivot
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'white'; ctx.fill();

  // Inner circle framing the number
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.30, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(210,210,210,0.7)'; ctx.lineWidth = 2.5; ctx.stroke();

  // Number
  if (remaining > 0) {
    const fSize = Math.floor(R * 0.48);
    ctx.font = `bold ${fSize}px "Courier New", Courier, monospace`;
    ctx.fillStyle = 'rgba(240,240,240,0.97)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(remaining), cx, cy + fSize * 0.05);
  }

  // Corner alignment circle (classic leader mark)
  ctx.beginPath(); ctx.arc(cx + R * 0.78, cy - R * 0.78, R * 0.10, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(200,200,200,0.65)'; ctx.lineWidth = 2; ctx.stroke();

  // Film grain (random dots)
  for (let i = 0; i < 60; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * cw, Math.random() * ch, Math.random() * 1.8 + 0.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`; ctx.fill();
  }
  // Occasional vertical scratch
  if (Math.random() < 0.04) {
    const sx = cx + (Math.random() - 0.5) * cw * 0.8;
    ctx.beginPath();
    ctx.moveTo(sx, 0); ctx.lineTo(sx + (Math.random() - 0.5) * 30, ch);
    ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.07 + 0.02})`;
    ctx.lineWidth = Math.random() * 1.5 + 0.5; ctx.stroke();
  }
}

function startCountdownAnim(endsAt) {
  if (countdownRafId) { cancelAnimationFrame(countdownRafId); countdownRafId = null; }
  countdownLastSec = -1;

  function frame() {
    const timeLeft = endsAt - Date.now();
    if (timeLeft <= 0) {
      drawCountdownFrame(0, 1);
      setTimeout(() => {
        countdownOverlay.style.display = 'none';
        cancelCountdownBtn.style.display = 'none';
      }, 300);
      return;
    }
    const remaining     = Math.ceil(timeLeft / 1000);
    const sweepProgress = (1000 - (timeLeft % 1000)) / 1000;

    if (remaining !== countdownLastSec) {
      countdownLastSec = remaining;
      playBeep(remaining === 1 ? 1760 : 880, remaining === 1 ? 0.25 : 0.1);
    }

    drawCountdownFrame(remaining, sweepProgress);
    countdownRafId = requestAnimationFrame(frame);
  }
  frame();
}

function stopCountdownAnim() {
  if (countdownRafId) { cancelAnimationFrame(countdownRafId); countdownRafId = null; }
  countdownOverlay.style.display = 'none';
  cancelCountdownBtn.style.display = 'none';
}

socket.on('countdown', ({ endsAt }) => {
  closeGuide();
  countdownOverlay.style.display = 'flex';
  if (isHost) cancelCountdownBtn.style.display = 'block';
  startCountdownAnim(endsAt);
});

socket.on('countdown-cancelled', stopCountdownAnim);

document.querySelectorAll('.btn-countdown-preset[data-secs]').forEach(btn => {
  btn.addEventListener('click', () => socket.emit('start-countdown', { seconds: Number(btn.dataset.secs) }));
});

const countdownCustomInput = document.getElementById('countdown-custom');
document.getElementById('countdown-custom-btn').addEventListener('click', () => {
  const val = parseInt(countdownCustomInput.value, 10);
  if (val >= 1 && val <= 99) socket.emit('start-countdown', { seconds: val });
});
countdownCustomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('countdown-custom-btn').click();
});

cancelCountdownBtn.addEventListener('click', () => socket.emit('cancel-countdown'));

// ── Room settings toggles (host only) ──────────────────────
function emitSettings() {
  socket.emit('update-settings', {
    playbackLocked:  document.getElementById('toggle-lock-playback').checked,
    reactionsEnabled: document.getElementById('toggle-reactions').checked
  });
}
document.getElementById('toggle-lock-playback').addEventListener('change', emitSettings);
document.getElementById('toggle-reactions').addEventListener('change', emitSettings);

// ── Intermission ────────────────────────────────────────────
let intermissionRafId = null;

const intermissionOverlay     = document.getElementById('intermission-overlay');
const intermissionTimerEl     = document.getElementById('intermission-timer');
const intermissionMovieTitleEl = document.getElementById('intermission-movie-title');
const intermissionPosterEl    = document.getElementById('intermission-poster');
const intermissionPlaceholderEl = document.getElementById('intermission-poster-placeholder');
const cancelIntermissionBtn   = document.getElementById('cancel-intermission-btn');

function formatIntermissionTime(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function showIntermissionOverlay(endsAt) {
  intermissionOverlay.style.display = 'flex';
  if (isHost) cancelIntermissionBtn.style.display = 'block';

  // Movie title + poster
  intermissionMovieTitleEl.textContent = titleEl.textContent || '';
  if (currentKey) {
    intermissionPosterEl.src = `/api/stream/thumb/${currentKey}`;
    intermissionPosterEl.style.display = 'block';
    intermissionPlaceholderEl.style.display = 'none';
    intermissionPosterEl.onerror = () => {
      intermissionPosterEl.style.display = 'none';
      intermissionPlaceholderEl.style.display = 'flex';
    };
  } else {
    intermissionPosterEl.style.display = 'none';
    intermissionPlaceholderEl.style.display = 'flex';
  }

  if (intermissionRafId) cancelAnimationFrame(intermissionRafId);

  function tick() {
    const remaining = endsAt - Date.now();
    intermissionTimerEl.textContent = formatIntermissionTime(remaining);
    if (remaining > 0) {
      intermissionRafId = requestAnimationFrame(tick);
    } else {
      intermissionRafId = null;
    }
  }
  tick();
}

function hideIntermissionOverlay() {
  if (intermissionRafId) { cancelAnimationFrame(intermissionRafId); intermissionRafId = null; }
  intermissionOverlay.style.display = 'none';
  cancelIntermissionBtn.style.display = 'none';
}

socket.on('intermission-started', ({ endsAt }) => {
  closeGuide();
  showIntermissionOverlay(endsAt);
});

socket.on('intermission-ended', () => {
  hideIntermissionOverlay();
});

socket.on('intermission-cancelled', () => {
  hideIntermissionOverlay();
});

document.getElementById('start-intermission-btn').addEventListener('click', () => {
  const val = parseInt(document.getElementById('intermission-minutes').value, 10);
  if (val >= 1 && val <= 120) socket.emit('start-intermission', { minutes: val });
});

document.getElementById('intermission-minutes').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('start-intermission-btn').click();
});

cancelIntermissionBtn.addEventListener('click', () => socket.emit('cancel-intermission'));

// ── Volume overlay (guest controls when playback is locked) ────────────────
// Volume is purely client-side — never emitted to the server.
// This widget is shown instead of native controls when the host locks playback.
(function initVolumeOverlay() {
  const muteBtn    = document.getElementById('volume-mute-btn');
  const volSlider  = document.getElementById('volume-slider');
  if (!muteBtn || !volSlider) return;

  function updateMuteIcon() {
    if (video.muted || video.volume === 0) {
      muteBtn.textContent = '🔇';
    } else if (video.volume < 0.5) {
      muteBtn.textContent = '🔉';
    } else {
      muteBtn.textContent = '🔊';
    }
  }

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    // If un-muting while slider is at 0, restore to a sensible level
    if (!video.muted && video.volume === 0) {
      video.volume = 0.5;
      volSlider.value = 0.5;
    }
    updateMuteIcon();
  });

  volSlider.addEventListener('input', () => {
    video.volume = parseFloat(volSlider.value);
    video.muted  = video.volume === 0;
    updateMuteIcon();
  });

  // Keep slider in sync if volume changes via other means (e.g. OS media keys)
  video.addEventListener('volumechange', () => {
    volSlider.value = video.muted ? 0 : video.volume;
    updateMuteIcon();
  });
})();

