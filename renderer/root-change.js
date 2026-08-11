(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TabDeskRootChange = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function message(result, t) {
    if (!result || result.ok || result.canceled || result.error === 'canceled') return null;
    const key = {
      'leave-timeout': 'projects.root.error.leaveTimeout',
      'root-change-in-progress': 'projects.root.error.busy',
      'invalid-root': 'projects.root.error.invalid',
      'persist-failed': 'projects.root.error.persist',
      'rollback-failed': 'projects.root.error.persist',
      'root-commit-failed': 'projects.root.error.persist',
      'commit-timeout': 'projects.root.error.reload',
      'commit-rejected': 'projects.root.error.reload',
      'reload-start-timeout': 'projects.root.error.reload',
      'reload-failed': 'projects.root.error.reload',
      'navigation-changed': 'projects.root.error.reload',
      'renderer-unavailable': 'projects.root.error.reload',
    }[result.error] || 'projects.root.error.generic';
    return t(key);
  }

  function bindPicker({ button, error, choose, t }) {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      error.textContent = '';
      error.classList.toggle('hidden', true);
      let result;
      try {
        result = await choose();
      } catch (_) {
        result = { ok: false, error: 'unknown' };
      } finally {
        button.disabled = false;
      }
      const text = message(result, t);
      error.textContent = text || '';
      error.classList.toggle('hidden', !text);
    });
  }

  return { bindPicker, message };
});
