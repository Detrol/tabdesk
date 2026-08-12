const SESSION_RECORD_LIMIT = 64;
const TMUX_ROW_LIMIT = 256;
const LEGACY_RELATIONSHIP_LIMIT = 256;
const RESTORE_TIMEOUT_MS = 10_000;
const TMUX_LIST_TIMEOUT_MS = 5_000;
const TMUX_LIST_MAX_BUFFER = 1024 * 1024;

function classifyTmuxSessionList(error, stdout, stderr) {
  const output = typeof stdout === 'string' ? stdout : String(stdout || '');
  const diagnostic = typeof stderr === 'string' ? stderr : String(stderr || '');
  if (error) {
    const stableAbsence = !output.trim()
      && Number(error.code) === 1
      && !error.signal
      && (/^no server running on [^\r\n]+\r?\n?$/.test(diagnostic)
        || /^error connecting to [^\r\n]+ \(No such file or directory\)\r?\n?$/.test(diagnostic));
    return stableAbsence ? { known: true, rows: [] } : { known: false, rows: [] };
  }

  const rows = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (rows.length >= TMUX_ROW_LIMIT) return { known: false, rows: [] };
    const gap = line.indexOf(' ');
    if (gap < 1) return { known: false, rows: [] };
    const session = line.slice(0, gap);
    const cwd = line.slice(gap + 1).trim();
    if (!cwd || /\s/.test(session)) return { known: false, rows: [] };
    rows.push({ session, cwd });
  }
  return { known: true, rows };
}

function createTmuxSessionLister({
  execFile,
  env = process.env,
  timeoutMs = TMUX_LIST_TIMEOUT_MS,
  maxBuffer = TMUX_LIST_MAX_BUFFER,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof execFile !== 'function') throw new TypeError('execFile is required');

  return function listTmuxSessions(operation) {
    const remaining = Number.isFinite(operation?.deadline)
      ? operation.deadline - now()
      : timeoutMs;
    if (remaining <= 0) return Promise.resolve({ known: false, rows: [] });
    const timeout = Math.max(1, Math.min(timeoutMs, remaining));

    return new Promise((resolve) => {
      let child;
      let timer;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) cancel(timer);
        resolve(result);
      };
      const callback = (error, stdout, stderr) => {
        finish(classifyTmuxSessionList(error, stdout, stderr));
      };
      try {
        child = execFile('tmux', ['ls', '-F', '#S #{session_path}'], {
          env: { ...env, LC_ALL: 'C' },
          maxBuffer,
          killSignal: 'SIGKILL',
        }, callback);
      } catch (_) {
        finish({ known: false, rows: [] });
        return;
      }
      if (settled) return;
      timer = schedule(() => {
        try { child?.kill('SIGKILL'); } catch (_) { /* already gone */ }
        finish({ known: false, rows: [] });
      }, timeout);
    });
  };
}

function createSessionRegistry({ read, write, upsert, maxRecords = SESSION_RECORD_LIMIT }) {
  if (typeof read !== 'function' || typeof write !== 'function' || typeof upsert !== 'function') {
    throw new TypeError('session registry dependencies are required');
  }

  function snapshot() {
    const value = read();
    if (!Array.isArray(value)) return { known: true, records: [] };
    if (value.length > maxRecords) return { known: false, records: [] };
    return {
      known: true,
      records: value.filter((record) => record && typeof record.session === 'string'),
    };
  }

  function records() {
    return snapshot().records;
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
    const current = snapshot();
    if (!current.known) return false;
    const previous = read();
    const next = upsert(current.records, record);
    if (!Array.isArray(next) || next.length > maxRecords) return false;
    return Boolean(next) && commit(previous, next);
  }

  function replace(next) {
    if (!snapshot().known || !Array.isArray(next) || next.length > maxRecords) return false;
    return commit(read(), next);
  }

  function forget(session) {
    if (typeof session !== 'string' || !session) return false;
    const bounded = snapshot();
    if (!bounded.known) return false;
    const previous = read();
    const current = bounded.records;
    const next = current.filter((record) => record.session !== session);
    if (next.length === current.length) return true;
    return commit(previous, next);
  }

  return { snapshot, records, remember, replace, forget };
}

