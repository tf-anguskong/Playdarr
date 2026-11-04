// Link previews (Discord, Slack, iMessage, …) for invite and watch links.
// Crawlers have no session, so server.js answers them with a small page of Open Graph tags built here: what's on,
// who's hosting, how many are watching, a summary, and artwork (served by imageHandler through Plex's photo
// transcoder, so the Plex token never reaches the crawler). Everything here is best-effort: a slow or failing Plex
// lookup falls back to a text-only card rather than holding the crawler up.
const axios = require('axios');
const { getGuide } = require('./livetv-manager');

// "Fri, Nov 7 · 8:00 PM EST" in the night's own time zone
function formatInTimeZone(date, tz) {
  const day  = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
  return `${day} · ${time}`;
}

const PLEX_URL   = () => process.env.PLEX_URL;
const PLEX_TOKEN = () => process.env.PLEX_TOKEN;
const ACCENT     = '#f0a500';   // --pd-accent; Discord paints the card's edge with theme-color
const CRAWLER_RE = /discordbot|slackbot|telegrambot|whatsapp|twitterbot|facebookexternalhit|linkedinbot|skypeuripreview|iframely|embedly|redditbot|mastodon|applebot|google-pagerenderer|vkshare/i;

const isCrawler = ua => CRAWLER_RE.test(ua || '');

// ── Plex metadata (cached; previews of the same title are common) ──
const metaCache = new Map();   // ratingKey -> { at, data }
const META_TTL_MS = 10 * 60 * 1000;
async function plexMeta(ratingKey) {
  if (!ratingKey || !/^\d+$/.test(String(ratingKey))) return null;
  const hit = metaCache.get(ratingKey);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.data;
  try {
    const { data } = await axios.get(`${PLEX_URL()}/library/metadata/${ratingKey}`, {
      params: { 'X-Plex-Token': PLEX_TOKEN() }, headers: { Accept: 'application/json' }, timeout: 3000,
    });
    const m = data?.MediaContainer?.Metadata?.[0] || null;
    if (metaCache.size > 500) metaCache.clear();
    metaCache.set(ratingKey, { at: Date.now(), data: m });
    return m;
  } catch {
    return null;
  }
}

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

/** The artwork a room's preview should use (Plex image path), or null. TV episodes use the show's backdrop. */
function artPath(meta) {
  if (!meta) return null;
  return meta.type === 'episode'
    ? (meta.grandparentArt || meta.art || meta.grandparentThumb || meta.thumb || null)
    : (meta.art || meta.thumb || null);
}

/**
 * Build the card for a live room.
 * @param room       a sync.js Room (or null)
 * @param imageUrl   absolute URL of this room's preview image endpoint (only used when the room has Plex artwork)
 * @param invite     true for an invite link (guests can join without Plex); false for a /watch link
 */
