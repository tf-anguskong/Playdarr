'use strict';

const socket = io();

// Escapes for text *and* attribute values (quotes included)
function esc(s = '') {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── User info ──────────────────────────────────────────────
let currentUserId = null;
let isAdmin = false;   // Plex server owner — can close rooms, kick viewers, cancel any scheduled room
let lastRooms = [];

async function loadUser() {
  const { user } = await fetch('/api/me').then(r => r.json());
  if (!user) return;
  currentUserId = user.id || null;
  isAdmin = !!user.isAdmin;
  if (isAdmin) {
    document.getElementById('admin-link').style.display = 'inline';
    document.getElementById('user-name').insertAdjacentHTML('afterend', ' <span class="admin-badge" title="You own the Plex server Playdarr is connected to">admin</span>');
    renderRooms(lastRooms);
  }
  document.getElementById('user-name').textContent = user.displayName || user.name;
  if (user.picture) {
    const a = document.getElementById('user-avatar');
    a.src = user.picture; a.style.display = 'block';
  }
  if (!user.isGuest) {
    document.getElementById('create-room-btn').style.display = 'inline-flex';
    document.getElementById('schedule-room-btn').style.display = 'inline-flex';
    document.getElementById('edit-name-btn').style.display = 'inline';
    loadScheduled();
    loadRecent();
    livenowActive = true;
    loadLiveNow();
    setInterval(loadLiveNow, 120000);   // programs change on the hour / half hour
  }
}

// ── Display name editor ────────────────────────────────────
const editBtn    = document.getElementById('edit-name-btn');
const nameEditor = document.getElementById('name-editor');
const nameInput  = document.getElementById('name-input');
const nameSave   = document.getElementById('name-save-btn');
const nameCancel = document.getElementById('name-cancel-btn');

function openNameEditor() {
  nameInput.value = document.getElementById('user-name').textContent;
  nameEditor.style.display = 'flex';
  editBtn.style.display = 'none';
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
}

function closeNameEditor() {
  nameEditor.style.display = 'none';
  editBtn.style.display = 'inline';
}

async function saveName() {
  const name = nameInput.value.trim();
  if (!name) return;
  let data;
  try {
    data = await fetch('/api/me/display-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).then(r => r.json());
  } catch { return alert('Failed to save name.'); }
  if (!data?.name) return alert(data?.error || 'Failed to save name.');   // e.g. the word filter refused it
  document.getElementById('user-name').textContent = data.name;
  closeNameEditor();
}

editBtn.addEventListener('click', openNameEditor);
nameSave.addEventListener('click', saveName);
nameCancel.addEventListener('click', closeNameEditor);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveName();
  if (e.key === 'Escape') closeNameEditor();
});

// ── Room list ──────────────────────────────────────────────
let livenowActive = false, livenowTimer = null;
socket.on('room-list', (rooms) => {
  lastRooms = rooms; renderRooms(rooms);
  // Rooms starting or ending change how many Live TV slots are in use — refresh the strip shortly after
  if (livenowActive) { clearTimeout(livenowTimer); livenowTimer = setTimeout(loadLiveNow, 2500); }
});

