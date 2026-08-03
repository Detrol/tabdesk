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

// ---- copy to clipboard ----
//
// The invite and the recovery string are long, wrapped and meant to be moved
// somewhere else, so selecting them by hand is the wrong ask. The button says
// what it did for a moment and then goes back to itself; a language change in
// between would otherwise leave "Copied" as the permanent label, so the reset
// re-reads the string rather than restoring a captured one.
function wireCopy(btnId, srcId) {
  const btn = document.getElementById(btnId);
  let timer = null;
  btn.addEventListener('click', async () => {
    const text = document.getElementById(srcId).textContent.trim();
    if (!text) return;
    const ok = await window.api.copyText(text);
    btn.textContent = window.t(ok ? 'settings.copied' : 'settings.copyFailed');
    clearTimeout(timer);
    timer = setTimeout(() => { btn.textContent = window.t('settings.copy'); }, 1400);
  });
}

wireCopy('st-td-invite-copy', 'st-td-invite-text');
wireCopy('st-td-recovery-copy', 'st-td-recovery-text');

// ---- moving your setup by file ----

document.getElementById('st-portable').addEventListener('click', () => window.api.openPortable());

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
  // Themes that come in official variants carry a family: those become an
  // optgroup with the variants under it, in the list's (already sorted) order.
  themeSel.textContent = '';
  const groups = new Map();
  for (const th of list) {
    let parent = themeSel;
    if (th.family) {
      if (!groups.has(th.family)) {
        const g = document.createElement('optgroup');
        g.label = th.family;
        groups.set(th.family, g);
        themeSel.appendChild(g);
      }
      parent = groups.get(th.family);
    }
    const opt = document.createElement('option');
    opt.value = th.id;
    opt.textContent = th.family ? (th.variant || th.name) : th.name;
    opt.selected = th.id === currentTheme;
    parent.appendChild(opt);
  }
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
loadKeyState().then(() => loadSync()).then(loadFiles);

// ---- project files ----
//
// A ticked project is watched and pushed when its files stop changing. The
// tick is the only control: there is no separate "sync now", because a manual
// push that disagrees with the watcher is two sources of truth for the same
// question.

const filesWrap = el('st-files');
const filesList = el('st-files-list');
const filesOut = el('st-files-out');
const ignoresEl = el('st-ignores');
const maxMbEl = el('st-maxmb');
const gitignoreEl = el('st-usegitignore');

let projects = [];
const stateEls = new Map();   // project path -> the span showing its status

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The slug the remote layout is keyed on. Kept simple and stable: it is a
// directory name on the server, not something to reconstruct a path from.
const slugOf = (p) => String(p).replace(/^.*\//, '') || 'project';

function renderProjects(pushing) {
  filesList.textContent = '';
  stateEls.clear();
  const on = new Set(pushing);
  for (const p of projects) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on.has(p.path);
    box.dataset.path = p.path;

    const name = document.createElement('span');
    name.className = 'st-file-name';
    name.textContent = p.name;
    name.title = p.path;

    const state = document.createElement('span');
    state.className = 'st-file-state';
    stateEls.set(p.path, state);

    box.addEventListener('change', () => toggleProject(p, box.checked));
    label.append(box, name);
    li.append(label, state);
    filesList.append(li);
  }
}

async function toggleProject(project, on) {
  const chosen = [...filesList.querySelectorAll('input[type=checkbox]')]
    .filter((b) => b.checked).map((b) => b.dataset.path);
  await window.api.saveSync({ pushProjects: chosen });
  if (on) await window.api.watchStart(slugOf(project.path), project.path);
  else await window.api.watchStop(slugOf(project.path));
  flashSaved();
}

async function loadFiles() {
  // Only offered once there is somewhere to send to — see the markup comment.
  // A group key is as much a precondition as the server is: without one every
  // operation below refuses with no-key.
  const keyState = await window.api.keyState();
  const ready = keyState.has && syncCfg && syncCfg.host && syncCfg.hostKey && syncCfg.remotePath;
  filesWrap.classList.toggle('hidden', !ready);
  if (!ready) return;

  ignoresEl.value = (syncCfg.extraIgnores || []).join(', ');
  maxMbEl.value = syncCfg.maxBytes ? Math.round(syncCfg.maxBytes / (1024 * 1024)) : '';
  gitignoreEl.checked = syncCfg.useGitignore !== false;

  const res = await window.api.listProjects();
  projects = (res && res.projects) || res || [];
  renderProjects(syncCfg.pushProjects || []);

  // Re-arm watchers for what was ticked in a previous session: the setting
  // persists, the chokidar instances do not.
  loadPull();

  const running = await window.api.watching();
  const live = new Set((running && running.watching) || []);
  for (const p of syncCfg.pushProjects || []) {
    if (!live.has(slugOf(p))) window.api.watchStart(slugOf(p), p);
  }
}

