'use strict';

// Outgoing webhooks (Discord or generic JSON), configured by the server owner in the admin panel.
// Stored in DATA_PATH/webhooks.json. A reminder ticker fires `schedule.reminder` shortly before a
// scheduled watch night starts, once per night per webhook.

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { randomUUID: uuidv4 } = require('crypto');
const scheduler = require('./scheduler');
const { inviteUrl, googleCalendarUrl } = require('./ical');
const embed = require('./embed');

const dataPath = process.env.DATA_PATH || '/data';
const FILE     = path.join(dataPath, 'webhooks.json');

const EVENTS = {
  'schedule.created':  'A watch night is scheduled',
  'schedule.reminder': 'A watch night is about to start',
  'schedule.started':  'A scheduled room has opened',
  'room.created':      'A room is created',
};
const TYPES = ['discord', 'generic'];
const LEADS = [5, 10, 15, 30, 60, 120, 1440];   // minutes before start a reminder may be sent
const AMBER = 0xf5a524;

const hooks = new Map();   // id -> webhook

// ── Persistence ───────────────────────────────────────────
function persist() {
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    // Webhook URLs (Discord ones embed a secret token) — keep the file private
    fs.writeFileSync(FILE, JSON.stringify(Array.from(hooks.values()), null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[Webhooks] Failed to write webhooks.json:', err.message);
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(list)) list.forEach(h => h && h.id && hooks.set(h.id, h));
    console.log(`[Webhooks] Loaded ${hooks.size} webhook(s)`);
  } catch (err) {
    console.error('[Webhooks] Failed to read webhooks.json:', err.message);
  }
}

// ── CRUD (used by the admin API) ──────────────────────────
/** Shape sent to the browser: the URL is a secret, so only a hint of it leaves the server. */
function publicView(h) {
  let hint = '';
  try { const u = new URL(h.url); hint = `${u.host}/…${h.url.slice(-6)}`; } catch { hint = '(invalid)'; }
  const { url, ...rest } = h;
  return { ...rest, urlHint: hint };
}

