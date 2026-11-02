'use strict';

const express = require('express');
const router  = express.Router();
const plex    = require('../plex');

const LIMIT        = 10;              // cards per row
const CACHE_MS     = 120_000;
// Episodes of one show added within this long of its newest one count as the same "drop"
const SAME_DROP_S  = 3 * 86400;

let cache = { at: 0, data: null };

const thumb = ratingKey => `/api/stream/thumb/${ratingKey}`;

async function recentMovies() {
  const sections = await plex.getMovieSections();
  const lists = await Promise.all(sections.map(s => plex.getRecentMovies(s.key, LIMIT)));
  const seen = new Set();
  return lists.flat()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .filter(m => { const k = `${m.title}|${m.year}`; return seen.has(k) ? false : seen.add(k); })   // same film in HD + 4K
    .slice(0, LIMIT)
    .map(m => ({ ratingKey: String(m.ratingKey), title: m.title, year: m.year || null, thumb: m.thumb ? thumb(m.ratingKey) : null, addedAt: m.addedAt || 0 }));
}

// One card per show, newest first. Clicking it starts the first episode of its latest drop —
// for a new show that's S1E1; for a show that just got three episodes it's the first of those three.
async function recentShows() {
  const sections = await plex.getShowSections();
  const lists = await Promise.all(sections.map(s => plex.getRecentEpisodes(s.key, LIMIT * 8)));
  const byShow = new Map();   // show ratingKey -> episodes, newest show first (Map keeps insertion order)
  for (const ep of lists.flat().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))) {
    if (!ep.grandparentRatingKey) continue;
    const key = String(ep.grandparentRatingKey);
    if (!byShow.has(key)) byShow.set(key, []);
    byShow.get(key).push(ep);
  }
  return [...byShow.entries()].slice(0, LIMIT).map(([showKey, eps]) => {
    const newest = eps[0].addedAt || 0;
    const drop = eps.filter(e => newest - (e.addedAt || 0) <= SAME_DROP_S);
    drop.sort((a, b) => (a.parentIndex || 0) - (b.parentIndex || 0) || (a.index || 0) - (b.index || 0));
    const first = drop[0];
    const label = first.parentIndex != null && first.index != null
      ? `S${first.parentIndex}E${first.index}` : '';
    return {
      ratingKey: String(first.ratingKey),          // the episode to start
      title: first.grandparentTitle,
      episode: [label, first.title].filter(Boolean).join(' · '),
      newCount: drop.length,
      thumb: thumb(showKey),
      addedAt: newest,
    };
  });
}

// GET /api/recent — a short "recently added" strip for the lobby
router.get('/', async (req, res) => {
  try {
    if (!cache.data || Date.now() - cache.at > CACHE_MS) {
      const [movies, shows] = await Promise.all([
        recentMovies().catch(err => { console.error('Recent movies error:', err.message); return []; }),
        recentShows().catch(err => { console.error('Recent shows error:', err.message); return []; }),
      ]);
      cache = { at: Date.now(), data: { movies, shows } };
    }
    res.json(cache.data);
  } catch (err) {
    console.error('Recent error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recent additions' });
  }
});

module.exports = router;