ignoresEl.addEventListener('change', async () => {
  await window.api.saveSync({ extraIgnores: ignoresEl.value.split(',') });
  syncCfg = await window.api.getSyncConfig();
  flashSaved();
});
maxMbEl.addEventListener('change', async () => {
  const mb = Number.parseInt(maxMbEl.value, 10);
  await window.api.saveSync({ maxBytes: Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0 });
  syncCfg = await window.api.getSyncConfig();
  flashSaved();
});
gitignoreEl.addEventListener('change', async () => {
  await window.api.saveSync({ useGitignore: gitignoreEl.checked });
  syncCfg = await window.api.getSyncConfig();
  flashSaved();
});

// Progress from both loops in main. Receiving events are handled FIRST: they
// have no local push row to attach to, and looking one up before dispatching
// meant the lookup's early return swallowed every one of them — the receive
// status never moved off whatever it said at load.
window.api.onSyncEvent((ev) => {
  if (ev.type === 'live-state' || ev.type === 'poll-ok') { refreshPullState(); return; }
  if (ev.type === 'pull-done') {
    filesOut.className = 'st-hint st-ok';
    filesOut.textContent = window.t('settings.pull.received', { slug: ev.slug, n: ev.written });
    refreshPullState();
    return;
  }
  if (ev.type === 'pull-error') {
    filesOut.className = 'st-hint st-bad';
    filesOut.textContent = ev.detail || ev.code;
    return;
  }

  // From here on it is push progress, which does have a row.
  const path = (projects.find((p) => slugOf(p.path) === ev.slug) || {}).path;
  const span = path && stateEls.get(path);
  if (!span) return;
  if (ev.type === 'push-start') {
    span.className = 'st-file-state busy';
    span.textContent = window.t('settings.files.sending');
  } else if (ev.type === 'push-done') {
    span.className = 'st-file-state';
    span.textContent = window.t('settings.files.sent', {
      n: ev.count, size: fmtBytes(ev.uploadedBytes || 0),
    });
    // Anything the manifest refused has to be visible: "synced" must not mean
    // "synced except the parts you would have wanted to know about".
    if (ev.skipped && ev.skipped.length) {
      filesOut.className = 'st-hint st-bad';
      filesOut.textContent = window.t('settings.files.skipped', {
        n: ev.skipped.length,
        list: ev.skipped.slice(0, 3).map((s) => s.path).join(', '),
      });
    }
  } else if (ev.type === 'push-error') {
    span.className = 'st-file-state bad';
    span.textContent = window.t('settings.files.failed');
    filesOut.className = 'st-hint st-bad';
    filesOut.textContent = ev.detail || ev.code;
  }
});

// ---- projects to receive ----
//
// The list is what the server has, not what this machine has: receiving is
// how a project first appears here, so offering only local ones would make it
// impossible to opt into anything new.

const pullList = el('st-pull-list');
const pullStateEl = el('st-pull-state');

async function loadPull() {
  pullList.textContent = '';
  pullStateEl.textContent = window.t('settings.pull.loading');

  const res = await window.api.filesList();
  if (!res || !res.ok) {
    pullStateEl.className = 'st-file-state bad';
    pullStateEl.textContent = (res && res.detail) || window.t('settings.pull.err');
    return;
  }
  pullStateEl.className = 'st-file-state';
  pullStateEl.textContent = '';

  // Our own pushes are not something to receive back.
  const offered = res.projects.filter((p) => !p.mine);
  if (!offered.length) {
    pullStateEl.textContent = window.t('settings.pull.none');
    return;
  }

  const on = new Set(syncCfg.pullProjects || []);
  for (const p of offered) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on.has(p.slug);
    box.dataset.slug = p.slug;

    const name = document.createElement('span');
    name.className = 'st-file-name';
    name.textContent = p.slug;

    const meta = document.createElement('span');
    meta.className = 'st-file-state';
    meta.textContent = window.t('settings.pull.meta', {
      n: p.count, from: p.deviceName || '?',
    });

    box.addEventListener('change', togglePull);
    label.append(box, name);
    li.append(label, meta);
    pullList.append(li);
  }
  refreshPullState();
}

