function classifyTmuxSessionList(error, stdout, stderr) {
  const output = typeof stdout === 'string' ? stdout : String(stdout || '');
  const diagnostic = typeof stderr === 'string' ? stderr : String(stderr || '');
  if (error) {
    const stableAbsence = !output.trim()
      && Number(error.code) === 1
      && !error.signal
      && /^no server running on [^\r\n]+\r?\n?$/.test(diagnostic);
    return stableAbsence ? { known: true, rows: [] } : { known: false, rows: [] };
  }

  const rows = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const gap = line.indexOf(' ');
    if (gap < 1) return { known: false, rows: [] };
    const session = line.slice(0, gap);
    const cwd = line.slice(gap + 1).trim();
    if (!cwd || /\s/.test(session)) return { known: false, rows: [] };
    rows.push({ session, cwd });
  }
  return { known: true, rows };
}

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

  function replace(next) {
    if (!Array.isArray(next)) return false;
    return commit(read(), next);
  }

  function forget(session) {
    if (typeof session !== 'string' || !session) return false;
    const previous = read();
    const current = records();
    const next = current.filter((record) => record.session !== session);
    if (next.length === current.length) return true;
    return commit(previous, next);
  }

  return { records, remember, replace, forget };
}

function createSessionOwnership({ projectFiles, remember, forget }) {
  if (!projectFiles || typeof projectFiles.resolveOwner !== 'function'
    || typeof projectFiles.verifySelectionOwner !== 'function'
    || typeof projectFiles.restoreSelection !== 'function'
    || typeof remember !== 'function' || typeof forget !== 'function') {
    throw new TypeError('session ownership dependencies are required');
  }

  async function rememberCurrent(record, isCurrent) {
    let owner;
    try {
      owner = await projectFiles.resolveOwner(record?.cwd);
    } catch (_) {
      owner = null;
    }
    if (!owner?.ok) return null;
    if (typeof isCurrent === 'function') {
      try {
        if (!isCurrent()) return null;
      } catch (_) {
        return null;
      }
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
    const storedCandidates = candidates.filter(({ storedOwner }) => storedOwner);
    const legacyCandidates = candidates.filter(({ storedOwner }) => !storedOwner);

    for (const { record, index } of storedCandidates) {
      let admitted;
      try {
        admitted = await projectFiles.restoreSelection(record.projectPath, record.cwd);
      } catch (_) {
        admitted = null;
      }
      if (!admitted?.ok) {
        projectFiles.replaceAdmissions('restored', verifiedOwners());
        continue;
      }
      const verified = { ...record, projectPath: admitted.projectPath };
      restoredByIndex.set(index, verified);
    }

    const legacyPaths = [...new Set(legacyCandidates
      .map(({ record }) => record.cwd)
      .filter((cwd) => typeof cwd === 'string' && cwd))]
      .sort((left, right) => left.localeCompare(right));
    const discoveredOwners = new Map();
    const relationshipVerificationFailures = new Set();
    for (const parentPath of legacyPaths) {
      for (const childPath of legacyPaths) {
        if (parentPath === childPath) continue;
        let relationship;
        try {
          relationship = await projectFiles.verifySelectionOwner(parentPath, childPath);
        } catch (_) {
          relationship = null;
        }
        if (relationship?.verificationFailed) {
          relationshipVerificationFailures.add(childPath);
        }
        if (!relationship?.ok) continue;
        if (!discoveredOwners.has(parentPath)) {
          discoveredOwners.set(parentPath, relationship.projectPath);
        }
        if (!discoveredOwners.has(childPath)) {
          discoveredOwners.set(childPath, relationship.projectPath);
        }
      }
    }

    async function deriveLegacyOwner(cwd) {
      let current;
      try {
        current = await projectFiles.resolveOwner(cwd);
      } catch (_) {
        current = null;
      }
      if (current?.ok) return current;
      if (current?.verificationFailed || relationshipVerificationFailures.has(cwd)) return null;

      const candidate = discoveredOwners.get(cwd) || cwd;
      try {
        const verified = await projectFiles.verifySelectionOwner(candidate, cwd);
        return verified?.ok ? verified : null;
      } catch (_) {
        return null;
      }
    }

    for (const { record, index } of legacyCandidates) {
      const owner = await deriveLegacyOwner(record.cwd);
      if (!owner?.ok) {
        projectFiles.replaceAdmissions('restored', verifiedOwners());
        continue;
      }
      const verified = { ...record, projectPath: owner.projectPath };
      if (persistedSessions.has(record.session) && remember(verified) !== true) {
        projectFiles.replaceAdmissions('restored', verifiedOwners());
        continue;
      }
      let admitted;
      try {
        admitted = await projectFiles.restoreSelection(verified.projectPath, record.cwd);
      } catch (_) {
        admitted = null;
      }
      if (!admitted?.ok) {
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

module.exports = { classifyTmuxSessionList, createSessionOwnership, createSessionRegistry };
