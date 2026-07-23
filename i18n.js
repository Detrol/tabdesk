// Translations. The app follows the desktop's language by default; a preset
// language can be pinned in settings once the settings UI exists.
//
// Locale files live in i18n/<code>.json. English is the fallback: any key a
// translation is missing falls through to en.json rather than showing the key.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DIR = path.join(__dirname, 'i18n');
const FALLBACK = 'en';

function available() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch (_) {
    return [FALLBACK];
  }
}

function load(code) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

// The desktop's language. app.getLocale() is Chromium's idea of it, which on
// Linux is derived from LANGUAGE/LC_ALL/LANG — check those first anyway, since
// Chromium normalises some locales we'd otherwise match exactly.
function systemLocale() {
  const env = process.env.LANGUAGE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  const raw = env.split(':')[0] || (app.isReady() ? app.getLocale() : '');
  return String(raw).replace('_', '-').split('.')[0] || FALLBACK;
}

// "sv-SE" -> sv.json if present, else en.
function pick(requested) {
  const codes = available();
  const want = String(requested || '').replace('_', '-');
  if (codes.includes(want)) return want;
  const base = want.split('-')[0];
  if (codes.includes(base)) return base;
  return FALLBACK;
}

// Resolve `language` ('system' or a code) into the strings the renderer uses.
function resolve(language) {
  const requested = !language || language === 'system' ? systemLocale() : language;
  const code = pick(requested);
  const strings = { ...(load(FALLBACK) || {}), ...(load(code) || {}) };
  return { code, source: language === 'system' || !language ? 'system' : 'pinned', strings };
}

function list() {
  return available().map((code) => ({ code, name: (load(code) || {})['language.name'] || code }));
}

module.exports = { resolve, list, systemLocale };
