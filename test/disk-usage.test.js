const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const disk = require('../disk-usage');

test('fromStat reports used as occupied blocks times block size', () => {
  const result = disk.fromStat({
    bsize: 4096,
    blocks: 1000,
    bfree: 250,
    bavail: 200,
  });
  assert.deepEqual(result, { diskUsed: 3072000, diskTotal: 4096000 });
});

test('fromStat counts reserved blocks as used, not free', () => {
  const result = disk.fromStat({
    bsize: 1024,
    blocks: 100,
    bfree: 30,
    bavail: 10,
  });
  assert.equal(result.diskUsed, 71680);
  assert.equal(result.diskTotal, 102400);
});

test('read("/") matches this machine\'s root filesystem', () => {
  const s = fs.statfsSync('/');
  const result = disk.read('/');
  assert.ok(result.diskTotal > 0);
  assert.ok(result.diskUsed >= 0);
  assert.ok(result.diskUsed <= result.diskTotal);
  assert.equal(result.diskTotal, Number(s.blocks) * Number(s.bsize));
  assert.equal(result.diskUsed, (Number(s.blocks) - Number(s.bfree)) * Number(s.bsize));
});