function renderRooms(rooms) {
  const grid = document.getElementById('rooms-grid');
  if (!rooms.length) {
    grid.innerHTML = '<div class="loading">No rooms yet — create one to get started!</div>';
    return;
  }
  grid.innerHTML = rooms.map(r => `
    <div class="room-card">
      <div class="room-card-header">
        <span class="room-card-name">${esc(r.name)}</span>${r.alwaysOn ? ' <span class="sched-badge always-on-badge" title="Stays open all the time">always on</span>' : ''}
        <span class="room-host">${r.alwaysOn && r.hostName === 'always on' ? 'open all the time' : 'hosted by ' + esc(r.hostName)}</span>
      </div>
      <div class="room-card-movie">
        ${r.roomType === 'youtube'
          ? `<span class="room-now-playing">▶ ${r.movieTitle ? esc(r.movieTitle) : (r.youtubeVideoId ? 'YouTube' : 'No video set')}</span>`
          : r.roomType === 'tv'
            ? (r.hasMovie
                ? `<span class="room-now-playing">📺 ${esc(r.movieTitle)}</span>`
                : `<span style="color:var(--text-muted)">No episode selected yet</span>`)
            : r.roomType === 'livetv'
              ? (r.liveTvChannel
                  ? `<span class="room-now-playing">📡 ${esc(r.liveTvChannel)}</span>`
                  : `<span style="color:var(--text-muted)">No channel selected yet</span>`)
              : r.hasMovie
                ? `<span class="room-now-playing">▶ ${esc(r.movieTitle)}</span>`
                : `<span style="color:var(--text-muted)">No movie selected yet</span>`
        }
      </div>
      <div class="room-card-footer">
        <span class="room-viewers">${r.viewerCount ? r.viewerCount + ' watching' : (r.alwaysOn ? (r.roomType === 'livetv' ? 'empty — tunes when you join' : 'empty') : '0 watching')}</span>
        <a class="btn-join" href="/watch/${r.id}">Join →</a>
      </div>
      ${isAdmin && r.viewers ? `
      <div class="admin-room-panel">
        ${r.viewers.map(v => `
          <div class="admin-viewer">
            <span class="admin-viewer-name">${esc(v.name)}${v.isHost ? ' 👑' : ''}${v.isGuest ? ' <span class="guest-tag">guest</span>' : ''}</span>
            ${v.isHost || v.isAdmin ? '' : `<button class="btn-kick" data-kick="${esc(v.socketId)}">Kick</button>`}
          </div>`).join('') || '<span class="admin-empty">Nobody in the room</span>'}
        <button class="btn-close-room" data-close="${esc(r.id)}" data-name="${esc(r.name)}">Close room</button>
      </div>` : ''}
    </div>
  `).join('');

  if (!isAdmin) return;
  grid.querySelectorAll('[data-kick]').forEach(btn => btn.addEventListener('click', () => {
    if (confirm('Kick this viewer and block them from rejoining the room?')) socket.emit('admin-kick', { targetSocketId: btn.dataset.kick });
  }));
  grid.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => {
    if (confirm(`Close "${btn.dataset.name}" for everyone in it?`)) socket.emit('admin-close-room', { roomId: btn.dataset.close });
  }));
}

// ── Recently added ─────────────────────────────────────────
// A short strip of the newest movies and shows; click one to be asked whether to start a room for it.
function timeAgo(unixSec) {
  const d = Math.floor((Date.now() / 1000 - unixSec) / 86400);
  if (d < 1) return 'today';
  if (d === 1) return '1d ago';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function recentCard(kind, item) {
  const sub = kind === 'movie'
    ? [item.year, timeAgo(item.addedAt)].filter(Boolean).join(' · ')
    : [item.episode.split(' · ')[0], timeAgo(item.addedAt)].filter(Boolean).join(' · ');
  return `
    <button type="button" class="recent-card" data-kind="${kind}" data-key="${esc(item.ratingKey)}"
            data-title="${esc(item.title)}" data-sub="${esc(kind === 'movie' ? String(item.year || '') : item.episode)}"
            data-thumb="${esc(item.thumb || '')}" title="${esc(item.title)}">
      ${item.thumb ? `<img src="${esc(item.thumb)}" alt="" loading="lazy" draggable="false">` : '<div class="recent-noimg">🎬</div>'}
      ${kind === 'tv' && item.newCount > 1 ? `<span class="recent-new">${item.newCount} new</span>` : ''}
      <span class="recent-title">${esc(item.title)}</span>
      <span class="recent-sub">${esc(sub)}</span>
    </button>`;
}

async function loadRecent() {
  try {
    const [{ enabledRoomTypes = {} }, data] = await Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/recent').then(r => r.json()),
    ]);
    const fill = (id, kind, list, enabled) => {
      const wrap = document.getElementById(id);
      wrap.style.display = enabled && list && list.length ? 'block' : 'none';
      wrap.querySelector('.recent-row').innerHTML = (list || []).map(i => recentCard(kind, i)).join('');
      return wrap.style.display !== 'none';
    };
    const anyMovies = fill('recent-movies', 'movie', data.movies, enabledRoomTypes.movie !== false);
    const anyShows  = fill('recent-shows', 'tv', data.shows, enabledRoomTypes.tv !== false);
    document.getElementById('recent-section').style.display = anyMovies || anyShows ? 'block' : 'none';
  } catch { /* Plex unreachable — the strip just stays hidden */ }
}

