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
  let creates = 0;
  let pins = 0;
  const token = navigation.next();
  const pending = navigation.runSession(token, {
    allocate: async () => ({ session: 'reserved-1', suffix: 0 }),
    load: () => details.promise,
    release: () => { releases += 1; },
    create: () => { creates += 1; return 'tab-1'; },
    activate: (id) => id,
    rollback: () => {},
  });

  await Promise.resolve();
  navigation.next();
  details.resolve(['model', 'effort']);
  const id = await pending;
  if (id) pins += 1;

  assert.equal(id, null);
  assert.equal(releases, 1);
  assert.equal(creates, 0);
  assert.equal(pins, 0);
});

test('later navigation during session allocation releases once before loading details', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  const allocation = deferred();
  let loads = 0;
  let releases = 0;
  let creates = 0;
  const pending = navigation.runSession(navigation.next(), {
    allocate: () => allocation.promise,
    load: async () => { loads += 1; return ['model', 'effort']; },
    release: () => { releases += 1; },
    create: () => { creates += 1; return 'tab-allocation'; },
    activate: (id) => id,
    rollback: () => {},
  });

  navigation.next();
  allocation.resolve({ session: 'reserved-allocation', suffix: 0 });
  const id = await pending;

  assert.equal(id, null);
  assert.equal(releases, 1);
  assert.equal(loads, 0);
  assert.equal(creates, 0);
});

test('session detail failure after reservation releases exactly once', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  let releases = 0;
  let creates = 0;
  const id = await navigation.runSession(navigation.next(), {
    allocate: async () => ({ session: 'reserved-2', suffix: 0 }),
    load: async () => { throw new Error('expected model failure'); },
    release: () => { releases += 1; },
    create: () => { creates += 1; return 'tab-2'; },
    activate: (id) => id,
    rollback: () => {},
  });

  assert.equal(id, null);
  assert.equal(releases, 1);
  assert.equal(creates, 0);
});

test('current successful session creates and activates without releasing its reservation', async () => {
  assert.equal(typeof Navigation.createNavigation, 'function');
  const navigation = Navigation.createNavigation();
  let releases = 0;
  let creates = 0;
  const allocation = { session: 'reserved-3', suffix: 0 };
  const details = ['model', 'effort'];
  const id = await navigation.runSession(navigation.next(), {
    allocate: async () => allocation,
    load: async () => details,
    release: () => { releases += 1; },
    create: (actualAllocation, actualDetails) => {
      creates += 1;
      assert.strictEqual(actualAllocation, allocation);
      assert.strictEqual(actualDetails, details);
      return { id: 'tab-3' };
    },
    activate: (created) => created.id,
    rollback: () => {},
  });

  assert.equal(id, 'tab-3');
  assert.equal(releases, 0);
  assert.equal(creates, 1);
});

test('failed activation rolls back the created session before releasing its reservation', async () => {
  const navigation = Navigation.createNavigation();
  const created = { id: 'tab-false' };
  let rollbacks = 0;
  let releases = 0;
  const result = await navigation.runSession(navigation.next(), {
    allocate: async () => ({ session: 'reserved-false', suffix: 0 }),
    load: async () => ['model', 'effort'],
    release: () => { releases += 1; },
    create: () => created,
    activate: () => false,
    rollback: (actual) => {
      assert.strictEqual(actual, created);
      rollbacks += 1;
    },
  });

  assert.equal(result, null);
  assert.equal(rollbacks, 1);
  assert.equal(releases, 1);
});

test('throwing activation rolls back the created session and releases exactly once', async () => {
  const navigation = Navigation.createNavigation();
  const created = { id: 'tab-throw' };
  let rollbacks = 0;
  let releases = 0;
  const result = await navigation.runSession(navigation.next(), {
    allocate: async () => ({ session: 'reserved-throw', suffix: 0 }),
    load: async () => ['model', 'effort'],
    release: () => { releases += 1; },
    create: () => created,
    activate: () => { throw new Error('expected activation failure'); },
    rollback: (actual) => {
      assert.strictEqual(actual, created);
      rollbacks += 1;
    },
  });

  assert.equal(result, null);
  assert.equal(rollbacks, 1);
  assert.equal(releases, 1);
});

test('successful activation keeps the created session and reservation', async () => {
  const navigation = Navigation.createNavigation();
  const created = { id: 'tab-success' };
  let rollbacks = 0;
  let releases = 0;
  const result = await navigation.runSession(navigation.next(), {
    allocate: async () => ({ session: 'reserved-success', suffix: 0 }),
    load: async () => ['model', 'effort'],
    release: () => { releases += 1; },
    create: () => created,
    activate: (actual) => {
      assert.strictEqual(actual, created);
      return actual.id;
    },
    rollback: () => { rollbacks += 1; },
  });

  assert.equal(result, 'tab-success');
  assert.equal(rollbacks, 0);
  assert.equal(releases, 0);
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

test('only terminals selected into the six visible slots are watched', () => {
  const pinned = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  const selection = {
    pinned,
    activeId: 'active',
    hasTab: () => true,
    maximum: 6,
  };

  assert.equal(Navigation.isTerminalWatched({ ...selection, id: 'p1' }), true);
  assert.equal(Navigation.isTerminalWatched({ ...selection, id: 'active' }), true);
  assert.equal(Navigation.isTerminalWatched({ ...selection, id: 'p6' }), false);
  assert.deepEqual([...pinned], ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
});