function createSessionOwnership({
  projectFiles,
  remember,
  forget,
  now = Date.now,
  restoreTimeoutMs = RESTORE_TIMEOUT_MS,
  maxLegacyRelationshipProbes = LEGACY_RELATIONSHIP_LIMIT,
}) {
  if (!projectFiles || typeof projectFiles.resolveOwner !== 'function'
    || typeof projectFiles.verifySelectionOwner !== 'function'
    || typeof projectFiles.restoreSelection !== 'function'
    || typeof remember !== 'function' || typeof forget !== 'function') {
    throw new TypeError('session ownership dependencies are required');
  }

  async function rememberCurrent(record, isCurrent, operation) {
    operation ||= { deadline: now() + restoreTimeoutMs };
    let owner;
    try {
      owner = await projectFiles.resolveOwner(record?.cwd, operation);
    } catch (_) {
      owner = null;
    }
    if (!Number.isFinite(operation.deadline) || now() >= operation.deadline) return null;
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

  async function restore(records, { persistedSessions = new Set(), operation } = {}) {
    const input = Array.isArray(records) ? records : [];
    if (input.length > SESSION_RECORD_LIMIT) {
      projectFiles.replaceAdmissions('restored', []);
      return [];
    }
    operation ||= { deadline: now() + restoreTimeoutMs };
    const expired = () => !Number.isFinite(operation.deadline) || now() >= operation.deadline;
    const abort = () => {
      projectFiles.replaceAdmissions('restored', []);
      return [];
    };
    const candidates = input
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
      if (expired()) return abort();
      let admitted;
      try {
        admitted = await projectFiles.restoreSelection(record.projectPath, record.cwd, operation);
      } catch (_) {
        admitted = null;
      }
      if (expired()) return abort();
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
    if (legacyPaths.length * Math.max(0, legacyPaths.length - 1)
      > maxLegacyRelationshipProbes) {
      const restored = [...restoredByIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, record]) => record);
      projectFiles.replaceAdmissions('restored', restored.map(({ projectPath }) => projectPath));
      return restored;
    }
    for (const parentPath of legacyPaths) {
      for (const childPath of legacyPaths) {
        if (parentPath === childPath) continue;
        if (expired()) return abort();
        let relationship;
        try {
          relationship = await projectFiles.verifySelectionOwner(parentPath, childPath, operation);
        } catch (_) {
          relationship = null;
        }
        if (expired()) return abort();
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
      if (expired()) return null;
      let current;
      try {
        current = await projectFiles.resolveOwner(cwd, operation);
      } catch (_) {
        current = null;
      }
      if (expired()) return null;
      if (current?.ok) return current;
      if (current?.verificationFailed || relationshipVerificationFailures.has(cwd)) return null;

      const candidate = discoveredOwners.get(cwd) || cwd;
      try {
        const verified = await projectFiles.verifySelectionOwner(candidate, cwd, operation);
        if (expired()) return null;
        return verified?.ok ? verified : null;
      } catch (_) {
        return null;
      }
    }

    for (const { record, index } of legacyCandidates) {
      if (expired()) return abort();
      const owner = await deriveLegacyOwner(record.cwd);
      if (expired()) return abort();
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
        admitted = await projectFiles.restoreSelection(verified.projectPath, record.cwd, operation);
      } catch (_) {
        admitted = null;
      }
      if (expired()) return abort();
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
    if (candidates.length > SESSION_RECORD_LIMIT) {
      return { known: false, records: [], persisted: candidates, claimed: new Set() };
    }
    const claimed = new Set(candidates
      .map((record) => record?.session)
      .filter((session) => typeof session === 'string' && session));
    const restorable = [];
    for (const record of candidates) {
      if (typeof record?.cwd === 'string' && record.cwd && exists(record.cwd)) {
        restorable.push(record);
      }
    }
    return { known: true, records: restorable, persisted: candidates, claimed };
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

module.exports = {
  LEGACY_RELATIONSHIP_LIMIT,
  RESTORE_TIMEOUT_MS,
  SESSION_RECORD_LIMIT,
  TMUX_ROW_LIMIT,
  classifyTmuxSessionList,
  createSessionOwnership,
  createSessionRegistry,
  createTmuxSessionLister,
};
