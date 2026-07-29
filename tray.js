// System tray icon + tab menu.
//
// The tray lives in the main process, but the tab list lives in the renderer
// (renderer/renderer.js owns the `tabs` Map). The renderer therefore pushes a
// flat snapshot over `tray:tabs` whenever tabs are added, closed, renamed or
// switched, and the menu is rebuilt from that snapshot. Picking an entry sends
// `tray:select` back and the renderer runs its normal setActive().
//
// Deliberately a mirror, not a second source of truth: the tray never decides
// which tab is active, it only asks.

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let win = null;
let strings = {};
let snapshot = { tabs: [], activeId: null };

function t(key, fallback) {
  const v = strings[key];
  return typeof v === 'string' && v.length ? v : fallback;
}

// The window can be hidden to the tray, so "show" has to cover three states:
// hidden, minimised, and open-but-behind-something.
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

// Truncate long project names so one deep path can't stretch the menu across
// the screen. Menu labels have no wrapping to fall back on.
function label(tab) {
  const name = String(tab.name || '').trim() || t('tray.untitled', 'Untitled');
  const clipped = name.length > 40 ? `${name.slice(0, 39)}…` : name;
  return tab.busy ? `${clipped} ●` : clipped;
}

function buildMenu() {
  const items = [];

  if (snapshot.tabs.length === 0) {
    items.push({ label: t('tray.noTabs', 'No open tabs'), enabled: false });
  } else {
    items.push({ label: t('tray.tabs', 'Tabs'), enabled: false });
    for (const tab of snapshot.tabs) {
      items.push({
        // `radio` gives the active tab a filled marker, which reads better than
        // `checkbox` for a pick-exactly-one list.
        type: 'radio',
        checked: tab.id === snapshot.activeId,
        label: label(tab),
        // Shows the path under the name on macOS. Linux/GTK menus have no
        // second line and drop it — the tab names come from project folders and
        // are unique in practice, so nothing is lost here.
        sublabel: tab.cwd || undefined,
        click: () => {
          showWindow();
          if (win && !win.isDestroyed()) win.webContents.send('tray:select', tab.id);
        },
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({
    label: win && win.isVisible() && !win.isMinimized()
      ? t('tray.hide', 'Hide TabDesk')
      : t('tray.show', 'Show TabDesk'),
    click: toggleWindow,
  });
  items.push({ type: 'separator' });
  items.push({ label: t('tray.quit', 'Quit TabDesk'), click: () => { app.quit(); } });

  return Menu.buildFromTemplate(items);
}

function refresh() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu());

  const active = snapshot.tabs.find((x) => x.id === snapshot.activeId);
  tray.setToolTip(active ? `TabDesk — ${active.name}` : 'TabDesk');
}

function init(targetWindow, i18nStrings) {
  win = targetWindow;
  strings = i18nStrings || {};

  // A dedicated glyph, not the app tile. Squeezing the 1024px tile down to tray
  // size gave a dark navy square that disappeared into a dark panel; build/tray
  // is the prompt mark alone on transparency, drawn for this size. tray@2x.png
  // sits next to it and Electron picks it up by name on HiDPI panels.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));

  tray = new Tray(icon);
  refresh();

  // On most Linux desktops the indicator opens the context menu on any click
  // and never fires this; where it does fire, toggling is the expected
  // behaviour. Harmless either way.
  tray.on('click', toggleWindow);

  // The menu shows "Hide"/"Show" depending on window state, so it has to be
  // rebuilt when that state changes rather than only when tabs do.
  for (const evt of ['show', 'hide', 'minimize', 'restore', 'focus']) {
    win.on(evt, refresh);
  }

  return tray;
}

function setTabs(next) {
  snapshot = {
    tabs: Array.isArray(next && next.tabs) ? next.tabs : [],
    activeId: (next && next.activeId) || null,
  };
  refresh();
}

function setStrings(i18nStrings) {
  strings = i18nStrings || {};
  refresh();
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { init, setTabs, setStrings, destroy };
