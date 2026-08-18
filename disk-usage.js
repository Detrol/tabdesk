const fs = require('fs');

function fromStat(s) {
  const bsize = Number(s.bsize);
  const blocks = Number(s.blocks);
  const bfree = Number(s.bfree);
  return {
    diskUsed: (blocks - bfree) * bsize,
    diskTotal: blocks * bsize,
  };
}

function read(target = '/') {
  return fromStat(fs.statfsSync(target));
}

module.exports = { fromStat, read };
