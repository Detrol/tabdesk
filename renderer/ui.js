// Theme + translation layer for the renderer.
//
// Loaded before renderer.js so window.theme / window.t exist by the time the
// app builds any DOM. Both follow the desktop by default and are re-applied
// live when the system (or, later, the theme manager) changes them.

(function () {
  const boot = (window.api && window.api.boot) || {};

  let current = boot.theme || null;
  let strings = (boot.i18n && boot.i18n.strings) || {};
  const listeners = [];

  // ---- theme ----

  function applyTheme(th) {
    if (!th || !th.tokens) return;
    current = th;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(th.tokens)) {
      root.style.setProperty(`--${key}`, value);
    }
    root.dataset.theme = th.id;
    root.dataset.themeMode = th.dark ? 'dark' : 'light';
    root.style.colorScheme = th.dark ? 'dark' : 'light';
    for (const fn of listeners) { try { fn('theme', th); } catch (_) { /* keep going */ } }
  }

  // ---- translation ----

  // t('bar.reset', { time: '3h' }) — falls back to the key so a missing string
  // is visible rather than silently empty.
  function t(key, vars) {
    let out = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
    }
    return out;
  }

  // Stamp every element carrying a data-i18n* attribute:
  //   data-i18n       -> textContent
  //   data-i18n-html  -> innerHTML (strings with <strong> in them)
  //   data-i18n-title -> title attribute
  //   data-i18n-placeholder -> placeholder attribute
  function applyStrings(scope) {
    const root = scope || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.documentElement.lang = (boot.i18n && boot.i18n.code) || 'en';
  }

  function applyLanguage(payload) {
    if (!payload || !payload.strings) return;
    strings = payload.strings;
    boot.i18n = payload;
    applyStrings();
    for (const fn of listeners) { try { fn('language', payload); } catch (_) { /* keep going */ } }
  }

  // Anything with strings baked into JS (button labels, toasts) re-renders here.
  function onChange(fn) { listeners.push(fn); }

  window.t = t;
  window.ui = {
    get theme() { return current; },
    get locale() { return (boot.i18n && boot.i18n.code) || 'en'; },
    applyStrings,
    onChange,
  };

  applyTheme(current);
  if (window.api) {
    window.api.onThemeChanged(applyTheme);
    window.api.onLanguageChanged(applyLanguage);
  }
  document.addEventListener('DOMContentLoaded', () => applyStrings());
})();
