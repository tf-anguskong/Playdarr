'use strict';

const express   = require('express');
const router    = express.Router();
const scheduler = require('../scheduler');
const notifier  = require('../notifier');
const plex      = require('../plex');
const { googleCalendarUrl, RECURRENCE } = require('../ical');

// Calendar links ride along with every record so the lobby can offer "add to calendar"
const withCalendar = s => ({ ...s, calendar: { ics: `/join/${s.inviteToken}/event.ics`, google: googleCalendarUrl(s) } });

// All routes are mounted under /api/schedule and already require Plex auth
// (enforced by server.js before mounting this router).

// ── GET /api/schedule ─────────────────────────────────────
// List all upcoming scheduled rooms.
router.get('/', (req, res) => {
  res.json({ scheduled: scheduler.listScheduled().map(withCalendar) });
});

// ── GET /api/schedule/config ──────────────────────────────
// Return server config relevant to scheduling (timezone default).
router.get('/config', (req, res) => {
  res.json({ defaultTimezone: process.env.DEFAULT_TIMEZONE || 'UTC' });
});

// ── POST /api/schedule ────────────────────────────────────
// Create a new scheduled room.
router.post('/', async (req, res) => {
  const { name, scheduledFor, timezone, movieKey, recurrence } = req.body || {};

  if (!scheduledFor) {
    return res.status(400).json({ error: 'scheduledFor is required' });
  }

  // Validate scheduledFor is in the future
  const scheduledDate = new Date(scheduledFor);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ error: 'scheduledFor is not a valid date' });
  }
  if (scheduledDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'scheduledFor must be in the future' });
  }

  // Validate timezone (fall back gracefully)
  let resolvedTz = process.env.DEFAULT_TIMEZONE || 'UTC';
  if (timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      resolvedTz = timezone;
    } catch {
      // Invalid timezone — use default
    }
  }

  // A pre-picked movie is looked up in Plex: the browser only names it, never its title or file (part)
  let movie = { movieKey: null, movieTitle: null, partId: null };
  if (movieKey) {
    try {
      if (!/^\d+$/.test(String(movieKey))) throw new Error('bad ratingKey');
      const item = await plex.getMovieDetails(String(movieKey));
      const part = item?.Media?.[0]?.Part?.[0]?.id;
      if (item?.type !== 'movie' || part == null) throw new Error('not a playable movie');
      movie = { movieKey: String(item.ratingKey), movieTitle: item.title, partId: String(part) };
    } catch (err) {
      return res.status(400).json({ error: 'Could not find that movie in Plex' });
    }
  }

  const user = req.session.user;
  const cleanName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
  const scheduled = scheduler.createScheduled({
    name:         cleanName || 'Watch Party',
    scheduledFor: scheduledDate.toISOString(),
    timezone:     resolvedTz,
    ...movie,
    recurrence:   RECURRENCE[recurrence] ? recurrence : null,
    createdBy:    { id: user.id, name: user.displayName || user.name }
  });

  notifier.notify('schedule.created', notifier.scheduleData(scheduled));
  res.status(201).json({ scheduled: withCalendar(scheduled) });
});

// ── DELETE /api/schedule/:id ──────────────────────────────
// Delete a scheduled room (creator only).
router.delete('/:id', (req, res) => {
  const scheduled = scheduler.getScheduled(req.params.id);
  if (!scheduled) {
    return res.status(404).json({ error: 'Scheduled room not found' });
  }

  const user = req.session.user;
  if (scheduled.createdBy.id !== user.id && !user.isAdmin) {
    return res.status(403).json({ error: 'Only the creator or the server owner can cancel a scheduled room' });
  }

  if (user.isAdmin && scheduled.createdBy.id !== user.id) {
    console.log(`[Admin] ${user.name} cancelled scheduled room "${scheduled.name}"`);
  }
  scheduler.deleteScheduled(req.params.id);
  res.json({ ok: true });
});

// ── POST /api/schedule/:id/skip ───────────────────────────
// Skip the next occurrence of a recurring night (creator or server owner).
router.post('/:id/skip', (req, res) => {
  const scheduled = scheduler.getScheduled(req.params.id);
  if (!scheduled) return res.status(404).json({ error: 'Scheduled room not found' });
  const user = req.session.user;
  if (scheduled.createdBy.id !== user.id && !user.isAdmin) {
    return res.status(403).json({ error: 'Only the creator or the server owner can skip an occurrence' });
  }
  const updated = scheduler.skipNext(req.params.id);
  if (!updated) return res.status(400).json({ error: 'That night does not repeat' });
  res.json({ scheduled: withCalendar(updated) });
});

module.exports = router;
