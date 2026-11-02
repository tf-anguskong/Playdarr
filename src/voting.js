'use strict';

// Swipe-to-vote movie picker. The host sets filters, the server draws a random deck of matching
// library movies, everyone swipes yes/no on their own device, and the movie the most people liked wins.
// Votes live on the room (in memory) — a vote is as short-lived as the room.

const plex = require('./plex');

const MIN_DECK = 2;
const MAX_DECK = 20;
const LIBRARY_TTL_MS = 60_000;

// ── Library (cached: a deck draw shouldn't re-page the whole Plex library every time) ──
let libraryCache = { at: 0, movies: null };

async function allMovies() {
  if (libraryCache.movies && Date.now() - libraryCache.at < LIBRARY_TTL_MS) return libraryCache.movies;
  const sections = await plex.getMovieSections();
  const movies = [];
  for (const section of sections) {
    const { movies: list } = await plex.getMovies(section.key);
    for (const m of list) {
      movies.push({
        ratingKey:     String(m.ratingKey),
        title:         m.title,
        year:          m.year || null,
        summary:       m.summary || '',
        minutes:       m.duration ? Math.round(m.duration / 60000) : null,
        thumb:         m.thumb ? `/api/stream/thumb/${m.ratingKey}` : null,
        rating:        m.audienceRating || m.rating || null,
        contentRating: m.contentRating || null,
        genres:        (m.Genre || []).map(g => g.tag),
        partId:        m.Media?.[0]?.Part?.[0]?.id ?? null,
      });
    }
  }
  libraryCache = { at: Date.now(), movies };
  return movies;
}

/** What the host can filter on, taken from what's actually in the library. */
async function facets() {
  const movies = await allMovies();
  const genres = new Set(), ratings = new Set();
  let minYear = Infinity, maxYear = 0, maxMinutes = 0;
  for (const m of movies) {
    m.genres.forEach(g => genres.add(g));
    if (m.contentRating) ratings.add(m.contentRating);
    if (m.year) { minYear = Math.min(minYear, m.year); maxYear = Math.max(maxYear, m.year); }
    if (m.minutes) maxMinutes = Math.max(maxMinutes, m.minutes);
  }
  return {
    count: movies.length,
    genres: [...genres].sort(),
    contentRatings: [...ratings].sort(),
    minYear: Number.isFinite(minYear) ? minYear : null,
    maxYear: maxYear || null,
    maxMinutes,
  };
}

// ── Deck ──────────────────────────────────────────────────
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== null && n >= lo && n <= hi ? n : null;
};

/** Normalise untrusted filter input from the host's browser. */
function cleanFilters(f = {}) {
  const strs = a => (Array.isArray(a) ? a : []).map(x => String(x).slice(0, 40)).slice(0, 30);
  return {
    genres:         strs(f.genres),                 // a movie needs at least one of these
    contentRatings: strs(f.contentRatings),         // e.g. PG, PG-13
    maxMinutes:     num(f.maxMinutes, 30, 600),
    minYear:        num(f.minYear, 1880, 2100),
    maxYear:        num(f.maxYear, 1880, 2100),
    minRating:      num(f.minRating, 0, 10),
    count:          Math.round(num(f.count, MIN_DECK, MAX_DECK) ?? 10),
  };
}

function matches(m, f) {
  if (f.genres.length && !m.genres.some(g => f.genres.includes(g))) return false;
  if (f.contentRatings.length && !f.contentRatings.includes(m.contentRating)) return false;
  if (f.maxMinutes && m.minutes && m.minutes > f.maxMinutes) return false;
  if (f.minYear && (!m.year || m.year < f.minYear)) return false;
  if (f.maxYear && (!m.year || m.year > f.maxYear)) return false;
  if (f.minRating && (m.rating || 0) < f.minRating) return false;
  return true;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Draw a random deck of movies matching the filters. */
async function drawDeck(rawFilters) {
  const filters = cleanFilters(rawFilters);
  const pool = (await allMovies()).filter(m => matches(m, filters));
  return { filters, matched: pool.length, candidates: shuffle(pool).slice(0, filters.count) };
}

// ── Vote state ────────────────────────────────────────────
let seq = 0;

function create(candidates, filters, matched) {
  return {
    id: `v${Date.now().toString(36)}${(seq++).toString(36)}`,
    status: 'voting',            // 'voting' | 'done'
    candidates, filters, matched,
    votes: new Map(),            // userId -> Map(ratingKey -> boolean)
    names: new Map(),            // userId -> display name
    result: null,
  };
}

/** The card data sent to browsers — never the partId or anyone's votes. */
function publicCard(c) {
  return {
    ratingKey: c.ratingKey, title: c.title, year: c.year,
    summary: c.summary.length > 320 ? c.summary.slice(0, 317) + '…' : c.summary,
    minutes: c.minutes, thumb: c.thumb, rating: c.rating,
    contentRating: c.contentRating, genres: c.genres.slice(0, 3),
  };
}

function publicState(vote, userId) {
  return {
    id: vote.id,
    candidates: vote.candidates.map(publicCard),
    filters: vote.filters,
    matched: vote.matched,
    mine: Array.from(vote.votes.get(userId)?.keys() || []),
  };
}

/** Record one swipe. Returns false if it isn't valid for this vote. */
function cast(vote, userId, name, ratingKey, yes) {
  if (!vote || vote.status !== 'voting' || typeof yes !== 'boolean') return false;
  if (!vote.candidates.some(c => c.ratingKey === ratingKey)) return false;
  if (!vote.votes.has(userId)) vote.votes.set(userId, new Map());
  vote.votes.get(userId).set(ratingKey, yes);
  vote.names.set(userId, name);
  return true;
}

/** How many of the given people have swiped the whole deck. */
function progress(vote, userIds) {
  const total = userIds.length;
  const done = userIds.filter(id => (vote.votes.get(id)?.size || 0) >= vote.candidates.length).length;
  return { done, total };
}

/** Tally the votes: most yes wins; ties go to the fewest no, then the deck's (random) order. */
function finalize(vote) {
  const voters = vote.votes.size;
  const ranking = vote.candidates.map((c, order) => {
    let yes = 0, no = 0;
    const yesNames = [];
    for (const [uid, v] of vote.votes) {
      if (!v.has(c.ratingKey)) continue;
      if (v.get(c.ratingKey)) { yes++; yesNames.push(vote.names.get(uid) || 'Someone'); } else no++;
    }
    return { ...publicCard(c), yes, no, yesNames, order };
  }).sort((a, b) => b.yes - a.yes || a.no - b.no || a.order - b.order);

  const top = ranking[0];
  vote.status = 'done';
  vote.result = {
    voters,
    winner: top && top.yes > 0 ? top.ratingKey : null,
    unanimous: !!top && voters > 1 && top.yes === voters,
    ranking: ranking.map(({ order, ...r }) => r),
  };
  return vote.result;
}

/** The candidate (with its partId) for a ratingKey in this vote. */
const findCandidate = (vote, ratingKey) => vote?.candidates.find(c => c.ratingKey === ratingKey) || null;

module.exports = { facets, drawDeck, create, publicState, cast, progress, finalize, findCandidate, MIN_DECK };