let recentPick = null;
// One handler for both strips (recently added + live now)
function onStripClick(e) {
  const card = e.target.closest('.recent-card, .livenow-card');
  if (!card) return;
  const live = card.dataset.kind === 'livetv';
  recentPick = live
    ? { kind: 'livetv', channel: card.dataset.channel || undefined }
    : { kind: card.dataset.kind, ratingKey: card.dataset.key };
  document.getElementById('recent-modal-title').textContent = card.dataset.title;
  document.getElementById('recent-modal-sub').textContent = card.dataset.sub;
  document.getElementById('recent-modal-text').textContent = !live
    ? 'Create a room with this ready to go and start watching?'
    : card.dataset.channel ? 'Start a Live TV room tuned to this channel?' : 'Start a Live TV room and pick a channel once you’re in?';
  const poster = document.getElementById('recent-modal-poster');
  poster.src = card.dataset.thumb;
  poster.classList.toggle('recent-modal-logo', live);   // channel logos are wide: fit, don't crop
  poster.style.display = card.dataset.thumb ? 'block' : 'none';
  const go = document.getElementById('recent-confirm');
  go.disabled = false; go.textContent = 'Create room';
  document.getElementById('recent-modal').style.display = 'flex';
}
document.getElementById('recent-section').addEventListener('click', onStripClick);
document.getElementById('livenow-section').addEventListener('click', onStripClick);
const closeRecentModal = () => { document.getElementById('recent-modal').style.display = 'none'; recentPick = null; };
document.getElementById('recent-cancel').addEventListener('click', closeRecentModal);
document.getElementById('recent-modal').addEventListener('click', e => { if (e.target.id === 'recent-modal') closeRecentModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRecentModal(); });
document.getElementById('recent-confirm').addEventListener('click', () => {
  if (!recentPick) return;
  const go = document.getElementById('recent-confirm');
  go.disabled = true; go.textContent = 'Creating…';
  socket.emit('create-room', { preload: recentPick });   // 'room-created' then sends us to the room
});
socket.on('error-msg', () => {   // e.g. Plex couldn't load the title — let them try again
  const go = document.getElementById('recent-confirm');
  go.disabled = false; go.textContent = 'Create room';
});

// ── Live TV: on now ────────────────────────────────────────
// What's airing right now, from the Plex guide. Main networks (x.1 subchannels) first.
const LIVENOW_MAX = 14;

function livenowCard(ch, full) {
  const title = `${ch.number} ${ch.title || ''}`.trim();
  return `
    <button type="button" class="livenow-card${full ? ' is-full' : ''}"${full ? ' disabled' : ''} data-kind="livetv" data-channel="${esc(ch.number)}"
            data-title="${esc(title)}" data-sub="${esc(ch.nowPlaying ? 'Now: ' + ch.nowPlaying : '')}"
            data-thumb="${esc(ch.thumb || '')}" title="${esc(title + (ch.nowPlaying ? ' — ' + ch.nowPlaying : ''))}">
      <span class="livenow-logo">${ch.thumb ? `<img src="${esc(ch.thumb)}" alt="" loading="lazy" draggable="false">` : '📡'}</span>
      <span class="livenow-chan">${esc(title)}</span>
      <span class="livenow-prog">${esc(ch.nowPlaying || 'On air')}</span>
    </button>`;
}

