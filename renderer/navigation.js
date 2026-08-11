(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TabDeskNavigation = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function createNavigation() {
    let generation = 0;

    function next() {
      generation += 1;
      return generation;
    }

    function isCurrent(token) {
      return token === generation;
    }

    async function runSession(token, {
      allocate,
      load,
      release,
      commit,
    }) {
      let allocation = null;
      let released = false;
      const releaseOnce = () => {
        if (released || !allocation || !allocation.session) return;
        released = true;
        try { release(allocation); } catch (_) { /* reservation cleanup is best effort */ }
      };

      try {
        allocation = await allocate();
        if (!isCurrent(token)) {
          releaseOnce();
          return null;
        }
        const details = await load();
        if (!isCurrent(token)) {
          releaseOnce();
          return null;
        }
        const result = commit(allocation, details);
        if (!result) releaseOnce();
        return result || null;
      } catch (_) {
        releaseOnce();
        return null;
      }
    }

    return { next, isCurrent, runSession };
  }

  function shownTerminalIds({ pinned, activeId, hasTab, maximum }) {
    const limit = Number.isInteger(maximum) && maximum > 0 ? maximum : 0;
    const available = typeof hasTab === 'function' ? hasTab : () => false;
    const pinnedIds = [...pinned].filter((id) => available(id));
    if (activeId && available(activeId) && !pinnedIds.includes(activeId)) {
      if (!limit) return [];
      return [...pinnedIds.slice(0, limit - 1), activeId];
    }
    return pinnedIds.slice(0, limit);
  }

  return { createNavigation, shownTerminalIds };
});
