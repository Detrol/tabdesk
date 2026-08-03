// One-time seed: pre-close the /srv/dev directories that are not projects, so
// the rail never offers a tab (and thereby an agent) in them. Run once with
// plain node, before or after first launch — NOT from the launcher: reopening
// a project clears its closed mark, and a re-seed on every start would hide it
// again against the user's choice. Merge-safe with an existing settings file.
const fs = require('fs');
const path = require('path');
const os = require('os');

const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
// Running from source, Electron's userData follows package.json "name".
const file = path.join(cfg, 'tabdesk', 'settings.json');

const HIDE = [
  'actions-runner-vorasense', 'docs', 'fixihem25', 'tests',
  'piton-smoketest', 'piton-smoketest2', 'piton-smoketest3',
  'piton-smoketest3-origin.git',
].map((n) => '/srv/dev/' + n);

let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first run */ }
cur.closedProjects = [...new Set([...(cur.closedProjects || []), ...HIDE])];
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cur, null, 2));
console.log(`Seeded ${HIDE.length} closed projects into ${file}`);
