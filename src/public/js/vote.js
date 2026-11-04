'use strict';

// Movie vote UI. Loaded after player.js, which provides `socket`, `isHost`, `roomType` and `showNotif`.
// The host sets filters and starts a deck; everyone swipes (drag, buttons or ← / →); the most-liked wins.
(() => {
  const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));   // text and attribute values
  const btn = document.getElementById('vote-btn');

  const overlay = document.createElement('div');
  overlay.id = 'vote-overlay';
  overlay.className = 'vote-overlay';
  overlay.style.display = 'none';
  document.body.appendChild(overlay);

  // null when no vote is running. phase: 'setup' | 'deck' | 'waiting' | 'result'
  let vote = null;
  let setupOpen = false;
  let facets = null;
  let setupError = '';
  let progress = { done: 0, total: 0 };

  const hostNow = () => typeof isHost !== 'undefined' && isHost;
  const notify = msg => { if (typeof showNotif === 'function') showNotif(msg); };

  // ── Button in the sidebar ────────────────────────────────
  function updateButton() {
    if (!btn) return;
    const movieRoom = typeof roomType !== 'undefined' && roomType === 'movie';
    btn.style.display = vote || (hostNow() && movieRoom) ? 'block' : 'none';
    btn.textContent = vote ? '🗳 Open vote' : '🗳 Movie vote';
  }

  function show() { overlay.style.display = 'flex'; render(); }
  function hide() { overlay.style.display = 'none'; }

  btn?.addEventListener('click', () => {
    if (vote) return show();
    openSetup();
  });

  // ── Helpers ──────────────────────────────────────────────
  const runtime = m => (m ? (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}`.trim() : `${m}m`) : '');
  const meta = c => [c.year, runtime(c.minutes), c.contentRating, c.rating ? `★ ${Number(c.rating).toFixed(1)}` : ''].filter(Boolean).join(' · ');
  const head = (title, extra = '') => `
    <div class="vote-head">
      <span class="vote-title">${title}</span>${extra}
      <span class="vote-head-actions">
        ${vote && vote.phase !== 'result' && hostNow() ? '<button class="vote-link" data-act="cancel">Cancel vote</button>' : ''}
        <button class="vote-link" data-act="min" title="Hide (the vote keeps going)">Hide</button>
      </span>
    </div>`;

  // ── Setup (host) ─────────────────────────────────────────
  async function openSetup() {
    setupOpen = true; setupError = '';
    show();
    if (!facets) {
      try { facets = await fetch('/api/movies/facets').then(r => r.json()); } catch { facets = null; }
      if (!facets || facets.error) { setupError = 'Could not read the movie library.'; facets = null; }
    }
    render();
  }

  function renderSetup() {
    if (!facets) {
      return `<div class="vote-panel">${head('🗳 Movie vote')}<div class="vote-note">${esc(setupError) || 'Loading the library…'}</div></div>`;
    }
    const chips = (name, list) => list.map(v => `<button type="button" class="vote-chip" data-chip="${name}" data-val="${esc(v)}">${esc(v)}</button>`).join('');
    const runtimes = [['', 'Any length'], [90, '≤ 1h 30m'], [120, '≤ 2h'], [150, '≤ 2h 30m'], [180, '≤ 3h']];
    return `
      <div class="vote-panel vote-setup">
        ${head('🗳 Movie vote')}
        <p class="vote-note">Pick filters, then everyone swipes through a random deck. The movie most people like wins.</p>
        <div class="vote-field"><label>Genres <em>(any of)</em></label><div class="vote-chips">${chips('genres', facets.genres)}</div></div>
        ${facets.contentRatings.length ? `<div class="vote-field"><label>Rated</label><div class="vote-chips">${chips('contentRatings', facets.contentRatings)}</div></div>` : ''}
        <div class="vote-grid">
          <div class="vote-field"><label>Length</label><select id="vs-runtime" class="filter-select">${runtimes.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="vote-field"><label>Min. rating</label><select id="vs-rating" class="filter-select"><option value="">Any</option><option value="6">6+</option><option value="7">7+</option><option value="8">8+</option></select></div>
          <div class="vote-field"><label>From year</label><input id="vs-from" class="search-input" type="number" placeholder="${facets.minYear || ''}" min="1880" max="2100"></div>
          <div class="vote-field"><label>To year</label><input id="vs-to" class="search-input" type="number" placeholder="${facets.maxYear || ''}" min="1880" max="2100"></div>
          <div class="vote-field"><label>Deck size</label><select id="vs-count" class="filter-select">${[5, 8, 10, 12, 15, 20].map(n => `<option value="${n}"${n === 10 ? ' selected' : ''}>${n} movies</option>`).join('')}</select></div>
        </div>
        ${setupError ? `<div class="vote-error">${esc(setupError)}</div>` : ''}
        <div class="vote-actions-row">
          <button class="btn-logout" data-act="setup-cancel">Cancel</button>
          <button class="btn-create" data-act="start">Start vote</button>
        </div>
      </div>`;
  }

  function startVote() {
    const picked = name => [...overlay.querySelectorAll(`[data-chip="${name}"].on`)].map(b => b.dataset.val);
    const val = id => overlay.querySelector(id).value;
    setupError = '';
    socket.emit('vote-start', {
      genres: picked('genres'), contentRatings: picked('contentRatings'),
      maxMinutes: val('#vs-runtime'), minRating: val('#vs-rating'),
      minYear: val('#vs-from'), maxYear: val('#vs-to'), count: val('#vs-count'),
    });
    const go = overlay.querySelector('[data-act="start"]');
    if (go) { go.disabled = true; go.textContent = 'Drawing deck…'; }
  }

  // ── Swipe deck ───────────────────────────────────────────
  const card = (c, i) => `
    <div class="vote-card" data-i="${i}">
      ${c.thumb ? `<img class="vote-poster" src="${esc(c.thumb)}" alt="" draggable="false">` : '<div class="vote-poster vote-poster-none">🎬</div>'}
      <div class="vote-card-info">
        <div class="vote-card-title">${esc(c.title)}</div>
        <div class="vote-card-meta">${esc(meta(c))}</div>
        ${c.genres.length ? `<div class="vote-card-genres">${c.genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
        <div class="vote-card-summary">${esc(c.summary)}</div>
      </div>
      <div class="vote-stamp vote-stamp-yes">YES</div>
      <div class="vote-stamp vote-stamp-no">NOPE</div>
    </div>`;

  function renderDeck() {
    const left = vote.cards.length - vote.idx;
    const top = vote.cards[vote.idx], next = vote.cards[vote.idx + 1];
    return `
      <div class="vote-panel">
        ${head('🗳 Movie vote', `<span class="vote-count">${vote.idx + 1} / ${vote.cards.length}</span>`)}
        <div class="vote-stack">
          ${next ? card(next, vote.idx + 1).replace('class="vote-card"', 'class="vote-card vote-card-behind"') : ''}
          ${card(top, vote.idx)}
        </div>
        <div class="vote-actions">
          <button class="vote-round vote-no" data-act="no" title="Nope (←)">✕</button>
          <button class="vote-round vote-yes" data-act="yes" title="Yes (→)">♥</button>
        </div>
        <div class="vote-hint">Drag the card, tap the buttons, or use ← / → · ${left} to go</div>
        <div class="vote-hint" id="vote-prog">${progressText()}</div>
      </div>`;
  }

  const progressText = () => (progress.total > 1 ? `${progress.done} of ${progress.total} finished` : '');

  function attachDrag() {
    const el = overlay.querySelector('.vote-card:not(.vote-card-behind)');
    if (!el) return;
    const yes = el.querySelector('.vote-stamp-yes'), no = el.querySelector('.vote-stamp-no');
    let startX = 0, dx = 0, drag = false;
    el.addEventListener('pointerdown', e => { drag = true; startX = e.clientX; dx = 0; el.setPointerCapture(e.pointerId); el.style.transition = 'none'; });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      dx = e.clientX - startX;
      el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      yes.style.opacity = Math.max(0, Math.min(1, dx / 110));
      no.style.opacity  = Math.max(0, Math.min(1, -dx / 110));
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      if (Math.abs(dx) > 110) return fling(dx > 0);
      el.style.transition = 'transform .2s ease';
      el.style.transform = '';
      yes.style.opacity = no.style.opacity = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  let flinging = false;
  function fling(yes) {
    if (flinging || !vote || vote.phase !== 'deck') return;
    flinging = true;
    const el = overlay.querySelector('.vote-card:not(.vote-card-behind)');
    if (el) {
      el.style.transition = 'transform .22s ease, opacity .22s ease';
      el.style.transform = `translateX(${yes ? 700 : -700}px) rotate(${yes ? 25 : -25}deg)`;
      el.style.opacity = '0';
    }
    setTimeout(() => { flinging = false; answer(yes); }, 200);
  }

  function answer(yes) {
    if (!vote || vote.phase !== 'deck') return;
    const c = vote.cards[vote.idx];
    socket.emit('vote-cast', { voteId: vote.id, ratingKey: c.ratingKey, yes });
    vote.answered.add(c.ratingKey);
    vote.idx++;
    if (vote.idx >= vote.cards.length) vote.phase = 'waiting';
    render();
  }

  document.addEventListener('keydown', e => {
    if (overlay.style.display === 'none' || !vote || vote.phase !== 'deck') return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); fling(true); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); fling(false); }
  });

  // ── Waiting + result ─────────────────────────────────────
  function renderWaiting() {
    return `
      <div class="vote-panel">
        ${head('🗳 Movie vote')}
        <div class="vote-wait">
          <div class="vote-wait-icon">✓</div>
          <div class="vote-wait-title">You're done!</div>
          <div class="vote-note" id="vote-prog">${progress.total > 1 ? `Waiting for the others… ${progress.done} of ${progress.total} finished` : 'Counting votes…'}</div>
          ${hostNow() ? '<button class="btn-create" data-act="reveal">Reveal results now</button>' : ''}
        </div>
      </div>`;
  }

  function renderResult() {
    const r = vote.result;
    const winner = r.ranking.find(c => c.ratingKey === r.winner);
    const others = r.ranking.filter(c => c !== winner).slice(0, 5);
    const playBtn = (c, label) => (hostNow() ? `<button class="${label ? 'btn-create' : 'vote-link'}" data-act="play" data-key="${esc(c.ratingKey)}">${label || 'Play this'}</button>` : '');
    const body = winner ? `
      <div class="vote-winner">
        ${winner.thumb ? `<img class="vote-winner-poster" src="${esc(winner.thumb)}" alt="">` : ''}
        <div class="vote-winner-info">
          <div class="vote-match">${r.unanimous ? '🎉 Everyone matched!' : '🏆 Tonight\'s pick'}</div>
          <div class="vote-card-title">${esc(winner.title)}</div>
          <div class="vote-card-meta">${esc(meta(winner))}</div>
          <div class="vote-likes">${winner.yes} of ${r.voters} liked it${winner.yesNames.length ? ` — ${esc(winner.yesNames.join(', '))}` : ''}</div>
          ${hostNow() ? playBtn(winner, `▶ Watch ${esc(winner.title)}`) : '<div class="vote-note">Waiting for the host to start it…</div>'}
        </div>
      </div>` : '<div class="vote-note" style="text-align:center;padding:1.2rem 0">Nobody liked anything — try a different set of filters.</div>';
    return `
      <div class="vote-panel">
        ${head('🗳 Results')}
        ${body}
        ${others.length ? `<div class="vote-others"><label>Also in the running</label>${others.map(c => `
          <div class="vote-other"><span class="vote-other-title">${esc(c.title)}</span><span class="vote-other-n">${c.yes} ♥</span>${playBtn(c)}</div>`).join('')}</div>` : ''}
        ${hostNow() ? '<div class="vote-actions-row"><button class="btn-logout" data-act="again">Vote again</button><button class="btn-logout" data-act="cancel">Close vote</button></div>' : ''}
      </div>`;
  }

  // ── Render + clicks ──────────────────────────────────────
  function render() {
    if (overlay.style.display === 'none') return;
    let html;
    if (vote) html = vote.phase === 'result' ? renderResult() : vote.phase === 'waiting' ? renderWaiting() : renderDeck();
    else if (setupOpen) html = renderSetup();
    else return hide();
    overlay.innerHTML = html;
    if (vote && vote.phase === 'deck') attachDrag();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) return hide();
    const chip = e.target.closest('.vote-chip');
    if (chip) return chip.classList.toggle('on');
    const a = e.target.closest('[data-act]');
    if (!a) return;
    switch (a.dataset.act) {
      case 'min':          return hide();
      case 'setup-cancel': setupOpen = false; return hide();
      case 'start':        return startVote();
      case 'yes':          return fling(true);
      case 'no':           return fling(false);
      case 'reveal':       return socket.emit('vote-reveal');
      case 'cancel':       if (confirm('Cancel the vote for everyone?')) socket.emit('vote-cancel'); return;
      case 'play':         return socket.emit('vote-play', { ratingKey: a.dataset.key });
      case 'again':        socket.emit('vote-cancel'); setupOpen = true; return render();
    }
  });

  // ── Server events ────────────────────────────────────────
  socket.on('vote-started', (v) => {
    const answered = new Set(v.mine);
    const idx = v.candidates.findIndex(c => !answered.has(c.ratingKey));
    vote = { id: v.id, cards: v.candidates, answered, idx: idx === -1 ? v.candidates.length : idx, phase: idx === -1 ? 'waiting' : 'deck', result: null };
    setupOpen = false;
    progress = { done: 0, total: 0 };
    updateButton();
    show();
  });

  socket.on('vote-progress', (p) => {
    progress = p;
    const el = overlay.querySelector('#vote-prog');
    if (!el) return;
    el.textContent = vote && vote.phase === 'waiting'
      ? (p.total > 1 ? `Waiting for the others… ${p.done} of ${p.total} finished` : 'Counting votes…')
      : progressText();
  });

  socket.on('vote-result', (r) => {
    if (!vote || vote.id !== r.id) return;
    vote.phase = 'result';
    vote.result = r;
    updateButton();
    show();
  });

  socket.on('vote-closed', ({ reason } = {}) => {
    const hadVote = !!vote;
    vote = null;
    updateButton();
    if (!setupOpen) hide(); else render();
    if (hadVote && reason === 'cancelled') notify('🗳 Vote cancelled');
  });

  // Show the problem in place — re-rendering the form would throw away the host's filter choices
  socket.on('vote-error', (msg) => {
    setupError = msg;
    if (!setupOpen) return;
    let el = overlay.querySelector('.vote-error');
    if (!el) {
      el = document.createElement('div');
      el.className = 'vote-error';
      overlay.querySelector('.vote-actions-row')?.before(el);
    }
    el.textContent = msg;
    const go = overlay.querySelector('[data-act="start"]');
    if (go) { go.disabled = false; go.textContent = 'Start vote'; }
  });

  ['room-state', 'became-host', 'lost-host'].forEach(ev => socket.on(ev, () => { updateButton(); if (overlay.style.display !== 'none') render(); }));
})();