async function togglePull() {
  const chosen = [...pullList.querySelectorAll('input[type=checkbox]')]
    .filter((b) => b.checked).map((b) => b.dataset.slug);
  await window.api.saveSync({ pullProjects: chosen });
  syncCfg = await window.api.getSyncConfig();
  // Restarting rather than adding: the loop holds the live channel and the
  // per-project record of what it last pulled, and rebuilding both from the
  // saved list is simpler than reconciling two sets that can disagree.
  if (chosen.length) await window.api.pullStart();
  else await window.api.pullStop();
  refreshPullState();
  flashSaved();
}

async function refreshPullState() {
  const st = await window.api.pullState();
  if (!st || !st.watching || !st.watching.length) {
    pullStateEl.textContent = '';
    return;
  }
  // Say which one is actually carrying the updates. "Live" and "checking every
  // 15s" are both working states, and they behave differently enough that a
  // single "on" would hide the difference.
  pullStateEl.textContent = st.live
    ? window.t('settings.pull.live')
    : window.t('settings.pull.polling', { s: Math.round(st.pollMs / 1000) });
}

el('st-pull-refresh').addEventListener('click', loadPull);

// ---- your TabDesk ----
//
// The group key comes before the server, because without one nothing below it
// can work. Two ways in: create a TabDesk, or paste an invite from a machine
// that already has one.

const tdNone = el('st-td-none');
const tdHave = el('st-td-have');
const tdRecovery = el('st-td-recovery');
const tdInvite = el('st-td-invite');
const tdJoinBox = el('st-td-joinbox');
const tdFp = el('st-td-fp');

let inviteTimer = null;

function tdShow(which) {
  for (const [node, name] of [[tdNone, 'none'], [tdHave, 'have'],
    [tdRecovery, 'recovery'], [tdInvite, 'invite'], [tdJoinBox, 'join']]) {
    node.classList.toggle('hidden', name !== which);
  }
  if (which !== 'invite') { clearInterval(inviteTimer); inviteTimer = null; }
}

async function loadKeyState() {
  const st = await window.api.keyState();
  if (!st.available) {
    // Without a keyring the group key would have to sit on disk in a form
    // anyone could read, which is worse than not syncing.
    tdShow('none');
    el('st-td-create').disabled = true;
    el('st-td-join').disabled = true;
    tdNone.querySelector('.st-hint').textContent = window.t('settings.td.nokeyring');
    return st;
  }
  if (st.has) {
    tdFp.textContent = st.fingerprint || '';
    tdShow('have');
  } else {
    tdShow('none');
  }
  return st;
}

el('st-td-create').addEventListener('click', async () => {
  const res = await window.api.keyCreate();
  if (!res.ok) {
    tdNone.querySelector('.st-hint').textContent = window.t(`settings.td.err.${res.code}`);
    return;
  }
  el('st-td-recovery-text').textContent = res.recovery;
  tdShow('recovery');
  flashSaved();
});

el('st-td-show-recovery').addEventListener('click', async () => {
  const res = await window.api.keyRecovery();
  if (!res.ok) return;
  el('st-td-recovery-text').textContent = res.recovery;
  tdShow('recovery');
});

el('st-td-recovery-done').addEventListener('click', async () => {
  el('st-td-recovery-text').textContent = '';
  await loadKeyState();
  await loadSync();
  await loadFiles();
});

// ---- invites ----

function renderInviteCountdown(expiresAt) {
  const left = el('st-td-invite-left');
  const tick = () => {
    const ms = Date.parse(expiresAt) - Date.now();
    if (ms <= 0) {
      // An expired invite is not shown as a still-valid string with a note
      // beside it — it is taken off the screen.
      el('st-td-invite-text').textContent = '';
      left.textContent = window.t('settings.td.invite.expired');
      clearInterval(inviteTimer);
      inviteTimer = null;
      return;
    }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    left.textContent = window.t('settings.td.invite.left', { time: `${m}:${String(s).padStart(2, '0')}` });
  };
  clearInterval(inviteTimer);
  tick();
  inviteTimer = setInterval(tick, 1000);
}

