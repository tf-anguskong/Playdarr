'use strict';

// GIF search and posting through Giphy. The API key stays on the server: browsers search via /api/gifs
// (server.js) and post a GIF by its Giphy id, which lookup() resolves here — so a chat message can only ever
// show an image from Giphy's own media hosts, at the content rating the admin chose.
// Settings (read on use): GIPHY_API_KEY (.env only, it's a secret) and GIPHY_RATING (g | pg | pg-13 | r).
const axios = require('axios');

const API = 'https://api.giphy.com/v1/gifs';
const RATINGS = ['g', 'pg', 'pg-13', 'r'];
const key = () => process.env.GIPHY_API_KEY || '';
const rating = () => (RATINGS.includes(process.env.GIPHY_RATING) ? process.env.GIPHY_RATING : 'pg-13');
const enabled = () => !!key();

const cache = new Map();   // url -> { at, data }
const TTL_MS = 10 * 60 * 1000;
async function cachedGet(url, params) {
  const k = url + '?' + new URLSearchParams(params);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const { data } = await axios.get(url, { params: { api_key: key(), ...params }, timeout: 5000 });
  if (cache.size > 300) cache.clear();
  cache.set(k, { at: Date.now(), data });
  return data;
}

// Only Giphy's own https media hosts
function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)giphy\.com$/i.test(x.hostname) ? x.href : null; } catch { return null; }
}

// A Giphy result → what browsers get: a small preview for the picker and the image to post
function card(g) {
  const pick = g?.images?.fixed_width;          // 200 px wide — right for a sidebar
  const prev = g?.images?.fixed_width_small || pick;
  const url = safeUrl(pick?.webp || pick?.url), preview = safeUrl(prev?.webp || prev?.url);
  if (!g?.id || !url) return null;
  return {
    id: String(g.id), title: String(g.title || 'GIF').slice(0, 100),
    url, w: Number(pick.width) || 200, h: Number(pick.height) || 150,
    preview: preview || url,
  };
}

/** Search (or trending when q is empty). Returns { results, next } — next is the offset for more, or null. */
async function search(q, offset = 0) {
  const params = { limit: 24, offset: Math.max(0, Math.min(4975, offset | 0)), rating: rating(), bundle: 'messaging_non_clips' };
  const data = q ? await cachedGet(`${API}/search`, { ...params, q: q.slice(0, 50), lang: 'en' }) : await cachedGet(`${API}/trending`, params);
  const results = (data?.data || []).map(card).filter(Boolean);
  const p = data?.pagination || {};
  const nextOffset = (p.offset || 0) + (p.count || 0);
  return { results, next: p.total_count > nextOffset && results.length ? nextOffset : null };
}

/** A GIF by id, checked against the rating setting — or null. */
async function lookup(id) {
  if (!enabled() || !/^[A-Za-z0-9]{5,40}$/.test(id)) return null;
  try {
    const g = (await cachedGet(`${API}/${id}`, {}))?.data;
    if (!g || RATINGS.indexOf(g.rating) > RATINGS.indexOf(rating())) return null;
    const c = card(g);
    return c && { id: c.id, title: c.title, url: c.url, w: c.w, h: c.h };
  } catch {
    return null;
  }
}

module.exports = { enabled, search, lookup };
