// Export / import window.
//
// Two views over one idea: what would leave this machine, and what a bundle
// would change on it. The import side never applies anything until the diff has
// been on screen — every file is labelled new / changed / unchanged first.

(function () {
  const $ = (id) => document.getElementById(id);

  const views = { export: $('pt-export'), import: $('pt-import') };
  const tabs = { export: $('pt-tab-export'), import: $('pt-tab-import') };
  const exList = $('pt-ex-list');
  const imList = $('pt-im-list');

  let scan = null;      // what this machine has
  let currentPlan = null;   // the diff of the bundle currently open
  let syncReady = false;    // a server is configured and its host key accepted
  let mode = 'export';

  const fmtBytes = (n) => (n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} kB`
    : `${(n / (1024 * 1024)).toFixed(1)} MB`);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- view switching ----

  function setMode(next) {
    mode = next;
    for (const key of ['export', 'import']) {
      views[key].classList.toggle('hidden', key !== next);
      tabs[key].classList.toggle('active', key === next);
    }
    $('pt-export-btn').classList.toggle('hidden', next !== 'export');
    // Only offered once a server is configured; loadPeers() unhides it.
    if (next !== 'export') $('pt-push-btn').classList.add('hidden');
    else if (syncReady) $('pt-push-btn').classList.remove('hidden');
    // The import buttons only make sense once a bundle is open.
    const hasPlan = Boolean(currentPlan);
    $('pt-import-btn').classList.toggle('hidden', next !== 'import' || !hasPlan);
    $('pt-im-other').classList.toggle('hidden', next !== 'import' || !hasPlan);
  }

  tabs.export.addEventListener('click', () => setMode('export'));
  tabs.import.addEventListener('click', () => setMode('import'));
  $('pt-close').addEventListener('click', () => window.api.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.close(); });

  // ---- export ----

  function renderExport() {
    exList.textContent = '';
    if (!scan) return;

    for (const project of scan.projects) {
      const li = el('li', 'pt-item');
      const label = el('label');

      const box = el('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.slug = project.slug;

      const bits = [];
      if (project.memoryCount) bits.push(window.t('portable.nMemory', { n: project.memoryCount }));
      if (project.hasClaudeMd) bits.push('CLAUDE.md');
      if (project.model) bits.push(project.model);

      label.append(box, el('span', 'pt-name', project.name),
                   el('span', 'pt-badge', bits.join(' · ')));
      // A project whose path we couldn't reconstruct travels by slug alone.
      if (!project.path) label.append(el('span', 'pt-path', project.slug));
      li.append(label);
      exList.append(li);
    }

    const totals = scan.totals;
    $('pt-ex-summary').textContent = window.t('portable.exSummary', {
      projects: totals.projects,
      memory: totals.memoryFiles,
      claudeMd: totals.claudeMd,
      models: totals.models,
      size: fmtBytes(totals.bytes),
    });
  }

  const checkAll = (on) => exList.querySelectorAll('input[type=checkbox]')
    .forEach((box) => { box.checked = on; });

  $('pt-ex-all').addEventListener('click', () => checkAll(true));
  $('pt-ex-none').addEventListener('click', () => checkAll(false));

  // Which projects the export tab has ticked. Shared by "Export…" and
  // "Send to server" so the two never disagree about what is being sent.
  const selectedSlugs = () => [...exList.querySelectorAll('input[type=checkbox]')]
    .filter((box) => box.checked).map((box) => box.dataset.slug);

  $('pt-export-btn').addEventListener('click', async () => {
    const slugs = selectedSlugs();
    const out = $('pt-ex-result');
    if (!slugs.length) {
      out.className = 'pt-result bad';
      out.textContent = window.t('portable.err.nothingPicked');
      return;
    }

    const btn = $('pt-export-btn');
    btn.disabled = true;
    const res = await window.api.exportPortable(slugs);
    btn.disabled = false;
    if (res && res.canceled) return;

    out.classList.remove('hidden');
    if (res && res.ok) {
      out.className = 'pt-result';
      out.textContent = window.t('portable.exDone', {
        file: res.path, size: fmtBytes(res.bytes),
        projects: res.projects, memory: res.memoryFiles,
      });
    } else {
      out.className = 'pt-result bad';
      out.textContent = window.t('portable.err.export', { error: (res && res.error) || '' });
    }
  });

  // ---- import ----

  // One row per file, so "changed" is never a number you have to trust blindly.
  function renderPlan(plan) {
    imList.textContent = '';

    // Anything the import can't take goes to the top: a row that scrolls out of
    // sight reads as a row that isn't there.
    const problem = (p) => Boolean(p.skipped || (p.claudeMd && p.claudeMd.status === 'no-project'));
    const ordered = [...plan.projects].sort((a, b) => (problem(b) ? 1 : 0) - (problem(a) ? 1 : 0));

    for (const project of ordered) {
      const head = el('li', 'pt-item');
      head.append(el('span', 'pt-name', project.name));
      if (project.skipped) {
        head.append(el('span', 'pt-badge blocked',
          window.t('portable.st.unplaceableN', { n: project.fileCount || 0 })));
      } else {
        const counts = { new: 0, changed: 0, same: 0 };
        for (const file of project.memory) counts[file.status]++;
        if (project.claudeMd && counts[project.claudeMd.status] !== undefined) {
          counts[project.claudeMd.status]++;
        }
        for (const kind of ['new', 'changed', 'same']) {
          if (counts[kind]) head.append(el('span', `pt-badge ${kind}`, window.t(`portable.st.${kind}`, { n: counts[kind] })));
        }
        // The slug moved because this machine's home differs — worth showing.
        if (project.slugChanged) head.append(el('span', 'pt-path', project.slug));
        if (project.claudeMd && project.claudeMd.status === 'no-project') {
          head.append(el('span', 'pt-badge blocked', window.t('portable.st.noProject')));
        }
      }
      imList.append(head);
    }

    const source = plan.source || {};
    $('pt-im-source').textContent = window.t('portable.imSummary', {
      host: source.hostname || '?',
      date: (plan.createdAt || '').slice(0, 16).replace('T', ' '),
      new: plan.totals.new,
      changed: plan.totals.changed,
      same: plan.totals.same,
    });

    // Files the import will drop on the floor. new/changed/same don't account
    // for them, so the summary above would otherwise read as full coverage.
    const dropped = $('pt-im-dropped');
    const lost = [];
    if (plan.totals.unplaceableFiles) {
      lost.push(window.t('portable.imDropped', {
        files: plan.totals.unplaceableFiles, projects: plan.totals.unplaceable,
      }));
    }
    if (plan.totals.noProject) {
      lost.push(window.t('portable.imNoProject', { n: plan.totals.noProject }));
    }
    dropped.textContent = lost.join(' ');
    dropped.classList.toggle('hidden', lost.length === 0);

    // Path rewriting is the one silent transformation here, so it gets a banner.
    const rewrite = $('pt-im-rewrite');
    rewrite.classList.toggle('hidden', !plan.rewriting);
    if (plan.rewriting) {
      rewrite.textContent = window.t('portable.imRewrite', {
        from: source.home || '?', to: plan.localHome, n: plan.totals.pathRewrites,
      });
    }

    $('pt-im-pick').classList.add('hidden');
    $('pt-im-plan').classList.remove('hidden');
    $('pt-im-result').classList.add('hidden');
  }

  // Both sources — a file the user picked and a bundle pulled off the server —
  // land here with the same {ok, plan} shape, so there is exactly one path to
  // the review screen and no way for a remote bundle to skip it.
  function showBundleResult(res, errKey) {
    if (!res || res.canceled) return;
    if (!res.ok) {
      // An unreadable bundle leaves nothing to diff: back to the empty state,
      // with the reason under it.
      currentPlan = null;
      $('pt-im-plan').classList.add('hidden');
      $('pt-im-pick').classList.remove('hidden');
      const err = $('pt-im-error');
      err.classList.remove('hidden');
      err.textContent = res.code
        ? syncError(errKey, res)
        : window.t(errKey, { error: res.error || '' });
      setMode('import');
      return;
    }
    $('pt-im-error').classList.add('hidden');
    currentPlan = res.plan;
    renderPlan(res.plan);
    setMode('import');
  }

  async function openBundle() {
    showBundleResult(await window.api.openBundle(), 'portable.err.open');
  }

  $('pt-im-open').addEventListener('click', openBundle);
  $('pt-im-other').addEventListener('click', openBundle);

  // ---- the same bundle, over the network ----

  // Prefer a message written for this exact failure, fall back to the generic
  // one. Without this a coded error like secret-lost reads as raw ssh2 text.
  function syncError(base, res) {
    const code = res && res.code;
    const specific = code && `${base}.${code}`;
    if (specific && window.t(specific) !== specific) return window.t(specific);
    return window.t(base, { error: (res && (res.detail || res.code)) || '' });
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    return d.toLocaleString(window.ui.locale);
  }

  async function loadPeers() {
    const ready = await window.api.syncReady();
    const wrap = $('pt-peers');
    // Nothing configured is the common case for everyone who is not syncing.
    // Say nothing rather than advertise a feature that would only error.
    if (!ready || !ready.ok) { wrap.classList.add('hidden'); return; }

    syncReady = true;
    if (mode === 'export') $('pt-push-btn').classList.remove('hidden');
    wrap.classList.remove('hidden');
    const list = $('pt-peers-list');
    const note = $('pt-peers-note');
    list.textContent = '';
    note.textContent = window.t('portable.peers.loading');

    const res = await window.api.syncPeers();
    if (!res || !res.ok) {
      note.textContent = syncError('portable.peers.err', res);
      return;
    }
    if (!res.peers.length) {
      note.textContent = window.t('portable.peers.none');
      return;
    }
    note.textContent = '';
    for (const p of res.peers) {
      const li = document.createElement('li');
      const meta = el('span', 'pt-peer-meta',
        window.t('portable.peers.meta', {
          projects: p.projects, memory: p.memoryFiles, when: fmtWhen(p.updatedAt),
        }));
      const btn = el('button', 'pt-link', window.t('portable.peers.fetch'));
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        note.textContent = window.t('portable.peers.fetching', { name: p.deviceName });
        showBundleResult(await window.api.pullBundle(p.deviceId), 'portable.peers.err');
        btn.disabled = false;
        note.textContent = '';
      });
      li.appendChild(el('span', 'pt-peer-name', p.deviceName || p.deviceId));
      li.appendChild(meta);
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  $('pt-push-btn').addEventListener('click', async () => {
    const btn = $('pt-push-btn');
    btn.disabled = true;
    const out = $('pt-ex-result');
    out.classList.remove('hidden');
    out.className = 'pt-result';
    out.textContent = window.t('portable.push.sending');
    const res = await window.api.pushBundle(selectedSlugs());
    btn.disabled = false;
    if (!res || !res.ok) {
      out.className = 'pt-result bad';
      out.textContent = syncError('portable.push.err', res);
      return;
    }
    out.className = 'pt-result';
    out.textContent = window.t('portable.push.ok', {
      projects: res.projects, memory: res.memoryFiles, size: fmtBytes(res.bytes),
    });
  });

  $('pt-import-btn').addEventListener('click', async () => {
    const btn = $('pt-import-btn');
    btn.disabled = true;
    const res = await window.api.applyBundle({
      memory: $('pt-opt-memory').checked,
      claudeMd: $('pt-opt-claudemd').checked,
      models: $('pt-opt-models').checked,
      prefs: $('pt-opt-prefs').checked,
      overwrite: $('pt-opt-overwrite').checked,
    });
    btn.disabled = false;

    const out = $('pt-im-result');
    out.classList.remove('hidden');
    if (!res || !res.ok) {
      out.className = 'pt-result bad';
      out.textContent = window.t('portable.err.import', { error: (res && res.error) || '' });
      return;
    }

    out.className = 'pt-result';
    const conflicts = res.skipped.filter((s) => s.why === 'conflict' || s.why === 'conflict-model').length;
    let text = window.t('portable.imDone', {
      written: res.written.length,
      models: res.modelsWritten,
      backup: res.backup,
    });
    if (conflicts) text += ' ' + window.t('portable.imConflicts', { n: conflicts });
    // Everything else that got skipped — unplaceable projects, CLAUDE.md with
    // nowhere to go, names that failed the safety check.
    const dropped = res.skipped.length - conflicts;
    if (dropped) text += ' ' + window.t('portable.imSkipped', { n: dropped });
    if (res.failed.length) text += ' ' + window.t('portable.imFailed', { n: res.failed.length });
    out.textContent = text;

    // The plan is stale the moment it's applied — re-derive it so a second pass
    // (say, with overwrite on) shows what's actually left. renderPlan() hides
    // the result line, so restore it afterwards.
    const again = await window.api.replanBundle();
    if (again && again.ok) {
      currentPlan = again.plan;
      renderPlan(again.plan);
      out.classList.remove('hidden');
    }
  });

  // ---- boot ----

  async function load() {
    const res = await window.api.scanPortable();
    if (res && res.ok) {
      scan = res.scan;
      renderExport();
    } else {
      $('pt-ex-summary').textContent = window.t('portable.err.scan', { error: (res && res.error) || '' });
    }
  }

  // Re-stamp anything with strings baked into JS when the language changes.
  window.ui.onChange((kind) => {
    if (kind !== 'language') return;
    renderExport();
    if (currentPlan) renderPlan(currentPlan);
    loadPeers();
  });

  setMode('export');
  load();
  loadPeers();
})();