async function loadLiveNow() {
  const section = document.getElementById('livenow-section');
  try {
    const { enabledRoomTypes = {} } = await fetch('/api/config').then(r => r.json());
    if (!enabledRoomTypes.livetv) { section.style.display = 'none'; return; }
    const [{ channels = [] }, cap] = await Promise.all([
      fetch('/api/livetv/guide').then(r => r.json()),
      fetch('/api/livetv/capacity').then(r => r.json()).catch(() => null),
    ]);
    const full = !!cap && cap.inUse >= cap.max;
    const capEl = document.getElementById('livenow-cap');
    capEl.textContent = cap ? (full ? `full · ${cap.inUse} of ${cap.max} tuners in use` : `${cap.inUse} of ${cap.max} tuners in use`) : '';
    capEl.classList.toggle('is-full', full);
    const live = channels.filter(c => c.nowPlaying);
    const main = c => (/\.1$/.test(c.number) ? 0 : 1);
    live.sort((a, b) => main(a) - main(b) || parseFloat(a.number) - parseFloat(b.number));
    if (!live.length) { section.style.display = 'none'; return; }
    document.getElementById('livenow-row').innerHTML =
      live.slice(0, LIVENOW_MAX).map(ch => livenowCard(ch, full)).join('') +
      `<button type="button" class="livenow-card livenow-more${full ? ' is-full' : ''}"${full ? ' disabled' : ''} data-kind="livetv" data-title="Live TV" data-sub="All channels" data-thumb="">
         <span class="livenow-logo">＋</span><span class="livenow-chan">More channels</span>
         <span class="livenow-prog">${live.length} on air — pick one in the room</span></button>`;
    section.style.display = 'block';
  } catch { /* guide unavailable — leave the strip hidden */ }
}

// ── Create room ────────────────────────────────────────────
let selectedRoomType = 'movie';

document.querySelectorAll('.btn-room-type').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedRoomType = btn.dataset.type;
    document.querySelectorAll('.btn-room-type').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('yt-url-row').style.display = selectedRoomType === 'youtube' ? 'block' : 'none';
    if (selectedRoomType === 'youtube') setTimeout(() => document.getElementById('yt-url-create').focus(), 30);
    else setTimeout(() => document.getElementById('room-name-input').focus(), 30);
  });
});

document.getElementById('create-room-btn').addEventListener('click', () => {
  // Reset modal state — select first visible room type button
  document.querySelectorAll('.btn-room-type').forEach(b => b.classList.remove('active'));
  const firstVisible = document.querySelector('.btn-room-type:not([style*="none"])');
  if (firstVisible) {
    firstVisible.classList.add('active');
    selectedRoomType = firstVisible.dataset.type;
  } else {
    selectedRoomType = 'movie';
  }
  document.getElementById('room-name-input').value = '';
  document.getElementById('yt-url-create').value = '';
  document.getElementById('yt-url-create-error').style.display = 'none';
  document.getElementById('yt-url-row').style.display = 'none';
  document.getElementById('create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('room-name-input').focus(), 50);
});
document.getElementById('cancel-create').addEventListener('click', () => {
  document.getElementById('create-modal').style.display = 'none';
});
document.getElementById('confirm-create').addEventListener('click', createRoom);
document.getElementById('room-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') createRoom();
  if (e.key === 'Escape') document.getElementById('create-modal').style.display = 'none';
});
document.getElementById('yt-url-create').addEventListener('keydown', e => {
  if (e.key === 'Enter') createRoom();
  if (e.key === 'Escape') document.getElementById('create-modal').style.display = 'none';
});

