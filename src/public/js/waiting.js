'use strict';

const token  = window.location.pathname.split('/').pop();
const params = new URLSearchParams(window.location.search);

// Populate from URL params immediately
document.getElementById('room-name').textContent = params.get('n') || 'Movie Night';

const scheduledFor = params.get('t');
const timezone     = params.get('z') || 'UTC';
try {
  document.getElementById('opens-time').textContent =
    new Date(scheduledFor).toLocaleString(undefined, {
      timeZone:     timezone,
      weekday:      'long',
      year:         'numeric',
      month:        'long',
      day:          'numeric',
      hour:         '2-digit',
      minute:       '2-digit',
      timeZoneName: 'short'
    });
} catch {
  document.getElementById('opens-time').textContent = scheduledFor || '—';
}

// Poll for room open, then redirect
async function poll() {
  try {
    const res  = await fetch('/join/' + token + '/info', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.roomId) {
      clearInterval(interval);
      window.location.href = '/join/' + token;
    }
  } catch { /* retry next tick */ }
}

const interval = setInterval(poll, 2000);
poll();
