// Tests for the sync crypto and the group key.
//
// Run with `npm test`. They need Electron rather than plain node because
// keys.js stores through safeStorage, which only exists in an Electron main
// process — and testing that against a mock would be testing the mock.
//
// Not shipped: build.files is an allowlist and test/ is not in it.

const { app } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fsx = require('fs');

const ROOT = path.join(__dirname, '..');

// A scratch profile, set before ready and therefore before settings.js can
// resolve a path. These tests create, replace and corrupt the group key, and
// none of that may touch a real installation — running them must never be a
// way to lose the key to your own data. Electron happens to fall back to a
// different directory for a bare script, but that is a coincidence of how it
// is launched, not a guarantee worth relying on.
const PROFILE = fsx.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-test-'));
app.setPath('userData', PROFILE);
// Cleaned up explicitly rather than on 'quit': app.exit() leaves immediately
// and never emits it, so a quit handler here would silently leave a profile
// holding a group key behind in /tmp on every run.
const cleanup = () => { try { fsx.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* gone */ } };

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); }
};
const throws = (n, fn, code) => {
  try { fn(); fail++; console.log('  FAIL ' + n + ' -> did not throw'); }
  catch (e) {
    if (!code || e.code === code) { pass++; console.log('  ok   ' + n + ' (' + e.code + ')'); }
    else { fail++; console.log('  FAIL ' + n + ' -> ' + e.code + ', expected ' + code); }
  }
};

