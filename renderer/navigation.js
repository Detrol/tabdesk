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
      create,
      activate,
      rollback,
    }) {
      let allocation = null;
      let released = false;
      let created;
      let hasCreated = false;
      let rolledBack = false;
      const releaseOnce = () => {
        if (released || !allocation || !allocation.session) return;
        released = true;
        try { release(allocation); } catch (_) { /* reservation cleanup is best effort */ }
      };
      const rollbackOnce = () => {
        if (rolledBack || !hasCreated) return;
        rolledBack = true;
        try { rollback(created); } catch (_) { /* release still has to run */ }
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
        created = create(allocation, details);
        hasCreated = true;
        const result = activate(created);
        if (!result) {
          rollbackOnce();
          releaseOnce();
        }
        return result || null;
      } catch (_) {
        rollbackOnce();
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

  function isTerminalWatched({ id, pinned, activeId, hasTab, maximum }) {
    return shownTerminalIds({ pinned, activeId, hasTab, maximum }).includes(id);
  }

  return { createNavigation, shownTerminalIds, isTerminalWatched };
});
