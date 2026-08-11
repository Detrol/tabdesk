function createSessionRegistry({ read, write, upsert }) {
  if (typeof read !== 'function' || typeof write !== 'function' || typeof upsert !== 'function') {
    throw new TypeError('session registry dependencies are required');
  }

  function records() {
    const value = read();
    return Array.isArray(value)
      ? value.filter((record) => record && typeof record.session === 'string')
      : [];
  }

  function commit(previous, next) {
    try {
      if (write(next) === true) return true;
    } catch (_) {
      // The writer may already have replaced its in-memory cache.
    }
    try { write(previous); } catch (_) { /* rollback still attempted */ }
    return false;
  }

  function remember(record) {
    const previous = read();
    const next = upsert(records(), record);
    return Boolean(next) && commit(previous, next);
  }

  function forget(session) {
    if (typeof session !== 'string' || !session) return false;
    const previous = read();
    const current = records();
    const next = current.filter((record) => record.session !== session);
    if (next.length === current.length) return true;
    return commit(previous, next);
  }

  return { records, remember, forget };
}

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
    if (remember(verified) !== true) return null;
    return verified;
  }

  async function restore(records, { persistedSessions = new Set() } = {}) {
    const candidates = (Array.isArray(records) ? records : [])
      .map((record, index) => ({
        record,
        index,
        storedOwner: Object.prototype.hasOwnProperty.call(record, 'projectPath'),
      }));
    const restoredByIndex = new Map();
    const verifiedOwners = () => [...restoredByIndex.values()]
      .map(({ projectPath }) => projectPath);
    const processingOrder = [
      ...candidates.filter(({ storedOwner }) => storedOwner),
      ...candidates.filter(({ storedOwner }) => !storedOwner),
    ];

    for (const { record, index, storedOwner } of processingOrder) {
      let admitted;
      try {
        admitted = storedOwner
          ? await projectFiles.restoreSelection(record.projectPath, record.cwd)
          : await projectFiles.admitSelection(record.cwd, 'restored');
      } catch (_) {
        admitted = null;
      }
      if (!admitted?.ok) {
        projectFiles.replaceAdmissions('restored', verifiedOwners());
        continue;
      }
      const verified = { ...record, projectPath: admitted.projectPath };
      if (!storedOwner && persistedSessions.has(record.session)
        && remember(verified) !== true) {
        projectFiles.replaceAdmissions('restored', verifiedOwners());
        continue;
      }
      restoredByIndex.set(index, verified);
    }
    const restored = [...restoredByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, record]) => record);
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
      }
    }
    return { records: restorable, persisted: candidates, claimed };
  }

  function reconcileLive(prepared, liveSessions) {
    const live = liveSessions instanceof Set ? liveSessions : new Set();
    for (const record of prepared?.persisted || []) {
      if (!live.has(record.session)) forget(record.session);
    }
    return (prepared?.records || []).filter((record) => live.has(record.session));
  }

  return { rememberCurrent, prepareRestore, reconcileLive, restore };
}

module.exports = { createSessionOwnership, createSessionRegistry };
