import { createEditor } from './editor.js';
import FileState from '../file-state.js';

const NOOP = () => {};
const SAFE_ERRORS = new Set([
  'project-unavailable', 'root-unavailable', 'invalid-path', 'outside-root',
  'git-metadata-denied', 'not-file', 'not-text', 'too-large',
  'permission-denied', 'unreadable', 'deleted', 'conflict', 'write-failed',
  'watch-failed',
]);
const SAFE_UNAVAILABLE = new Set(['outside-root', 'unreadable', 'not-file']);

function node(tag, className, attributes = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function parentPath(path) {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function translated(t, key) {
  const value = t(key);
  return typeof value === 'string' ? value : key;
}

export function createFileView({
  api,
  t = (key) => key,
  confirmDiscard = () => false,
  confirmReload = () => false,
  copyText = NOOP,
  toast = NOOP,
  theme,
} = {}) {
  if (!api) throw new TypeError('createFileView requires an api');
  const element = node('section', 'panel files-panel', { 'aria-label': '' });
  const toolbar = node('header', 'files-toolbar');
  const rootControl = node('label');
  const rootLabel = node('span', 'files-root-label');
  const rootSelect = node('select', 'files-root');
  const ignoredButton = node('button', 'files-ignored', {
    type: 'button',
    'aria-pressed': 'false',
  });
  rootControl.append(rootLabel, rootSelect);
  toolbar.append(rootControl, ignoredButton);

  const body = node('div', 'files-body');
  const tree = node('nav', 'files-tree', { role: 'tree' });
  const documentPanel = node('section', 'files-document');
  const documentHead = node('header', 'files-document-head');
  const pathLabel = node('span', 'files-path');
  const statusLabel = node('span', 'files-status', { role: 'status' });
  const saveButton = node('button', 'files-save', { type: 'button' });
  documentHead.append(pathLabel, statusLabel, saveButton);
  const conflictPanel = node('div', 'files-conflict hidden', { role: 'alert' });
  const editorHost = node('div', 'files-editor');
  documentPanel.append(documentHead, conflictPanel, editorHost);
  body.append(tree, documentPanel);
  element.append(toolbar, body);

  const projectMemory = new Map();
  const readGate = FileState.createRequestGate();
  let documentState = FileState.initial();
  let activeProjectPath = null;
  let activeMemory = null;
  let activationRequest = 0;
  let rootSwitchRequest = 0;
  let documentOperationRequest = 0;
  let pendingDocumentOperation = null;
  let treeRequest = 0;
  let destroyed = false;
  let watchQueue = Promise.resolve();
  let viewMessageKey = null;
  let loadedDirectories = new Map();
  let unsubscribe = NOOP;

  function selectedRootId() {
    return activeMemory && activeMemory.selectedRootId;
  }

  function currentIdentity(path = documentState.path) {
    return {
      projectPath: activeProjectPath,
      projectId: activeMemory && activeMemory.projectId,
      rootId: selectedRootId(),
      path,
    };
  }

  function identityMatches(identity, token) {
    const current = currentIdentity(identity.path);
    return !destroyed && readGate.isCurrent(token)
      && identity.projectPath === current.projectPath
      && identity.projectId === current.projectId
      && identity.rootId === current.rootId
      && identity.path === documentState.path;
  }

  function operationCurrent(operation) {
    return !destroyed && pendingDocumentOperation === operation
      && operation.request === documentOperationRequest && activeMemory
      && operation.projectPath === activeProjectPath
      && operation.projectId === activeMemory.projectId
      && operation.rootId === selectedRootId()
      && operation.path === documentState.path;
  }

  function beginDocumentOperation(kind) {
    if (pendingDocumentOperation || !activeMemory || !documentState.path) return null;
    const operation = {
      ...currentIdentity(),
      request: ++documentOperationRequest,
      kind,
      content: documentState.content,
      revision: documentState.revision,
      status: documentState.status,
    };
    pendingDocumentOperation = operation;
    repaintDocument();
    return operation;
  }

  function finishDocumentOperation(operation) {
    if (pendingDocumentOperation !== operation) return;
    pendingDocumentOperation = null;
    repaintDocument();
  }

  function invalidateDocumentOperation() {
    documentOperationRequest += 1;
    pendingDocumentOperation = null;
  }

  function errorKey(code) {
    const safeCode = SAFE_ERRORS.has(code) ? code : 'unreadable';
    return `files.error.${safeCode}`;
  }

  function unavailableText(code) {
    const safeCode = SAFE_UNAVAILABLE.has(code) ? code : 'unreadable';
    return translated(t, `files.unavailable.${safeCode}`);
  }

  function setViewMessage(code) {
    viewMessageKey = errorKey(code);
    repaintDocument();
  }

  function dispatch(event) {
    documentState = FileState.reduce(documentState, event);
    repaintDocument();
  }

  function clearDocument() {
    invalidateDocumentOperation();
    readGate.invalidate();
    documentState = FileState.initial();
    viewMessageKey = null;
    editor.setDocument('', { anchor: 0, head: 0 });
    editor.setReadOnly(true);
    editor.setLanguage('');
    repaintDocument();
  }

  function canLeave() {
    if (!FileState.needsDiscard(documentState)) return true;
    if (!confirmDiscard(documentState.path)) return false;
    invalidateDocumentOperation();
    dispatch({ type: 'discard' });
    editor.setDocument('', { anchor: 0, head: 0 });
    editor.setReadOnly(true);
    readGate.invalidate();
    return true;
  }

  async function save() {
    if (destroyed || documentState.status !== 'dirty' || !activeMemory) return;
    const operation = beginDocumentOperation('save');
    if (!operation) return;
    let result;
    try {
      result = await api.writeProjectFile({
        projectId: operation.projectId,
        rootId: operation.rootId,
        path: operation.path,
        content: operation.content,
        expectedRevision: operation.revision,
        overwrite: false,
      });
    } catch { result = null; }
    if (!operationCurrent(operation)) return;
    if (result && result.ok) {
      await reconcileWrite(operation, result);
    } else if (result && result.error === 'conflict') {
      dispatch({ type: 'disk-changed', exists: true });
      finishDocumentOperation(operation);
    } else if (result && result.error === 'deleted') {
      dispatch({ type: 'disk-changed', exists: false });
      finishDocumentOperation(operation);
    } else {
      setViewMessage(result && result.error);
      finishDocumentOperation(operation);
    }
  }

  const editor = createEditor({
    parent: editorHost,
    theme,
    label: translated(t, 'files.panel'),
    onChange(content) {
      dispatch({ type: 'edit', content });
    },
    onSave: save,
  });

  function appendAction(container, key, action, disabled = false) {
    const button = node('button', '', { type: 'button' });
    button.textContent = translated(t, key);
    button.disabled = disabled;
    button.addEventListener('click', action);
    container.append(button);
  }

  function copyLocalChanges() {
    const content = documentState.content;
    try {
      Promise.resolve(copyText(content))
        .then(() => toast(translated(t, 'files.copied')))
        .catch(NOOP);
    } catch { /* clipboard remains best effort */ }
  }

  async function rereadForReload() {
    if (!activeMemory || !documentState.path || pendingDocumentOperation
      || !confirmReload(documentState.path)) return;
    const operation = beginDocumentOperation('reload');
    if (!operation) return;
    const token = readGate.next();
    let result;
    try {
      result = await api.readProjectFile({
        projectId: operation.projectId,
        rootId: operation.rootId,
        path: operation.path,
      });
    } catch { result = null; }
    if (!operationCurrent(operation)) return;
    if (!identityMatches(operation, token) || operation.content !== documentState.content
      || operation.status !== documentState.status) {
      finishDocumentOperation(operation);
      return;
    }
    if (!result || !result.ok) {
      if (result && result.error === 'deleted') dispatch({ type: 'disk-changed', exists: false });
      else setViewMessage(result && result.error);
      finishDocumentOperation(operation);
      return;
    }
    viewMessageKey = null;
    dispatch({
      type: 'reload-success',
      content: result.content,
      revision: result.revision,
      ignored: result.ignored,
    });
    editor.setDocument(result.content, { anchor: 0, head: 0 });
    editor.setReadOnly(false);
    editor.setLanguage(result.path);
    finishDocumentOperation(operation);
  }

  async function overwrite() {
    if (!activeMemory || pendingDocumentOperation || documentState.status !== 'conflict'
      || !documentState.exists) return;
    const operation = beginDocumentOperation('overwrite');
    if (!operation) return;
    let result;
    try {
      result = await api.writeProjectFile({
        projectId: operation.projectId,
        rootId: operation.rootId,
        path: operation.path,
        content: operation.content,
        expectedRevision: operation.revision,
        overwrite: true,
      });
    } catch { result = null; }
    if (!operationCurrent(operation)) return;
    if (result && result.ok) {
      await reconcileWrite(operation, result);
    } else if (result && result.error === 'deleted') {
      dispatch({ type: 'disk-changed', exists: false });
      finishDocumentOperation(operation);
    } else {
      setViewMessage(result && result.error);
      finishDocumentOperation(operation);
    }
  }

  async function reconcileWrite(operation, writeResult) {
    let snapshot;
    try {
      snapshot = await api.readProjectFile({
        projectId: operation.projectId,
        rootId: operation.rootId,
        path: operation.path,
      });
    } catch { snapshot = null; }
    if (!operationCurrent(operation)) return;
    if (snapshot && snapshot.ok && snapshot.revision === writeResult.revision
      && snapshot.content === operation.content) {
      viewMessageKey = null;
      dispatch({
        type: 'write-snapshot',
        content: snapshot.content,
        revision: snapshot.revision,
        ignored: snapshot.ignored,
      });
    } else if (snapshot && snapshot.ok) {
      dispatch({
        type: 'disk-snapshot',
        content: snapshot.content,
        revision: snapshot.revision,
        ignored: snapshot.ignored,
      });
    } else if (snapshot && snapshot.error === 'deleted') {
      dispatch({ type: 'disk-changed', exists: false });
    } else {
      setViewMessage(snapshot && snapshot.error);
    }
    finishDocumentOperation(operation);
  }

  function repaintDocument() {
    pathLabel.textContent = documentState.path || translated(t, 'files.noFile');
    const statusKeys = {
      unopened: 'files.noFile',
      loading: 'files.loading',
      clean: 'files.saved',
      dirty: 'files.dirty',
      conflict: 'files.conflict',
      deleted: 'files.deleted',
      error: 'files.error.unreadable',
    };
    const statusKey = documentState.ignored && !activeMemory?.showIgnored
      ? 'files.ignored'
      : statusKeys[documentState.status];
    statusLabel.textContent = translated(t, viewMessageKey || statusKey);
    saveButton.textContent = translated(t, 'files.save');
    const operationPending = Boolean(pendingDocumentOperation);
    saveButton.disabled = documentState.status !== 'dirty' || operationPending;
    conflictPanel.replaceChildren();
    conflictPanel.classList.toggle(
      'hidden',
      documentState.status !== 'conflict' && documentState.status !== 'deleted',
    );
    if (documentState.status === 'conflict') {
      const explanation = node('span', 'files-conflict-message');
      explanation.textContent = translated(
        t,
        documentState.exists ? 'files.conflict' : 'files.deleted',
      );
      conflictPanel.append(explanation);
      if (documentState.exists) {
        appendAction(conflictPanel, 'files.reload', rereadForReload, operationPending);
        appendAction(conflictPanel, 'files.overwrite', overwrite, operationPending);
      }
      appendAction(conflictPanel, 'files.copy', copyLocalChanges, operationPending);
    } else if (documentState.status === 'deleted') {
      const explanation = node('span', 'files-conflict-message');
      explanation.textContent = translated(t, 'files.deleted');
      conflictPanel.append(explanation);
      appendAction(conflictPanel, 'files.reload', rereadForReload, operationPending);
      appendAction(conflictPanel, 'files.copy', copyLocalChanges, operationPending);
    }
  }

  function rootExpandedSet() {
    if (!activeMemory || !selectedRootId()) return new Set();
    let paths = activeMemory.expandedByRoot.get(selectedRootId());
    if (!paths) {
      paths = new Set();
      activeMemory.expandedByRoot.set(selectedRootId(), paths);
    }
    return paths;
  }

  function visibleTreeItems() {
    return [...tree.querySelectorAll('[role="treeitem"]')].filter((item) => {
      let ancestor = item.parentElement;
      while (ancestor && ancestor !== tree) {
        if (ancestor.getAttribute('role') === 'group' && ancestor.classList.contains('hidden')) {
          return false;
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  function focusItem(item) {
    if (!item) return;
    for (const candidate of tree.querySelectorAll('[role="treeitem"]')) {
      candidate.tabIndex = candidate === item ? 0 : -1;
    }
    item.focus();
  }

  function setExpanded(item, expanded) {
    const group = item.querySelector(':scope > [role="group"]');
    item.setAttribute('aria-expanded', String(expanded));
    if (group) group.classList.toggle('hidden', !expanded);
    const path = item.dataset.path;
    if (expanded) rootExpandedSet().add(path);
    else rootExpandedSet().delete(path);
  }

  function addListingError(group, directory, reload) {
    group.replaceChildren();
    const message = node('span', 'files-tree-error');
    message.textContent = translated(t, 'files.error.unreadable');
    const retry = node('button', 'files-tree-retry', { type: 'button' });
    retry.textContent = translated(t, 'files.retry');
    retry.addEventListener('click', () => reload(directory));
    group.append(message, retry);
  }

  async function openFile(path, { skipGuard = false } = {}) {
    if (!activeMemory || (!skipGuard && !canLeave())) return false;
    invalidateDocumentOperation();
    const identity = currentIdentity(path);
    const token = readGate.next();
    viewMessageKey = null;
    dispatch({ type: 'open-start', request: token, path });
    editor.setDocument('', { anchor: 0, head: 0 });
    editor.setReadOnly(true);
    editor.setLanguage('');
    const result = await api.readProjectFile({
      projectId: identity.projectId,
      rootId: identity.rootId,
      path,
    });
    if (!identityMatches(identity, token)) return false;
    if (!result || !result.ok) {
      dispatch({ type: 'open-failure', request: token, error: result && result.error });
      setViewMessage(result && result.error);
      return false;
    }
    dispatch({
      type: 'open-success',
      request: token,
      path: result.path,
      content: result.content,
      revision: result.revision,
      ignored: result.ignored,
    });
    editor.setDocument(result.content, { anchor: 0, head: 0 });
    editor.setReadOnly(false);
    editor.setLanguage(result.path);
    activeMemory.lastFile = { rootId: selectedRootId(), path: result.path };
    markTreeSelection(result.path);
    return true;
  }

  function markTreeSelection(path) {
    for (const item of tree.querySelectorAll('[role="treeitem"]')) {
      if (item.hasAttribute('aria-expanded')) item.removeAttribute('aria-selected');
      else item.setAttribute('aria-selected', String(item.dataset.path === path));
    }
  }

  async function expandDirectory(item) {
    if (item.getAttribute('aria-disabled') === 'true') return;
    if (item.getAttribute('aria-expanded') === 'true') {
      setExpanded(item, false);
      return;
    }
    const group = item.querySelector(':scope > [role="group"]');
    setExpanded(item, true);
    if (group && group.dataset.loaded !== 'true') await loadDirectory(item.dataset.path, group);
  }

  function treeItem(entry, directory) {
    const item = node('div', 'files-tree-item', { role: 'treeitem' });
    item.dataset.path = entry.path;
    item.tabIndex = -1;
    item.setAttribute('aria-disabled', entry.unavailable ? 'true' : 'false');
    const label = node('span', 'files-tree-label');
    label.textContent = entry.name;
    item.append(label);
    if (entry.symlink) {
      const marker = node('span', 'files-symlink');
      marker.textContent = translated(t, 'files.symlink');
      item.append(marker);
    }
    if (entry.ignored) {
      const marker = node('span', 'files-ignored-marker');
      marker.textContent = translated(t, 'files.ignored');
      item.append(marker);
    }
    if (entry.unavailable) {
      const explanation = node('span', 'files-unavailable');
      explanation.textContent = unavailableText(entry.unavailable);
      item.append(explanation);
    }
    if (entry.kind === 'directory') {
      item.setAttribute('aria-expanded', 'false');
      const group = node('div', 'hidden', { role: 'group' });
      group.dataset.directory = entry.path;
      item.append(group);
    }
    item.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      focusItem(item);
      if (entry.unavailable) return;
      if (entry.kind === 'directory') expandDirectory(item);
      else if (entry.kind === 'file') openFile(entry.path);
    });
    item.addEventListener('keydown', (event) => handleTreeKey(event, item));
    loadedDirectories.get(directory)?.items.push(item);
    return item;
  }

  async function loadDirectory(directory, group = tree) {
    if (!activeMemory) return;
    const generation = treeRequest;
    const identity = currentIdentity(directory);
    const record = { group, items: [], generation };
    loadedDirectories.set(directory, record);
    group.dataset.loaded = 'loading';
    const result = await api.listProjectFiles({
      projectId: identity.projectId,
      rootId: identity.rootId,
      directory,
      showIgnored: activeMemory.showIgnored,
    });
    if (destroyed || generation !== treeRequest || !activeMemory
      || identity.projectPath !== activeProjectPath
      || identity.projectId !== activeMemory.projectId
      || identity.rootId !== selectedRootId()
      || loadedDirectories.get(directory) !== record) return;
    if (!result || !result.ok) {
      group.dataset.loaded = 'error';
      addListingError(group, directory, reloadDirectory);
      return;
    }
    group.replaceChildren();
    for (const entry of result.entries) group.append(treeItem(entry, directory));
    group.dataset.loaded = 'true';
    if (documentState.path) markTreeSelection(documentState.path);
    if (!tree.querySelector('[role="treeitem"][tabindex="0"]')) {
      const first = visibleTreeItems()[0];
      if (first) first.tabIndex = 0;
    }
    const expanded = rootExpandedSet();
    for (const item of record.items) {
      if (item.getAttribute('aria-expanded') === 'false' && expanded.has(item.dataset.path)) {
        await expandDirectory(item);
      }
    }
  }

  async function reloadDirectory(directory) {
    const record = loadedDirectories.get(directory);
    if (!record) return;
    for (const [path] of [...loadedDirectories]) {
      if (path === directory || path.startsWith(`${directory}/`)) loadedDirectories.delete(path);
    }
    record.group.dataset.loaded = 'false';
    await loadDirectory(directory, record.group);
  }

  function handleTreeKey(event, item) {
    const items = visibleTreeItems();
    const index = items.indexOf(item);
    let target = null;
    if (event.key === 'ArrowDown') target = items[Math.min(items.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') target = items[Math.max(0, index - 1)];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items.at(-1);
    else if (event.key === 'ArrowRight' && item.hasAttribute('aria-expanded')) {
      if (item.getAttribute('aria-expanded') === 'false') expandDirectory(item);
      else target = item.querySelector(':scope > [role="group"] > [role="treeitem"]');
    } else if (event.key === 'ArrowLeft') {
      if (item.getAttribute('aria-expanded') === 'true') setExpanded(item, false);
      else target = item.parentElement?.closest('[role="treeitem"]');
    } else if (event.key === 'Enter') {
      if (item.getAttribute('aria-disabled') !== 'true') {
        if (item.hasAttribute('aria-expanded')) expandDirectory(item);
        else openFile(item.dataset.path);
      }
    } else return;
    event.preventDefault();
    if (target) focusItem(target);
  }

  async function rebuildTree() {
    treeRequest += 1;
    loadedDirectories = new Map();
    tree.replaceChildren();
    if (activeMemory && selectedRootId()) await loadDirectory('', tree);
  }

  function enqueueWatch(projectPath, projectId, rootId) {
    watchQueue = watchQueue.then(async () => {
      try { await api.unwatchProjectFiles(); } catch { /* best effort */ }
      if (destroyed || activeProjectPath !== projectPath || !activeMemory
        || activeMemory.projectId !== projectId || selectedRootId() !== rootId) return;
      let result;
      try { result = await api.watchProjectFiles({ projectId, rootId }); } catch { result = null; }
      if (destroyed || activeProjectPath !== projectPath || !activeMemory
        || activeMemory.projectId !== projectId || selectedRootId() !== rootId) return;
      if (!result || !result.ok) setViewMessage('watch-failed');
    }).catch(() => {
      if (!destroyed) setViewMessage('watch-failed');
    });
    return watchQueue;
  }

  function enqueueUnwatch() {
    watchQueue = watchQueue.then(async () => {
      try { await api.unwatchProjectFiles(); } catch { /* best effort */ }
    });
    return watchQueue;
  }

  function renderRoots() {
    rootSelect.replaceChildren();
    if (!activeMemory) {
      rootSelect.disabled = true;
      return;
    }
    for (const root of activeMemory.roots) {
      const option = node('option');
      option.value = root.id;
      option.textContent = root.label;
      rootSelect.append(option);
    }
    rootSelect.value = activeMemory.selectedRootId || '';
    rootSelect.disabled = activeMemory.roots.length === 0;
  }

  async function switchRoot(rootId) {
    if (!activeMemory || rootId === selectedRootId()) return true;
    const request = ++rootSwitchRequest;
    const memory = activeMemory;
    const projectPath = activeProjectPath;
    const projectId = memory.projectId;
    const previous = selectedRootId();
    if (!canLeave()) {
      rootSelect.value = previous || '';
      return false;
    }
    activeMemory.selectedRootId = rootId;
    clearDocument();
    renderRoots();
    const identity = currentIdentity();
    enqueueWatch(identity.projectPath, identity.projectId, identity.rootId);
    await rebuildTree();
    if (destroyed || request !== rootSwitchRequest || activeMemory !== memory
      || activeProjectPath !== projectPath || memory.projectId !== projectId
      || selectedRootId() !== rootId) return false;
    if (memory.lastFile && memory.lastFile.rootId === rootId) {
      await openFile(memory.lastFile.path, { skipGuard: true });
    }
    return true;
  }

  rootSelect.addEventListener('change', () => switchRoot(rootSelect.value));
  ignoredButton.addEventListener('click', async () => {
    if (!activeMemory) return;
    activeMemory.showIgnored = !activeMemory.showIgnored;
    ignoredButton.setAttribute('aria-pressed', String(activeMemory.showIgnored));
    await rebuildTree();
    repaintDocument();
  });
  saveButton.addEventListener('click', save);

  async function activate(projectPath) {
    if (destroyed) return false;
    if (activeProjectPath === projectPath && activeMemory) return true;
    if (activeProjectPath !== null && activeProjectPath !== projectPath && !canLeave()) return false;
    if (activeProjectPath !== projectPath) clearDocument();
    const request = ++activationRequest;
    rootSwitchRequest += 1;
    readGate.invalidate();
    treeRequest += 1;
    activeProjectPath = projectPath;
    activeMemory = null;
    enqueueUnwatch();
    renderRoots();
    tree.replaceChildren();
    let result;
    try { result = await api.openProjectFiles(projectPath); } catch { result = null; }
    if (destroyed || request !== activationRequest || activeProjectPath !== projectPath) return false;
    if (!result || !result.ok) {
      setViewMessage(result && result.error);
      return false;
    }
    let memory = projectMemory.get(projectPath);
    if (!memory) {
      memory = {
        projectId: null,
        roots: [],
        selectedRootId: null,
        showIgnored: false,
        expandedByRoot: new Map(),
        lastFile: null,
      };
      projectMemory.set(projectPath, memory);
    }
    const rememberedRoot = memory.selectedRootId;
    memory.projectId = result.projectId;
    memory.roots = result.roots;
    if (!result.roots.some((root) => root.id === rememberedRoot)) {
      memory.selectedRootId = result.roots[0]?.id || null;
      if (rememberedRoot) {
        toast(translated(t, 'files.rootGone'));
        viewMessageKey = 'files.rootGone';
      }
    }
    activeMemory = memory;
    ignoredButton.setAttribute('aria-pressed', String(memory.showIgnored));
    renderRoots();
    repaintDocument();
    if (!selectedRootId()) return false;
    enqueueWatch(projectPath, memory.projectId, memory.selectedRootId);
    await rebuildTree();
    if (destroyed || request !== activationRequest || activeMemory !== memory) return false;
    if (memory.lastFile && memory.lastFile.rootId === memory.selectedRootId) {
      await openFile(memory.lastFile.path, { skipGuard: true });
    }
    return true;
  }

  async function deactivate() {
    activationRequest += 1;
    rootSwitchRequest += 1;
    treeRequest += 1;
    readGate.invalidate();
    invalidateDocumentOperation();
    activeProjectPath = null;
    activeMemory = null;
    editor.setLanguage('');
    await enqueueUnwatch();
  }

  async function checkOpenFileHint() {
    if (!activeMemory || !documentState.path
      || !['clean', 'dirty', 'conflict'].includes(documentState.status)) return;
    const identity = currentIdentity();
    const token = readGate.next();
    const result = await api.readProjectFile({
      projectId: identity.projectId,
      rootId: identity.rootId,
      path: identity.path,
    });
    if (!identityMatches(identity, token)) return;
    if (pendingDocumentOperation && operationCurrent(pendingDocumentOperation)) return;
    if (!result || !result.ok) {
      if (result && result.error === 'deleted') {
        dispatch({ type: 'disk-changed', exists: false });
        editor.setReadOnly(documentState.status === 'deleted');
      } else setViewMessage(result && result.error);
      return;
    }
    if (result.revision === documentState.revision) return;
    if (documentState.status === 'clean') {
      const selection = editor.getSelection();
      dispatch({
        type: 'disk-snapshot',
        content: result.content,
        revision: result.revision,
        ignored: result.ignored,
      });
      editor.setDocument(result.content, selection);
      editor.setReadOnly(false);
      editor.setLanguage(result.path);
    } else {
      dispatch({ type: 'disk-changed', exists: true });
    }
  }

  async function handleWatchHint(change) {
    if (destroyed || !activeMemory || !change
      || change.projectId !== activeMemory.projectId
      || change.rootId !== selectedRootId()) return;
    if (change.kind === 'watch-failed') {
      setViewMessage('watch-failed');
      return;
    }
    const directory = parentPath(change.path || '');
    if (loadedDirectories.has(directory)) await reloadDirectory(directory);
    if (pendingDocumentOperation && operationCurrent(pendingDocumentOperation)) {
      return;
    }
    await checkOpenFileHint();
  }

  if (typeof api.onProjectFilesChanged === 'function') {
    unsubscribe = api.onProjectFilesChanged((change) => { handleWatchHint(change); }) || NOOP;
  }

  function applyLabels() {
    element.setAttribute('aria-label', translated(t, 'files.panel'));
    editor.setLabel(translated(t, 'files.panel'));
    rootLabel.textContent = translated(t, 'files.root');
    ignoredButton.textContent = translated(t, 'files.showIgnored');
    tree.setAttribute('aria-label', translated(t, 'files.tree'));
    repaintDocument();
  }

  function onLanguage() {
    applyLabels();
    renderRoots();
    if (activeMemory) rebuildTree();
  }

  function onTheme(nextTheme) {
    editor.setTheme(nextTheme);
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    activationRequest += 1;
    rootSwitchRequest += 1;
    treeRequest += 1;
    readGate.invalidate();
    invalidateDocumentOperation();
    unsubscribe();
    editor.destroy();
    await enqueueUnwatch();
  }

  applyLabels();
  editor.setReadOnly(true);

  return {
    element,
    activate,
    deactivate,
    canLeave,
    hasUnsavedChanges: () => FileState.needsDiscard(documentState),
    onTheme,
    onLanguage,
    destroy,
  };
}