function clean(input, existing) {
  const out = existing ? { ...existing } : { id: uuidv4(), createdAt: new Date().toISOString(), lastStatus: null };
  if (input.name !== undefined) out.name = String(input.name).trim().slice(0, 40);
  if (!out.name) throw new Error('Name is required');
  if (input.type !== undefined) {
    if (!TYPES.includes(input.type)) throw new Error('Unknown webhook type');
    out.type = input.type;
  }
  out.type = out.type || 'discord';
  if (input.url) {
    let u;
    try { u = new URL(String(input.url).trim()); } catch { throw new Error('That is not a valid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('URL must be http or https');
    out.url = u.toString();
  }
  if (!out.url) throw new Error('URL is required');
  if (input.events !== undefined) {
    out.events = [...new Set((input.events || []).filter(e => EVENTS[e]))];
  }
  out.events = out.events || [];
  if (input.leadMinutes !== undefined) {
    const lead = parseInt(input.leadMinutes, 10);
    if (!LEADS.includes(lead)) throw new Error('Unsupported reminder lead time');
    out.leadMinutes = lead;
  }
  out.leadMinutes = out.leadMinutes || 15;
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  if (out.enabled === undefined) out.enabled = true;
  return out;
}

const list   = () => Array.from(hooks.values()).map(publicView);
const get    = id => hooks.get(id) || null;
function create(input) { const h = clean(input); hooks.set(h.id, h); persist(); return publicView(h); }
function update(id, input) {
  const cur = hooks.get(id);
  if (!cur) return null;
  const h = clean(input, cur);
  hooks.set(id, h); persist();
  return publicView(h);
}
function remove(id) { const ok = hooks.delete(id); if (ok) persist(); return ok; }

// ── Message building ──────────────────────────────────────
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);

function describe(event, d) {
  const when = d.scheduledFor ? `<t:${unix(d.scheduledFor)}:F> (<t:${unix(d.scheduledFor)}:R>)` : '';
  const repeats = d.recurrence ? ` · repeats ${d.recurrence === 'biweekly' ? 'every 2 weeks' : 'weekly'}` : '';
  switch (event) {
    case 'schedule.created':
      return { title: `📅 Watch night scheduled: ${d.name}`, text: `${when}${repeats}` };
    case 'schedule.reminder':
      return { title: `⏰ Starting soon: ${d.name}`, text: `Doors open <t:${unix(d.scheduledFor)}:R> — ${when}` };
    case 'schedule.started':
      return { title: `🍿 ${d.name} is open`, text: 'The room is open — come on in!' };
    case 'room.created':
      return { title: `🎬 New room: ${d.name}`, text: d.createdBy ? `Opened by ${d.createdBy}` : 'A new room is open' };
    default:
      return { title: d.name || event, text: '' };
  }
}

// The small line above the title, naming what happened (the card's title then says what's on)
const HEADERS = {
  'schedule.created':  'Watch night scheduled',
  'schedule.reminder': 'Starting soon',
  'schedule.started':  'Doors are open',
  'room.created':      'New room',
};
const appUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');
const previewUrl = token => `${appUrl()}/join/${token}/preview.jpg`;

/**
 * The same card a link preview of the invite would show (embed.js): what's on, facts, host, tagline, artwork.
 * ctx.room is a live sync.js Room, ctx.schedule a scheduled-night record. Null when there's nothing to build from
 * or it fails — the message then falls back to the plain describe() text.
 */
async function cardFor(event, ctx = {}) {
  try {
    if (ctx.room) {
      const r = ctx.room;
      return await embed.forRoom(r, `${previewUrl(r.inviteToken)}?v=${encodeURIComponent(r.movieKey || '')}`);
    }
    if (ctx.schedule) {
      const s = ctx.schedule, t = unix(s.scheduledFor);
      const repeat = s.recurrence === 'weekly' ? ' · every week' : s.recurrence === 'biweekly' ? ' · every other week' : '';
      const time = event === 'schedule.started'  ? '🍿 The room is open — come on in!'
                 : event === 'schedule.reminder' ? `⏰ Doors open <t:${t}:R> · <t:${t}:t>`
                 : `Starts <t:${t}:F> (<t:${t}:R>)${repeat}`;
      const img = s.inviteToken ? `${previewUrl(s.inviteToken)}?v=${encodeURIComponent(s.movieKey || '')}` : null;
      return await embed.forScheduled(s, img, { time });
    }
  } catch (err) {
    console.warn(`[Webhooks] Could not build the ${event} card:`, err.message);
  }
  return null;
}

/** Discord embed built from a card, laid out like Discord's own unfurl of the invite link. */
function discordEmbed(event, data, card) {
  const links = [];
  if (data.url) links.push(`**[Join the room](${data.url})**${event === 'room.created' ? ' — no Plex account needed' : ''}`);
  if (data.calendar && event !== 'schedule.started') {
    links.push(`[Add to calendar](${data.calendar.ics})`, `[Google Calendar](${data.calendar.google})`);
  }
  const description = [...card.lines, '', links.join(' · ')].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    author: { name: `Playdarr · ${HEADERS[event] || event}` },
    title: embed.clip(card.title, 256),
    url: data.url || undefined,
    description: description.slice(0, 4000),
    color: AMBER,
    // Big backdrop for Plex titles / YouTube; Live TV channel logos stay small, as in the link preview
    ...(card.image ? (card.large ? { image: { url: card.image } } : { thumbnail: { url: card.image } }) : {}),
    footer: { text: 'Playdarr' },
    timestamp: new Date().toISOString(),
  };
}

function bodyFor(hook, event, data, card) {
  const { title, text } = describe(event, data);
  if (hook.type === 'discord' && card) {
    return { username: 'Playdarr', embeds: [discordEmbed(event, data, card)] };
  }
  if (hook.type === 'discord') {
    return {
      username: 'Playdarr',
      embeds: [{
        title, description: [text, data.url ? `**[Join the room](${data.url})**` : ''].filter(Boolean).join('\n\n'),
        url: data.url || undefined,
        color: AMBER,
        ...(data.movieTitle ? { fields: [{ name: 'Planned', value: data.movieTitle, inline: true }] } : {}),
        footer: { text: 'Playdarr' },
        timestamp: new Date().toISOString(),
      }],
    };
  }
  // generic: plain readable text plus the raw data, for ntfy/Gotify/Home Assistant/n8n-style receivers
  return {
    event, title,
    message: text.replace(/<t:(\d+):[FR]>/g, (_, s) => new Date(s * 1000).toISOString()),
    url: data.url || null,
    image: card?.image || null,
    data,
  };
}

