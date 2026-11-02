'use strict';

// Wall-clock <-> UTC helpers for recurring events. A "weekly 8pm" night must stay at 8pm local
// across daylight-saving changes, so occurrences are computed in the event's own timezone.

/** Local date/time parts of a UTC instant in `tz`. */
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Milliseconds `tz` is ahead of UTC at the given instant. */
function tzOffsetMs(date, tz) {
  const p = localParts(date, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant for a wall-clock time in `tz` (handles DST by re-checking the offset once). */
function zonedToUtc(p, tz) {
  const guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s || 0);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

/** The same local wall-clock time `days` later in `tz`, as a UTC Date. */
function addLocalDays(date, days, tz) {
  const p = localParts(date, tz);
  const shifted = new Date(Date.UTC(p.y, p.mo - 1, p.d + days));
  return zonedToUtc({ y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), h: p.h, mi: p.mi, s: p.s }, tz);
}

const pad = n => String(n).padStart(2, '0');

/** `YYYYMMDDTHHMMSS` local time in `tz` (iCalendar / Google Calendar floating format). */
function localStamp(date, tz) {
  const p = localParts(date, tz);
  return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

/** `YYYYMMDDTHHMMSSZ` UTC. */
function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

module.exports = { localParts, zonedToUtc, addLocalDays, localStamp, utcStamp };
