// "New tab" project picker.
//
// Every new tab starts from a project: one that already exists under
// ~/claude-projects, a new folder created here, or a folder browsed for
// elsewhere. A plain shell is still reachable, but it is now a deliberate
// choice rather than what "+" happens to do.

const listEl = document.getElementById('pk-list');
const searchEl = document.getElementById('pk-search');
const noneEl = document.getElementById('pk-none');
const nameEl = document.getElementById('pk-name');
const errorEl = document.getElementById('pk-error');

let projects = [];

function choose(choice) { window.api.done(choice); }

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  const matches = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

  listEl.innerHTML = '';
  for (const p of matches) {
    const item = document.createElement('button');
    item.className = 'pk-item';
    item.title = p.path;

    const name = document.createElement('span');
    name.className = 'pk-name';
    name.textContent = p.name;
    item.appendChild(name);

    // Only worth the pixels when the project has actually pinned a model.
    if (p.model && p.model !== 'default') {
      const model = document.createElement('span');
      model.className = 'pk-model';
      model.textContent = p.model;
      item.appendChild(model);
    }

    item.addEventListener('click', () => choose({ kind: 'project', ...p }));
    listEl.appendChild(item);
  }
  noneEl.classList.toggle('hidden', matches.length > 0);
}

async function create() {
  errorEl.classList.add('hidden');
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }

  const res = await window.api.createProject(name);
  if (!res || !res.ok) {
    const key = { empty: 'picker.err.empty', invalid: 'picker.err.invalid', exists: 'picker.err.exists' }[res && res.error];
    showError(key ? window.t(key) : window.t('picker.err.failed', { error: (res && res.error) || '' }));
    return;
  }
  choose({ kind: 'project', name: res.name, path: res.path, model: 'default' });
}

searchEl.addEventListener('input', renderList);

// Enter in the search box takes the first match — the list is already filtered
// to what you typed, so there is nothing else it could reasonably mean.
searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = listEl.querySelector('.pk-item');
  if (first) first.click();
});

nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
document.getElementById('pk-create').addEventListener('click', create);

document.getElementById('pk-browse').addEventListener('click', async () => {
  const dir = await window.api.browseFolder();
  if (dir) choose({ kind: 'project', ...dir });
});

document.getElementById('pk-shell').addEventListener('click', () => choose({ kind: 'shell' }));
document.getElementById('pk-cancel').addEventListener('click', () => choose(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') choose(null); });

window.api.listProjects().then((list) => {
  projects = list || [];
  renderList();
  searchEl.focus();
});
