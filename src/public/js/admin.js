'use strict';

const socket = io();

// Escapes for text *and* attribute values (quotes included)
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const LEAD_LABEL = m => m >= 1440 ? '1 day' : m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} min`;
const TYPE_LABEL = { discord: 'Discord', generic: 'Generic JSON' };

// ── Webhooks ───────────────────────────────────────────────
let meta = { events: {}, types: [], leads: [] };
let webhooks = [];

async function loadWebhooks() {
  try {
    const data = await api('GET', '/api/admin/webhooks');
    meta = data;
    webhooks = data.webhooks;
    fillFormOptions();
    renderWebhooks();
  } catch (err) {
    $('wh-list').innerHTML = `<div class="loading">${esc(err.message)}</div>`;
  }
}

function fillFormOptions() {
  $('wh-type').innerHTML = meta.types.map(t => `<option value="${t}">${esc(TYPE_LABEL[t] || t)}</option>`).join('');
  $('wh-lead').innerHTML = meta.leads.map(m => `<option value="${m}">${LEAD_LABEL(m)} before</option>`).join('');
  $('wh-events').innerHTML = Object.entries(meta.events).map(([key, label]) =>
    `<label class="admin-inline"><input type="checkbox" data-event="${esc(key)}"> ${esc(label)}</label>`).join('');
}

function renderWebhooks() {
  if (!webhooks.length) {
    $('wh-list').innerHTML = '<div class="loading">No webhooks yet — add one to post to Discord.</div>';
    return;
  }
  $('wh-list').innerHTML = webhooks.map(h => {
    const st = h.lastStatus;
    const status = st
      ? `<span class="admin-status ${st.ok ? 'ok' : 'bad'}">${st.ok ? '✓' : '✕'} ${esc(st.message)} · ${new Date(st.at).toLocaleString()}</span>`
      : '<span class="admin-status">not used yet</span>';
    return `
      <div class="admin-row${h.enabled ? '' : ' disabled'}">
        <div class="admin-row-main">
          <div class="admin-row-title">${esc(h.name)} <span class="sched-badge">${esc(TYPE_LABEL[h.type] || h.type)}</span>${h.enabled ? '' : ' <span class="sched-badge">disabled</span>'}</div>
          <div class="admin-row-sub">${esc(h.urlHint)}</div>
          <div class="admin-row-sub">${h.events.length ? h.events.map(e => esc(meta.events[e] || e)).join(' · ') : 'no events selected'}${h.events.includes('schedule.reminder') ? ` · reminder ${LEAD_LABEL(h.leadMinutes)} before` : ''}</div>
          <div class="admin-row-sub">${status}</div>
        </div>
        <div class="admin-row-actions">
          <button class="btn-copy" data-act="test" data-id="${esc(h.id)}">Send test</button>
          <button class="btn-copy" data-act="edit" data-id="${esc(h.id)}">Edit</button>
          <button class="btn-kick" data-act="delete" data-id="${esc(h.id)}">Delete</button>
        </div>
      </div>`;
  }).join('');
}

function openForm(h) {
  $('wh-form').style.display = 'block';
  $('wh-id').value      = h ? h.id : '';
  $('wh-name').value    = h ? h.name : '';
  $('wh-type').value    = h ? h.type : 'discord';
  $('wh-url').value     = '';
  $('wh-url').required  = !h;
  $('wh-url-note').textContent = h ? `Leave blank to keep the current URL (${h.urlHint}).` : 'Treat this URL like a password — anyone with it can post to the channel.';
  $('wh-lead').value    = h ? h.leadMinutes : 15;
  $('wh-enabled').checked = h ? h.enabled : true;
  const events = new Set(h ? h.events : ['schedule.created', 'schedule.reminder']);
  $('wh-events').querySelectorAll('input').forEach(cb => { cb.checked = events.has(cb.dataset.event); });
  $('wh-error').style.display = 'none';
  $('wh-name').focus();
  $('wh-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
const closeForm = () => { $('wh-form').style.display = 'none'; };

$('wh-add-btn').addEventListener('click', () => openForm(null));
$('wh-cancel').addEventListener('click', closeForm);

$('wh-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('wh-id').value;
  const body = {
    name: $('wh-name').value, type: $('wh-type').value,
    events: [...$('wh-events').querySelectorAll('input:checked')].map(cb => cb.dataset.event),
    leadMinutes: $('wh-lead').value, enabled: $('wh-enabled').checked,
  };
  if ($('wh-url').value.trim()) body.url = $('wh-url').value.trim();
  try {
    await (id ? api('PUT', `/api/admin/webhooks/${id}`, body) : api('POST', '/api/admin/webhooks', body));
    closeForm();
    loadWebhooks();
  } catch (err) {
    $('wh-error').textContent = err.message;
    $('wh-error').style.display = 'block';
  }
});

$('wh-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const h = webhooks.find(w => w.id === btn.dataset.id);
  if (!h) return;
  if (btn.dataset.act === 'edit') return openForm(h);
  if (btn.dataset.act === 'delete') {
    if (!confirm(`Delete webhook "${h.name}"?`)) return;
    await api('DELETE', `/api/admin/webhooks/${h.id}`).catch(err => alert(err.message));
    return loadWebhooks();
  }
  if (btn.dataset.act === 'test') {
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const { status } = await api('POST', `/api/admin/webhooks/${h.id}/test`);
      alert(status.ok ? 'Test message sent.' : `Delivery failed: ${status.message}`);
    } catch (err) { alert(err.message); }
    loadWebhooks();
  }
});

// ── Live rooms (the owner's sockets get the detailed room list) ──
socket.on('room-list', (rooms) => {
  if (!rooms.length) { $('rooms-list').innerHTML = '<div class="loading">No rooms are open.</div>'; return; }
  $('rooms-list').innerHTML = rooms.map(r => `
    <div class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-title">${esc(r.name)} <span class="sched-badge">${esc(r.roomType)}</span>${r.alwaysOn ? ' <span class="sched-badge always-on-badge">always on</span>' : ''}</div>
        <div class="admin-row-sub">${r.alwaysOn && !r.viewerCount ? 'empty — waiting for someone to arrive' : `hosted by ${esc(r.hostName)}`}${r.movieTitle ? ` · ${esc(r.movieTitle)}` : ''}${r.alwaysOn && !r.viewerCount ? '' : ` · ${r.viewerCount} watching`}</div>
        <div class="admin-chips">
          ${(r.viewers || []).map(v => `
            <span class="admin-chip">${esc(v.name)}${v.isHost ? ' 👑' : ''}${v.isGuest ? ' <em>guest</em>' : ''}${v.isHost || v.isAdmin ? '' : ` <button class="chip-x" data-kick="${esc(v.socketId)}" title="Kick and block from this room">✕</button>`}</span>`).join('')}
        </div>
      </div>
      <div class="admin-row-actions">
        <a class="btn-copy" href="/watch/${esc(r.id)}" style="text-decoration:none">Open</a>
        <button class="btn-kick" data-close="${esc(r.id)}" data-name="${esc(r.name)}"${r.alwaysOn ? ' title="Sends everyone out; the room stays open and resets"' : ''}>${r.alwaysOn ? 'Eject everyone' : 'Close room'}</button>
      </div>
    </div>`).join('');
});

$('rooms-list').addEventListener('click', (e) => {
  const kick = e.target.closest('[data-kick]');
  if (kick && confirm('Kick this viewer and block them from rejoining the room?')) socket.emit('admin-kick', { targetSocketId: kick.dataset.kick });
  const close = e.target.closest('[data-close]');
  if (close && confirm(`${close.textContent.trim() === 'Eject everyone' ? 'Send everyone out of' : 'Close'} "${close.dataset.name}"?`)) socket.emit('admin-close-room', { roomId: close.dataset.close });
});
socket.on('error-msg', msg => alert(msg));

// ── Always-on rooms ────────────────────────────────────────
const AO_TYPES = { livetv: '📡 Live TV', movie: '🎬 Movie', tv: '📺 TV show' };
let alwaysOn = [];
let guideLoaded = false;

async function loadAlwaysOn() {
  try {
    const data = await api('GET', '/api/admin/always-on');
    alwaysOn = data.rooms;
    $('ao-type').innerHTML = Object.entries(AO_TYPES)
      .filter(([t]) => data.enabledRoomTypes[t])
      .map(([t, label]) => `<option value="${t}">${label}</option>`).join('');
    renderAlwaysOn();
  } catch (err) {
    $('ao-list').innerHTML = `<div class="loading">${esc(err.message)}</div>`;
  }
}

function renderAlwaysOn() {
  if (!alwaysOn.length) { $('ao-list').innerHTML = '<div class="loading">No always-on rooms. Add one to keep a room open permanently.</div>'; return; }
  $('ao-list').innerHTML = alwaysOn.map(r => {
    const where = r.channel ? `${r.channel.channel} ${r.channel.channelTitle}` : (r.roomType === 'livetv' ? 'pick a channel in the room' : '');
    const status = !r.open ? 'Not open — that room type is turned off in .env'
      : r.viewers ? `${esc(r.hostName || 'someone')} hosting · ${r.viewers} watching${r.onChannel ? ` · on ${esc(r.onChannel)}` : ''}`
      : (r.roomType === 'livetv' ? 'Empty — tunes when someone arrives' : 'Empty — waiting for someone to arrive');
    return `
      <div class="admin-row">
        <div class="admin-row-main">
          <div class="admin-row-title">${esc(r.name)} <span class="sched-badge">${esc(AO_TYPES[r.roomType] || r.roomType)}</span></div>
          <div class="admin-row-sub">${where ? esc(where) + ' · ' : ''}${status}</div>
        </div>
        <div class="admin-row-actions">
          ${r.roomId ? `<a class="btn-copy" href="/watch/${esc(r.roomId)}" style="text-decoration:none">Open</a>` : ''}
          <button class="btn-copy" data-ao="copy" data-url="${esc(r.inviteUrl)}">Copy link</button>
          <button class="btn-kick" data-ao="remove" data-id="${esc(r.id)}" data-name="${esc(r.name)}">Remove</button>
        </div>
      </div>`;
  }).join('');
}

async function fillChannels() {
  if (guideLoaded) return;
  $('ao-channel').innerHTML = '<option value="">Loading channels…</option>';
  try {
    const { channels = [] } = await api('GET', '/api/livetv/guide');
    channels.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
    $('ao-channel').innerHTML = '<option value="">No channel — pick one when joining</option>' +
      channels.map(c => `<option value="${esc(c.number)}">${esc(c.number)} ${esc(c.title || '')}</option>`).join('');
    guideLoaded = true;
  } catch {
    $('ao-channel').innerHTML = '<option value="">Channel guide unavailable</option>';
  }
}

function syncAoForm() {
  const live = $('ao-type').value === 'livetv';
  $('ao-channel-wrap').style.display = live ? 'flex' : 'none';
  if (live) fillChannels();
}

$('ao-add-btn').addEventListener('click', () => {
  $('ao-form').style.display = 'block';
  $('ao-name').value = ''; $('ao-error').style.display = 'none';
  syncAoForm();
  $('ao-name').focus();
});
$('ao-cancel').addEventListener('click', () => { $('ao-form').style.display = 'none'; });
$('ao-type').addEventListener('change', syncAoForm);

$('ao-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('ao-name').value, roomType: $('ao-type').value };
  if (body.roomType === 'livetv' && $('ao-channel').value) body.channel = $('ao-channel').value;
  try {
    await api('POST', '/api/admin/always-on', body);
    $('ao-form').style.display = 'none';
    loadAlwaysOn();
  } catch (err) {
    $('ao-error').textContent = err.message;
    $('ao-error').style.display = 'block';
  }
});

$('ao-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ao]');
  if (!btn) return;
  if (btn.dataset.ao === 'copy') {
    await navigator.clipboard.writeText(btn.dataset.url).catch(() => {});
    btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
    return;
  }
  if (!confirm(`Remove "${btn.dataset.name}"? It closes now (everyone in it is sent to the lobby) and won't come back.`)) return;
  try { await api('DELETE', `/api/admin/always-on/${btn.dataset.id}`); loadAlwaysOn(); }
  catch (err) { alert(err.message); }
});

