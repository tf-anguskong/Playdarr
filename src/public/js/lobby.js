'use strict';

const socket = io();

function esc(s = '') {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

// ── User info ──────────────────────────────────────────────
async function loadUser() {
  const { user } = await fetch('/api/me').then(r => r.json());
  if (!user) return;
  document.getElementById('user-name').textContent = user.displayName || user.name;
  if (user.picture) {
    const a = document.getElementById('user-avatar');
    a.src = user.picture; a.style.display = 'block';
  }
  if (!user.isGuest) {
    document.getElementById('create-room-btn').style.display = 'inline-flex';
    document.getElementById('edit-name-btn').style.display = 'inline';
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
  try {
    const { name: saved } = await fetch('/api/me/display-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).then(r => r.json());
    document.getElementById('user-name').textContent = saved;
    closeNameEditor();
  } catch { alert('Failed to save name.'); }
}

editBtn.addEventListener('click', openNameEditor);
nameSave.addEventListener('click', saveName);
nameCancel.addEventListener('click', closeNameEditor);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveName();
  if (e.key === 'Escape') closeNameEditor();
});

// ── Room list ──────────────────────────────────────────────
socket.on('room-list', (rooms) => {
  const grid = document.getElementById('rooms-grid');
  if (!rooms.length) {
    grid.innerHTML = '<div class="loading">No rooms yet — create one to get started!</div>';
    return;
  }
  grid.innerHTML = rooms.map(r => `
    <div class="room-card">
      <div class="room-card-header">
        <span class="room-card-name">${esc(r.name)}</span>
        <span class="room-host">hosted by ${esc(r.hostName)}</span>
      </div>
      <div class="room-card-movie">
        ${r.roomType === 'youtube'
          ? `<span class="room-now-playing">▶ ${r.movieTitle ? esc(r.movieTitle) : (r.youtubeVideoId ? 'YouTube' : 'No video set')}</span>`
          : r.hasMovie
            ? `<span class="room-now-playing">▶ ${esc(r.movieTitle)}</span>`
            : `<span style="color:var(--text-muted)">No movie selected yet</span>`
        }
      </div>
      <div class="room-card-footer">
        <span class="room-viewers">${r.viewerCount} watching</span>
        <a class="btn-join" href="/watch/${r.id}">Join →</a>
      </div>
    </div>
  `).join('');
});

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
  // Reset modal state
  selectedRoomType = 'movie';
  document.querySelectorAll('.btn-room-type').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-type="movie"]').classList.add('active');
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
    socket.emit('create-room', { name });
  }
}

socket.on('room-created', ({ roomId }) => {
  window.location.href = `/watch/${roomId}`;
});

socket.on('error-msg', (msg) => alert(msg));

loadUser();