// ── Delivery ──────────────────────────────────────────────
async function deliver(hook, event, data, card = null) {
  const body = bodyFor(hook, event, data, card);
  let status;
  try {
    const res = await axios.post(hook.url, body, { timeout: 8000, maxRedirects: 0, validateStatus: () => true });
    status = { at: new Date().toISOString(), ok: res.status >= 200 && res.status < 300, message: `HTTP ${res.status}`, event };
    // 429: honour Discord's retry hint once
    if (res.status === 429) {
      const wait = Math.min(Number(res.data?.retry_after) || 1, 5) * 1000;
      await new Promise(r => setTimeout(r, wait));
      const retry = await axios.post(hook.url, body, { timeout: 8000, maxRedirects: 0, validateStatus: () => true });
      status = { at: new Date().toISOString(), ok: retry.status >= 200 && retry.status < 300, message: `HTTP ${retry.status} (retried)`, event };
    }
  } catch (err) {
    status = { at: new Date().toISOString(), ok: false, message: err.code || err.message, event };
  }
  const live = hooks.get(hook.id);
  if (live) { live.lastStatus = status; persist(); }
  if (!status.ok) console.warn(`[Webhooks] "${hook.name}" ${event} failed: ${status.message}`);
  return status;
}

/**
 * Send `event` to every enabled webhook subscribed to it. Never throws — notifications are best-effort.
 * `ctx` ({ room } or { schedule }) lets the message carry the full link-preview card; the card is built once
 * (it may ask Plex for metadata) and shared by every webhook.
 */
async function notify(event, data, ctx = {}) {
  const targets = Array.from(hooks.values()).filter(h => h.enabled && h.events.includes(event));
  if (!targets.length) return;
  const card = await cardFor(event, ctx);
  await Promise.all(targets.map(h => deliver(h, event, data, card).catch(() => {})));
}

/** Webhook payload for a scheduled-room record. */
const scheduleData = s => ({
  name: s.name, scheduledFor: s.scheduledFor, timezone: s.timezone, recurrence: s.recurrence || null,
  movieTitle: s.movieTitle || null, createdBy: s.createdBy?.name || null, url: inviteUrl(s),
  calendar: { ics: `${inviteUrl(s)}/event.ics`, google: googleCalendarUrl(s) },
});

/** Send a test message to one webhook (bypasses the event subscription). */
async function test(id) {
  const hook = hooks.get(id);
  if (!hook) return null;
  const sample = {
    name: 'Test watch night', scheduledFor: new Date(Date.now() + hook.leadMinutes * 60000).toISOString(),
    timezone: 'UTC', recurrence: null, createdBy: { name: 'Playdarr admin' },
  };
  return deliver(hook, 'schedule.reminder', {
    name: sample.name, scheduledFor: sample.scheduledFor, timezone: 'UTC', recurrence: null, movieTitle: null,
    createdBy: sample.createdBy.name, url: `${appUrl()}/`,
  }, await cardFor('schedule.reminder', { schedule: sample }));
}

// ── Reminder ticker ───────────────────────────────────────
function checkReminders() {
  const now = Date.now();
  const reminderHooks = Array.from(hooks.values()).filter(h => h.enabled && h.events.includes('schedule.reminder'));
  if (!reminderHooks.length) return;
  for (const s of scheduler.listScheduled()) {
    const start = new Date(s.scheduledFor).getTime();
    if (start <= now) continue;
    for (const h of reminderHooks) {
      if (start - now > h.leadMinutes * 60000) continue;
      if (s.remindersSent?.[h.id] === s.scheduledFor) continue;   // already sent for this night
      scheduler.markReminded(s.id, h.id);
      cardFor('schedule.reminder', { schedule: s })
        .then(card => deliver(h, 'schedule.reminder', scheduleData(s), card)).catch(() => {});
    }
  }
}

function init() {
  load();
  setInterval(checkReminders, 30_000).unref();
}

module.exports = { init, notify, scheduleData, list, get, create, update, remove, test, EVENTS, TYPES, LEADS };
