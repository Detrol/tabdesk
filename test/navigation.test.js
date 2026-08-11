const test = require('node:test');
const assert = require('node:assert/strict');

const Navigation = require('../renderer/navigation');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('only the latest navigation generation remains current', () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  const first = navigation.next();
  const second = navigation.next();

  assert.equal(navigation.isCurrent(first), false);
  assert.equal(navigation.isCurrent(second), true);
});

test('later navigation during session details releases once without commit or pin', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  const details = deferred();
  let releases = 0;
  let commits = 0;
  let pins = 0;
  const token = navigation.next();
  const pending = navigation.runSession(token, {
    allocate: async () => ({ session: 'reserved-1', suffix: 0 }),
    load: () => details.promise,
    release: () => { releases += 1; },
    commit: () => { commits += 1; return 'tab-1'; },
  });

  await Promise.resolve();
  navigation.next();
  details.resolve(['model', 'effort']);
  const id = await pending;
  if (id) pins += 1;

  assert.equal(id, null);
  assert.equal(releases, 1);
  assert.equal(commits, 0);
  assert.equal(pins, 0);
});

test('later navigation during session allocation releases once before loading details', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  const allocation = deferred();
  let loads = 0;
  let releases = 0;
  let commits = 0;
  const pending = navigation.runSession(navigation.next(), {
    allocate: () => allocation.promise,
    load: async () => { loads += 1; return ['model', 'effort']; },
    release: () => { releases += 1; },
    commit: () => { commits += 1; return 'tab-allocation'; },
  });

  navigation.next();
  allocation.resolve({ session: 'reserved-allocation', suffix: 0 });
  const id = await pending;

  assert.equal(id, null);
  assert.equal(releases, 1);
  assert.equal(loads, 0);
  assert.equal(commits, 0);
});

test('session detail failure after reservation releases exactly once', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  let releases = 0;
  let commits = 0;
  const id = await navigation.runSession(navigation.next(), {
    allocate: async () => ({ session: 'reserved-2', suffix: 0 }),
    load: async () => { throw new Error('expected model failure'); },
    release: () => { releases += 1; },
    commit: () => { commits += 1; return 'tab-2'; },
  });

  assert.equal(id, null);
  assert.equal(releases, 1);
  assert.equal(commits, 0);
});

test('current successful session commits without releasing its reservation', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  let releases = 0;
  let commits = 0;
  const allocation = { session: 'reserved-3', suffix: 0 };
  const details = ['model', 'effort'];
  const id = await navigation.runSession(navigation.next(), {
    allocate: async () => allocation,
    load: async () => details,
    release: () => { releases += 1; },
    commit: (actualAllocation, actualDetails) => {
      commits += 1;
      assert.strictEqual(actualAllocation, allocation);
      assert.strictEqual(actualDetails, details);
      return 'tab-3';
    },
  });

  assert.equal(id, 'tab-3');
  assert.equal(releases, 0);
  assert.equal(commits, 1);
});

test('six pinned terminals reserve one visible slot for an unpinned active terminal', () => {
  assert.equal(typeof Navigation.shownTerminalIds, 'function');
  const pinned = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  const ids = Navigation.shownTerminalIds({
    pinned,
    activeId: 'active',
    hasTab: () => true,
    maximum: 6,
  });

  assert.deepEqual(ids, ['p1', 'p2', 'p3', 'p4', 'p5', 'active']);
  assert.deepEqual([...pinned], ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.equal(ids.length + 1, 7); // Files is the one additional special panel.
});
