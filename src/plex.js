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

async function getMovies(sectionId, start = 0, limit = 200) {
  const res = await plexAxios.get(`/library/sections/${sectionId}/all`, {
    params: {
      ...token(),
      type: 1,
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': limit
    }
  });
  const container = res.data.MediaContainer;
  return {
    movies: container.Metadata || [],
    totalSize: container.totalSize || 0
  };
}

async function getMovieDetails(ratingKey) {
  const res = await plexAxios.get(`/library/metadata/${ratingKey}`, {
    params: token()
  });
  return res.data.MediaContainer.Metadata[0];
}

module.exports = { getMovieSections, getMovies, getMovieDetails };
