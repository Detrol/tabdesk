// Theme engine.
//
// Two kinds of themes exist:
//   * "system"  — derived at runtime from the desktop's GTK theme, so TabDesk
//                 matches whatever the user runs (colours, light/dark, accent).
//   * presets   — JSON files in themes/, e.g. the original neon look.
//
// A theme is a flat map of CSS custom properties the renderer stamps onto
// :root, plus a terminal palette used by xterm.js and the embedded xterm.

const { nativeTheme } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('./logger');

const log = createLogger('theme');

const THEMES_DIR = path.join(__dirname, 'themes');

// ---- colour helpers -------------------------------------------------------

function parse(hex) {
  const h = String(hex || '').replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(s.slice(0, 2), 16) || 0,
    g: parseInt(s.slice(2, 4), 16) || 0,
    b: parseInt(s.slice(4, 6), 16) || 0,
  };
}
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hex = ({ r, g, b }) => '#' + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('');

function mix(a, b, t) {
  const A = parse(a), B = parse(b);
  return hex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
// amt > 0 lightens toward white, < 0 darkens toward black.
const shade = (c, amt) => (amt >= 0 ? mix(c, '#ffffff', amt) : mix(c, '#000000', -amt));

function rgba(c, a) {
  const { r, g, b } = parse(c);
  return `rgba(${r},${g},${b},${a})`;
}

// Perceived luminance, 0 (black) – 1 (white).
function lum(c) {
  const { r, g, b } = parse(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Pull a colour away from the background until it is actually readable on it.
function ensureContrast(c, bg, min = 0.28) {
  let out = c;
  const up = lum(bg) < 0.5;
  for (let i = 0; i < 12 && Math.abs(lum(out) - lum(bg)) < min; i++) {
    out = shade(out, up ? 0.08 : -0.08);
  }
  return out;
}

// ---- GTK probe ------------------------------------------------------------

// Read the live GTK theme's named colours. Runs in a throwaway python3+gi
// process — the only reliable way to resolve a GTK theme's palette, since the
// colours come from the theme's own CSS, not from any settings key. Passed with
// -c rather than as a file so it still works from inside the asar archive.
const PROBE = `
import json, sys
try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk
    Gtk.init([])
    ctx = Gtk.Window().get_style_context()
    names = ['theme_bg_color', 'theme_fg_color', 'theme_base_color', 'theme_text_color',
             'theme_selected_bg_color', 'theme_selected_fg_color', 'borders',
             'insensitive_fg_color', 'success_color', 'warning_color', 'error_color']
    out = {}
    for n in names:
        ok, c = ctx.lookup_color(n)
        if ok:
            out[n] = '#%02x%02x%02x' % (round(c.red * 255), round(c.green * 255), round(c.blue * 255))
    s = Gtk.Settings.get_default()
    out['theme_name'] = s.get_property('gtk-theme-name')
    out['prefer_dark'] = bool(s.get_property('gtk-application-prefer-dark-theme'))
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(0)
`;

function probeGtk() {
  return new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve(null);
    execFile('python3', ['-c', PROBE], { timeout: 6000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(String(stdout).trim().split('\n').pop());
        resolve(data && data.theme_bg_color ? data : null);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

// ---- theme construction ---------------------------------------------------

// Build the full token set from a handful of base colours. Everything the CSS
// needs is derived here so a theme file only has to carry the essentials.
function buildTokens(p, glowOn = true) {
  const dark = lum(p.bg) < 0.5;
  const bg = dark ? shade(p.bg, -0.12) : p.bg;
  const bg2 = p.base;
  const rail = dark ? shade(p.bg, -0.04) : shade(p.bg, -0.03);
  const rail2 = dark ? shade(rail, -0.35) : shade(rail, -0.05);
  const surface = dark ? shade(p.base, -0.06) : p.base;
  const line = p.border;
  const accent = ensureContrast(p.accent, bg, 0.2);
  const accent2 = p.accent2 || (dark ? shade(accent, 0.3) : shade(accent, -0.12));
  const text = p.text;
  const dim = mix(text, bg, 0.42);
  const faint = p.faint || mix(text, bg, 0.62);

  // Glow is the signature of the neon preset; on a desktop-derived theme it is
  // toned down (and dropped entirely in light themes, where it reads as smudge).
  // The user can switch it off outright (settings), which forces the flat
  // variants below the same way a light theme does.
  const g = glowOn && dark ? 1 : 0;
  const glow = (c, a, b) => (g ? `0 0 6px ${rgba(c, a)}, 0 0 16px ${rgba(c, b)}` : 'none');

  return {
    'bg': bg,
    'bg-2': bg2,
    'rail': rail,
    'rail-2': rail2,
    'surface': surface,
    'line': line,
    'line-soft': mix(line, bg, 0.5),
    'text': text,
    'dim': dim,
    'faint': faint,
    'accent': accent,
    'accent-2': accent2,
    'accent-soft': mix(accent2, text, 0.45),
    'ok': p.ok,
    'warn': p.warn,
    'danger': p.danger,
    'on-accent': p.onAccent || (lum(accent) < 0.5 ? '#ffffff' : '#101010'),

    'tint': rgba(accent, dark ? 0.08 : 0.07),
    'tint-strong': rgba(accent, dark ? 0.2 : 0.16),
    'tint-2': rgba(accent2, dark ? 0.08 : 0.07),
    'tint-2-strong': rgba(accent2, dark ? 0.22 : 0.18),
    'track': rgba(accent, dark ? 0.14 : 0.16),
    'overlay': rgba(bg, 0.96),

    'halo-1': rgba(accent, dark ? 0.1 : 0.05),
    'halo-2': rgba(accent2, dark ? 0.08 : 0.04),

    'glow-accent': glow(accent, 0.55, 0.35),
    'glow-accent-2': glow(accent2, 0.7, 0.45),
    'glow-ok': glow(p.ok, 0.9, 0.5),
    'glow-warn': glow(p.warn, 0.9, 0.5),
    'glow-danger': glow(p.danger, 0.8, 0.4),
    'glow-text': g ? `0 0 6px ${rgba(accent2, 0.4)}` : 'none',

    'shadow-rail': g ? `inset -1px 0 0 ${rgba(accent2, 0.15)}, 6px 0 24px -12px ${rgba(accent, 0.6)}`
                     : `inset -1px 0 0 ${rgba(line, 0.6)}`,
    'shadow-dock': g ? `inset 1px 0 0 ${rgba(accent2, 0.15)}, -6px 0 24px -12px ${rgba(accent2, 0.6)}`
                     : `inset 1px 0 0 ${rgba(line, 0.6)}`,
    'shadow-bar': g ? `0 -6px 22px -14px ${rgba(accent, 0.7)}` : 'none',
    'shadow-panel': g ? `inset 0 0 0 1px ${rgba(accent2, 0.08)}, 0 0 22px -6px ${rgba(accent, 0.55)}`
                      : `0 1px 3px ${rgba('#000000', 0.12)}`,
    'shadow-panel-focus': g ? `inset 0 0 0 1px ${rgba(accent2, 0.3)}, 0 0 28px -4px ${rgba(accent2, 0.7)}`
                            : `0 0 0 1px ${accent2}, 0 2px 8px ${rgba('#000000', 0.18)}`,
    'meter-fill': `linear-gradient(90deg, ${accent}, ${accent2})`,
    'meter-hot': `linear-gradient(90deg, ${p.warn}, ${p.danger})`,
    'meter-glow': g ? `0 0 8px ${rgba(accent2, 0.7)}` : 'none',
  };
}

// xterm palette (in-app xterm.js and the embedded native xterm).
function buildTerminal(p, tokens) {
  const dark = lum(tokens.bg) < 0.5;
  return {
    background: tokens.surface,
    foreground: tokens.text,
    cursor: tokens['accent-2'],
    cursorAccent: tokens.surface,
    selectionBackground: rgba(tokens.accent, 0.35),
    black: dark ? shade(tokens.bg, -0.2) : '#2b2b2b',
    brightBlack: tokens.faint,
    red: p.danger, brightRed: shade(p.danger, 0.2),
    green: p.ok, brightGreen: shade(p.ok, 0.2),
    yellow: p.warn, brightYellow: shade(p.warn, 0.2),
    blue: tokens.accent, brightBlue: shade(tokens.accent, 0.25),
    magenta: p.magenta || '#9a7bff', brightMagenta: shade(p.magenta || '#9a7bff', 0.2),
    cyan: tokens['accent-2'], brightCyan: tokens['accent-soft'],
    white: tokens.text, brightWhite: dark ? '#ffffff' : '#000000',
  };
}

// GTK palette -> our base colours. Falls back to a neutral desktop-ish pair
// when the probe fails (no python3-gi, Wayland-only session, non-Linux…).
function paletteFromGtk(gtk, prefersDark) {
  if (!gtk) {
    return prefersDark
      ? { bg: '#1f2126', base: '#26282e', text: '#e6e8ec', border: '#3a3d45', accent: '#5b8ff9',
          ok: '#4cc98a', warn: '#e8a33d', danger: '#e5565b', faint: '#8c9099' }
      : { bg: '#f2f3f5', base: '#ffffff', text: '#1f2329', border: '#d3d6db', accent: '#3b6fd4',
          ok: '#2e9e63', warn: '#c07a12', danger: '#c8353a', faint: '#8b9099' };
  }
  return {
    bg: gtk.theme_bg_color,
    base: gtk.theme_base_color || gtk.theme_bg_color,
    text: gtk.theme_fg_color,
    border: gtk.borders || mix(gtk.theme_fg_color, gtk.theme_bg_color, 0.72),
    accent: gtk.theme_selected_bg_color,
    onAccent: gtk.theme_selected_fg_color,
    faint: gtk.insensitive_fg_color,
    ok: gtk.success_color || '#3fb950',
    warn: gtk.warning_color || '#e3a83c',
    danger: gtk.error_color || '#e5565b',
  };
}

// ---- preset loading -------------------------------------------------------

function loadPresets() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith('.json')); } catch (_) { return out; }
  for (const f of files) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, f), 'utf8'));
      if (def && def.id && def.palette) out.push(def);
    } catch (err) {
      log.warn('preset_invalid', { file: f, error: err });
    }
  }
  // Families sort as a unit (Catppuccin's four flavours stay together), and
  // inside one the JSON's `order` wins — variant order is light→dark or
  // canonical, not alphabetical.
  return out.sort((a, b) =>
    String(a.family || a.name).localeCompare(String(b.family || b.name)) ||
    (a.order || 0) - (b.order || 0) ||
    String(a.name).localeCompare(String(b.name)));
}