// ── People ─────────────────────────────────────────────────
let people = [];

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d < 60 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

function renderPeople() {
  const q = $('people-search').value.trim().toLowerCase();
  const list = people.filter(p => !q || `${p.name} ${p.nickname || ''}`.toLowerCase().includes(q));
  if (!people.length) { $('people-list').innerHTML = '<div class="loading">Nobody has signed in yet.</div>'; return; }
  if (!list.length)   { $('people-list').innerHTML = '<div class="loading">No one matches that search.</div>'; return; }
  $('people-list').innerHTML = list.map(p => `
    <div class="admin-row">
      ${p.picture ? `<img class="admin-avatar" src="${esc(p.picture)}" alt="">` : `<div class="admin-avatar admin-avatar-none">${esc((p.nickname || p.name || '?')[0].toUpperCase())}</div>`}
      <div class="admin-row-main">
        <div class="admin-row-title">${esc(p.nickname || p.name)}${p.online ? ' <span class="admin-online" title="Connected now"></span>' : ''}</div>
        <div class="admin-row-sub">${p.nickname ? `Plex name: ${esc(p.name)} · ` : 'No nickname set · '}${p.online ? 'online now' : `last seen ${esc(ago(p.lastSeen))}`}${p.logins ? ` · ${p.logins} sign-in${p.logins === 1 ? '' : 's'}` : ''} · first seen ${esc(new Date(p.firstSeen).toLocaleDateString())}</div>
      </div>
      <div class="admin-row-actions">
        <button class="btn-make-host" data-rename="${esc(p.id)}" data-name="${esc(p.nickname || p.name)}">Rename</button>
        ${p.nickname ? `<button class="btn-kick" data-clear="${esc(p.id)}" data-name="${esc(p.nickname)}">Reset nickname</button>` : ''}
      </div>
    </div>`).join('');
}

