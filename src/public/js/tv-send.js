// "Send to your TV" page (/tv/<code>): pastes an invite link into the Playdarr Android TV app (see src/tvlink.js).
(() => {
  const $ = id => document.getElementById(id);
  const codeEl = $('tv-code'), textEl = $('tv-text'), nameEl = $('tv-name');
  const errEl = $('error-msg'), form = $('send-form'), btn = $('send-btn'), pasteBtn = $('paste-btn');

  const showError = msg => { errEl.textContent = msg; errEl.style.display = msg ? '' : 'none'; };
  const clean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  // /tv/K7M2QX (from the QR code) fills the code in; /tv on its own asks for it
  const fromPath = clean(decodeURIComponent(location.pathname.split('/')[2] || ''));
  if (fromPath) {
    codeEl.value = fromPath;
    fetch(`/api/tv/pair/${fromPath}/check`).then(r => r.json()).then(({ ok }) => {
      if (!ok) showError("That code has expired. Check the TV for the current one and type it above.");
    }).catch(() => {});
  }
  try { nameEl.value = localStorage.getItem('tv-send-name') || ''; } catch { /* private mode */ }
  (fromPath ? textEl : codeEl).focus();

  // A one-tap paste where the browser allows reading the clipboard (most need https and a tap)
  if (navigator.clipboard?.readText) {
    pasteBtn.style.display = '';
    pasteBtn.addEventListener('click', async () => {
      try { textEl.value = (await navigator.clipboard.readText()).trim(); showError(''); }
      catch { showError('Your browser blocked reading the clipboard. Long-press the box and choose Paste.'); }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = clean(codeEl.value), text = textEl.value.trim(), name = nameEl.value.trim();
    if (code.length !== 6) return showError('Enter the 6-character code shown on the TV.');
    if (!text) return showError('Paste the invite link first.');
    showError('');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/tv/pair/${code}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
      try { if (name) localStorage.setItem('tv-send-name', name); } catch { /* private mode */ }
      form.style.display = 'none';
      $('intro').style.display = 'none';
      $('sent').style.display = '';
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
    }
  });
})();
