// Injected into the preview <webview>. Highlights the element under the cursor
// and reports its source (outerHTML) back to the host renderer.
const { ipcRenderer } = require('electron');

let pinned = false;
let box = null;

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.setAttribute('data-tabdesk-inspect', '');
  box.style.cssText = [
    'position:fixed', 'pointer-events:none', 'z-index:2147483647',
    'border:2px solid #34e2ff', 'background:rgba(52,226,255,.12)',
    'box-shadow:0 0 12px rgba(52,226,255,.6)', 'border-radius:2px',
    'transition:top .04s,left .04s,width .04s,height .04s', 'display:none',
  ].join(';');
  (document.body || document.documentElement).appendChild(box);
  return box;
}

function highlight(el) {
  const b = ensureBox();
  const r = el.getBoundingClientRect();
  b.style.display = 'block';
  b.style.top = r.top + 'px';
  b.style.left = r.left + 'px';
  b.style.width = r.width + 'px';
  b.style.height = r.height + 'px';
}

function selectorPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== 'HTML' && parts.length < 6) {
    let s = node.tagName.toLowerCase();
    if (node.id) s += '#' + node.id;
    else if (node.classList && node.classList.length) {
      s += '.' + [...node.classList].slice(0, 2).join('.');
    }
    parts.unshift(s);
    node = node.parentElement;
  }
  return parts.join(' › ');
}

function describe(el) {
  let html = '';
  try { html = el.outerHTML || ''; } catch (_) { /* ignore */ }
  if (html.length > 6000) html = html.slice(0, 6000) + '\n… (truncated)';
  return { path: selectorPath(el), html };
}

document.addEventListener('mouseover', (e) => {
  if (pinned) return;
  const el = e.target;
  if (!el || el === box) return;
  highlight(el);
  ipcRenderer.sendToHost('inspect', describe(el));
}, true);

document.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  pinned = !pinned;
  if (pinned) {
    highlight(e.target);
    ipcRenderer.sendToHost('inspect', Object.assign(describe(e.target), { pinned: true }));
  } else {
    ipcRenderer.sendToHost('inspect', { resume: true });
  }
}, true);

document.addEventListener('mouseleave', () => {
  if (!pinned && box) box.style.display = 'none';
}, true);
