const express = require('express');
const router = express.Router();
const plex = require('../plex');

// GET /api/shows?search=
router.get('/', async (req, res) => {
  try {
    const sections = await plex.getShowSections();
    if (!sections.length) return res.json({ shows: [] });

    const { search = '' } = req.query;

    const allShows = [];
    for (const section of sections) {
      const shows = await plex.getShows(section.key);
      allShows.push(...shows);
    }

    let filtered = allShows;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(s => s.title.toLowerCase().includes(q));
    }
    filtered.sort((a, b) => a.title.localeCompare(b.title));

    res.json({
      shows: filtered.map(s => ({
        ratingKey: s.ratingKey,
        title: s.title,
        year: s.year,
        thumb: s.thumb ? `/api/stream/thumb/${s.ratingKey}` : null,
        rating: s.audienceRating || s.rating || null,
        childCount: s.childCount || 0,
        leafCount: s.leafCount || 0
      }))
    });
  } catch (err) {
    console.error('Shows error:', err.message);
    res.status(500).json({ error: 'Failed to fetch shows' });
  }
});

// GET /api/shows/episode/:ratingKey — must be before /:ratingKey routes
router.get('/episode/:ratingKey', async (req, res) => {
  if (!/^\d+$/.test(req.params.ratingKey)) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }
  try {
    const ep = await plex.getMovieDetails(req.params.ratingKey);
    const part = ep.Media?.[0]?.Part?.[0];
    res.json({
      ratingKey: ep.ratingKey,
      title: ep.title,
      index: ep.index,
      parentIndex: ep.parentIndex,
      grandparentTitle: ep.grandparentTitle,
      duration: ep.duration,
      partId: part?.id ?? null,
      thumb: ep.thumb ? `/api/stream/thumb/${ep.ratingKey}` : null
    });
  } catch (err) {
    console.error('Episode detail error:', err.message);
    res.status(500).json({ error: 'Failed to fetch episode' });
  }
});

// GET /api/shows/:ratingKey/seasons
router.get('/:ratingKey/seasons', async (req, res) => {
  if (!/^\d+$/.test(req.params.ratingKey)) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }
  try {
    const seasons = await plex.getShowChildren(req.params.ratingKey);
    res.json({
      seasons: seasons.map(s => ({
        ratingKey: s.ratingKey,
        title: s.title,
        index: s.index,
        leafCount: s.leafCount || 0,
        thumb: s.thumb ? `/api/stream/thumb/${s.ratingKey}` : null
      }))
    });
  } catch (err) {
    console.error('Seasons error:', err.message);
    res.status(500).json({ error: 'Failed to fetch seasons' });
  }
});

// GET /api/shows/:ratingKey/episodes
router.get('/:ratingKey/episodes', async (req, res) => {
  if (!/^\d+$/.test(req.params.ratingKey)) {
    return res.status(400).json({ error: 'Invalid ratingKey' });
  }
  try {
    const episodes = await plex.getShowChildren(req.params.ratingKey);
    res.json({
      episodes: episodes.map(e => ({
        ratingKey: e.ratingKey,
        title: e.title,
        index: e.index,
        parentIndex: e.parentIndex,
        duration: e.duration,
        thumb: e.thumb ? `/api/stream/thumb/${e.ratingKey}` : null,
        summary: e.summary
      }))
    });
  } catch (err) {
    console.error('Episodes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch episodes' });
  }
});

module.exports = router;
