const test = require('node:test');
const assert = require('node:assert/strict');
const createLogger = require('../lib/logging');

// Run a function while capturing one console sink, returning the parsed JSON
// records it produced. Non-JSON lines (none expected here) come back as null so
// a stray console.log from another path can't masquerade as a log record.
function capture(consoleMethod, fn) {
  const original = console[consoleMethod];
  const lines = [];
  console[consoleMethod] = (...args) => lines.push(args.map(String).join(' '));
  try { fn(); } finally { console[consoleMethod] = original; }
  return lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } });
}

test('createLogger emits one JSON record per call with the right fields', () => {
  const log = createLogger('test-unit');
  const records = capture('warn', () => log.warn('hello', { port: 7000 }));
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'warn');
  assert.equal(records[0].component, 'test-unit');
  assert.equal(records[0].msg, 'hello');
  assert.equal(records[0].port, 7000);
  assert.ok(records[0].ts, 'record carries a timestamp');
});

test('error records carry the message and stack of an Error', () => {
  const log = createLogger('test-unit');
  const err = new Error('boom');
  const records = capture('error', () => log.error('failed', { error: err }));
  assert.equal(records.length, 1);
  assert.equal(records[0].error.message, 'boom');
  assert.ok(records[0].error.stack, 'error stack is preserved for diagnostics');
});

test('error records carry the code when present', () => {
  const log = createLogger('test-unit');
  const err = Object.assign(new Error('enoent'), { code: 'ENOENT' });
  const records = capture('error', () => log.error('open failed', { error: err }));
  assert.equal(records[0].error.code, 'ENOENT');
});

test('debug is filtered out at the default info level', () => {
  const log = createLogger('test-unit');
  const lines = capture('log', () => log.debug('noisy'));
  assert.equal(lines.length, 0);
});

test('TABDESK_LOG_LEVEL=debug lets debug records through', () => {
  const log = createLogger('test-unit');
  process.env.TABDESK_LOG_LEVEL = 'debug';
  try {
    const records = capture('log', () => log.debug('now visible'));
    assert.equal(records.length, 1);
    assert.equal(records[0].level, 'debug');
  } finally {
    delete process.env.TABDESK_LOG_LEVEL;
  }
});

test('TABDESK_LOG_LEVEL=warn suppresses info records', () => {
  const log = createLogger('test-unit');
  process.env.TABDESK_LOG_LEVEL = 'warn';
  try {
    const lines = capture('log', () => log.info('quiet please'));
    assert.equal(lines.length, 0);
  } finally {
    delete process.env.TABDESK_LOG_LEVEL;
  }
});

test('a scalar context is stored under the context key', () => {
  const log = createLogger('test-unit');
  const records = capture('log', () => log.info('noted', 42));
  assert.equal(records[0].context, 42);
});

test('the default logger is scoped to app', () => {
  const records = capture('log', () => createLogger.logger.info('boot'));
  assert.equal(records[0].component, 'app');
});
