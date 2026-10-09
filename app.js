/* WritePad — kiosk exam text editor
 *
 * Design rules:
 *  - Never lose a student's work: autosave to localStorage on every change,
 *    recover on next launch, keep a short history of cleared documents.
 *  - Never interrupt: no auto-reload, no network calls, no external assets.
 *  - Save = real text file via the File System Access API when available,
 *    otherwise a plain download. Print = clean page with a student header.
 */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';

  // ---------- Storage keys ----------
  const KEY_DOC = 'writepad.doc.v1';
  const KEY_PREFS = 'writepad.prefs.v1';
  const KEY_HISTORY = 'writepad.history.v1';
  const HISTORY_MAX = 5;

  // ---------- URL options ----------
  // ?title=Unit%203%20Essay   exam title shown in the header and on printouts
  // ?spell=1                  turn spellcheck on (off by default)
  // ?nofields=1               hide the Name and ID fields
  // ?size=24                  starting text size in px (14–40)
  // ?font=serif|sans|mono     starting font
  const params = new URLSearchParams(location.search);
  const OPT = {
    title: (params.get('title') || '').trim().slice(0, 120),
    spell: params.get('spell') === '1',
    nofields: params.get('nofields') === '1',
    size: clampInt(params.get('size'), 14, 40, null),
    font: ['serif', 'sans', 'mono'].includes(params.get('font')) ? params.get('font') : null
  };

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const nameInput = $('student-name');
  const idInput = $('student-id');
  const fields = $('fields');
  const examTitle = $('exam-title');
  const btnSave = $('btn-save');
  const btnPrint = $('btn-print');
  const btnHelp = $('btn-help');
  const btnHistory = $('btn-history');
  const btnFinish = $('btn-finish');
  const menu = $('menu');
  const fontSmaller = $('font-smaller');
  const fontLarger = $('font-larger');
  const fontSizeLabel = $('font-size-label');
  const fontFamilySel = $('font-family');
  const themeSel = $('theme');
  const statWords = $('stat-words');
  const statChars = $('stat-chars');
  const statLines = $('stat-lines');
  const statDirty = $('stat-dirty');
  const statAutosave = $('stat-autosave');
  const statBattery = $('stat-battery');
  const statClock = $('stat-clock');
  const toastEl = $('toast');

  const dlgRecover = $('dlg-recover');
  const dlgFinish = $('dlg-finish');
  const dlgHelp = $('dlg-help');
  const dlgHistory = $('dlg-history');

  // ---------- State ----------
  let dirty = false;              // changed since last file save
  let fileHandle = null;          // File System Access handle for quick re-save
  let lastAutosave = null;        // Date
  let autosaveTimer = null;
  let toastTimer = null;

  const FONT_STACKS = {
    sans: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", Times, serif',
    mono: 'ui-monospace, Consolas, "Courier New", monospace'
  };

  // ---------- Helpers ----------
  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }
  function readJSON(key, fallback) {
    const raw = safeGet(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDateTime(d) {
    return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
  function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }
  function sanitizeFilePart(s) {
    return s.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 40);
  }

  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function countWords(text) {
    const t = text.trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  // ---------- Preferences ----------
  const prefs = Object.assign(
    { size: 22, font: 'sans', theme: 'system' },
    readJSON(KEY_PREFS, {})
  );
  if (OPT.size) prefs.size = OPT.size;
  if (OPT.font) prefs.font = OPT.font;

  function applyPrefs() {
    document.documentElement.style.setProperty('--editor-size', prefs.size + 'px');
    document.documentElement.style.setProperty('--editor-font', FONT_STACKS[prefs.font] || FONT_STACKS.sans);
    fontSizeLabel.textContent = String(prefs.size);
    fontFamilySel.value = prefs.font;
    themeSel.value = prefs.theme;
    if (prefs.theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', prefs.theme);
    }
    safeSet(KEY_PREFS, JSON.stringify(prefs));
  }

  function changeSize(delta) {
    prefs.size = clampInt(prefs.size + delta, 14, 40, 22);
    applyPrefs();
  }

  // ---------- Autosave ----------
  function currentDoc() {
    return {
      text: editor.value,
      name: nameInput.value,
      id: idInput.value,
      title: OPT.title,
      updated: Date.now()
    };
  }

  function autosaveNow() {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    const doc = currentDoc();
    if (!doc.text && !doc.name && !doc.id) {
      safeRemove(KEY_DOC);
      statAutosave.textContent = 'Nothing to save yet';
      return;
    }
    if (safeSet(KEY_DOC, JSON.stringify(doc))) {
      lastAutosave = new Date();
      statAutosave.textContent = `Saved on this device ${fmtTime(lastAutosave)}`;
    } else {
      statAutosave.textContent = 'Could not save on this device — use Save or Print soon';
    }
  }

  function scheduleAutosave() {
    if (autosaveTimer) return;
    autosaveTimer = setTimeout(autosaveNow, 400);
  }

  function updateStats() {
    const text = editor.value;
    const words = countWords(text);
    const chars = text.length;
    const lines = text ? text.split('\n').length : 1;
    statWords.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    statChars.textContent = `${chars.toLocaleString()} ${chars === 1 ? 'character' : 'characters'}`;
    statLines.textContent = `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
  }

  function setDirty(v) {
    dirty = v;
    statDirty.textContent = v ? 'Not saved to a file' : '';
  }

  function onEdit() {
    updateStats();
    setDirty(true);
    scheduleAutosave();
  }

  // ---------- History of cleared documents ----------
  function pushHistory(doc) {
    if (!doc || !doc.text || !doc.text.trim()) return;
    const hist = readJSON(KEY_HISTORY, []);
    hist.unshift({ ...doc, cleared: Date.now() });
    safeSet(KEY_HISTORY, JSON.stringify(hist.slice(0, HISTORY_MAX)));
  }

  function renderHistory() {
    const list = $('history-list');
    list.textContent = '';
    const hist = readJSON(KEY_HISTORY, []);
    if (!hist.length) {
      const p = document.createElement('p');
      p.className = 'history-empty';
      p.textContent = 'No previous documents on this device.';
      list.appendChild(p);
      return;
    }
    hist.forEach((h, i) => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const info = document.createElement('div');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const who = [h.name, h.id].filter(Boolean).join(' · ') || 'No name';
      meta.textContent = `${who} — ${countWords(h.text)} words — cleared ${fmtDateTime(new Date(h.cleared))}`;
      const prev = document.createElement('div');
      prev.className = 'preview';
      prev.textContent = h.text.trim().slice(0, 90);
      info.appendChild(meta);
      info.appendChild(prev);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Restore';
      btn.addEventListener('click', () => {
        const current = currentDoc();
        if (current.text.trim()) pushHistory(current);
        loadDoc(h);
        const rest = readJSON(KEY_HISTORY, []);
        rest.splice(i, 1);
        safeSet(KEY_HISTORY, JSON.stringify(rest));
        dlgHistory.close();
        menu.removeAttribute('open');
        toast('Document restored');
        editor.focus();
      });

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  // ---------- Load / clear ----------
  function loadDoc(doc) {
    editor.value = doc.text || '';
    nameInput.value = doc.name || '';
    idInput.value = doc.id || '';
    fileHandle = null;
    updateStats();
    setDirty(Boolean(editor.value));
    autosaveNow();
  }

  function clearAll() {
    editor.value = '';
    nameInput.value = '';
    idInput.value = '';
    fileHandle = null;
    safeRemove(KEY_DOC);
    updateStats();
    setDirty(false);
    statAutosave.textContent = 'Ready for the next student';
    lastAutosave = null;
  }

  // ---------- Save to file ----------
  function suggestedFilename() {
    const parts = [];
    const n = sanitizeFilePart(nameInput.value);
    const id = sanitizeFilePart(idInput.value);
    if (n) parts.push(n);
    if (id) parts.push(id);
    if (!parts.length) parts.push(sanitizeFilePart(OPT.title) || 'WritePad');
    parts.push(stamp(new Date()));
    return parts.join('_') + '.txt';
  }

  function fileContents() {
    // Text only. A short header makes the file self-identifying when it
    // ends up in a shared folder or on a USB stick.
    const header = [];
    if (nameInput.value.trim()) header.push(`Name: ${nameInput.value.trim()}`);
    if (idInput.value.trim()) header.push(`ID: ${idInput.value.trim()}`);
    if (OPT.title) header.push(`Title: ${OPT.title}`);
    header.push(`Date: ${fmtDateTime(new Date())}`);
    header.push(`Words: ${countWords(editor.value)}`);
    return header.join('\r\n') + '\r\n\r\n' + editor.value.replace(/\r?\n/g, '\r\n') + '\r\n';
  }

  async function saveFile({ forceDialog = false } = {}) {
    const text = fileContents();
    const filename = suggestedFilename();

    if ('showSaveFilePicker' in window) {
      try {
        if (!fileHandle || forceDialog) {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }]
          });
        }
        const writable = await fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        setDirty(false);
        toast(`Saved ${fileHandle.name}`);
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          toast('Save cancelled');
          return false;
        }
        // Picker blocked or failed (e.g. kiosk policy): fall through to download.
        fileHandle = null;
      }
    }

    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setDirty(false);
      toast(`Downloaded ${filename}`);
      return true;
    } catch (_) {
      toast('Could not save. Try Print instead.', 5000);
      return false;
    }
  }

  // ---------- Print ----------
  function preparePrint() {
    const now = new Date();
    $('print-name').textContent = nameInput.value.trim() || 'Name: ____________________';
    $('print-id').textContent = idInput.value.trim() ? `ID: ${idInput.value.trim()}` : '';
    $('print-title').textContent = OPT.title;
    $('print-date').textContent = fmtDateTime(now);
    $('print-body').textContent = editor.value;
    const words = countWords(editor.value);
    $('print-footer').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · printed ${fmtDateTime(now)}`;
  }

  function doPrint() {
    preparePrint();
    window.print();
  }

  // ---------- Finish ----------
  function openFinish() {
    menu.removeAttribute('open');
    const w = countWords(editor.value);
    $('finish-warning').textContent = dirty && w
      ? `Warning: this document (${w} words) has not been saved to a file since the last change.`
      : '';
    dlgFinish.showModal();
  }

  // ---------- Recovery on launch ----------
  function maybeRecover() {
    const saved = readJSON(KEY_DOC, null);
    if (!saved || !(saved.text || saved.name || saved.id)) {
      editor.focus();
      return;
    }
    const who = [saved.name, saved.id].filter(Boolean).join(' · ');
    const when = saved.updated ? fmtDateTime(new Date(saved.updated)) : 'unknown time';
    const w = countWords(saved.text || '');
    $('recover-summary').textContent =
      `${who ? who + ' — ' : ''}${w} ${w === 1 ? 'word' : 'words'}, last edited ${when}.`;
    dlgRecover.showModal();
  }

  $('recover-restore').addEventListener('click', () => {
    const saved = readJSON(KEY_DOC, null);
    if (saved) loadDoc(saved);
    dlgRecover.close();
    toast('Work restored');
    editor.focus();
  });

  $('recover-discard').addEventListener('click', () => {
    const saved = readJSON(KEY_DOC, null);
    pushHistory(saved);
    clearAll();
    dlgRecover.close();
    editor.focus();
  });

  // Prevent Esc from dismissing the recovery dialog without a choice.
  dlgRecover.addEventListener('cancel', (e) => e.preventDefault());

  // ---------- Wire up ----------
  if (OPT.title) {
    examTitle.textContent = OPT.title;
    document.title = `${OPT.title} — WritePad`;
  }
  if (OPT.nofields) fields.hidden = true;
  if (OPT.spell) editor.spellcheck = true;

  editor.addEventListener('input', onEdit);
  nameInput.addEventListener('input', () => { setDirty(true); scheduleAutosave(); });
  idInput.addEventListener('input', () => { setDirty(true); scheduleAutosave(); });

  btnSave.addEventListener('click', () => saveFile({ forceDialog: true }));
  btnPrint.addEventListener('click', doPrint);

  fontSmaller.addEventListener('click', () => changeSize(-2));
  fontLarger.addEventListener('click', () => changeSize(2));
  fontFamilySel.addEventListener('change', () => { prefs.font = fontFamilySel.value; applyPrefs(); });
  themeSel.addEventListener('change', () => { prefs.theme = themeSel.value; applyPrefs(); });

  btnHelp.addEventListener('click', () => {
    menu.removeAttribute('open');
    $('help-version').textContent = `WritePad ${APP_VERSION}`;
    dlgHelp.showModal();
  });
  $('help-close').addEventListener('click', () => dlgHelp.close());

  btnHistory.addEventListener('click', () => {
    menu.removeAttribute('open');
    renderHistory();
    dlgHistory.showModal();
  });
  $('history-close').addEventListener('click', () => dlgHistory.close());

  btnFinish.addEventListener('click', openFinish);
  $('finish-cancel').addEventListener('click', () => dlgFinish.close());
  $('finish-confirm').addEventListener('click', () => {
    pushHistory(currentDoc());
    clearAll();
    dlgFinish.close();
    toast('Cleared. Ready for the next student.');
    nameInput.focus();
  });

  // Close the menu when clicking elsewhere.
  document.addEventListener('pointerdown', (e) => {
    if (menu.hasAttribute('open') && !menu.contains(e.target)) menu.removeAttribute('open');
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveFile();
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      doPrint();
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      changeSize(2);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      changeSize(-2);
    } else if (mod && e.key === '0') {
      e.preventDefault();
      prefs.size = 22;
      applyPrefs();
    } else if (e.key === 'F1') {
      e.preventDefault();
      btnHelp.click();
    } else if (e.key === 'Escape' && menu.hasAttribute('open')) {
      menu.removeAttribute('open');
      editor.focus();
    }
  });

  // Flush autosave when the page is hidden, unloading, or losing focus.
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosaveNow(); });
  window.addEventListener('pagehide', autosaveNow);
  window.addEventListener('blur', autosaveNow);
  window.addEventListener('beforeunload', (e) => {
    autosaveNow();
    if (dirty && editor.value.trim()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('beforeprint', preparePrint);

  // Status: clock and battery
  function tickClock() {
    statClock.textContent = fmtTime(new Date());
  }
  tickClock();
  setInterval(tickClock, 15000);

  if ('getBattery' in navigator) {
    navigator.getBattery().then((b) => {
      const upd = () => {
        const pct = Math.round(b.level * 100);
        statBattery.textContent = `Battery ${pct}%${b.charging ? ' (charging)' : ''}`;
        statBattery.style.color = (!b.charging && pct <= 15) ? 'var(--danger)' : '';
      };
      upd();
      b.addEventListener('levelchange', upd);
      b.addEventListener('chargingchange', upd);
    }).catch(() => {});
  }

  // Service worker (offline support). Never reloads on its own.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
    });
  }

  // ---------- Go ----------
  applyPrefs();
  updateStats();
  maybeRecover();
})();
