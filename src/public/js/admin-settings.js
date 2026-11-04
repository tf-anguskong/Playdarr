'use strict';

// Admin → Settings. Everything here is keyed by the server's opaque setting ids; the page never sees (or shows)
// environment variable names, and secrets arrive only as "configured / not set".

const root = document.getElementById('settings-root');

const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));   // text and attribute values

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Time-zone suggestions for the "default time zone" box
try {
  document.getElementById('tz-list').innerHTML = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])
    .map(z => `<option value="${esc(z)}">`).join('');
} catch { /* older browser: no suggestions */ }

const display = (s, v) => (s.type === 'bool' ? (v ? 'On' : 'Off') : v === '' || v == null ? 'Default' : String(v));

function control(s) {
  const dis = s.locked ? ' disabled' : '';
  switch (s.type) {
    case 'bool':
      return `<label class="switch"><input type="checkbox" data-ctl${s.value ? ' checked' : ''}${dis}><span class="switch-track"></span></label>`;
    case 'select': {
      const opts = s.options.slice();
      if (!opts.some(o => o.value === String(s.value))) opts.push({ value: String(s.value), label: String(s.value) });   // an unusual value set in .env
      return `<select class="filter-select set-input" data-ctl${dis}>${opts.map(o => `<option value="${esc(o.value)}"${o.value === String(s.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    }
    case 'int':
    case 'number':
      return `<span class="set-num"><input class="search-input set-input" type="number" data-ctl value="${esc(s.value)}" min="${s.min}" max="${s.max}" step="${s.step || 1}"${dis}>${s.unit ? `<span class="set-unit">${esc(s.unit)}</span>` : ''}</span>`;
    case 'text':
      return `<input class="search-input set-input set-text" type="text" data-ctl value="${esc(s.value)}" maxlength="${s.maxLength || 200}" placeholder="${esc(s.placeholder || '')}" spellcheck="false"${s.id === 'defaultTimezone' ? ' list="tz-list"' : ''}${dis}>`;
    case 'secret':
      return s.configured ? '<span class="set-ok">● Configured</span>' : '<span class="set-muted">Not set</span>';
    default:
      return `<span class="set-value">${esc(s.value) || '<span class="set-muted">Not set</span>'}</span>`;
  }
}

function row(s) {
  const tags = [];
  if (s.source === 'env') tags.push(`<span class="set-tag set-tag-env" title="${s.readOnly ? 'Defined in your .env file. Edit .env and recreate the container to change it.' : 'Defined in your .env file, so it can’t be changed here. Edit .env and recreate the container to change it.'}">🔒 Set in .env</span>`);
  else if (s.source === 'ui') tags.push('<span class="set-tag set-tag-ui">Customised</span>');
  if (s.restart) tags.push('<span class="set-tag set-tag-restart" title="Read once at startup">Applies after a restart</span>');
  if (s.advanced) tags.push('<span class="set-tag">Advanced</span>');
  const reset = s.source === 'ui'
    ? `<button type="button" class="set-reset" data-reset title="Back to the default (${esc(display(s, s.default))})">Reset</button>` : '';
  return `
    <div class="set-row${s.source === 'env' ? ' is-env' : ''}" data-id="${esc(s.id)}">
      <div class="set-info">
        <div class="set-label">${esc(s.label)} ${tags.join(' ')}</div>
        <div class="set-desc">${esc(s.description)}</div>
      </div>
      <div class="set-control">${control(s)}<span class="set-status" aria-live="polite"></span>${reset}</div>
    </div>`;
}

let model = [];   // groups as last received

function render() {
  root.innerHTML = model.map(g => `
    <section class="admin-section set-group">
      <h3 class="set-group-title">${esc(g.title)}</h3>
      ${g.blurb ? `<p class="admin-hint">${esc(g.blurb)}</p>` : ''}
      <div class="admin-list">${g.settings.map(row).join('')}</div>
    </section>`).join('');
}

function find(id) {
  for (const g of model) { const i = g.settings.findIndex(s => s.id === id); if (i >= 0) return [g, i]; }
  return null;
}

function replaceRow(setting) {
  const hit = find(setting.id);
  if (!hit) return;
  hit[0].settings[hit[1]] = setting;
  const el = root.querySelector(`.set-row[data-id="${CSS.escape(setting.id)}"]`);
  if (el) { const tmp = document.createElement('div'); tmp.innerHTML = row(setting); el.replaceWith(tmp.firstElementChild); }
}

function flash(id, text, bad) {
  const el = root.querySelector(`.set-row[data-id="${CSS.escape(id)}"] .set-status`);
  if (!el) return;
  el.textContent = text;
  el.className = 'set-status ' + (bad ? 'bad' : 'ok');
  if (!bad) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2200);
}

async function save(id, ctl) {
  const hit = find(id); if (!hit) return;
  const s = hit[0].settings[hit[1]];
  const value = s.type === 'bool' ? ctl.checked : ctl.value;
  if (s.type !== 'bool' && String(value) === String(s.value)) return;    // nothing changed
  flash(id, 'Saving…');
  try {
    const { setting } = await api('PUT', `/api/admin/settings/${encodeURIComponent(id)}`, { value });
    replaceRow(setting);
    flash(id, 'Saved ✓');
  } catch (err) {
    flash(id, err.message, true);
    // put the control back to what's actually in effect
    if (s.type === 'bool') ctl.checked = !!s.value; else ctl.value = s.value;
  }
}

root.addEventListener('change', (e) => {
  const ctl = e.target.closest('[data-ctl]');
  if (ctl) save(ctl.closest('.set-row').dataset.id, ctl);
});
root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-ctl]')) e.target.blur();   // commit with Enter
});
root.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reset]');
  if (!btn) return;
  const id = btn.closest('.set-row').dataset.id;
  try {
    const { setting } = await api('DELETE', `/api/admin/settings/${encodeURIComponent(id)}`);
    replaceRow(setting);
    flash(id, 'Back to default ✓');
  } catch (err) { flash(id, err.message, true); }
});

api('GET', '/api/admin/settings')
  .then(data => { model = data.groups; render(); })
  .catch(err => { root.innerHTML = `<div class="loading">${esc(err.message)}</div>`; });
