'use strict';

// Grid/list toggle for poster pickers. Buttons: <button class="view-toggle-btn" data-target="<grid id>" data-view="grid|list">
(function () {
  const KEY = 'playdarr-picker-view';
  const read = () => { try { return localStorage.getItem(KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } };

  function apply(view) {
    document.querySelectorAll('.modal-grid.movies-grid').forEach(g => g.classList.toggle('view-list', view === 'list'));
    document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('.view-toggle-btn');
    if (!btn) return;
    try { localStorage.setItem(KEY, btn.dataset.view); } catch { /* storage unavailable */ }
    apply(btn.dataset.view);
  });

  apply(read());
})();
