// "New tab" project picker.
//
// Every new tab starts from a project: one that already exists under
// ~/claude-projects, a new folder created here, or a folder browsed for
// elsewhere. A plain shell is still reachable, but it is now a deliberate
// choice rather than what "+" happens to do.
//
// Two questions, one window: which project the tab belongs to, and what it
// starts in it — a plain terminal or one of the agent CLIs installed on this
// machine. The second one has an answer already (the project remembers what it
// ran last), so it is optional; picking a project is what closes the window.

const listEl = document.getElementById('pk-list');
const searchEl = document.getElementById('pk-search');
const noneEl = document.getElementById('pk-none');
const nameEl = document.getElementById('pk-name');
const errorEl = document.getElementById('pk-error');
const startsEl = document.getElementById('pk-starts');

let projects = [];
// null means "whatever this project already starts with" — an untouched row
// must not overwrite a per-project choice made from the rail's agent menu.
let startAgent = null;

// The agent rides along with the project so main's renderer can store it the
// same way the agent menu does. A plain shell tab has no project to store it
// against, so it carries none.
function choose(choice) {
  window.api.done(choice && choice.kind === 'project' && startAgent
    ? { ...choice, agent: startAgent }
    : choice);
}

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

// Clicking the chip that is already on turns it back off: that is how you get
// out of an override and back to the project's own choice.
function renderStarts(agents) {
  startsEl.innerHTML = '';
  for (const a of agents) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pk-start' + (a.id === startAgent ? ' on' : '');
    chip.textContent = `${a.id === 'shell' ? '⌨' : '🤖'} ${a.label}`;
    chip.title = a.hint ? window.t(a.hint) : (a.command || '');
    chip.addEventListener('click', () => {
      startAgent = startAgent === a.id ? null : a.id;
      renderStarts(agents);
    });
    startsEl.appendChild(chip);
  }
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

// Nothing installed but the shell still gives one chip, so the row never turns
// up empty — but there is no choice to make, so it doesn't earn the space.
window.api.listAgents().then((agents) => {
  const list = agents || [];
  if (list.length < 2) {
    document.getElementById('pk-starts-sec').classList.add('hidden');
    return;
  }
  renderStarts(list);
});