app.on('ready', async () => {
  const C = require(path.join(ROOT, 'sync/crypto'));
  const K = require(path.join(ROOT, 'sync/keys'));
  const settings = require(path.join(ROOT, 'settings'));
  const fs = require('fs');
  const file = path.join(app.getPath('userData'), 'settings.json');
  {


  console.log('== HKDF-harledning ==');
  const gk = Buffer.alloc(32, 7);
  const d1 = C.derive(gk), d2 = C.derive(gk);
  ok('deterministisk', d1.blob.equals(d2.blob));
  ok('undernycklar skiljer sig', new Set([d1.blob, d1.meta, d1.name, d1.slug].map((b) => b.toString('hex'))).size === 4);
  ok('32 byte', Object.values(d1).every((b) => b.length === 32));
  const other = C.derive(Buffer.alloc(32, 8));
  ok('annan gruppnyckel -> andra undernycklar', !d1.blob.equals(other.blob));
  console.log('  vektor blob: ' + d1.blob.toString('hex').slice(0, 32) + ' ...');
  throws('kort gruppnyckel avvisas', () => C.derive(Buffer.alloc(16)));

  console.log('== seal/open ==');
  const pt = Buffer.from('projektfil med aao och tecken');
  const s = C.seal(d1.blob, pt, 'blobs/ab/cd');
  ok('rundtur', C.open(d1.blob, s, 'blobs/ab/cd').equals(pt));
  ok('magi TDE1', s.subarray(0, 4).toString() === 'TDE1');
  ok('overhead 32 byte', s.length === pt.length + 32, s.length + ' vs ' + pt.length);
  ok('tva seal ger olika chiffertext', !C.seal(d1.blob, pt, 'x').equals(C.seal(d1.blob, pt, 'x')));
  ok('tom klartext', C.open(d1.blob, C.seal(d1.blob, Buffer.alloc(0), 'x'), 'x').length === 0);
  const big = crypto.randomBytes(3 * 1024 * 1024);
  ok('3 MB rundtur', C.open(d1.blob, C.seal(d1.blob, big, 'b'), 'b').equals(big));

  console.log('== manipulering avvisas ==');
  throws('fel AAD', () => C.open(d1.blob, s, 'blobs/zz/zz'), 'auth');
  throws('AAD saknas', () => C.open(d1.blob, s), 'auth');
  throws('fel nyckel', () => C.open(d1.meta, s, 'blobs/ab/cd'), 'auth');
  const flip = Buffer.from(s); flip[30] ^= 1;
  throws('andrad chiffertext', () => C.open(d1.blob, flip, 'blobs/ab/cd'), 'auth');
  const flipTag = Buffer.from(s); flipTag[flipTag.length - 1] ^= 1;
  throws('andrad tagg', () => C.open(d1.blob, flipTag, 'blobs/ab/cd'), 'auth');
  const flipNonce = Buffer.from(s); flipNonce[5] ^= 1;
  throws('andrad nonce', () => C.open(d1.blob, flipNonce, 'blobs/ab/cd'), 'auth');
  throws('avhuggen', () => C.open(d1.blob, s.subarray(0, 20), 'blobs/ab/cd'), 'truncated');
  throws('inte forseglad', () => C.open(d1.blob, Buffer.from('bara text som ar lang nog att passera'), 'x'), 'not-sealed');
  const v2 = Buffer.from(s); v2[3] = '2'.charCodeAt(0);
  throws('nyare version', () => C.open(d1.blob, v2, 'blobs/ab/cd'), 'version');

  console.log('== adressering ==');
  const h = crypto.createHash('sha256').update('innehall').digest('hex');
  ok('bloballias deterministiskt', C.blobAlias(d1.name, h) === C.blobAlias(d1.name, h));
  ok('bloballias skiljer sig fran hashen', C.blobAlias(d1.name, h) !== h);
  ok('annan nyckel -> annat alias', C.blobAlias(d1.name, h) !== C.blobAlias(other.name, h));
  ok('slugalias 32 tecken', C.slugAlias(d1.slug, 'kundprojekt').length === 32);
  ok('slugalias avslojar inte slug', !C.slugAlias(d1.slug, 'kundprojekt').includes('kund'));
  console.log('  vektor alias: ' + C.blobAlias(d1.name, h).slice(0, 24) + ' ...');

  console.log('== aterstallningsstrang ==');
  const r = K.toRecovery(gk);
  console.log('  ' + r);
  ok('borjar med TD-', r.startsWith('TD-'));
  ok('grupperad i fyror', /^TD-([0-9A-Z]{4}-)*[0-9A-Z]{1,4}$/.test(r));
  ok('rundtur', K.fromRecovery(r).equals(gk));
  ok('tal gemener', K.fromRecovery(r.toLowerCase()).equals(gk));
  ok('tal borttagna bindestreck', K.fromRecovery(r.replace(/-/g, '')).equals(gk));
  ok('tal mellanslag', K.fromRecovery(r.replace(/-/g, ' ')).equals(gk));
  ok('tal saknat TD-prefix', K.fromRecovery(r.slice(3)).equals(gk));
  const folded = r.slice(0, 3) + r.slice(3).replace(/0/g, 'O').replace(/1/g, 'I');
  ok('viker ihop O/0 och I/1', K.fromRecovery(folded).equals(gk));

  console.log('== transkriptionsfel fangas ==');
  let caught = 0, silent = 0;
  for (let i = 3; i < r.length; i++) {
    if (r[i] === '-') continue;
    const alt = r[i] === '2' ? '3' : '2';
    const typo = r.slice(0, i) + alt + r.slice(i + 1);
    try {
      const got = K.fromRecovery(typo);
      if (!got.equals(gk)) silent++;
    } catch (_) { caught++; }
  }
  ok('ett fel tecken fangas (' + caught + ' fangade, ' + silent + ' tysta)', silent === 0,
    silent + ' gav fel nyckel utan varning');
  throws('ogiltigt tecken', () => K.fromRecovery('TD-!!!!'), 'charset');
  throws('tom', () => K.fromRecovery(''), 'empty');

  
  }
  {


  console.log('== nyckelring ==');
  ok('safeStorage tillganglig', K.available());

  console.log('== skapa ==');
  ok('ingen nyckel fran borjan', !K.has());
  throws('get utan nyckel', () => K.get(), 'no-key');
  const made = K.create();
  ok('create lyckas', made.ok);
  ok('has efter create', K.has());
  console.log('  ' + made.recovery);

  console.log('== lagring pa disk ==');
  const raw = fs.readFileSync(file, 'utf8');
  const stored = JSON.parse(raw).sync.groupKey;
  ok('groupKey finns i settings.json', Boolean(stored));
  const key = K.get();
  ok('nyckeln ar 32 byte', key.length === 32);
  ok('nyckeln finns INTE i klartext pa disk', !raw.includes(key.toString('base64')));
  ok('nyckeln finns INTE som hex pa disk', !raw.includes(key.toString('hex')));
  ok('aterstallningsstrangen finns INTE pa disk', !raw.includes(made.recovery.replace(/-/g, '')));

  console.log('== aterstallning ==');
  ok('recovery() ger samma strang', K.recovery() === made.recovery);
  ok('strangen kodar samma nyckel', K.fromRecovery(made.recovery).equals(key));
  const fp = K.fingerprint();
  ok('fingeravtryck 12 tecken', fp.length === 12);
  ok('fingeravtrycket ar inte nyckeln', !key.toString('hex').startsWith(fp));

  console.log('== dubbelskapande ==');
  throws('create nar en redan finns', () => K.create(), 'exists');

  console.log('== undernycklar cachas men stammer ==');
  const d = K.derived();
  ok('derived matchar direkt harledning', d.blob.equals(C.derive(key).blob));
  ok('derived cachad (samma objekt)', K.derived() === d);

  console.log('== adopt ==');
  const other = C.newGroupKey();
  K.adopt(other);
  ok('adopt byter nyckel', K.get().equals(other));
  ok('cache invaliderad', K.derived().blob.equals(C.derive(other).blob));

  console.log('== glomma ==');
  K.forget();
  ok('has efter forget', !K.has());
  throws('get efter forget', () => K.get(), 'no-key');

  console.log('== aterta fran strang ==');
  K.adopt(K.fromRecovery(made.recovery));
  ok('samma nyckel tillbaka', K.get().equals(key));
  ok('samma fingeravtryck', K.fingerprint() === fp);

  console.log('== trasig lagrad nyckel ==');
  const cfg = settings.get('sync');
  settings.set('sync', Object.assign({}, cfg, { groupKey: Buffer.from('skrap').toString('base64') }));
  throws('oppningsbar blob som inte gar att dekryptera', () => K.get(), 'key-lost');


  }
  {


  // Earlier conversations are read out of the agents' own stores, so the tests
  // build a store of their own rather than depending on whatever happens to be
  // in ~/.claude and ~/.codex on the machine running them.
  const H = require(path.join(ROOT, 'history'));
  const STORE = fsx.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-hist-'));
  const CWD = '/srv/dev/nagot-projekt';
  const line = (o) => JSON.stringify(o) + '\n';
  const write = (file, text, when) => {
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    fsx.writeFileSync(file, text);
    if (when) fsx.utimesSync(file, when / 1000, when / 1000);
  };

  console.log('== claudes sessionslager ==');
  ok('katalognamn ur sokvag', H.claudeDirFor(CWD) === '-srv-dev-nagot-projekt');
  ok('punkter blir bindestreck', H.claudeDirFor('/a/.worktrees/b') === '-a--worktrees-b');
  ok('titel: sista ai-title vinner',
    H.claudeTitle(line({ type: 'ai-title', aiTitle: 'forst' }) + line({ type: 'ai-title', aiTitle: 'sist' })) === 'sist');
  ok('titel: faller tillbaka pa senaste prompt',
    H.claudeTitle(line({ type: 'last-prompt', lastPrompt: 'vad hande?' })) === 'vad hande?');
  ok('titel: tom nar inget finns', H.claudeTitle(line({ type: 'user' })) === null);

  const cdir = path.join(STORE, 'claude', H.claudeDirFor(CWD));
  write(path.join(cdir, '11111111-1111-1111-1111-111111111111.jsonl'),
    line({ type: 'user', cwd: CWD }) + line({ type: 'ai-title', aiTitle: 'Aldre samtal' }), 1000000);
  write(path.join(cdir, '22222222-2222-2222-2222-222222222222.jsonl'),
    line({ type: 'user', cwd: CWD }) + line({ type: 'last-prompt', lastPrompt: 'senaste  raden' }), 2000000);
  // Started by the SDK (a code review, a subagent) — a job, not a conversation.
  write(path.join(cdir, '44444444-4444-4444-4444-444444444444.jsonl'),
    line({ type: 'user', cwd: CWD, entrypoint: 'sdk-py' }) + line({ type: 'ai-title', aiTitle: 'Granskning' }), 2500000);
  // The id is spliced into a command line, so a filename that could be read as
  // a flag never becomes one.
  write(path.join(cdir, '--dangerously-skip-permissions.jsonl'), line({ type: 'user', cwd: CWD }), 2600000);
  const claudeRows = await H.claudeSessions(CWD, path.join(STORE, 'claude'));
  ok('filnamn som ser ut som flaggor listas inte', !claudeRows.some((r) => r.id.startsWith('-')));
  ok('sdk-sessioner listas inte', !claudeRows.some((r) => r.id.startsWith('4444')));
  ok('bada sessionerna listas', claudeRows.length === 2, String(claudeRows.length));
  ok('nyast forst', claudeRows[0].id === '22222222-2222-2222-2222-222222222222');
  ok('id ar filnamnet utan andelse', claudeRows[1].id === '11111111-1111-1111-1111-111111111111');
  ok('titel foljer med', claudeRows[1].title === 'Aldre samtal', String(claudeRows[1].title));
  ok('blanktecken normaliseras', claudeRows[0].title === 'senaste raden', String(claudeRows[0].title));
  ok('agenten ar utsatt', claudeRows.every((r) => r.agent === 'claude'));
  ok('okand katalog ger tom lista',
    (await H.claudeSessions('/finns/inte', path.join(STORE, 'claude'))).length === 0);

  // Two different paths can sanitise to the same directory name; the files say
  // which path they were written for, and a mismatch must list nothing.
  const clash = path.join(STORE, 'claude', H.claudeDirFor('/srv/dev/annat'));
  write(path.join(clash, '33333333-3333-3333-3333-333333333333.jsonl'),
    line({ type: 'user', cwd: '/srv/dev/nagon-annanstans' }), 3000000);
  ok('fel cwd i filen listar inget',
    (await H.claudeSessions('/srv/dev/annat', path.join(STORE, 'claude'))).length === 0);

  console.log('== codex rollout-lager ==');
  const meta = H.codexMeta(JSON.stringify({ type: 'session_meta', payload: { cwd: CWD, originator: 'codex_cli_rs' } }));
  ok('meta ger cwd', meta && meta.cwd === CWD);
  ok('meta ger originator', meta && meta.originator === 'codex_cli_rs');
  ok('interaktiv session behalls', meta && !meta.skip);
  ok('codex exec hoppas over',
    H.codexMeta(JSON.stringify({ payload: { cwd: CWD, originator: 'codex_exec' } })).skip);
  ok('underagent hoppas over',
    H.codexMeta(JSON.stringify({ payload: { cwd: CWD, thread_source: 'subagent' } })).skip);
  ok('rad utan cwd ar inte meta', H.codexMeta('{"type":"event_msg"}') === null);
  ok('titel ur user_message',
    H.codexTitle(line({ type: 'event_msg', payload: { type: 'user_message', message: 'Fixa bygget' } })) === 'Fixa bygget');
  const codexResponseTitle = line({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Fixa nya formatet' }],
    },
  });
  ok('titel ur response_item', H.codexTitle(codexResponseTitle) === 'Fixa nya formatet');
  const codexInjectedContext = line({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /srv/dev/tabdesk\n<INSTRUCTIONS>...' },
        { type: 'input_text', text: '<environment_context>...</environment_context>' },
      ],
    },
  });
  ok('injicerad codex-kontext blir ingen titel',
    H.codexTitle(codexInjectedContext + codexResponseTitle) === 'Fixa nya formatet');
  ok('utvecklarpreambel blir ingen titel',
    H.codexTitle(line({ payload: { type: 'message', role: 'developer', content: [{ text: 'hej' }] } })) === null);

  const croot = path.join(STORE, 'codex');
  const rollout = (day, id, payload, body, when) => write(
    path.join(croot, day, `rollout-2026-08-0${day.slice(-1)}T10-00-00-${id}.jsonl`),
    line({ type: 'session_meta', payload }) + (body || ''), when);
  rollout('2026/08/01', 'aaaaaaaa-1111-4111-8111-111111111111', { cwd: CWD, originator: 'codex_cli_rs' },
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Gammalt arende' } }), 1000000);
  rollout('2026/08/03', 'bbbbbbbb-2222-4222-8222-222222222222', { cwd: CWD, originator: 'codex_chatgpt_android_remote' },
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Fran telefonen' } }), 3000000);
  rollout('2026/08/03', 'cccccccc-3333-4333-8333-333333333333', { cwd: CWD, originator: 'codex_exec' }, '', 3500000);
  rollout('2026/08/03', 'dddddddd-4444-4444-8444-444444444444', { cwd: CWD, thread_source: 'subagent' }, '', 3600000);
  rollout('2026/08/03', 'eeeeeeee-5555-4555-8555-555555555555', { cwd: '/nagon/annan', originator: 'codex_cli_rs' }, '', 3700000);
  const codexRows = await H.codexSessions(CWD, croot);
  ok('bara projektets egna interaktiva sessioner', codexRows.length === 2,
    codexRows.map((r) => r.id).join(', '));
  ok('nyast forst har ocksa', codexRows[0].id === 'bbbbbbbb-2222-4222-8222-222222222222');
  ok('telefonsessioner raknas med', codexRows[0].title === 'Fran telefonen');
  ok('aldre dag hittas', codexRows[1].title === 'Gammalt arende');
  ok('agenten ar utsatt', codexRows.every((r) => r.agent === 'codex'));

  console.log('== opencode sessionslager ==');
  // opencode keeps everything in one SQLite file. The fixture is a minimal
  // schema the real CLI would write — enough for history, transcript and
  // usage to exercise their queries without depending on a live install.
  const { execFileSync } = require('child_process');
  const ocdb = path.join(STORE, 'opencode.db');
  const ocSql = (sql) => execFileSync('sqlite3', [ocdb, sql], { encoding: 'utf8' });
  ocSql(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'p',
      parent_id TEXT,
      slug TEXT NOT NULL DEFAULT 's',
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const ocIns = (id, dir, title, created, updated, extra = {}) => {
    const parent = extra.parent == null ? 'NULL' : `'${extra.parent}'`;
    const archived = extra.archived == null ? 'NULL' : String(extra.archived);
    const ti = extra.ti || 0, to = extra.to || 0, cost = extra.cost || 0;
    ocSql(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived,
      cost, tokens_input, tokens_output) VALUES
      ('${id}', ${parent}, '${dir}', '${title.replace(/'/g, "''")}', ${created}, ${updated}, ${archived},
       ${cost}, ${ti}, ${to});`);
  };
  ocIns('ses_aaaaaaaaaaaaaaaaaaaaaa01', CWD, 'Forsta opencode', 1000000, 1500000, { ti: 100, to: 50, cost: 0.1 });
  ocIns('ses_bbbbbbbbbbbbbbbbbbbbbb02', CWD, 'Nyare opencode', 2000000, 3500000, { ti: 200, to: 100, cost: 0.2 });
  ocIns('ses_cccccccccccccccchild003', CWD, 'Subagent job', 3000000, 3600000, { parent: 'ses_bbbbbbbbbbbbbbbbbbbbbb02' });
  ocIns('ses_dddddddddddddddddddddd04', CWD, 'Arkiverad', 4000000, 4500000, { archived: 4600000 });
  ocIns('ses_eeeeeeeeeeeeeeeeeeeeee05', '/nagon/annan', 'Annat projekt', 5000000, 5500000);
  ocIns('--bad-id-as-flag-------------', CWD, 'Osakert id', 6000000, 6500000);

  const ocRows = await H.opencodeSessions(CWD, ocdb);
  ok('bara projektets egna toppsessioner', ocRows.length === 2, ocRows.map((r) => r.id).join(', '));
  ok('nyast forst opencode', ocRows[0].id === 'ses_bbbbbbbbbbbbbbbbbbbbbb02');
  ok('titel foljer med', ocRows[0].title === 'Nyare opencode');
  ok('subagent hoppas over', !ocRows.some((r) => r.id.includes('child')));
  ok('arkiverad hoppas over', !ocRows.some((r) => r.id.includes('dddd')));
  ok('agenten ar opencode', ocRows.every((r) => r.agent === 'opencode'));
  ok('fodselsetid finns', ocRows.every((r) => r.born > 0 && r.at >= r.born));
  ok('osakert id filtreras', !ocRows.some((r) => r.id.startsWith('-')));

  console.log('== sammanslagen lista ==');
  const where = { claude: path.join(STORE, 'claude'), codex: croot, opencode: ocdb };
  const merged = await H.previousSessions(CWD, ['claude', 'codex', 'opencode'], where);
  ok('tre agenter kommer med', merged.length === 6, String(merged.length));
  ok('sorterad pa tid', merged.every((r, i) => i === 0 || merged[i - 1].at >= r.at));
  // Live tabs match a fresh conversation on when its store file was born, so
  // every row must say — mtime moves with each turn and can't tell fresh from
  // freshly-resumed.
  ok('varje rad bar sin fodselsetid', merged.every((r) => typeof r.born === 'number' && r.born > 0),
    merged.map((r) => `${r.agent}:${r.born}`).join(', '));
  ok('ingen agent utan lasare', (await H.previousSessions(CWD, ['aider'], where)).length === 0);
  ok('tom sokvag ger tom lista', (await H.previousSessions('', ['claude'], where)).length === 0);

  console.log('== symlankade projekt ==');
  // The agents record their cwd physically (the kernel resolves the symlink),
  // while the rail asks with the symlink's spelling — both must meet.
  const symBase = fsx.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-sym-'));
  const phys = path.join(symBase, 'workspace', 'projekt');
  fsx.mkdirSync(phys, { recursive: true });
  const link = path.join(symBase, 'projekt');
  fsx.symlinkSync(phys, link);
  const realPhys = fsx.realpathSync(phys);

  ok('spellingsOf ger bada stavningarna',
    H.spellingsOf(link).includes(link) && H.spellingsOf(link).includes(realPhys));

  write(path.join(STORE, 'claude', H.claudeDirFor(realPhys), '55555555-5555-4555-8555-555555555555.jsonl'),
    line({ type: 'user', cwd: realPhys }) + line({ type: 'last-prompt', lastPrompt: 'via symlank' }), 4000000);
  const viaLink = await H.claudeSessions(link, path.join(STORE, 'claude'));
  ok('fysiskt lagrad session hittas via symlanken',
    viaLink.length === 1 && viaLink[0].id === '55555555-5555-4555-8555-555555555555',
    viaLink.map((r) => r.id).join(', '));
  ok('titeln foljer med via symlanken', viaLink[0] && viaLink[0].title === 'via symlank');

  // The same session mirrored under both spellings is one conversation.
  write(path.join(STORE, 'claude', H.claudeDirFor(link), '55555555-5555-4555-8555-555555555555.jsonl'),
    line({ type: 'user', cwd: link }), 3900000);
  ok('samma id under bada stavningarna listas en gang',
    (await H.claudeSessions(link, path.join(STORE, 'claude'))).length === 1);

  // The collision guard still rejects a file written for an unrelated path.
  write(path.join(STORE, 'claude', H.claudeDirFor(realPhys), '66666666-6666-4666-8666-666666666666.jsonl'),
    line({ type: 'user', cwd: '/helt/annan/plats' }), 4100000);
  ok('frammande cwd avvisas ocksa via symlank',
    !(await H.claudeSessions(link, path.join(STORE, 'claude'))).some((r) => r.id.startsWith('6666')));

  rollout('2026/08/03', 'ffffffff-6666-4666-8666-666666666666',
    { cwd: realPhys, originator: 'codex_cli_rs' },
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Symlank codex' } }), 4200000);
  const codexViaLink = await H.codexSessions(link, croot);
  ok('codex-session med fysisk cwd hittas via symlanken',
    codexViaLink.some((r) => r.id === 'ffffffff-6666-4666-8666-666666666666'),
    codexViaLink.map((r) => r.id).join(', '));

  ocIns('ses_ffffffffffffsymlink006', realPhys, 'Symlank opencode', 7000000, 7500000);
  const ocViaLink = await H.opencodeSessions(link, ocdb);
  ok('opencode-session med fysisk cwd hittas via symlanken',
    ocViaLink.some((r) => r.id === 'ses_ffffffffffffsymlink006'),
    ocViaLink.map((r) => r.id).join(', '));

  console.log('== opencode transcript ==');
  const TR = require(path.join(ROOT, 'transcript'));
  const sid = 'ses_bbbbbbbbbbbbbbbbbbbbbb02';
  ocSql(`
    INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('msg_u1', '${sid}', 2000001, 2000001, '{"role":"user","id":"msg_u1"}'),
      ('msg_a1', '${sid}', 2000002, 2000002, '{"role":"assistant","id":"msg_a1"}');
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      ('prt_u1', 'msg_u1', '${sid}', 2000001, 2000001, '{"type":"text","text":"Hej opencode"}'),
      ('prt_r1', 'msg_a1', '${sid}', 2000002, 2000002, '{"type":"reasoning","text":"hemlig tanke"}'),
      ('prt_a1', 'msg_a1', '${sid}', 2000003, 2000003, '{"type":"text","text":"Hej tillbaka"}'),
      ('prt_t1', 'msg_a1', '${sid}', 2000004, 2000004, '{"type":"tool","tool":"bash"}');
  `);
  const ocText = await TR.read(CWD, sid, { opencode: ocdb });
  ok('opencode transcript lases', typeof ocText === 'string' && ocText.includes('Hej opencode'), ocText);
  ok('assistant-text foljer med', ocText && ocText.includes('Hej tillbaka'));
  ok('reasoning hoppas over', ocText && !ocText.includes('hemlig tanke'));
  ok('tool namnges', ocText && ocText.includes('[bash]'));
  ok('frammande cwd ger null', (await TR.read('/helt/annan', sid, { opencode: ocdb })) === null);

  console.log('== kimi sessionslager ==');
  const kimiHome = path.join(STORE, 'kimi-home');
  const kimiSessA = path.join(kimiHome, 'sessions', 'wd_test', 'session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const kimiSessB = path.join(kimiHome, 'sessions', 'wd_test', 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const kimiOther = path.join(kimiHome, 'sessions', 'wd_other', 'session_cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  fsx.mkdirSync(path.join(kimiSessA, 'agents', 'main'), { recursive: true });
  fsx.mkdirSync(path.join(kimiSessB, 'agents', 'main'), { recursive: true });
  fsx.mkdirSync(path.join(kimiOther, 'agents', 'main'), { recursive: true });
  fsx.writeFileSync(path.join(kimiHome, 'session_index.jsonl'), [
    JSON.stringify({ sessionId: 'session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionDir: kimiSessA, workDir: CWD }),
    JSON.stringify({ sessionId: 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionDir: kimiSessB, workDir: CWD }),
    JSON.stringify({ sessionId: 'session_cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionDir: kimiOther, workDir: '/helt/annan' }),
    JSON.stringify({ sessionId: 'bad id!', sessionDir: kimiSessA, workDir: CWD }),
  ].join('\n') + '\n');
  fsx.writeFileSync(path.join(kimiSessA, 'state.json'), JSON.stringify({
    title: 'Aldre kimi', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T11:00:00.000Z', workDir: CWD,
  }));
  fsx.writeFileSync(path.join(kimiSessB, 'state.json'), JSON.stringify({
    title: 'Nyare kimi', createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-05T12:00:00.000Z', workDir: CWD,
  }));
  const kimiRows = await H.kimiSessions(CWD, kimiHome);
  ok('kimi hittar tva for cwd', kimiRows.length === 2, String(kimiRows.length));
  ok('kimi nyast forst', kimiRows[0].id === 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  ok('kimi titel foljer med', kimiRows[0].title === 'Nyare kimi');
  ok('kimi agent-tag', kimiRows.every((r) => r.agent === 'kimi'));
  ok('kimi hoppar over annan cwd och bad id', !kimiRows.some((r) => r.id.includes('cccc') || r.id.includes(' ')));

  console.log('== kimi transcript ==');
  const kSid = 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fsx.writeFileSync(path.join(kimiSessB, 'agents', 'main', 'wire.jsonl'), [
    JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'Hej kimi' }] }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'hemlig' } } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Hej tillbaka kimi' } } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash' } }),
  ].join('\n') + '\n');
  const kText = await TR.read(CWD, kSid, { kimi: kimiHome });
  ok('kimi transcript lases', typeof kText === 'string' && kText.includes('Hej kimi'), kText);
  ok('kimi assistant-text', kText && kText.includes('Hej tillbaka kimi'));
  ok('kimi think hoppas over', kText && !kText.includes('hemlig'));
  ok('kimi tool namnges', kText && kText.includes('[Bash]'));
  ok('kimi frammande cwd ger null', (await TR.read('/helt/annan', kSid, { kimi: kimiHome })) === null);

  console.log('== fysisk cwd tillbaka till radens stavning ==');
  const PR = require(path.join(ROOT, 'projects-root'));
  const entries = [
    { path: '/root/proj', real: '/ws/proj' },
    { path: '/root/mp', real: '/ws/proj/.worktrees/mp' },
    { path: '/root/vanlig', real: '/root/vanlig' },
  ];
  ok('exakt fysisk vag blir logisk', PR.logicalizeCwd('/ws/proj', entries) === '/root/proj');
  ok('worktree under fysisk vag behaller suffixet',
    PR.logicalizeCwd('/ws/proj/.worktrees/x', entries) === '/root/proj/.worktrees/x');
  ok('mest specifika lanken vinner', PR.logicalizeCwd('/ws/proj/.worktrees/mp', entries) === '/root/mp');
  ok('omappbar vag ror inte', PR.logicalizeCwd('/nagon/annanstans', entries) === '/nagon/annanstans');
  ok('prefix utan avgransare mappas inte', PR.logicalizeCwd('/ws/projekt', entries) === '/ws/projekt');
  ok('tom entrylista ror inget', PR.logicalizeCwd('/ws/proj', []) === '/ws/proj');

  try { fsx.rmSync(STORE, { recursive: true, force: true }); } catch (_) { /* gone */ }
  try { fsx.rmSync(symBase, { recursive: true, force: true }); } catch (_) { /* gone */ }

  console.log('== kimi-kvot ur /usages-payload ==');
  const KL = require(path.join(ROOT, 'kimi-limits'));
  const kimiPayload = {
    usage: { limit: '100', remaining: '40', resetTime: '2026-08-08T07:30:15.145199Z' },
    limits: [{
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', remaining: '75', resetTime: '2026-08-05T10:30:15.145199Z' },
    }],
  };
  const kimiWin = KL.normalize(kimiPayload);
  ok('kimi week fran usage', kimiWin && kimiWin.week && Math.round(kimiWin.week.pct) === 60, JSON.stringify(kimiWin && kimiWin.week));
  ok('kimi session fran 5h-fonster', kimiWin && kimiWin.session && Math.round(kimiWin.session.pct) === 25, JSON.stringify(kimiWin && kimiWin.session));
  ok('kimi resetTime blir ms', kimiWin && kimiWin.week.resetsAt === Date.parse('2026-08-08T07:30:15.145199Z'));
  ok('kimi tom payload ger null', KL.normalize({}) === null);
  ok('kimi effort-env-flag', (() => {
    const E = require(path.join(ROOT, 'effort'));
    return E.flagFor('kimi', 'high') === 'KIMI_MODEL_THINKING_EFFORT=high' && E.isEnvFlag(E.flagFor('kimi', 'high'));
  })());

  console.log('== codex-kvot ur rollout ==');
  const CX = require(path.join(ROOT, 'codex-limits'));
  const NOW = 1786000000000; // fast klocka: resets_at jamfors mot den
  const snap = (obj) => JSON.stringify({ payload: { rate_limits: obj } });
  const week = { used_percent: 46, window_minutes: 10080, resets_at: (NOW + 3600000) / 1000 };
  const fiveH = { used_percent: 12, window_minutes: 300, resets_at: (NOW + 600000) / 1000 };

  const bothWin = CX.parseRateLimits('x\n' + snap({ primary: week, secondary: fiveH }) + '\n', NOW);
  ok('primart 7d-fonster blir week', bothWin && bothWin.week && bothWin.week.pct === 46);
  ok('sekundart 5h-fonster blir session', bothWin && bothWin.session && bothWin.session.pct === 12);
  ok('reset i epoksekunder blir ms', bothWin && bothWin.week.resetsAt === NOW + 3600000);

  const singleWin = CX.parseRateLimits(snap({ primary: week, secondary: null }), NOW);
  ok('utan sekundart fonster finns bara week', singleWin && singleWin.week && !singleWin.session);

  const lastWins = CX.parseRateLimits(
    snap({ primary: { ...week, used_percent: 10 } }) + '\n' + snap({ primary: week }), NOW);
  ok('sista snapshotten i filen vinner', lastWins && lastWins.week.pct === 46);

  ok('passerad reset kasseras',
    CX.parseRateLimits(snap({ primary: { ...week, resets_at: (NOW - 1000) / 1000 } }), NOW) === null);
  ok('text utan snapshot ger null', CX.parseRateLimits('inga granser har', NOW) === null);
  ok('trasig snapshot ger null', CX.parseRateLimits('"rate_limits":{oparsbar', NOW) === null);

  console.log('== tmux-aktivitet for sessioner utan pty ==');
  const AC = require(path.join(ROOT, 'activity'));
  const acLine = (name, at, cwd, title) => `${name}\t${at}\t${cwd}\t${title}`;
  const acMap = AC.parse([
    acLine('td-claude-x', 1785835133, '/srv/dev/x', '✳ Nagot'),
    acLine('td-codex-y', 1785835091, '/srv/dev/y/.worktrees/feat', '[ ! ] Action Required | pmsystem'),
    '',
  ].join('\n'));
  ok('varje session ger sin stampel',
    acMap['td-claude-x'].at === 1785835133 && acMap['td-codex-y'].at === 1785835091);
  ok('titeln foljer med hel, med mellanslag och rorstreck',
    acMap['td-codex-y'].title === '[ ! ] Action Required | pmsystem');
  ok('cwd foljer med',
    acMap['td-codex-y'].cwd === '/srv/dev/y/.worktrees/feat');
  ok('sessioner utanfor TabDesk ignoreras',
    Object.keys(AC.parse([
      acLine('main', 1785761003, '/tmp', 'x'),
      acLine('irc', 12, '/tmp', 'y'),
      acLine('td-claude-x', 5, '/tmp', 'z'),
    ].join('\n'))).join(',') === 'td-claude-x');
  ok('rader utan stampel hoppas over',
    Object.keys(AC.parse('td-claude-x\ntd-codex-y\thej\n' + acLine('td-shell-z', 7, '/tmp', 't'))).join(',') === 'td-shell-z');
  ok('tomt svar ger tom karta',
    Object.keys(AC.parse('')).length === 0 && Object.keys(AC.parse(undefined)).length === 0);
  ok('nyaste fonstret talar for sessionen',
    AC.parse([
      acLine('td-claude-x', 100, '/a', 'a'),
      acLine('td-claude-x', 400, '/b', 'b'),
      acLine('td-claude-x', 250, '/c', 'c'),
    ].join('\n'))['td-claude-x'].at === 400);

  console.log('== fragar runtimen, eller ar den bara tyst ==');
  const AS = require(path.join(ROOT, 'asking'));
  // Fangat ur Claude Code 2.1.221 i planlage.
  const claudeAsk = [
    'What one-line note should I add to note.txt?', '',
    '❯ 1. You decide — brief, useful note',
    '     Pick something short and practical',
    '  2. I\'ll specify it', '  3. Type something.', '  4. Chat about this', '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
  // Samma session efter ett avslutat svar: tyst, inga val.
  const claudeIdle = [
    '● note.txt has 1 line.', '', '✻ Cooked for 4s', '',
    '───────────', '❯ ', '───────────',
    '  Haiku 4.5 | ask-probe | 38k/200k (19%) | effort: med | v2.1.221',
    '  ⏸ manual mode on · ← 1 agent'].join('\n');
  const codexIdle = [
    '• Ran wc -l note.txt', '  └ 1 note.txt', '',
    '› Use /skills to list available skills',
    '  gpt-5.6-sol xhigh · /srv/dev · Context 94% left · weekly 34% left'].join('\n');
  const codexBusy = ['• Working (22s • esc to interrupt)', '› Explain this codebase'].join('\n');
  ok('claudes fragemeny raknas som fraga', AS.isAsking(claudeAsk) === true);
  ok('claude vid tom prompt fragar inte', AS.isAsking(claudeIdle) === false);
  ok('codex vid tom prompt fragar inte', AS.isAsking(codexIdle) === false);
  ok('codex mitt i arbetet fragar inte', AS.isAsking(codexBusy) === false);
  ok('godkannanderuta utan siffror fangas pa ordalydelsen',
    AS.isAsking('Bash(touch x)\n\nDo you want to proceed?\n  Yes\n  No') === true);
  ok('codex godkannande fangas', AS.isAsking('Allow Codex to run `rm -rf /`?') === true);
  ok('numrerad lista i prosa ar ingen fraga',
    AS.isAsking('Har ar planen:\n1. Lasa filen\n2. Skriva testet\n3. Kora sviten') === false);
  // Fangat ur samma probe: claude fragade i loptext, utan meny.
  const claudeProse = [
    '  ⎿  Invalid tool parameters',
    '● note.txt doesn\'t exist yet. What line should I add to it?', '',
    '✻ Brewed for 11s', '', '───────────', '❯ ', '───────────',
    '  Haiku 4.5 | demo-proj | 40k/200k (20%) | effort: med | v2.1.221',
    '  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent'].join('\n');
  ok('fraga i loptext raknas ocksa', AS.isAsking(claudeProse) === true);
  ok('vanligt svar raknas inte', AS.isAsking(
    ['● Fixat: tre tester till, alla grona.', '', '✻ Cooked for 9s', '❯ '].join('\n')) === false);
  ok('radbruten fraga hittas i sista raden', AS.isAsking(
    ['● Jag kan gora det pa tva satt, men det beror pa hur du vill',
     '  ha felhanteringen. Vilken vag foredrar du?', '', '❯ '].join('\n')) === true);
  ok('fragetecken i ett tidigare meddelande raknas inte', AS.isAsking(
    ['● Ska jag fortsatta?', '  ⎿  Ja', '● Klart.', '', '❯ '].join('\n')) === false);
  ok('tom skarm fragar inte', AS.isAsking('') === false && AS.isAsking(null) === false);
  // Codex sager det i fonstertiteln, och blinkar mellan de tva formerna.
  ok('codex titel sager att den vantar',
    AS.fromTitle('[ ! ] Action Required | pmsystem') === true
    && AS.fromTitle('[ . ] Action Required | pmsystem') === true);
  ok('codex titel under arbete sager inget', AS.fromTitle('⠼ agent-workflow') === false);
  ok('claudes titel ar ingen fragesignal',
    AS.fromTitle('✳ Värvningsprogram för Facebook') === false);
  ok('tom titel sager inget', AS.fromTitle('') === false && AS.fromTitle(null) === false);

  console.log('== ansträngningsnivåer per agent ==');
  const EF = require(path.join(ROOT, 'effort'));
  ok('claude har egna nivaer', EF.list('claude').map((r) => r.id).join(',') === 'default,low,medium,high,xhigh,max,ultracode');
  ok('codex har sina', EF.list('codex').map((r) => r.id).join(',') === 'default,minimal,low,medium,high,xhigh,ultra');
  ok('agent utan installning far inga rader', EF.list('gemini').length === 0 && !EF.supports('gemini'));
  ok('claude-flaggan', EF.flagFor('claude', 'xhigh') === ' --effort xhigh');
  ok('ultracode ar ett eget lage, inte en niva hos codex',
    EF.flagFor('claude', 'ultracode') === ' --effort ultracode' && EF.flagFor('codex', 'ultracode') === '');
  ok('ultracode forklarar sig i menyn',
    (EF.list('claude').find((r) => r.id === 'ultracode') || {}).hint === 'bar.effort.hint.ultracode');
  ok('codex-flaggan ar en config-override', EF.flagFor('codex', 'ultra') === ' -c model_reasoning_effort=ultra');
  ok('default ger ingen flagga', EF.flagFor('claude', 'default') === '');
  ok('nivan maste finnas hos agenten', EF.flagFor('claude', 'ultra') === '' && EF.flagFor('codex', 'max') === '');
  ok('agent utan installning ger ingen flagga', EF.flagFor('gemini', 'high') === '');
  const EFPROJ = '/tmp/tabdesk-effort-proj';
  ok('okand niva avvisas', EF.setFor(EFPROJ, 'codex', 'turbo').ok === false);
  ok('giltig niva sparas per agent', EF.setFor(EFPROJ, 'codex', 'ultra').ok === true
    && EF.getFor(EFPROJ, 'codex') === 'ultra' && EF.getFor(EFPROJ, 'claude') === 'default');
  ok('default tar bort posten', EF.setFor(EFPROJ, 'codex', 'default').ok === true
    && EF.getFor(EFPROJ, 'codex') === 'default');

  console.log('== codex-modeller ur rollouttext ==');
  const MD = require(path.join(ROOT, 'model'));
  const mtext = '{"model":"gpt-5.6-sol"}\n{"model":"gpt-5.6-terra"}\n{"model":"gpt-5.6-sol"}\n{"model":"bad;rm"}';
  const mids = MD.codexModelsFromText(mtext);
  ok('distinkta modeller utan dubbletter', mids.length === 2 && mids.includes('gpt-5.6-sol') && mids.includes('gpt-5.6-terra'), mids.join(','));
  ok('osakra id avvisas', !mids.some((x) => x.includes(';')));
  ok('tom text ger tom lista', MD.codexModelsFromText('inget har').length === 0);

  console.log('== nyaste rollout over dagkataloger ==');
  const CODEXROOT = fsx.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-cx-'));
  const dayOld = path.join(CODEXROOT, '2026', '08', '01');
  const dayNew = path.join(CODEXROOT, '2026', '08', '03');
  fsx.mkdirSync(dayOld, { recursive: true });
  fsx.mkdirSync(dayNew, { recursive: true });
  const resumedFile = path.join(dayOld, 'rollout-a.jsonl');
  const todayFile = path.join(dayNew, 'rollout-b.jsonl');
  fsx.writeFileSync(resumedFile, 'x');
  fsx.writeFileSync(todayFile, 'y');
  // En aterupptagen gammal session skrivs sist fast dess fil ligger i en aldre
  // dagkatalog — mtime ska avgora, inte katalognamnet.
  fsx.utimesSync(todayFile, new Date(1e12), new Date(1e12));
  fsx.utimesSync(resumedFile, new Date(1e12 + 1000), new Date(1e12 + 1000));
  const newestHit = CX.newestRollout(CODEXROOT);
  ok('senaste skrivningen vinner over dagkatalogen', newestHit && newestHit.file === resumedFile,
    newestHit && newestHit.file);
  ok('saknad rot ger null', CX.newestRollout(path.join(CODEXROOT, 'finns-ej')) === null);
  try { fsx.rmSync(CODEXROOT, { recursive: true, force: true }); } catch (_) { /* gone */ }

  }

  {
  console.log('== instruktionsfiler ==');
  // projects-root memoises resolve() on first call, so the env override must
  // be set before instructions.js is required — nothing above has resolved it.
  const INSROOT = fsx.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-ins-'));
  const INSPROJ = path.join(INSROOT, 'projektet');
  fsx.mkdirSync(INSPROJ, { recursive: true });
  process.env.TABDESK_PROJECTS_DIR = INSROOT;
  const INS = require(path.join(ROOT, 'instructions'));

  ok('saknad fil lases som tom',
    (() => { const r = INS.read('claude', 'project', INSPROJ); return r.ok && !r.exists && r.content === ''; })());
  ok('okand agent avvisas', INS.read('nope', 'project', INSPROJ).ok === false);
  ok('okand scope avvisas', INS.read('claude', 'bogus', INSPROJ).ok === false);
  ok('aider har ingen global fil', INS.read('aider', 'global', INSPROJ).ok === false);
  ok('projekt utanfor roten avvisas', INS.write('claude', 'project', '/etc', 'x').ok === false);
  ok('traversal avvisas', INS.write('claude', 'project', path.join(INSROOT, '..', 'utanfor'), 'x').ok === false);
  ok('icke-stranginnehall avvisas', INS.write('claude', 'project', INSPROJ, null).ok === false);

  ok('skriv skapar projektfilen', INS.write('claude', 'project', INSPROJ, '# Regler\n').ok === true);
  ok('innehallet landar pa disk',
    fsx.readFileSync(path.join(INSPROJ, 'CLAUDE.md'), 'utf8') === '# Regler\n');
  ok('omläsning ger samma innehall',
    (() => { const r = INS.read('claude', 'project', INSPROJ); return r.ok && r.exists && r.content === '# Regler\n'; })());
  ok('roten sjalv ar ett giltigt projekt', INS.write('codex', 'project', INSROOT, 'rot\n').ok === true);

  try { fsx.rmSync(INSROOT, { recursive: true, force: true }); } catch (_) { /* gone */ }
  }


  cleanup();
  app.exit(fail ? 1 : 0);
});
