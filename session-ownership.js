function createSessionOwnership({ projectFiles, remember, forget }) {
  if (!projectFiles || typeof projectFiles.resolveOwner !== 'function'
    || typeof projectFiles.restoreSelection !== 'function'
    || typeof remember !== 'function' || typeof forget !== 'function') {
    throw new TypeError('session ownership dependencies are required');
  }

  async function rememberCurrent(record) {
    let owner;
    try {
      owner = await projectFiles.resolveOwner(record?.cwd);
    } catch (_) {
      owner = null;
    }
    if (!owner?.ok) {
      if (typeof record?.session === 'string' && record.session) forget(record.session);
      return null;
    }
    const verified = { ...record, projectPath: owner.projectPath };
    remember(verified);
    return verified;
  }

  async function restore(records, { persistedSessions = new Set() } = {}) {
    const restored = [];
    for (const record of Array.isArray(records) ? records : []) {
      let admitted;
      try {
        admitted = Object.prototype.hasOwnProperty.call(record, 'projectPath')
          ? await projectFiles.restoreSelection(record.projectPath, record.cwd)
          : await projectFiles.admitSelection(record.cwd, 'restored');
      } catch (_) {
        admitted = null;
      }
      if (!admitted?.ok) {
        if (persistedSessions.has(record.session)) forget(record.session);
        continue;
      }
      const verified = { ...record, projectPath: admitted.projectPath };
      restored.push(verified);
      if (persistedSessions.has(record.session)) remember(verified);
    }
    projectFiles.replaceAdmissions('restored', restored.map(({ projectPath }) => projectPath));
    return restored;
  }

  function prepareRestore(records, exists) {
    const candidates = Array.isArray(records) ? records : [];
    const claimed = new Set(candidates
      .map((record) => record?.session)
      .filter((session) => typeof session === 'string' && session));
    const restorable = [];
    for (const record of candidates) {
      if (typeof record?.cwd === 'string' && record.cwd && exists(record.cwd)) {
        restorable.push(record);
      } else if (typeof record?.session === 'string' && record.session) {
        forget(record.session);
      }
    }
    return { records: restorable, claimed };
  }

  return { rememberCurrent, prepareRestore, restore };
}

module.exports = { createSessionOwnership };