async function makeInvite() {
  const out = el('st-td-out');
  const res = await window.api.inviteCreate({ includeAuth: el('st-td-invite-auth').checked });
  if (!res.ok) {
    tdShow('have');
    out.className = 'st-hint st-bad';
    // `incomplete` is the common one on a device that has a key but no server
    // yet, and it should name the fields rather than say "that did not work".
    out.textContent = res.code === 'incomplete'
      ? window.t('settings.td.err.incomplete', { fields: (res.missing || []).join(', ') })
      : window.t(`settings.td.err.${res.code}`);
    return;
  }
  out.textContent = '';
  el('st-td-invite-text').textContent = res.invite;
  tdShow('invite');
  renderInviteCountdown(res.expiresAt);
}

el('st-td-add').addEventListener('click', makeInvite);
el('st-td-invite-auth').addEventListener('change', makeInvite);
el('st-td-invite-done').addEventListener('click', () => {
  el('st-td-invite-text').textContent = '';
  tdShow('have');
});

// ---- joining ----

el('st-td-join').addEventListener('click', () => {
  el('st-td-join-text').value = '';
  el('st-td-join-out').textContent = '';
  tdShow('join');
});
el('st-td-join-cancel').addEventListener('click', () => loadKeyState());

el('st-td-join-text').addEventListener('input', async () => {
  const out = el('st-td-join-out');
  const text = el('st-td-join-text').value.trim();
  if (!text) { out.textContent = ''; return; }
  const p = await window.api.invitePreview(text);
  if (!p.ok) {
    out.className = 'st-hint st-bad';
    out.textContent = window.t(`settings.td.err.${p.code}`);
    return;
  }
  // Say what accepting would do before it is done — in particular that it
  // replaces a key this device may already have, which is not undoable.
  out.className = 'st-hint';
  out.textContent = window.t('settings.td.join.preview', {
    user: p.user, host: p.host, path: p.path,
  }) + (p.replacesExistingKey ? ` ${window.t('settings.td.join.replaces')}` : '');
  if (p.replacesExistingKey) out.className = 'st-hint st-bad';
});

el('st-td-join-go').addEventListener('click', async () => {
  const out = el('st-td-join-out');
  const res = await window.api.inviteAccept(el('st-td-join-text').value.trim());
  if (!res.ok) {
    out.className = 'st-hint st-bad';
    out.textContent = window.t(`settings.td.err.${res.code}`);
    return;
  }
  el('st-td-join-text').value = '';
  await loadKeyState();
  await loadSync();
  await loadFiles();
  flashSaved();
});

// ---- Statistics & About ----------------------------------------------------
//
// Total and Messages-today used to live in the status bar. They change slowly
// and you read them deliberately, which is not what a status bar is for — so
// they moved here, next to the version they belong beside.

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n | 0);
}
const fmtCost = (c) => '≈$' + (c >= 100 ? c.toFixed(0) : c.toFixed(2));

async function loadStats() {
  const u = await window.api.getUsageStats();
  if (!u || !u.total) return;
  el('st-total').textContent = `${fmtTokens(u.total.tokens)} · ${fmtCost(u.total.cost)}`;
  el('st-total').title = u.total.tokens.toLocaleString();
  el('st-msgs').textContent = String(u.today.msgs);
  el('st-span').textContent = window.t('settings.stats.days', { days: u.total.days });
}

async function loadAbout() {
  el('st-version').textContent = (await window.api.appVersion()) || '–';
}

el('st-site').addEventListener('click', () => window.api.openExternal('https://www.thern.io'));
el('st-repo').addEventListener('click', () => window.api.openExternal('https://github.com/TheJonaz/tabdesk'));

// The transcript scan behind this is the expensive one, so it runs when the
// pane is actually opened rather than on every settings launch.
for (const b of document.querySelectorAll('.st-navbtn')) {
  b.addEventListener('click', () => {
    if (b.dataset.section === 'stats') loadStats();
    if (b.dataset.section === 'about') loadAbout();
  });
}
