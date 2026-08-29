// Persisted user preferences (userData/settings.json).
//
// Theme and language default to 'system': the app follows the desktop until the
// user explicitly pins one. projectModels maps a project path to the Claude
// model that project runs with; a project with no entry follows Claude Code's
// own default. closedProjects lists the project paths whose tab was closed with
// the ×, so the rail doesn't rebuild them from the directories on disk.
// recentProjects maps a project path to the last time it was opened in TabDesk.

const { app } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('./logger');

const log = createLogger('settings');

const DEFAULTS = { theme: 'system', glow: true, projectsDir: null, language: 'system', projectModels: {}, projectEfforts: {}, projectAutonomies: {}, closedProjects: [], recentProjects: {}, openTabs: [] };

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function all() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key) { return all()[key]; }

function persist(next) {
  const target = file();
  const directory = path.dirname(target);
  const temporary = path.join(directory,
    `.${path.basename(target)}.tabdesk-${process.pid}-${crypto.randomUUID()}.tmp`);
  let descriptor = null;
  let ownsTemporary = false;
  try {
    fs.mkdirSync(directory, { recursive: true });
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    ownsTemporary = true;
    fs.writeFileSync(descriptor, JSON.stringify(next, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (_) { /* already closed or unusable */ }
    }
    if (ownsTemporary) {
      try { fs.unlinkSync(temporary); } catch (_) { /* absent or already renamed */ }
    }
    throw error;
  }
}

function set(key, value) {
  const next = { ...all(), [key]: value };
  cache = next;
  try {
    persist(next);
    return true;
  } catch (err) {
    log.warn('persist_failed', { error: err });
    return false;
  }
}

module.exports = { all, get, set, DEFAULTS };