async function loadPeople() {
  try {
    people = (await api('GET', '/api/admin/users')).users;
    renderPeople();
  } catch (err) {
    $('people-list').innerHTML = `<div class="loading">${esc(err.message)}</div>`;
  }
}

$('people-search').addEventListener('input', renderPeople);
$('people-list').addEventListener('click', async (e) => {
  const ren = e.target.closest('[data-rename]');
  if (ren) {
    const name = prompt(`New name for ${ren.dataset.name}:`, ren.dataset.name);
    if (name === null || !name.trim() || name.trim() === ren.dataset.name) return;
    try { await api('PUT', `/api/admin/users/${encodeURIComponent(ren.dataset.rename)}/nickname`, { name: name.trim() }); loadPeople(); }
    catch (err) { alert(err.message); }
    return;
  }
  const btn = e.target.closest('[data-clear]');
  if (!btn || !confirm(`Clear the nickname "${btn.dataset.name}"? They can pick a new one.`)) return;
  try { await api('DELETE', `/api/admin/users/${encodeURIComponent(btn.dataset.clear)}/nickname`); loadPeople(); }
  catch (err) { alert(err.message); }
});

// ── Scheduled & recurring ──────────────────────────────────
async function loadScheduled() {
  try {
    const { scheduled } = await api('GET', '/api/schedule');
    if (!scheduled.length) { $('sched-list').innerHTML = '<div class="loading">Nothing scheduled.</div>'; return; }
    $('sched-list').innerHTML = scheduled.map(s => {
      let when;
      try {
        when = new Date(s.scheduledFor).toLocaleString(undefined, {
          timeZone: s.timezone || 'UTC', weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
        });
      } catch { when = s.scheduledFor; }
      const repeat = s.recurrence ? ` <span class="sched-badge">repeats ${s.recurrence === 'biweekly' ? 'every 2 weeks' : 'weekly'}</span>` : '';
      return `
        <div class="admin-row">
          <div class="admin-row-main">
            <div class="admin-row-title">${esc(s.name)}${repeat}</div>
            <div class="admin-row-sub">Next: ${esc(when)} · by ${esc(s.createdBy ? s.createdBy.name : 'unknown')}</div>
          </div>
          <div class="admin-row-actions">
            <button class="btn-copy" data-url="${esc(location.origin + '/join/' + s.inviteToken)}" data-sact="copy">Copy link</button>
            ${s.recurrence ? `<button class="btn-copy" data-sact="skip" data-id="${esc(s.id)}">Skip next</button>` : ''}
            <button class="btn-kick" data-sact="cancel" data-id="${esc(s.id)}">${s.recurrence ? 'Cancel series' : 'Cancel'}</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    $('sched-list').innerHTML = `<div class="loading">${esc(err.message)}</div>`;
  }
}

$('sched-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sact]');
  if (!btn) return;
  try {
    if (btn.dataset.sact === 'copy') {
      await navigator.clipboard.writeText(btn.dataset.url);
      btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
      return;
    }
    if (btn.dataset.sact === 'skip') {
      if (!confirm('Skip the next occurrence?')) return;
      await api('POST', `/api/schedule/${btn.dataset.id}/skip`);
    } else if (btn.dataset.sact === 'cancel') {
      if (!confirm('Cancel this scheduled room?')) return;
      await api('DELETE', `/api/schedule/${btn.dataset.id}`);
    }
    loadScheduled();
  } catch (err) { alert(err.message); }
});

loadWebhooks();
loadScheduled();
loadPeople();
loadAlwaysOn();
setInterval(loadScheduled, 60000);
setInterval(loadAlwaysOn, 10000);
setInterval(loadPeople, 30000);