// The tokens that carry glow. With glow off these must come from the derived
// (flat) set even when a preset overrides them — neon.json carries its glow
// hardcoded, and spreading those overrides back in would defeat the switch.
const GLOW_KEYS = ['glow-accent', 'glow-accent-2', 'glow-ok', 'glow-warn', 'glow-danger', 'glow-text',
  'shadow-rail', 'shadow-dock', 'shadow-bar', 'shadow-panel', 'shadow-panel-focus', 'meter-glow'];

function materialize(def, glowOn = true) {
  const tokens = buildTokens(def.palette, glowOn);
  let overrides = def.tokens || {};
  if (!glowOn) {
    overrides = { ...overrides };
    for (const k of GLOW_KEYS) delete overrides[k];
  }
  return {
    id: def.id,
    name: def.name,
    dark: lum(tokens.bg) < 0.5,
    tokens: { ...tokens, ...overrides },                 // a preset may override any token
    terminal: { ...buildTerminal(def.palette, tokens), ...(def.terminal || {}) },
  };
}

// ---- public API -----------------------------------------------------------

let gtkCache = null;

async function systemTheme(glowOn = true) {
  if (gtkCache === null) gtkCache = (await probeGtk()) || false;
  const gtk = gtkCache || null;
  const prefersDark = nativeTheme.shouldUseDarkColors || (gtk && gtk.prefer_dark) || false;
  const palette = paletteFromGtk(gtk, prefersDark);
  const tokens = buildTokens(palette, glowOn);
  return {
    id: 'system',
    name: gtk && gtk.theme_name ? `System (${gtk.theme_name})` : 'System',
    dark: lum(tokens.bg) < 0.5,
    tokens,
    terminal: buildTerminal(palette, tokens),
  };
}

// Drop the probe cache so the next resolve() picks up a theme switch.
function invalidate() { gtkCache = null; }

async function resolve(id, glowOn = true) {
  if (!id || id === 'system') return systemTheme(glowOn);
  const def = loadPresets().find((d) => d.id === id);
  return def ? materialize(def, glowOn) : systemTheme(glowOn);
}

async function list() {
  const sys = await systemTheme();
  return [
    { id: 'system', name: sys.name, dark: sys.dark, builtin: true },
    ...loadPresets().map((d) => ({
      id: d.id, name: d.name, dark: lum(buildTokens(d.palette).bg) < 0.5,
      family: d.family || null, variant: d.variant || null,
    })),
  ];
}

module.exports = { resolve, list, invalidate, systemTheme };
