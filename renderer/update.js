// Update window.
//
// One linear flow: what's running → the newest release tag → fast-forward →
// restart. Every step that can fail says so in place rather than closing the
// window, and a blocked fast-forward offers the terminal command instead of a
// dead end.

(function () {
  const $ = (id) => document.getElementById(id);

  let state = null;      // the last check's result
  let phase = 'checking';   // checking | current | available | working | done | error

  const fmtBytes = (n) => (n < 1024 * 1024
    ? `${(n / 1024).toFixed(0)} kB`
    : `${(n / (1024 * 1024)).toFixed(1)} MB`);

  function setStatus(text, kind) {
    const node = $('up-status');
    node.className = 'up-status' + (kind ? ` ${kind}` : '');
    node.textContent = text;
    node.classList.toggle('hidden', !text);
  }

  function setProgress(fraction, label) {
    $('up-progress').classList.remove('hidden');
    const fill = $('up-fill');
    // A null fraction means "working, but no number to show".
    fill.classList.toggle('busy', fraction === null);
    if (fraction !== null) fill.style.width = `${Math.round(fraction * 100)}%`;
    $('up-pct').textContent = label;
  }

  // Which buttons make sense depends only on the phase.
  function render() {
    const buttons = {
      run: phase === 'available',
      restart: phase === 'done',
      terminal: phase === 'manual',
      recheck: phase !== 'working',
    };
    for (const [id, on] of Object.entries(buttons)) {
      $(`up-${id}`).classList.toggle('hidden', !on);
    }
    $('up-recheck').disabled = phase === 'working';

    if (!state) return;
    $('up-versions').classList.toggle('hidden', phase === 'checking');
    $('up-from').textContent = state.installed || state.running;
    $('up-to').textContent = state.latest;
    $('up-size').textContent = state.size ? fmtBytes(state.size) : '';

    // A dev checkout reports package.json's version, not the .deb's. Say which
    // one the buttons here would actually replace.
    const mismatch = state.installed && state.installed !== state.running;
    $('up-running').classList.toggle('hidden', !mismatch);
    if (mismatch) {
      $('up-running').textContent = window.t('update.runningNote', {
        running: state.running, installed: state.installed,
      });
    }

    $('up-lead').textContent = phase === 'available'
      ? window.t('update.availableLead', { version: state.latest })
      : (phase === 'current' ? window.t('update.upToDate', { version: state.baseline })
        : $('up-lead').textContent);
  }

  // ---- check ----

  // refresh:true means the user asked — apt-get update runs, with its prompt.
  async function check(refresh) {
    phase = 'checking';
    $('up-lead').textContent = window.t(refresh ? 'update.refreshing' : 'update.checking');
    setStatus('');
    render();

    const res = await window.api.checkForUpdate(refresh);
    if (!res || !res.ok) {
      phase = 'error';
      $('up-lead').textContent = window.t('update.checkFailedLead');
      setStatus(window.t('update.err.check', { error: (res && res.error) || '' }), 'bad');
      render();
      return;
    }
    state = res.state;
    // The repo isn't set up on this machine at all — nothing to compare against.
    if (!state.configured) {
      phase = 'error';
      $('up-lead').textContent = window.t('update.notConfiguredLead');
      setStatus(window.t('update.notConfigured'), 'bad');
      render();
      return;
    }
    phase = state.available ? 'available' : 'current';
    render();
    if (!state.available) setStatus(window.t('update.noneStatus'), '');
    showCommits();
  }

  // The release's commit list is the changelog; show it where dpkg's output
  // used to go.
  function showCommits() {
    const list = (state && state.commits) || [];
    $('up-output').textContent = list.join('\n');
    $('up-output').classList.toggle('hidden', phase !== 'available' || !list.length);
  }

  // ---- install ----
  //
  // git fetches and fast-forwards as one step, so there is no percentage to
  // report — the bar just says "working".
  window.api.onProgress((p) => {
    if (p.step !== 'install') return;
    setProgress(null, '');
    setStatus(window.t('update.installing'), 'busy');
  });

  $('up-run').addEventListener('click', async () => {
    phase = 'working';
    render();
    setProgress(null, '');
    setStatus(window.t('update.starting'), 'busy');

    const res = await window.api.runUpdate();
    $('up-progress').classList.add('hidden');

    if (res && res.ok) {
      phase = 'done';
      setStatus(window.t('update.done', { version: res.version }), '');
      $('up-lead').textContent = window.t('update.doneLead');
      render();
      return;
    }

    // Local commits or uncommitted files block the fast-forward — that's not a
    // failure of the update, it's work of yours to look at in a terminal.
    if (res && res.reason === 'local-changes') {
      phase = 'manual';
      setStatus(window.t('update.err.localChanges'), 'bad');
      render();
      return;
    }

    phase = 'error';
    setStatus(window.t('update.err.install', { error: (res && res.error) || '' }), 'bad');
    if (res && res.output) {
      $('up-output').textContent = res.output;
      $('up-output').classList.remove('hidden');
    }
    render();
  });

  $('up-terminal').addEventListener('click', async () => {
    await window.api.openInTerminal();
    window.api.close();
  });

  $('up-restart').addEventListener('click', () => window.api.restartApp());
  $('up-recheck').addEventListener('click', () => check(true));
  $('up-close').addEventListener('click', () => window.api.close());
  document.addEventListener('keydown', (e) => {
    // Escape shouldn't abandon a running install mid-way.
    if (e.key === 'Escape' && phase !== 'working') window.api.close();
  });

  window.ui.onChange((kind) => { if (kind === 'language') render(); });

  // Use whatever the periodic background check already found, so opening the
  // window is instant; only go to the network if there's nothing yet.
  window.api.getUpdateState().then((cached) => {
    if (cached && cached.ok && cached.state && cached.state.configured) {
      state = cached.state;
      phase = state.available ? 'available' : 'current';
      render();
      if (!state.available) setStatus(window.t('update.noneStatus'), '');
      showCommits();
    } else {
      check(false);
    }
  });
})();
