// Settings window.
//
// Theme and language are applied the moment they are picked — there is no Save
// button, and no Cancel, because main persists on every set() and every window
// repaints from the broadcast. The footer note is the only feedback needed.

const themeSel = document.getElementById('st-theme');
const langSel = document.getElementById('st-lang');
const savedEl = document.getElementById('st-saved');

// Local copies, not a handle on boot.settings: contextBridge deep-clones and
// freezes everything it exposes, so assigning back into that object is a silent
// no-op outside strict mode. Writing to it and then re-reading it is what made
// the menu snap back to the previous theme after a pick, while the colours the
// pick applied stayed — the two disagreed because only one of them was real.
const bootSettings = (window.api.boot && window.api.boot.settings) || {};
let currentTheme = bootSettings.theme || 'system';
let currentLanguage = bootSettings.language || 'system';

// ---- section switcher ----

const navBtns = [...document.querySelectorAll('.st-navbtn')];
const sections = [...document.querySelectorAll('.st-section')];

for (const btn of navBtns) {
  btn.addEventListener('click', () => {
    const want = btn.dataset.section;
    for (const b of navBtns) {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const s of sections) s.classList.toggle('hidden', s.dataset.section !== want);
  });
}

// ---- saved indicator ----

let savedTimer = null;
function flashSaved() {
  savedEl.textContent = window.t('settings.saved');
  savedEl.classList.add('is-on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('is-on'), 1400);
}

// ---- pickers ----

// `selected` is the stored preference ('system' or an id), not the theme that
// happens to be active: with 'system' picked those differ, and showing the
// resolved one would make the menu jump to 'Neon' the moment the desktop is dark.
function fill(select, items, selected, toOption) {
  select.textContent = '';
  for (const item of items) {
    const opt = document.createElement('option');
    const { value, label } = toOption(item);
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === selected;
    select.appendChild(opt);
  }
}

async function loadThemes() {
  const list = await window.api.listThemes();
  // theme.list() already labels the system entry with the desktop theme it
  // resolved to ("System (Adwaita Dark)", theme.js), so the name is used as-is.
  // Wrapping it again here is what produced "System (System (Adwaita Dark))".
  fill(themeSel, list, currentTheme, (th) => ({ value: th.id, label: th.name }));
}

async function loadLanguages() {
  const list = await window.api.listLanguages();
  fill(langSel, [{ code: 'system', name: window.t('settings.language.system') }, ...list],
    currentLanguage, (l) => ({ value: l.code, label: l.name }));
}

themeSel.addEventListener('change', async () => {
  currentTheme = themeSel.value;
  await window.api.setTheme(themeSel.value);
  // The system entry's label carries the resolved desktop theme's name, which
  // changes with the pick — re-read rather than leave a stale one behind.
  await loadThemes();
  flashSaved();
});

langSel.addEventListener('change', async () => {
  currentLanguage = langSel.value;
  await window.api.setLanguage(langSel.value);
  flashSaved();
});

// ---- sync ----

const el = (id) => document.getElementById(id);
const hostEl = el('st-host'), portEl = el('st-port'), userEl = el('st-user'),
      pathEl = el('st-path'), authEl = el('st-auth'), keyEl = el('st-key'),
      secretEl = el('st-secret'), secretLabel = el('st-secret-label'),
      secretHint = el('st-secret-hint'), hostKeyBox = el('st-hostkey'),
      hostKeyText = el('st-hostkey-text'), acceptBtn = el('st-accept'),
      testOut = el('st-test-out');

let syncCfg = null;
let pendingHostKey = null;   // probed, not yet accepted

function applyAuthMode() {
  const isKey = authEl.value === 'key';
  el('st-keyrow').classList.toggle('hidden', !isKey);
  secretLabel.textContent = window.t(isKey ? 'settings.sync.passphrase' : 'settings.sync.password');
  // An empty field means "leave what is stored alone", which is not obvious —
  // say so, and say whether there is anything stored to leave alone.
  secretHint.textContent = syncCfg && syncCfg.hasSecret
    ? window.t('settings.sync.secret.stored')
    : window.t('settings.sync.secret.none');
}

// `state` is what we actually know, which is not the same as what is stored:
//   pinned  — a key is on file, nothing has been checked this session
//   known   — a probe just confirmed the server still presents that key
//   new / changed / none — as named
// Showing a stored pin as "matching" would be asserting a check that never
// ran; the only honest green is one a probe just earned.
function showHostKey(state, key, known) {
  hostKeyBox.className = `st-hostkey st-hostkey-${state}`;
  acceptBtn.classList.toggle('hidden', state === 'known' || state === 'pinned' || !key);
  if (!key) {
    hostKeyText.textContent = window.t('settings.sync.hostkey.none');
    return;
  }
  const fp = `SHA256:${key.sha256}`;
  if (state === 'pinned') hostKeyText.textContent = `${window.t('settings.sync.hostkey.pinned')}\n${fp}`;
  else if (state === 'known') hostKeyText.textContent = `${window.t('settings.sync.hostkey.ok')}\n${fp}`;
  else if (state === 'changed') {
    hostKeyText.textContent =
      `${window.t('settings.sync.hostkey.changed')}\n` +
      `${window.t('settings.sync.hostkey.was')} SHA256:${known ? known.sha256 : '?'}\n` +
      `${window.t('settings.sync.hostkey.now')} ${fp}`;
  } else hostKeyText.textContent = `${window.t('settings.sync.hostkey.new')}\n${fp}`;
}

async function loadSync() {
  syncCfg = await window.api.getSyncConfig();
  hostEl.value = syncCfg.host;
  portEl.value = syncCfg.port;
  userEl.value = syncCfg.user;
  pathEl.value = syncCfg.remotePath;
  authEl.value = syncCfg.authMethod;
  keyEl.value = syncCfg.keyPath;
  secretEl.value = '';
  applyAuthMode();
  showHostKey(syncCfg.hostKey ? 'pinned' : 'none', syncCfg.hostKey, syncCfg.hostKey);
  if (!syncCfg.secretAvailable) {
    secretHint.textContent = window.t('settings.sync.nokeyring');
    secretHint.classList.add('st-bad');
  }
}

// The whole form, minus the secret unless it was typed into.
function formPatch() {
  const patch = {
    host: hostEl.value, port: portEl.value, user: userEl.value,
    remotePath: pathEl.value, authMethod: authEl.value, keyPath: keyEl.value,
  };
  if (secretEl.value) patch.secret = secretEl.value;
  return patch;
}

async function saveSync() {
  const res = await window.api.saveSync(formPatch());
  if (!res.ok) {
    testOut.textContent = window.t('settings.sync.err.nokeyring');
    testOut.className = 'st-hint st-bad';
    return false;
  }
  syncCfg = res.config;
  secretEl.value = '';
  applyAuthMode();
  // save() drops the pin when host or port changed; reflect that rather than
  // leaving a fingerprint on screen that is no longer trusted.
  if (!syncCfg.hostKey) { pendingHostKey = null; showHostKey('none', null, null); }
  flashSaved();
  return true;
}

for (const f of [hostEl, portEl, userEl, pathEl, keyEl]) {
  f.addEventListener('change', saveSync);
}
authEl.addEventListener('change', async () => { await saveSync(); applyAuthMode(); });
secretEl.addEventListener('change', saveSync);

el('st-key-pick').addEventListener('click', async () => {
  const picked = await window.api.pickKeyFile();
  if (picked) { keyEl.value = picked; await saveSync(); }
});

el('st-probe').addEventListener('click', async () => {
  await saveSync();
  hostKeyText.textContent = window.t('settings.sync.checking');
  acceptBtn.classList.add('hidden');
  const res = await window.api.probeSync({});
  if (!res.ok) {
    hostKeyBox.className = 'st-hostkey st-hostkey-changed';
    hostKeyText.textContent = window.t(`settings.sync.err.${res.code}`, { detail: res.detail || '' });
    return;
  }
  pendingHostKey = res.hostKey;
  showHostKey(res.state, res.hostKey, res.known);
});

acceptBtn.addEventListener('click', async () => {
  if (!pendingHostKey) return;
  syncCfg = await window.api.pinHostKey(pendingHostKey);
  showHostKey('known', syncCfg.hostKey, syncCfg.hostKey);
  pendingHostKey = null;
  flashSaved();
});

el('st-test').addEventListener('click', async () => {
  await saveSync();
  testOut.className = 'st-hint';
  testOut.textContent = window.t('settings.sync.testing');
  const res = await window.api.testSync();
  if (res.ok) {
    testOut.className = 'st-hint st-ok';
    testOut.textContent = window.t('settings.sync.test.ok', { path: res.path, n: res.entries });
    return;
  }
  testOut.className = 'st-hint st-bad';
  testOut.textContent = res.code === 'incomplete'
    ? window.t('settings.sync.err.incomplete', { fields: (res.missing || []).join(', ') })
    : window.t(`settings.sync.err.${res.code}`, { detail: res.detail || '' });
});

// Strings baked into JS (the option labels) have to be rebuilt on a language
// change; data-i18n attributes are handled by ui.js.
window.ui.onChange((kind) => {
  if (kind === 'language') { loadThemes(); loadLanguages(); applyAuthMode(); }
});

document.getElementById('st-close').addEventListener('click', () => window.api.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.close(); });

loadThemes();
loadLanguages();
loadSync();