function createRoom() {
  const name = document.getElementById('room-name-input').value.trim();
  if (selectedRoomType === 'youtube') {
    const youtubeUrl = document.getElementById('yt-url-create').value.trim();
    const errEl = document.getElementById('yt-url-create-error');
    if (!youtubeUrl) {
      errEl.textContent = 'YouTube URL is required';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    document.getElementById('create-modal').style.display = 'none';
    socket.emit('create-room', { name, roomType: 'youtube', youtubeUrl });
  } else {
    document.getElementById('create-modal').style.display = 'none';
    socket.emit('create-room', { name, roomType: selectedRoomType });
  }
}

socket.on('room-created', ({ roomId }) => {
  window.location.href = `/watch/${roomId}`;
});

socket.on('error-msg', (msg) => alert(msg));

// ── Schedule room ──────────────────────────────────────────

function populateTimezones() {
  const sel = document.getElementById('sched-timezone');
  const commonZones = [
    'Pacific/Honolulu','America/Anchorage','America/Los_Angeles','America/Denver',
    'America/Chicago','America/New_York','America/Halifax','America/Sao_Paulo',
    'Atlantic/Azores','Europe/London','Europe/Paris','Europe/Berlin','Europe/Helsinki',
    'Europe/Moscow','Asia/Dubai','Asia/Kolkata','Asia/Bangkok','Asia/Singapore',
    'Asia/Tokyo','Australia/Sydney','Pacific/Auckland'
  ];
  let zones;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = commonZones;
  }

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  zones.forEach(tz => {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz;
    if (tz === browserTz) opt.selected = true;
    sel.appendChild(opt);
  });

  // Fallback: if browser tz wasn't in the list, try to select it or default to UTC
  if (!sel.value) sel.value = 'UTC';
}

function openScheduleModal() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const localMin = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const dt = document.getElementById('sched-datetime');
  dt.min = localMin;
  dt.value = '';

  document.getElementById('sched-name').value = '';
  document.getElementById('sched-movie-display').value = '';
  document.getElementById('sched-movie-key').value = '';
  document.getElementById('sched-movie-partid').value = '';
  document.getElementById('sched-movie-clear').style.display = 'none';
  document.getElementById('sched-error').style.display = 'none';
  document.getElementById('sched-repeat').value = '';
  document.getElementById('schedule-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('sched-name').focus(), 50);
}

// ── Schedule movie browser ──────────────────────────────────
let schedMovieSearchTimeout = null;

