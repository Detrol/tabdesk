// Settings window.
//
// Theme and language are applied the moment they are picked — there is no Save
// button, and no Cancel, because main persists on every set() and every window
// repaints from the broadcast. The footer note is the only feedback needed.

const themeSel = document.getElementById('st-theme');
const langSel = document.getElementById('st-lang');
const savedEl = document.getElementById('st-saved');

// Local copies, not a handle on boot.settings: contextBridge deep-clones and
// freezes everything it exposes, so assigning back into that object is a silent
// no-op outside strict mode. Writing to it and then re-reading it is what made
// the menu snap back to the previous theme after a pick, while the colours the
// pick applied stayed — the two disagreed because only one of them was real.
const bootSettings = (window.api.boot && window.api.boot.settings) || {};
let currentTheme = bootSettings.theme || 'system';
let currentLanguage = bootSettings.language || 'system';

// ---- section switcher ----

const navBtns = [...document.querySelectorAll('.st-navbtn')];
const sections = [...document.querySelectorAll('.st-section')];

for (const btn of navBtns) {
  btn.addEventListener('click', () => {
    const want = btn.dataset.section;
    for (const b of navBtns) {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const s of sections) s.classList.toggle('hidden', s.dataset.section !== want);
  });
}

// ---- saved indicator ----

let savedTimer = null;
function flashSaved() {
  savedEl.textContent = window.t('settings.saved');
  savedEl.classList.add('is-on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('is-on'), 1400);
}

// ---- pickers ----

// `selected` is the stored preference ('system' or an id), not the theme that
// happens to be active: with 'system' picked those differ, and showing the
// resolved one would make the menu jump to 'Neon' the moment the desktop is dark.
function fill(select, items, selected, toOption) {
  select.textContent = '';
  for (const item of items) {
    const opt = document.createElement('option');
    const { value, label } = toOption(item);
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === selected;
    select.appendChild(opt);
  }
}

async function loadThemes() {
  const list = await window.api.listThemes();
  // theme.list() already labels the system entry with the desktop theme it
  // resolved to ("System (Adwaita Dark)", theme.js), so the name is used as-is.
  // Wrapping it again here is what produced "System (System (Adwaita Dark))".
  fill(themeSel, list, currentTheme, (th) => ({ value: th.id, label: th.name }));
}

async function loadLanguages() {
  const list = await window.api.listLanguages();
  fill(langSel, [{ code: 'system', name: window.t('settings.language.system') }, ...list],
    currentLanguage, (l) => ({ value: l.code, label: l.name }));
}

themeSel.addEventListener('change', async () => {
  currentTheme = themeSel.value;
  await window.api.setTheme(themeSel.value);
  // The system entry's label carries the resolved desktop theme's name, which
  // changes with the pick — re-read rather than leave a stale one behind.
  await loadThemes();
  flashSaved();
});

langSel.addEventListener('change', async () => {
  currentLanguage = langSel.value;
  await window.api.setLanguage(langSel.value);
  flashSaved();
});

// Strings baked into JS (the option labels) have to be rebuilt on a language
// change; data-i18n attributes are handled by ui.js.
window.ui.onChange((kind) => {
  if (kind === 'language') { loadThemes(); loadLanguages(); }
});

document.getElementById('st-close').addEventListener('click', () => window.api.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.close(); });

loadThemes();
loadLanguages();
