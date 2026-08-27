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

// The suite never creates a renderer, so avoid starting Chromium's GPU process.
app.disableHardwareAcceleration();

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
  const TabOrder = require(path.join(ROOT, 'renderer/tab-order'));
  console.log('== flikordning ==');
  ok('flyttar fore malet',
    JSON.stringify(TabOrder.move(['a', 'b', 'c'], 'c', 'a', false)) === JSON.stringify(['c', 'a', 'b']));
  ok('flyttar efter malet',
    JSON.stringify(TabOrder.move(['a', 'b', 'c'], 'a', 'b', true)) === JSON.stringify(['b', 'a', 'c']));
  ok('samma plats ar no-op', TabOrder.move(['a', 'b', 'c'], 'a', 'b', false) === null);
  ok('okand flik avvisas', TabOrder.move(['a', 'b'], 'x', 'a', false) === null);
  ok('vanster halva placerar fore', TabOrder.afterMidpoint(109, 100, 20) === false);
  ok('hoger halva placerar efter', TabOrder.afterMidpoint(111, 100, 20) === true);
  ok('ogiltig bredd avvisas', TabOrder.afterMidpoint(100, 100, 0) === null);

  const makeDragPreview = TabOrder.createDragPreview;
  ok('dragpreview har en testbar livscykel', typeof makeDragPreview === 'function');
  if (typeof makeDragPreview === 'function') {
    const cancelled = makeDragPreview(['a', 'b', 'c'], 'c');
    ok('dragpreview omordnar fore drop',
      cancelled.preview('a', false).join(',') === 'c,a,b');
    ok('avbrutet drag aterstaller ursprungsordningen',
      cancelled.finish().join(',') === 'a,b,c');

    const dropped = makeDragPreview(['a', 'b', 'c'], 'c');
    dropped.preview('a', false);
    dropped.commit();
    ok('drop behaller den forhandsvisade ordningen',
      dropped.finish().join(',') === 'c,a,b');
  }

  const records = [
    { session: 'a1', cwd: '/a', name: 'A1', agentSession: 'conv-a1', projectPath: '/project-a' },
    { session: 'b1', cwd: '/b', name: 'B1' },
    { session: 'a2', cwd: '/a', name: 'A2' },
  ];
  const reordered = TabOrder.reorderRecords(records, ['a2', 'a1']);
  ok('ordnar bara projektets poster',
    reordered.map((r) => r.session).join(',') === 'a2,b1,a1',
    reordered.map((r) => r.session).join(','));
  ok('dubbletter avvisas', TabOrder.reorderRecords(records, ['a1', 'a1']) === null);
  ok('okand session avvisas', TabOrder.reorderRecords(records, ['a1', 'x']) === null);
  ok('sessionslosa flikar hindrar inte beständig ordning',
    TabOrder.persistentSessionIds([
      { id: 'a', session: 'a1' },
      { id: 'update', session: null },
      { id: 'b', session: 'b1' },
    ]).join(',') === 'a1,b1');

  const updated = TabOrder.upsertRecord(records, { session: 'a1', name: 'Nytt namn' });
  ok('uppdatering behaller plats', updated[0].session === 'a1' && updated[1].session === 'b1');
  ok('uppdatering behaller metadata', updated[0].agentSession === 'conv-a1');
  ok('deluppdatering behaller verifierad projektagare', updated[0].projectPath === '/project-a');
  ok('ny post laggs sist', TabOrder.upsertRecord(records, { session: 'c1' })[3].session === 'c1');

  const C = require(path.join(ROOT, 'sync/crypto'));
  const K = require(path.join(ROOT, 'sync/keys'));
  const settings = require(path.join(ROOT, 'settings'));
  const fs = require('fs');
  const file = path.join(app.getPath('userData'), 'settings.json');
  console.log('== settings skrivfel ==');
  const originalWriteFileSync = fsx.writeFileSync;
  const originalWarn = console.warn;
  const warnings = [];
  let failedWrite;
  try {
    fsx.writeFileSync = () => { throw new Error('expected settings write failure'); };
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    failedWrite = settings.set('writeFailureProbe', { session: 'kept-in-memory' });
  } finally {
    fsx.writeFileSync = originalWriteFileSync;
    console.warn = originalWarn;
  }
  ok('skrivfel rapporteras till anroparen', failedWrite === false);
  ok('skrivfel behaller vardet i minnet', settings.get('writeFailureProbe').session === 'kept-in-memory');
  const settingsWarn = warnings.length === 1 ? JSON.parse(warnings[0]) : {};
  ok('skrivfel varnas exakt en gang', warnings.length === 1
    && settingsWarn.level === 'warn' && settingsWarn.scope === 'settings'
    && settingsWarn.event === 'persist_failed'
    && String(settingsWarn.error && settingsWarn.error.message).includes('expected settings write failure'), warnings.join(' | '));
  const { createSessionRegistry } = require(path.join(ROOT, 'session-ownership'));
  const priorTabs = settings.get('openTabs');
  const registryWarnings = [];
  const registry = createSessionRegistry({
    read: () => settings.get('openTabs'),
    write: (records) => settings.set('openTabs', records),
    upsert: TabOrder.upsertRecord,
  });
  let failedRegistryWrite;
  try {
    fsx.writeFileSync = () => { throw new Error('expected registry write failure'); };
    console.warn = (...args) => registryWarnings.push(args.map(String).join(' '));
    failedRegistryWrite = registry.remember({ session: 'new-session', cwd: '/new' });
  } finally {
    fsx.writeFileSync = originalWriteFileSync;
    console.warn = originalWarn;
  }
  ok('registry skrivfel rapporteras till sessionsflodet', failedRegistryWrite === false);
  ok('registry skrivfel aterstaller exakt tidigare cache',
    JSON.stringify(settings.get('openTabs')) === JSON.stringify(priorTabs));
  ok('registry rollback forsoker bada cachelagena', registryWarnings.length === 2,
    registryWarnings.join(' | '));
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
  const codexInjectedLegacyContext = line({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '# AGENTS.md instructions for /srv/dev/tabdesk\n<INSTRUCTIONS>...',
    },
  });
  ok('injicerad legacy-kontext blir ingen titel',
    H.codexTitle(codexInjectedLegacyContext
      + line({ type: 'event_msg', payload: { type: 'user_message', message: 'Riktig titel' } }))
      === 'Riktig titel');
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

  const { execFileSync } = require('child_process');
  const codexDb = path.join(STORE, 'state_5.sqlite');
  const codexSql = (sql) => execFileSync('sqlite3', [codexDb, sql], { encoding: 'utf8' });
  codexSql(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      source TEXT NOT NULL,
      thread_source TEXT,
      title TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO threads VALUES
      ('99999999-9999-4999-8999-999999999999', '${CWD}', 'cli', 'user',
       'Titel fran Codex index', 'Titel fran Codex index', 0,
       1000, 2000, 1000000, 2000000, 1900000),
      ('88888888-8888-4888-8888-888888888888', '${CWD}', 'exec', 'user',
       'Icke-interaktiv', 'Icke-interaktiv', 0,
       2000, 3000, 2000000, 3000000, 2900000),
      ('77777777-7777-4777-8777-777777777777', '${CWD}', 'cli', 'subagent',
       'Underagent', 'Underagent', 0,
       3000, 4000, 3000000, 4000000, 3900000),
      ('66666666-6666-4666-8666-666666666666', '${CWD}', 'cli', 'user',
       'Arkiverad', 'Arkiverad', 1,
       4000, 5000, 4000000, 5000000, 4900000);
    WITH RECURSIVE noise(n) AS (
      VALUES(1) UNION ALL SELECT n + 1 FROM noise WHERE n < 350
    )
    INSERT INTO threads
      SELECT printf('00000000-0000-4000-8000-%012d', n), '/annat/projekt', 'cli', 'user',
        'Brus', 'Brus', 0, 5000 + n, 5000 + n, 5000000 + n, 5000000 + n, 5000000 + n
      FROM noise;
  `);
  const indexedCodexRows = await H.previousSessions(CWD, ['codex'], { codex: codexDb });
  ok('Codex index hittar projektet bakom mer an 300 andra sessioner',
    indexedCodexRows.length === 1
      && indexedCodexRows[0].id === '99999999-9999-4999-8999-999999999999',
    indexedCodexRows.map((r) => r.id).join(', '));
  ok('Codex index ger den riktiga titeln', indexedCodexRows[0]?.title === 'Titel fran Codex index',
    indexedCodexRows[0]?.title);
  const indexedTitles = await H.codexSessionTitles(
    ['99999999-9999-4999-8999-999999999999', '--unsafe-id'], codexDb);
  ok('Codex index kan namnge en flyttad aktiv session via dess id',
    indexedTitles.get('99999999-9999-4999-8999-999999999999') === 'Titel fran Codex index'
      && indexedTitles.size === 1);

  console.log('== opencode sessionslager ==');
  // opencode keeps everything in one SQLite file. The fixture is a minimal
  // schema the real CLI would write — enough for history, transcript and
  // usage to exercise their queries without depending on a live install.
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

  console.log('== grok sessionslager ==');
  const grokRoot = path.join(STORE, 'grok');
  const grokGroup = path.join(grokRoot, encodeURIComponent(CWD));
  const grokSid = '019f86bd-6407-7b41-82df-5c2c71c85c89';
  const grokDir = path.join(grokGroup, grokSid);
  const grokSummary = (id, cwd, title, created, updated, extra = {}) => ({
    info: { id, cwd },
    generated_title: title,
    session_summary: title ? `Reserv ${title}` : 'Reservtitel',
    created_at: created,
    updated_at: updated,
    ...extra,
  });
  write(path.join(grokDir, 'summary.json'), JSON.stringify(grokSummary(
    grokSid, CWD, 'Grok-arendet', '2026-08-01T10:00:00.000Z', '2026-08-05T11:00:00.000Z',
  )), Date.parse('2026-08-05T11:00:00.000Z'));
  for (let i = 0; i < 11; i += 1) {
    const id = `grok-extra-${String(i).padStart(2, '0')}`;
    write(path.join(grokGroup, id, 'summary.json'), JSON.stringify(grokSummary(
      id, CWD, `Extra ${i}`, '2026-07-01T10:00:00.000Z', `2026-07-${String(i + 1).padStart(2, '0')}T11:00:00.000Z`,
    )), Date.parse(`2026-07-${String(i + 1).padStart(2, '0')}T11:00:00.000Z`));
  }
  write(path.join(grokGroup, 'foreign-session', 'summary.json'), JSON.stringify(grokSummary(
    'foreign-session', '/helt/annan', 'Fel projekt', '2026-08-03T10:00:00.000Z', '2026-08-03T11:00:00.000Z',
  )));
  write(path.join(grokGroup, 'subagent-session', 'summary.json'), JSON.stringify(grokSummary(
    'subagent-session', CWD, 'Underagent', '2026-08-04T10:00:00.000Z', '2026-08-04T11:00:00.000Z',
    { session_kind: 'subagent' },
  )));
  write(path.join(grokGroup, '--unsafe', 'summary.json'), JSON.stringify(grokSummary(
    '--unsafe', CWD, 'Osaker', '2026-08-04T10:00:00.000Z', '2026-08-04T11:00:00.000Z',
  )));

  const grokRows = typeof H.grokSessions === 'function'
    ? await H.grokSessions(CWD, grokRoot)
    : [];
  ok('grok begransar listan till tio', grokRows.length === 10, String(grokRows.length));
  ok('grok nyast forst', grokRows[0] && grokRows[0].id === grokSid, grokRows.map((r) => r.id).join(', '));
  ok('grok titel och agent foljer med', grokRows[0]
    && grokRows[0].title === 'Grok-arendet' && grokRows[0].agent === 'grok');
  ok('grok tider parsas', grokRows[0]
    && grokRows[0].born === Date.parse('2026-08-01T10:00:00.000Z')
    && grokRows[0].at === Date.parse('2026-08-05T11:00:00.000Z'));
  ok('grok avvisar annan cwd, underagent och osakert id',
    !grokRows.some((r) => ['foreign-session', 'subagent-session', '--unsafe'].includes(r.id)));

  const grokUpdate = (update) => JSON.stringify({
    method: 'session/update', params: { sessionId: grokSid, update },
  }) + '\n';
  write(path.join(grokDir, 'updates.jsonl'),
    grokUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hej Grok' } })
    + grokUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hemlig tanke' } })
    + grokUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hej ' } })
    + grokUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tillbaka' } })
    + grokUpdate({ sessionUpdate: 'tool_call', title: 'Bash' })
    + grokUpdate({ sessionUpdate: 'tool_call_update', rawOutput: { secret: 'ra output' } }));
  const grokText = typeof TR.readGrok === 'function' ? TR.readGrok(CWD, grokSid, grokRoot) : null;
  ok('grok transcript lases', typeof grokText === 'string' && grokText.includes('Hej Grok'), grokText);
  ok('grok sammanfogar assistant-chunks', grokText && grokText.includes('Hej tillbaka'));
  ok('grok tanke och raw output hoppas over', grokText
    && !grokText.includes('hemlig tanke') && !grokText.includes('ra output'));
  ok('grok tool namnges', grokText && grokText.includes('[Bash]'));
  ok('grok transcript avvisar annan cwd',
    (typeof TR.readGrok === 'function' ? TR.readGrok('/helt/annan', grokSid, grokRoot) : null) === null);

  console.log('== droid sessionslager ==');
  const factoryBase = path.join(STORE, 'factory');
  const droidDir = path.join(factoryBase, 'sessions', H.claudeDirFor(CWD));
  const droidSid = 'd1d1d1d1-0000-4000-8000-000000000001';
  const droidSub = 'd2d2d2d2-0000-4000-8000-000000000002';
  const droidForeign = 'd3d3d3d3-0000-4000-8000-000000000003';
  const startLine = (id, cwd, extra = {}) => line({ type: 'session_start', id, cwd, ...extra });
  const msgLine = (role, content) => line({ type: 'message', message: { role, content } });
  const droidWhen = (iso) => Date.parse(iso);

  write(path.join(droidDir, `${droidSid}.jsonl`),
    startLine(droidSid, CWD)
    + msgLine('user', [{ type: 'text', text: 'Hej Droid' }])
    + msgLine('assistant', [
      { type: 'thinking', thinking: 'hemlig tanke' },
      { type: 'text', text: 'Hej tillbaka' },
      { type: 'tool_use', name: 'Bash' },
    ])
    + msgLine('user', [{ type: 'tool_result', content: 'ra output', tool_use_id: 't1' }])
    + line({ type: 'todo_state', todos: [] })
    + line({ type: 'agent_turn_outcome', reason: 'done', resultKind: 'ok' })
    + line({ type: 'compaction_state', summaryText: 'komprimerad sammanfattning' })
    + line({ type: 'nagot_okant', foo: 'bar' })
    + msgLine('assistant', [{ type: 'text', text: 'Klart' }]),
    droidWhen('2026-08-05T11:00:00.000Z'));
  // A subagent (callingSessionId set) is a job, not a conversation to resume.
  write(path.join(droidDir, `${droidSub}.jsonl`),
    startLine(droidSub, CWD, { callingSessionId: droidSid })
    + msgLine('user', [{ type: 'text', text: 'underuppgift' }]),
    droidWhen('2026-08-06T11:00:00.000Z'));
  write(path.join(factoryBase, 'sessions', H.claudeDirFor('/helt/annan'), `${droidForeign}.jsonl`),
    startLine(droidForeign, '/helt/annan')
    + msgLine('user', [{ type: 'text', text: 'fel projekt' }]),
    droidWhen('2026-08-07T11:00:00.000Z'));

  const droidExtra = [];
  for (let i = 0; i < 11; i += 1) {
    const id = `d0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    const iso = `2026-07-${String(i + 1).padStart(2, '0')}T11:00:00.000Z`;
    write(path.join(droidDir, `${id}.jsonl`),
      startLine(id, CWD) + msgLine('user', [{ type: 'text', text: `extra ${i}` }]), droidWhen(iso));
    droidExtra.push({ sessionId: id, cwd: CWD, title: `Extra ${i}`, mtime: droidWhen(iso) });
  }

  const droidIndex = {
    version: 4,
    entries: [
      { sessionId: droidSid, cwd: CWD, title: 'Droid-arendet', mtime: droidWhen('2026-08-05T11:00:00.000Z') },
      { sessionId: droidSub, cwd: CWD, title: 'Underagent', mtime: droidWhen('2026-08-06T11:00:00.000Z') },
      { sessionId: droidForeign, cwd: '/helt/annan', title: 'Fel projekt', mtime: droidWhen('2026-08-07T11:00:00.000Z') },
      { sessionId: 'bad id!', cwd: CWD, title: 'Osaker', mtime: droidWhen('2026-08-08T11:00:00.000Z') },
      ...droidExtra,
    ],
  };
  fsx.mkdirSync(factoryBase, { recursive: true });
  fsx.writeFileSync(path.join(factoryBase, 'sessions-index.json'), JSON.stringify(droidIndex));

  const droidRows = await H.droidSessions(CWD, factoryBase);
  ok('droid begransar listan till tio', droidRows.length === 10, String(droidRows.length));
  ok('droid huvudsession finns med', droidRows.some((r) => r.id === droidSid));
  ok('droid utesluter underagent', !droidRows.some((r) => r.id === droidSub));
  ok('droid utesluter annan cwd', !droidRows.some((r) => r.id === droidForeign));
  ok('droid utesluter osakert id', !droidRows.some((r) => r.id.includes(' ')));
  ok('droid nyast forst', droidRows[0] && droidRows[0].id === droidSid, droidRows.map((r) => r.id).join(', '));
  ok('droid titel och agent foljer med', droidRows[0]
    && droidRows[0].title === 'Droid-arendet' && droidRows[0].agent === 'droid');
  ok('droid slug som claudeDirFor', H.claudeDirFor('/srv/dev/tabdesk') === '-srv-dev-tabdesk');
  ok('droid saknad index ger tom lista',
    (await H.droidSessions(CWD, path.join(STORE, 'saknas'))).length === 0);
  const droidBadBase = path.join(STORE, 'factory-bad');
  write(path.join(droidBadBase, 'sessions-index.json'), '{ inte giltig json');
  ok('droid korrupt index ger tom lista', (await H.droidSessions(CWD, droidBadBase)).length === 0);
  const droidPrev = await H.previousSessions(CWD, ['droid'], { droid: factoryBase });
  ok('droid registrerad i PROVIDERS (via previousSessions)',
    droidPrev.some((r) => r.agent === 'droid' && r.id === droidSid));

  console.log('== droid transcript ==');
  const droidText = TR.readDroid(CWD, droidSid, factoryBase);
  ok('droid transcript lases', typeof droidText === 'string' && droidText.includes('Hej Droid'), droidText);
  ok('droid user-prompt markeras', droidText && droidText.includes('› Hej Droid'));
  ok('droid assistant-text foljer med',
    droidText && droidText.includes('Hej tillbaka') && droidText.includes('Klart'));
  ok('droid tool namnges', droidText && droidText.includes('[Bash]'));
  ok('droid thinking hoppas over', droidText && !droidText.includes('hemlig tanke'));
  ok('droid tool_result hoppas over', droidText && !droidText.includes('ra output'));
  ok('droid ovriga record-typer hoppas over',
    droidText && !droidText.includes('komprimerad sammanfattning'));
  ok('droid nas via read()',
    typeof (await TR.read(CWD, droidSid, { droid: factoryBase })) === 'string');
  ok('droid saknad session ger null',
    TR.readDroid(CWD, 'd9999999-0000-4000-8000-000000000099', factoryBase) === null);
  const droidEmptySid = 'd8888888-0000-4000-8000-000000000088';
  write(path.join(droidDir, `${droidEmptySid}.jsonl`), '');
  ok('droid tom session ger null', TR.readDroid(CWD, droidEmptySid, factoryBase) === null);
  ok('droid frammande cwd ger null', TR.readDroid('/helt/annan-katalog', droidSid, factoryBase) === null);

  console.log('== grok rendererpolicy ==');
  const rendererSource = fsx.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const grokSet = (name) => new RegExp(
    `const ${name} = new Set\\(\\[[^\\]]*'grok'[^\\]]*\\]\\)`,
  ).test(rendererSource);
  ok('grok far levande sessionstitlar', grokSet('TITLED_AGENTS'));
  ok('grok doljer kvotmatare utan data', grokSet('NO_QUOTA_AGENTS'));
  ok('grok renderer skickar ratt effort-flagga',
    /grok:\s*\[[^\]]*'xhigh'[^\]]*\]/.test(rendererSource)
    && rendererSource.includes("if (agent === 'grok') return ` --reasoning-effort ${level}`;"));

  console.log('== droid rendererpolicy ==');
  const droidInSet = (name) => new RegExp(
    `const ${name} = new Set\\(\\[[^\\]]*'droid'[^\\]]*\\]\\)`,
  ).test(rendererSource);
  // Droid is a full-screen TUI (xterm must not force its own selection) and
  // carries live titles from the session store; it does have a quota meter, so
  // it must stay out of NO_QUOTA_AGENTS.
  ok('droid valjer sig sjalv (full-tui)', droidInSet('SELECTS_ITSELF'));
  ok('droid far levande sessionstitlar', droidInSet('TITLED_AGENTS'));
  ok('droid doljer inte kvotmatare', !droidInSet('NO_QUOTA_AGENTS'));

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

  console.log('== droid-kvot ur /api/billing/limits ==');
  const DL = require(path.join(ROOT, 'droid-limits'));
  const DNOW = 1786000000000; // fast klocka: windowEnd jamfors mot den
  const droidPayload = {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 23, windowEnd: '2026-08-27T15:30:00.000Z', secondsRemaining: 18000 },
        weekly: { usedPercent: 58, windowEnd: '2026-09-02T00:00:00.000Z', secondsRemaining: 432000 },
        monthly: { usedPercent: 12, windowEnd: '2026-09-10T00:00:00.000Z', secondsRemaining: 1209600 },
      },
      core: {},
    },
    overagePreference: 'pay_as_you_go',
    canManageOverage: true,
    extraUsageBalanceCents: 0,
    extraUsageAllowed: true,
  };
  const droidWin = DL.normalize(droidPayload, DNOW);
  ok('droid fiveHour blir session',
    droidWin && droidWin.session && droidWin.session.pct === 23, JSON.stringify(droidWin && droidWin.session));
  ok('droid weekly blir week',
    droidWin && droidWin.week && droidWin.week.pct === 58, JSON.stringify(droidWin && droidWin.week));
  ok('droid monthly ignoreras',
    droidWin && !droidWin.monthly && !droidWin.scoped);
  ok('droid windowEnd blir ms',
    droidWin && droidWin.session.resetsAt === Date.parse('2026-08-27T15:30:00.000Z'));
  ok('droid procent klamms 0-100',
    DL.normalize({ limits: { standard: { fiveHour: { usedPercent: 150, windowEnd: '2099-01-01T00:00:00Z' } } } }, DNOW)
      .session.pct === 100);
  ok('droid negativ procent klamms till 0',
    DL.normalize({ limits: { standard: { fiveHour: { usedPercent: -5, windowEnd: '2099-01-01T00:00:00Z' } } } }, DNOW)
      .session.pct === 0);
  ok('droid passerad windowEnd kasseras',
    DL.normalize({ limits: { standard: { fiveHour: { usedPercent: 30, windowEnd: '2020-01-01T00:00:00Z' } } } }, DNOW)
      === null);
  ok('droid secondsRemaining ger resetsAt',
    (() => {
      const w = DL.mapWindow({ usedPercent: 10, secondsRemaining: 3600 }, DNOW);
      return w && w.resetsAt === DNOW + 3600000;
    })());
  ok('droid saknat standard ger null', DL.normalize({ limits: {} }, DNOW) === null);
  ok('droid saknad limits ger null', DL.normalize({}, DNOW) === null);
  ok('droid tom payload ger null', DL.normalize(null, DNOW) === null);
  ok('droid bara weekly ger bara week',
    (() => {
      const w = DL.normalize({ limits: { standard: { weekly: { usedPercent: 40, windowEnd: '2099-01-01T00:00:00Z' } } } }, DNOW);
      return w && w.week && !w.session;
    })());
  ok('droid ogiltig procent ger null',
    DL.mapWindow({ usedPercent: 'x', windowEnd: '2099-01-01T00:00:00Z' }, DNOW) === null);
  ok('droid decodeJwtExp parsar exp',
    (() => {
      const jwt = 'header.' + Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64') + '.sig';
      return DL.decodeJwtExp(jwt) === 1893456000;
    })());
  ok('droid decodeJwtExp ger null for ogiltig JWT',
    DL.decodeJwtExp('not-a-jwt') === null && DL.decodeJwtExp('') === null);
  ok('droid getLimits kastar aldrig',
    await DL.getLimits().then((r) => r && typeof r.ok === 'boolean', () => false));
  ok('droid skriver inte till keyring (kalla getLimits)',
    await (async () => {
      const keyringPath = path.join(os.homedir(), '.factory', 'auth.v2.keyring');
      const before = (() => { try { return fsx.statSync(keyringPath).mtimeMs; } catch (_) { return 0; } })();
      await DL.getLimits();
      const after = (() => { try { return fsx.statSync(keyringPath).mtimeMs; } catch (_) { return 0; } })();
      return before === after;
    })());
  ok('droid-limits.js ligger i build.files',
    JSON.parse(fsx.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.files.includes('droid-limits.js'));
  ok('droid meter-nycklar finns i bada sprak',
    (() => {
      const en = JSON.parse(fsx.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
      const sv = JSON.parse(fsx.readFileSync(path.join(ROOT, 'i18n', 'sv.json'), 'utf8'));
      return typeof en['bar.droidTitle'] === 'string' && typeof en['bar.droidTitleStale'] === 'string'
        && typeof sv['bar.droidTitle'] === 'string' && typeof sv['bar.droidTitleStale'] === 'string';
    })());
  ok('renderer har droid-gren i meter-tooltip',
    /metersAgent === 'droid'/.test(rendererSource)
    && rendererSource.includes("bar.droidTitleStale"));
  ok('usage:limits skickar droid till droidLimits',
    (() => {
      const mainSource = fsx.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
      return /agent === 'droid'[\s\S]*?droidLimits\.getLimits\(\)/.test(mainSource);
    })());

  console.log('== droid-kvot: TTL, staleness och felhantering ==');
  // Source-level verification of constants and implementation details that
  // are impractical to exercise live (TTL wait, staleness window, child-process
  // spawn shape). The regexes pin the contract: 60 s TTL, 15 min staleness,
  // spawn-based keytar, base64 key decode, AES-256-GCM, inFlight dedup.
  const dlSrc = fsx.readFileSync(path.join(ROOT, 'droid-limits.js'), 'utf8');
  ok('droid TTL ar 60 sekunder', /TTL_MS\s*=\s*60000/.test(dlSrc));
  ok('droid staleness-traskel ar 15 minuter', /STALE_MS\s*=\s*15\s*\*\s*60000/.test(dlSrc));
  ok('droid token via child node (spawn)', /spawn\s*\(\s*NODE_BIN/.test(dlSrc));
  ok('droid base64-avkodning av nyckel',
    /Buffer\.from\([^)]*,\s*['"]base64['"]/.test(dlSrc));
  ok('droid AES-256-GCM dekryptering',
    /createDecipheriv\(\s*['"]aes-256-gcm['"]/.test(dlSrc));
  ok('droid inFlight dedup finns', /if \(inFlight\) return inFlight/.test(dlSrc));
  ok('droid staleness logik (lastGood inom STALE_MS)',
    /lastGood\s*&&\s*Date\.now\(\)\s*-\s*lastGood\.at\s*<\s*STALE_MS/.test(dlSrc));
  ok('droid auth-fel ger inte stale data',
    /result\.reason\s*!==\s*['"]auth['"]/.test(dlSrc));
  ok('droid skriver inte till keyring (kallkod)',
    !/writeFileSync|writeFile|appendFile/.test(dlSrc));
  ok('droid token cache med JWT-expiry',
    /tokenCache\s*&&\s*tokenCache\.exp/.test(dlSrc));

  // --- Fixture-based failure/success tests ---
  // Each scenario re-requires droid-limits with tailored env vars so the
  // module-level cache starts empty. Env vars are restored at the end.
  const DL_REQ_PATH = require.resolve(path.join(ROOT, 'droid-limits'));
  const savedEnv = {
    TABDESK_NODE_BIN: process.env.TABDESK_NODE_BIN,
    TABDESK_KEYTAR_NODE: process.env.TABDESK_KEYTAR_NODE,
    TABDESK_KEYRING_FILE: process.env.TABDESK_KEYRING_FILE,
    FACTORY_API_BASE_URL: process.env.FACTORY_API_BASE_URL,
  };
  const meterTmp = fsx.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-droid-meter-'));

  // Graceful failure: missing node binary → keytarKey returns null.
  process.env.TABDESK_NODE_BIN = '/nonexistent/node-' + Date.now();
  delete require.cache[DL_REQ_PATH];
  const DL_NO_NODE = require(path.join(ROOT, 'droid-limits'));
  const noNodeRes = await DL_NO_NODE.getLimits();
  ok('droid saknad node ger ok:false', noNodeRes && noNodeRes.ok === false, JSON.stringify(noNodeRes));
  ok('droid saknad node ger reason keyring-locked',
    noNodeRes && noNodeRes.reason === 'keyring-locked', JSON.stringify(noNodeRes));

  // TTL cache: second call within 60 s returns the exact same cached object.
  const noNodeRes2 = await DL_NO_NODE.getLimits();
  ok('droid TTL cache returnerar samma objekt', noNodeRes === noNodeRes2);

  // inFlight dedup: two concurrent calls on a fresh module resolve to the
  // same result object (both share the same inFlight promise). getLimits is
  // async so each call returns a new outer Promise, but both adopt the same
  // inFlight — so the resolved values are the exact same object reference.
  delete require.cache[DL_REQ_PATH];
  const DL_DEDUP = require(path.join(ROOT, 'droid-limits'));
  const dedupP1 = DL_DEDUP.getLimits();
  const dedupP2 = DL_DEDUP.getLimits();
  const [dedupR1, dedupR2] = await Promise.all([dedupP1, dedupP2]);
  ok('droid inFlight dedup ger samma resultat-objekt', dedupR1 === dedupR2,
    'r1=' + JSON.stringify(dedupR1) + ' r2=' + JSON.stringify(dedupR2));

  // Create a valid AES-256-GCM encrypted keyring with a fake JWT so the full
  // chain (keytar → decrypt → API) can be exercised against a mock server.
  const knownKey = crypto.randomBytes(32);
  const knownIv = crypto.randomBytes(12);
  const fakeJwt = 'hdr.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64') + '.sig';
  const plainBuf = Buffer.from(JSON.stringify({ access_token: fakeJwt }));
  const enc = crypto.createCipheriv('aes-256-gcm', knownKey, knownIv);
  const encBytes = Buffer.concat([enc.update(plainBuf), enc.final()]);
  const encTag = enc.getAuthTag();
  const validKeyring = path.join(meterTmp, 'valid.keyring');
  fsx.writeFileSync(validKeyring,
    knownIv.toString('base64') + ':' + encTag.toString('base64') + ':' + encBytes.toString('base64'));
  const validKeytar = path.join(meterTmp, 'valid-keytar.js');
  fsx.writeFileSync(validKeytar,
    'module.exports = { getPassword: async () => ' + JSON.stringify(knownKey.toString('base64')) + ' };');

  // Graceful failure: valid keytar but garbage keyring → decryptKeyring null.
  const badKeyring = path.join(meterTmp, 'bad.keyring');
  fsx.writeFileSync(badKeyring, 'garbage:not-encrypted:data');
  process.env.TABDESK_NODE_BIN = '/usr/bin/node';
  process.env.TABDESK_KEYTAR_NODE = validKeytar;
  process.env.TABDESK_KEYRING_FILE = badKeyring;
  delete require.cache[DL_REQ_PATH];
  const DL_BAD_KEY = require(path.join(ROOT, 'droid-limits'));
  const badKeyRes = await DL_BAD_KEY.getLimits();
  ok('droid trasig keyring ger ok:false', badKeyRes && badKeyRes.ok === false, JSON.stringify(badKeyRes));
  ok('droid trasig keyring ger reason keyring-locked',
    badKeyRes && badKeyRes.reason === 'keyring-locked', JSON.stringify(badKeyRes));

  // Mock API server for success and HTTP failure modes.
  const http = require('http');
  let mockStatus = 200;
  let mockBody = JSON.stringify({
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 42, windowEnd: new Date(Date.now() + 3600000).toISOString(), secondsRemaining: 3600 },
        weekly: { usedPercent: 67, windowEnd: new Date(Date.now() + 86400000).toISOString(), secondsRemaining: 86400 },
      },
    },
  });
  const mockServer = http.createServer((req, res) => {
    res.writeHead(mockStatus, { 'Content-Type': 'application/json' });
    res.end(mockStatus === 200 ? mockBody : '');
  });
  mockServer.on('error', () => { /* swallow — test checks return values */ });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;

  process.env.TABDESK_KEYTAR_NODE = validKeytar;
  process.env.TABDESK_KEYRING_FILE = validKeyring;
  process.env.FACTORY_API_BASE_URL = 'http://127.0.0.1:' + mockPort;

  // Successful API call → { ok: true, session.pct: 42, week.pct: 67 }.
  delete require.cache[DL_REQ_PATH];
  const DL_OK = require(path.join(ROOT, 'droid-limits'));
  const okRes = await DL_OK.getLimits();
  ok('droid mock-API ger ok:true', okRes && okRes.ok === true, JSON.stringify(okRes));
  ok('droid mock-API session procent 42', okRes && okRes.session && okRes.session.pct === 42);
  ok('droid mock-API week procent 67', okRes && okRes.week && okRes.week.pct === 67);

  // TTL cache: second call returns the same cached object (no new API call).
  const okRes2 = await DL_OK.getLimits();
  ok('droid mock-API TTL cache returnar samma objekt', okRes === okRes2);

  // 401 → { ok: false, reason: 'auth' } (no stale data even with prior good).
  mockStatus = 401;
  delete require.cache[DL_REQ_PATH];
  const DL_401 = require(path.join(ROOT, 'droid-limits'));
  const authFailRes = await DL_401.getLimits();
  ok('droid 401 ger ok:false reason auth',
    authFailRes && authFailRes.ok === false && authFailRes.reason === 'auth', JSON.stringify(authFailRes));

  // 500 → { ok: false, reason: 'http:500' }.
  mockStatus = 500;
  delete require.cache[DL_REQ_PATH];
  const DL_500 = require(path.join(ROOT, 'droid-limits'));
  const httpFailRes = await DL_500.getLimits();
  ok('droid 500 ger ok:false reason http:500',
    httpFailRes && httpFailRes.ok === false && httpFailRes.reason === 'http:500', JSON.stringify(httpFailRes));

  // 200 with valid JSON but no limits.standard → { ok: false, reason: 'shape' }.
  mockStatus = 200;
  mockBody = JSON.stringify({ foo: 'bar' });
  delete require.cache[DL_REQ_PATH];
  const DL_SHAPE = require(path.join(ROOT, 'droid-limits'));
  const shapeFailRes = await DL_SHAPE.getLimits();
  ok('droid felaktig shape ger ok:false reason shape',
    shapeFailRes && shapeFailRes.ok === false && shapeFailRes.reason === 'shape', JSON.stringify(shapeFailRes));

  // Network unreachable (server closed) → { ok: false, reason: 'network' }.
  await new Promise((resolve) => mockServer.close(resolve));
  delete require.cache[DL_REQ_PATH];
  const DL_NET = require(path.join(ROOT, 'droid-limits'));
  const netFailRes = await DL_NET.getLimits();
  ok('droid narverk fel ger ok:false', netFailRes && netFailRes.ok === false, JSON.stringify(netFailRes));

  // Never throws: every failure mode above returned a plain object with ok.
  ok('droid alla felhanteringar returnerar objekt (kastar aldrig)',
    [noNodeRes, badKeyRes, authFailRes, httpFailRes, shapeFailRes, netFailRes]
      .every((r) => r && typeof r === 'object' && typeof r.ok === 'boolean'));

  // Cleanup env and temp fixtures.
  for (const ek of Object.keys(savedEnv)) {
    if (savedEnv[ek] === undefined) delete process.env[ek];
    else process.env[ek] = savedEnv[ek];
  }
  delete require.cache[DL_REQ_PATH];
  try { fsx.rmSync(meterTmp, { recursive: true, force: true }); } catch (_) { /* gone */ }

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
  ok('grok har egna effort-nivaer',
    EF.list('grok').map((r) => r.id).join(',') === 'default,none,minimal,low,medium,high,xhigh,max');
  ok('agent utan installning far inga rader', EF.list('gemini').length === 0 && !EF.supports('gemini'));
  ok('claude-flaggan', EF.flagFor('claude', 'xhigh') === ' --effort xhigh');
  ok('ultracode ar ett eget lage, inte en niva hos codex',
    EF.flagFor('claude', 'ultracode') === ' --effort ultracode' && EF.flagFor('codex', 'ultracode') === '');
  ok('ultracode forklarar sig i menyn',
    (EF.list('claude').find((r) => r.id === 'ultracode') || {}).hint === 'bar.effort.hint.ultracode');
  ok('codex-flaggan ar en config-override', EF.flagFor('codex', 'ultra') === ' -c model_reasoning_effort=ultra');
  ok('grok effort blir CLI-flagga', EF.flagFor('grok', 'xhigh') === ' --reasoning-effort xhigh');
  ok('default ger ingen flagga', EF.flagFor('claude', 'default') === '');
  ok('nivan maste finnas hos agenten', EF.flagFor('claude', 'ultra') === '' && EF.flagFor('codex', 'max') === '');
  ok('agent utan installning ger ingen flagga', EF.flagFor('gemini', 'high') === '');
  const EFPROJ = '/tmp/tabdesk-effort-proj';
  ok('okand niva avvisas', EF.setFor(EFPROJ, 'codex', 'turbo').ok === false);
  ok('giltig niva sparas per agent', EF.setFor(EFPROJ, 'codex', 'ultra').ok === true
    && EF.getFor(EFPROJ, 'codex') === 'ultra' && EF.getFor(EFPROJ, 'claude') === 'default');
  ok('default tar bort posten', EF.setFor(EFPROJ, 'codex', 'default').ok === true
    && EF.getFor(EFPROJ, 'codex') === 'default');

  console.log('== autonomi (droid) ==');
  const AU = require(path.join(ROOT, 'autonomy'));
  ok('autonomy exporterar hela API:t',
    ['list', 'supports', 'globalDefault', 'getFor', 'setFor', 'flagFor', 'isEnvFlag', 'keyFor', 'LEVELS']
      .every((k) => AU[k] !== undefined));
  ok('bara droid har autonomi', AU.supports('droid') === true && AU.supports('claude') === false);
  ok('droid har egna nivaer', AU.LEVELS.droid.join(',') === 'low,medium,high');
  ok('list ger default plus nivaer',
    AU.list('droid').map((r) => r.id).join(',') === 'default,low,medium,high');
  ok('agent utan autonomi far inga rader', AU.list('claude').length === 0);
  // ~/.factory/settings.json has autonomyLevel "off" here, which falls back to
  // medium — the same result as a missing value.
  ok('globalDefault ger medium for off/saknad', AU.globalDefault('droid') === 'medium');
  ok('default injicerar alltid den upplosta nivan',
    AU.flagFor('droid', 'default') === ` --auto ${AU.globalDefault('droid')}`);
  ok('explicit niva blir --auto', AU.flagFor('droid', 'high') === ' --auto high');
  ok('okand agent ger ingen flagga', AU.flagFor('claude', 'high') === '');
  ok('autonomi ar aldrig en env-flagga',
    AU.isEnvFlag(AU.flagFor('droid', 'high')) === false
    && AU.isEnvFlag(AU.flagFor('droid', 'default')) === false);
  const AUPROJ = '/tmp/tabdesk-autonomy-proj';
  ok('okand niva avvisas', AU.setFor(AUPROJ, 'droid', 'turbo').ok === false);
  ok('agent utan autonomi avvisas', AU.setFor(AUPROJ, 'claude', 'high').ok === false);
  ok('giltig niva sparas', AU.setFor(AUPROJ, 'droid', 'high').ok === true
    && AU.getFor(AUPROJ, 'droid') === 'high');
  ok('default tar bort posten (autonomi)', AU.setFor(AUPROJ, 'droid', 'default').ok === true
    && AU.getFor(AUPROJ, 'droid') === 'default');
  const SET = require(path.join(ROOT, 'settings'));
  ok('settings DEFAULTS har projectAutonomies',
    SET.DEFAULTS.projectAutonomies && typeof SET.DEFAULTS.projectAutonomies === 'object'
    && Object.keys(SET.DEFAULTS.projectAutonomies).length === 0);
  const pkg = JSON.parse(fsx.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('autonomy.js ligger i build.files', pkg.build.files.includes('autonomy.js'));
  const enJson = JSON.parse(fsx.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
  const svJson = JSON.parse(fsx.readFileSync(path.join(ROOT, 'i18n', 'sv.json'), 'utf8'));
  const autonomyKeys = ['bar.autonomy', 'bar.autonomy.follows', 'toast.autonomySet', 'toast.autonomyLater', 'toast.autonomyFailed'];
  ok('autonomi-nycklar finns i bada sprak',
    autonomyKeys.every((k) => typeof enJson[k] === 'string' && typeof svJson[k] === 'string'));

  console.log('== autonomi rendererpolicy ==');
  ok('renderer AUTONOMY_LEVELS.droid',
    /AUTONOMY_LEVELS\s*=\s*\{\s*droid:\s*\[[^\]]*'low'[^\]]*'medium'[^\]]*'high'[^\]]*\]/.test(rendererSource));
  // The explicit droid branch must emit --auto, not fall through to Codex's
  // -c model_reasoning_effort= tail the effort bar uses for unknown agents.
  const autonomyFlagBody = (rendererSource.match(/function autonomyFlag[\s\S]*?\n}/) || [''])[0];
  ok('renderer autonomyFlag har egen droid-gren (ingen Codex-fallthrough)',
    /if \(agent === 'droid'\)/.test(autonomyFlagBody)
    && autonomyFlagBody.includes('--auto')
    && !autonomyFlagBody.includes('model_reasoning_effort'));

  console.log('== codex-modeller ur rollouttext ==');
  const MD = require(path.join(ROOT, 'model'));
  const mtext = '{"model":"gpt-5.6-sol"}\n{"model":"gpt-5.6-terra"}\n{"model":"gpt-5.6-sol"}\n{"model":"bad;rm"}';
  const mids = MD.codexModelsFromText(mtext);
  ok('distinkta modeller utan dubbletter', mids.length === 2 && mids.includes('gpt-5.6-sol') && mids.includes('gpt-5.6-terra'), mids.join(','));
  ok('osakra id avvisas', !mids.some((x) => x.includes(';')));
  ok('tom text ger tom lista', MD.codexModelsFromText('inget har').length === 0);
  const grokModels = typeof MD.grokModelsFromText === 'function' ? MD.grokModelsFromText([
    'Default model: grok-4.6',
    'Available models:',
    '  * grok-4.6 (default)',
    '  - grok-4.5',
    '  - bad;rm',
  ].join('\n')) : [];
  ok('grok-modeller parsas', grokModels.join(',') === 'grok-4.6,grok-4.5', grokModels.join(','));

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
  const GROKHOME = path.join(PROFILE, 'grok-home');
  const GROKBIN = path.join(PROFILE, 'bin');
  fsx.mkdirSync(INSPROJ, { recursive: true });
  fsx.mkdirSync(GROKBIN, { recursive: true });
  fsx.writeFileSync(path.join(GROKBIN, 'grok'), '#!/bin/sh\nexit 0\n');
  fsx.chmodSync(path.join(GROKBIN, 'grok'), 0o755);
  fsx.writeFileSync(path.join(GROKBIN, 'droid'), '#!/bin/sh\nexit 0\n');
  fsx.chmodSync(path.join(GROKBIN, 'droid'), 0o755);
  process.env.TABDESK_PROJECTS_DIR = INSROOT;
  process.env.GROK_HOME = GROKHOME;
  process.env.PATH = GROKBIN + path.delimiter + process.env.PATH;
  const AG = require(path.join(ROOT, 'agents'));
  const grokAgent = AG.list().find((agent) => agent.id === 'grok');
  ok('grok finns i agentlistan', grokAgent
    && grokAgent.label === 'Grok'
    && grokAgent.command === 'grok --permission-mode auto'
    && grokAgent.takesModel
    && grokAgent.resumeArgs === '--resume {id}'
    && grokAgent.continueArgs === '--continue');
  // Droid: plain `droid` command (the autonomy bar adds --auto), no model flag,
  // `-r`/`-r {id}` for continue/resume so the ↺ chip appears in the overview.
  const droidAgent = AG.list().find((agent) => agent.id === 'droid');
  ok('droid finns i agentlistan', droidAgent
    && droidAgent.label === 'Droid'
    && droidAgent.command === 'droid'
    && droidAgent.takesModel === false
    && droidAgent.resumeArgs === '-r {id}'
    && droidAgent.continueArgs === '-r'
    && droidAgent.hint === 'agent.hint.droid');
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
  ok('grok anvander projektets AGENTS.md',
    (() => { const r = INS.read('grok', 'project', INSPROJ); return r.ok && r.path === path.join(INSPROJ, 'AGENTS.md'); })());
  ok('grok anvander global AGENTS.md',
    (() => { const r = INS.read('grok', 'global', INSPROJ); return r.ok && r.path === path.join(GROKHOME, 'AGENTS.md'); })());

  ok('droid finns i instruktionslistan',
    INS.list(INSPROJ).some((e) => e.id === 'droid'));
  ok('droid anvander projektets AGENTS.md',
    (() => { const r = INS.read('droid', 'project', INSPROJ); return r.ok && r.path === path.join(INSPROJ, 'AGENTS.md'); })());
  // The global file resolves under the real ~/.factory, so this only reads the
  // resolved path (never writes there) — the write path is exercised on the
  // project scope below, which lands in the scratch projects root.
  ok('droid global pekar pa ~/.factory/AGENTS.md',
    (() => { const r = INS.read('droid', 'global', INSPROJ); return r.ok && r.path === path.join(os.homedir(), '.factory', 'AGENTS.md'); })());
  ok('droid skriver och laser projektfilen',
    INS.write('droid', 'project', INSPROJ, '# Droidregler\n').ok === true
    && fsx.readFileSync(path.join(INSPROJ, 'AGENTS.md'), 'utf8') === '# Droidregler\n');

  try { fsx.rmSync(INSROOT, { recursive: true, force: true }); } catch (_) { /* gone */ }
  }


  cleanup();
  app.exit(fail ? 1 : 0);
});