async function loadSchedMovies() {
  const grid   = document.getElementById('sched-movies-grid');
  const search = document.getElementById('sched-search-input').value.trim();
  const genre  = document.getElementById('sched-genre-select').value;
  const sort   = document.getElementById('sched-sort-select').value;

  grid.innerHTML = '<div class="loading">Loading movies…</div>';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (genre)  params.set('genre', genre);
  if (sort)   params.set('sort', sort);

  try {
    const { movies, genres, error } = await fetch(`/api/movies?${params}`).then(r => r.json());
    if (error) throw new Error(error);

    const genreSelect = document.getElementById('sched-genre-select');
    const currentGenre = genreSelect.value;
    if (genres?.length) {
      genreSelect.innerHTML = '<option value="">All genres</option>' +
        genres.map(g => `<option value="${esc(g)}"${g === currentGenre ? ' selected' : ''}>${esc(g)}</option>`).join('');
    }

    document.getElementById('sched-movie-count').textContent =
      movies.length ? `${movies.length} movie${movies.length !== 1 ? 's' : ''}` : '';

    if (!movies.length) {
      grid.innerHTML = '<div class="loading">No movies found.</div>';
      return;
    }

    grid.innerHTML = movies.map(m => `
      <div class="movie-card" data-key="${esc(m.ratingKey)}" data-title="${esc(m.title)}">
        ${m.thumb
          ? `<img class="movie-poster" src="${esc(m.thumb)}" alt="${esc(m.title)}" loading="lazy">`
          : `<div class="movie-poster-placeholder">🎬</div>`}
        <div class="movie-info">
          <h3 title="${esc(m.title)}">${esc(m.title)}</h3>
          <span>${m.year || ''}${m.year && m.rating ? ' · ' : ''}${m.rating ? '★ ' + Number(m.rating).toFixed(1) : ''}</span>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => selectSchedMovie(card.dataset.key, card.dataset.title));
    });
  } catch (err) {
    grid.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

async function selectSchedMovie(ratingKey, title) {
  try {
    const movie = await fetch(`/api/movies/${ratingKey}`).then(r => r.json());
    if (!movie.partId) { alert('No stream found for this movie.'); return; }

    document.getElementById('sched-movie-display').value = movie.title || title;
    document.getElementById('sched-movie-key').value     = movie.ratingKey;
    document.getElementById('sched-movie-partid').value  = movie.partId;
    document.getElementById('sched-movie-clear').style.display = 'inline-flex';

    document.getElementById('sched-movie-modal').style.display = 'none';
    document.getElementById('schedule-modal').style.display    = 'flex';
  } catch {
    alert('Failed to load movie details.');
  }
}

document.getElementById('sched-movie-btn').addEventListener('click', () => {
  document.getElementById('schedule-modal').style.display    = 'none';
  document.getElementById('sched-movie-modal').style.display = 'flex';
  loadSchedMovies();
});

document.getElementById('sched-movie-clear').addEventListener('click', () => {
  document.getElementById('sched-movie-display').value = '';
  document.getElementById('sched-movie-key').value     = '';
  document.getElementById('sched-movie-partid').value  = '';
  document.getElementById('sched-movie-clear').style.display = 'none';
});

document.getElementById('close-sched-movie-modal').addEventListener('click', () => {
  document.getElementById('sched-movie-modal').style.display = 'none';
  document.getElementById('schedule-modal').style.display    = 'flex';
});

document.getElementById('sched-search-input').addEventListener('input', () => {
  clearTimeout(schedMovieSearchTimeout);
  schedMovieSearchTimeout = setTimeout(loadSchedMovies, 300);
});
document.getElementById('sched-genre-select').addEventListener('change', loadSchedMovies);
document.getElementById('sched-sort-select').addEventListener('change', loadSchedMovies);

async function submitSchedule() {
  const nameEl  = document.getElementById('sched-name');
  const dtEl    = document.getElementById('sched-datetime');
  const tzEl    = document.getElementById('sched-timezone');
  const errEl   = document.getElementById('sched-error');

  const name       = nameEl.value.trim();
  const dtLocal    = dtEl.value;
  const timezone   = tzEl.value;
  const movieKey   = document.getElementById('sched-movie-key').value   || null;
  const movieTitle = document.getElementById('sched-movie-display').value.trim() || null;
  const partId     = document.getElementById('sched-movie-partid').value || null;

  errEl.style.display = 'none';

  if (!dtLocal) {
    errEl.textContent = 'Please choose a date and time.';
    errEl.style.display = 'block';
    return;
  }

  const scheduledFor = new Date(dtLocal).toISOString();

  if (new Date(scheduledFor) <= new Date()) {
    errEl.textContent = 'Scheduled time must be in the future.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res  = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Watch Party', scheduledFor, timezone, movieKey, movieTitle, partId,
        recurrence: document.getElementById('sched-repeat').value || null })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Failed to schedule room.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('schedule-modal').style.display = 'none';
    loadScheduled();
  } catch {
    errEl.textContent = 'Network error. Please try again.';
    errEl.style.display = 'block';
  }
}

async function loadScheduled() {
  try {
    const res  = await fetch('/api/schedule');
    if (!res.ok) return;
    const { scheduled } = await res.json();
    renderScheduled(scheduled || []);
  } catch {
    renderScheduled([]);
  }
}

function renderScheduled(list) {
  const section = document.getElementById('scheduled-section');
  const grid    = document.getElementById('scheduled-grid');

  if (!list.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  grid.innerHTML = list.map(s => {
    const tz = s.timezone || 'UTC';
    let timeStr;
    try {
      timeStr = new Date(s.scheduledFor).toLocaleString(undefined, {
        timeZone: tz,
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      });
    } catch {
      timeStr = s.scheduledFor;
    }

    const inviteUrl = window.location.origin + '/join/' + s.inviteToken;
    const isOwner   = isAdmin || (currentUserId && s.createdBy && s.createdBy.id === currentUserId);

    return `
      <div class="room-card scheduled-card">
        <div class="room-card-header">
          <span class="room-card-name">${esc(s.name)}</span>
          <span class="sched-badge">${s.recurrence ? (s.recurrence === 'biweekly' ? 'Every 2 weeks' : 'Weekly') : 'Scheduled'}</span>
        </div>
        <div class="room-card-movie">
          ${s.movieTitle ? `<span class="room-now-playing">🎬 ${esc(s.movieTitle)}</span><br>` : ''}
          <span style="color:var(--text-muted);font-size:0.82rem">Opens ${esc(timeStr)}</span>
        </div>
        <div class="room-card-footer">
          <span class="room-viewers">by ${esc(s.createdBy ? s.createdBy.name : 'unknown')}</span>
          <div style="display:flex;gap:0.4rem;align-items:center">
            <button class="btn-copy-link" data-url="${esc(inviteUrl)}" title="Copy invite link">Copy Link</button>
            ${s.calendar ? `<a class="btn-copy-link" href="${esc(s.calendar.ics)}" title="Download a calendar file (Apple, Outlook…)" style="text-decoration:none">.ics</a>
            <a class="btn-copy-link" href="${esc(s.calendar.google)}" target="_blank" rel="noopener" title="Add to Google Calendar" style="text-decoration:none">Google</a>` : ''}
            ${isOwner && s.recurrence ? `<button class="btn-copy-link" data-skip="${esc(s.id)}" title="Skip the next night">Skip next</button>` : ''}
            ${isOwner ? `<button class="btn-cancel-sched" data-id="${esc(s.id)}">${s.recurrence ? 'Cancel series' : 'Cancel'}</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire up copy-link buttons
  grid.querySelectorAll('.btn-copy-link').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.url).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => alert(btn.dataset.url));
    });
  });

  grid.querySelectorAll('[data-skip]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Skip the next occurrence of this night?')) return;
      const res = await fetch('/api/schedule/' + btn.dataset.skip + '/skip', { method: 'POST' }).catch(() => null);
      if (res && res.ok) loadScheduled(); else alert('Failed to skip.');
    });
  });

  // Wire up cancel buttons
  grid.querySelectorAll('.btn-cancel-sched').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(btn.textContent.includes('series') ? 'Cancel this whole recurring series?' : 'Cancel this scheduled room?')) return;
      try {
        const res = await fetch('/api/schedule/' + btn.dataset.id, { method: 'DELETE' });
        if (res.ok) {
          loadScheduled();
        } else {
          const d = await res.json();
          alert(d.error || 'Failed to cancel.');
        }
      } catch {
        alert('Network error.');
      }
    });
  });
}

// Wire up schedule modal buttons
document.getElementById('schedule-room-btn').addEventListener('click', openScheduleModal);
document.getElementById('sched-cancel').addEventListener('click', () => {
  document.getElementById('schedule-modal').style.display = 'none';
});
document.getElementById('sched-confirm').addEventListener('click', submitSchedule);
document.getElementById('sched-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitSchedule();
  if (e.key === 'Escape') document.getElementById('schedule-modal').style.display = 'none';
});

// Populate timezone dropdown once on load
populateTimezones();

// Hide room type buttons for disabled types
fetch('/api/config').then(r => r.json()).then(({ enabledRoomTypes }) => {
  document.querySelectorAll('.btn-room-type').forEach(btn => {
    if (enabledRoomTypes && enabledRoomTypes[btn.dataset.type] === false) {
      btn.style.display = 'none';
    }
  });
  // Ensure the default selection is the first visible type
  const first = document.querySelector('.btn-room-type:not([style*="none"])');
  if (first && !document.querySelector('.btn-room-type.active:not([style*="none"])')) {
    document.querySelectorAll('.btn-room-type').forEach(b => b.classList.remove('active'));
    selectedRoomType = first.dataset.type;
    first.classList.add('active');
  }
}).catch(() => {});

loadUser();
