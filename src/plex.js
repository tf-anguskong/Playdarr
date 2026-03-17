const axios = require('axios');

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;

const plexAxios = axios.create({
  baseURL: PLEX_URL,
  headers: {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': 'movienight-app',
    'X-Plex-Product': 'Movie Night'
  }
});

function token() {
  return { 'X-Plex-Token': PLEX_TOKEN };
}

async function getMovieSections() {
  const res = await plexAxios.get('/library/sections', { params: token() });
  const dirs = res.data.MediaContainer.Directory || [];
  return dirs.filter(s => s.type === 'movie');
}

async function getMovies(sectionId) {
  const PAGE = 500;
  let start = 0;
  let all = [];
  while (true) {
    const res = await plexAxios.get(`/library/sections/${sectionId}/all`, {
      params: {
        ...token(),
        type: 1,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PAGE
      }
    });
    const container = res.data.MediaContainer;
    const page = container.Metadata || [];
    all.push(...page);
    const total = container.totalSize ?? container.size ?? all.length;
    if (all.length >= total || page.length === 0) break;
    start += PAGE;
  }
  return { movies: all, totalSize: all.length };
}

async function getMovieDetails(ratingKey) {
  const res = await plexAxios.get(`/library/metadata/${ratingKey}`, {
    params: token()
  });
  return res.data.MediaContainer.Metadata[0];
}

async function getShowSections() {
  const res = await plexAxios.get('/library/sections', { params: token() });
  const dirs = res.data.MediaContainer.Directory || [];
  return dirs.filter(s => s.type === 'show');
}

async function getShows(sectionId) {
  const PAGE = 500;
  let start = 0;
  let all = [];
  while (true) {
    const res = await plexAxios.get(`/library/sections/${sectionId}/all`, {
      params: {
        ...token(),
        type: 2,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PAGE
      }
    });
    const container = res.data.MediaContainer;
    const page = container.Metadata || [];
    all.push(...page);
    const total = container.totalSize ?? container.size ?? all.length;
    if (all.length >= total || page.length === 0) break;
    start += PAGE;
  }
  return all;
}

// Works for both show→seasons and season→episodes
async function getShowChildren(ratingKey) {
  const res = await plexAxios.get(`/library/metadata/${ratingKey}/children`, { params: token() });
  return res.data.MediaContainer.Metadata || [];
}

module.exports = { getMovieSections, getMovies, getMovieDetails, getShowSections, getShows, getShowChildren };
