'use strict';

const socket = io();

// ── User info ──────────────────────────────────────────────
async function loadUser() {
  try {
    const { user } = await fetch('/api/me').then(r => r.json());
    if (!user) return;
    document.getElementById('user-name').textContent = user.name;
    if (user.picture) {
      const avatar = document.getElementById('user-avatar');
      avatar.src = user.picture;
      avatar.style.display = 'block';
    }
  } catch { /* silent */ }
}

// ── Helpers ────────────────────────────────────────────────
function escapeHtml(str = '') {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

function getFilters() {
  return {
    search: document.getElementById('search-input').value.trim(),
    genre: document.getElementById('genre-select').value,
    sort: document.getElementById('sort-select').value
  };
}

// ── Movie grid ─────────────────────────────────────────────
async function loadMovies() {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '<div class="loading">Loading movies…</div>';

  const { search, genre, sort } = getFilters();
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (genre)  params.set('genre', genre);
  if (sort)   params.set('sort', sort);

  try {
    const { movies, genres, error } = await fetch(`/api/movies?${params}`).then(r => r.json());
    if (error) throw new Error(error);

    // Populate genre dropdown (only on first load or when genres change)
    const genreSelect = document.getElementById('genre-select');
    const currentGenre = genreSelect.value;
    if (genres?.length) {
      // Rebuild options preserving current selection
      genreSelect.innerHTML = '<option value="">All genres</option>' +
        genres.map(g => `<option value="${escapeHtml(g)}"${g === currentGenre ? ' selected' : ''}>${escapeHtml(g)}</option>`).join('');
    }

    // Update count
    document.getElementById('movie-count').textContent =
      movies.length ? `${movies.length} movie${movies.length !== 1 ? 's' : ''}` : '';

    if (!movies.length) {
      grid.innerHTML = '<div class="loading">No movies found.</div>';
      return;
    }

    grid.innerHTML = movies.map(m => `
      <div class="movie-card" data-key="${m.ratingKey}">
        ${m.thumb
          ? `<img class="movie-poster" src="${m.thumb}" alt="${escapeHtml(m.title)}" loading="lazy">`
          : `<div class="movie-poster-placeholder">🎬</div>`
        }
        <div class="movie-info">
          <h3 title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</h3>
          <span>${m.year || ''}${m.year && m.rating ? ' · ' : ''}${m.rating ? '★ ' + Number(m.rating).toFixed(1) : ''}</span>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => selectMovie(card.dataset.key));
    });
  } catch (err) {
    grid.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function selectMovie(ratingKey) {
  try {
    const movie = await fetch(`/api/movies/${ratingKey}`).then(r => r.json());
    if (!movie.partId) {
      alert('No stream found for this movie.');
      return;
    }
    socket.emit('select-movie', {
      movieKey: movie.ratingKey,
      movieTitle: movie.title,
      partId: movie.partId
    });
    window.location.href = '/watch';
  } catch {
    alert('Failed to load movie details.');
  }
}

// ── Socket events ──────────────────────────────────────────
socket.on('viewers', (viewers) => {
  const badge = document.getElementById('watching-badge');
  document.getElementById('watching-count').textContent = viewers.length;
  badge.style.display = viewers.length > 0 ? 'block' : 'none';
});

// ── Filter controls ────────────────────────────────────────
let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadMovies, 300);
});
document.getElementById('genre-select').addEventListener('change', loadMovies);
document.getElementById('sort-select').addEventListener('change', loadMovies);

loadUser();
loadMovies();
