const assert = require('node:assert/strict');
const test = require('node:test');
const { createLogger } = require('../logger');

test('structured logger emits JSON with scope and event fields', () => {
  const records = [];
  const originalInfo = console.info;
  console.info = (line) => records.push(JSON.parse(line));
  try {
    createLogger('settings').info('loaded', { projectsDir: '/tmp/projects' });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    timestamp: records[0].timestamp,
    level: 'info',
    scope: 'settings',
    event: 'loaded',
    projectsDir: '/tmp/projects',
  });
  assert.match(records[0].timestamp, /^\d{4}-\d\d-\d\dT/);
});

test('structured logger redacts sensitive fields and serializes errors', () => {
  const records = [];
  const originalWarn = console.warn;
  console.warn = (line) => records.push(JSON.parse(line));
  try {
    createLogger('sync').warn('connection_failed', {
      password: 'do-not-log',
      nested: { accessToken: 'also-do-not-log' },
      error: new Error('connection refused'),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(records[0].password, '[REDACTED]');
  assert.equal(records[0].nested.accessToken, '[REDACTED]');
  assert.equal(records[0].error.message, 'connection refused');
  assert.equal(records[0].error.name, 'Error');
});
