'use strict';

const { localStamp, utcStamp } = require('./timeutil');

const EVENT_HOURS = 2; // a watch night's calendar length (the app doesn't know the runtime)
const RECURRENCE  = { weekly: { freq: 'WEEKLY', interval: 1, days: 7 }, biweekly: { freq: 'WEEKLY', interval: 2, days: 14 } };

const baseUrl   = () => (process.env.APP_URL || '').replace(/\/$/, '');
const inviteUrl = s => `${baseUrl()}/join/${s.inviteToken}`;
const rrule     = s => { const r = RECURRENCE[s.recurrence]; return r ? `FREQ=${r.freq};INTERVAL=${r.interval}` : null; };
const endOf     = start => new Date(start.getTime() + EVENT_HOURS * 3600 * 1000);

const esc = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// RFC 5545: lines are folded at 75 octets with a leading space on continuations
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

function description(s) {
  return `Join the watch night on Playdarr: ${inviteUrl(s)}` + (s.movieTitle ? `\nPlanned: ${s.movieTitle}` : '');
}

/** A single-event .ics. Recurring nights get an RRULE and a local-time DTSTART so DST doesn't shift them. */
function buildIcs(s) {
  const start = new Date(s.scheduledFor);
  const tz    = s.timezone || 'UTC';
  const rule  = rrule(s);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Playdarr//Watch Night//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${s.id}@playdarr`,
    `DTSTAMP:${utcStamp(new Date())}`,
    rule ? `DTSTART;TZID=${tz}:${localStamp(start, tz)}` : `DTSTART:${utcStamp(start)}`,
    rule ? `DTEND;TZID=${tz}:${localStamp(endOf(start), tz)}` : `DTEND:${utcStamp(endOf(start))}`,
    ...(rule ? [`RRULE:${rule}`] : []),
    `SUMMARY:${esc('🍿 ' + s.name)}`,
    `DESCRIPTION:${esc(description(s))}`,
    `URL:${inviteUrl(s)}`,
    `LOCATION:${esc(inviteUrl(s))}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(s.name + ' starts soon')}`, 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** "Add to Google Calendar" link for the next occurrence (with a recurrence rule when it repeats). */
function googleCalendarUrl(s) {
  const start = new Date(s.scheduledFor);
  const tz    = s.timezone || 'UTC';
  const rule  = rrule(s);
  const q = new URLSearchParams({
    action:  'TEMPLATE',
    text:    '🍿 ' + s.name,
    dates:   `${localStamp(start, tz)}/${localStamp(endOf(start), tz)}`,
    ctz:     tz,
    details: description(s),
    location: inviteUrl(s),
  });
  if (rule) q.set('recur', `RRULE:${rule}`);
  return `https://calendar.google.com/calendar/render?${q}`;
}

module.exports = { buildIcs, googleCalendarUrl, inviteUrl, RECURRENCE };
