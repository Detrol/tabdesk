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

  console.log('== sammanslagen lista ==');
  const where = { claude: path.join(STORE, 'claude'), codex: croot };
  const merged = await H.previousSessions(CWD, ['claude', 'codex'], where);
  ok('bada agenterna kommer med', merged.length === 4, String(merged.length));
  ok('sorterad pa tid', merged.every((r, i) => i === 0 || merged[i - 1].at >= r.at));
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


  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  cleanup();
  app.exit(fail ? 1 : 0);
});