async function forRoom(room, imageUrl, { invite = true } = {}) {
  const host = room.hostName && !room.awaitingHost ? `Hosted by ${room.hostName}` : 'Waiting for a host';
  const who = room.viewers?.size ? `${host} · ${plural(room.viewers.size, 'person', 'people')} watching` : host;
  const status = room.playing ? `▶ Playing` : '⏸ Paused';
  const card = { siteName: `Playdarr · ${room.name}`, title: room.name, lines: [], image: null, large: false };

  if ((room.roomType === 'movie' || room.roomType === 'tv') && room.movieKey) {
    const m = await plexMeta(room.movieKey);
    const pos = room.currentPosition();
    const dur = m?.duration ? m.duration / 1000 : 0;
    const progress = dur ? `${clock(pos)} of ${clock(dur)}` : `${clock(pos)} in`;
    if (m?.type === 'episode') {
      const se = m.parentIndex != null && m.index != null ? `S${m.parentIndex} · E${m.index}` : '';
      card.title = `📺 ${m.grandparentTitle}${se ? ` — ${se}` : ''}`;
      card.lines.push(`“${m.title}”`);
    } else {
      const title = m?.title || room.movieTitle || 'A movie';
      card.title = `🎬 ${title}${m?.year ? ` (${m.year})` : ''}`;
      const facts = [m?.contentRating, dur ? clock(dur) : null, (m?.Genre || []).slice(0, 2).map(g => g.tag).join(', ') || null].filter(Boolean);
      if (facts.length) card.lines.push(facts.join(' · '));
    }
    card.lines.push(`${status} · ${progress}`, who);
    const blurb = m?.tagline || m?.summary;
    if (blurb) card.lines.push('', clip(blurb, 200));
    if (artPath(m)) { card.image = imageUrl; card.large = true; }
  } else if (room.roomType === 'livetv' && room.liveTvChannel) {
    const ch = room.liveTvChannelTitle || room.liveTvChannel;
    card.title = `🔴 Live on ${ch}`;
    if (room.liveTvProgram) card.lines.push(`On now: ${room.liveTvProgram}`);
    card.lines.push(`${room.playing ? '▶ Watching live' : '⏸ Paused'} · channel ${room.liveTvChannel}`, who);
    // Channel logo from the (cached) guide, as a small thumbnail — only when Plex gives a public https URL
    try {
      const guide = await Promise.race([getGuide(), new Promise(r => setTimeout(r, 2000, null))]);
      const thumb = guide?.channels?.find(c => c.number === room.liveTvChannel)?.thumb;
      if (/^https:\/\//i.test(thumb || '')) card.image = thumb;
    } catch {}
  } else if (room.roomType === 'youtube' && room.youtubeVideoId) {
    card.title = `▶ ${room.name}`;
    card.lines.push('Watching YouTube together', who);
    if (/^[\w-]{6,20}$/.test(room.youtubeVideoId)) { card.image = `https://i.ytimg.com/vi/${room.youtubeVideoId}/hqdefault.jpg`; card.large = true; }
  } else {
    card.title = `🍿 ${room.name}`;
    card.lines.push(room.roomType === 'livetv' ? 'Waiting for the host to pick a channel' : 'Waiting for the host to pick something', who);
  }
  card.lines.push('', invite ? 'Tap to join — no Plex account needed.' : 'Tap to join.');
  return card;
}

/** Card for a watch night that hasn't opened yet. */
async function forScheduled(s, imageUrl) {
  const tz = s.timezone || 'UTC';
  let when;
  try { when = formatInTimeZone(new Date(s.scheduledFor), tz); } catch { when = new Date(s.scheduledFor).toUTCString(); }
  const repeat = s.recurrence === 'weekly' ? ' · every week' : s.recurrence === 'biweekly' ? ' · every other week' : '';
  const card = { siteName: 'Playdarr · Watch night', title: `📅 ${s.name}`, lines: [`Starts ${when}${repeat}`], image: null, large: false };
  if (s.createdBy?.name) card.lines.push(`Hosted by ${s.createdBy.name}`);
  if (s.movieKey) {
    const m = await plexMeta(s.movieKey);
    const title = m?.title || s.movieTitle;
    if (title) card.lines.push(`Showing: ${title}${m?.year ? ` (${m.year})` : ''}`);
    if (m?.tagline || m?.summary) card.lines.push('', clip(m.tagline || m.summary, 200));
    if (artPath(m)) { card.image = imageUrl; card.large = true; }
  }
  card.lines.push('', 'Open the link to add it to your calendar.');
  return card;
}

const expired = () => ({ siteName: 'Playdarr', title: 'This invite has expired', lines: ['The room has closed. Ask the host for a new link.'], image: null, large: false });

/** The HTML page a crawler gets. */
function page(card, url) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const desc = card.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const tags = [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', card.siteName],
    ['property', 'og:title', card.title],
    ['property', 'og:description', desc],
    ['property', 'og:url', url],
    ['name', 'theme-color', ACCENT],
    ['name', 'twitter:card', card.image && card.large ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', card.title],
    ['name', 'twitter:description', desc],
  ];
  if (card.image) tags.push(['property', 'og:image', card.image], ['name', 'twitter:image', card.image]);
  if (card.image && card.large) tags.push(['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630']);
  return `<!DOCTYPE html><html><head>\n<meta charset="UTF-8">\n<title>${esc(card.title)}</title>\n`
    + tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`).join('\n')
    + '\n</head><body></body></html>';
}

/** Stream a 1200×630 crop of a Plex item's artwork. Resolves false if there is none (caller sends 404). */
async function sendArt(res, ratingKey) {
  const p = artPath(await plexMeta(ratingKey));
  if (!p) return false;
  try {
    const img = await axios({
      method: 'GET', url: `${PLEX_URL()}/photo/:/transcode`, responseType: 'stream', timeout: 10000,
      params: { url: p, width: 1200, height: 630, minSize: 1, upscale: 1, 'X-Plex-Token': PLEX_TOKEN() },
    });
    res.setHeader('Content-Type', img.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    img.data.pipe(res);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isCrawler, forRoom, forScheduled, expired, page, sendArt };
