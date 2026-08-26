const fs = require('fs');

/**
 * @param {{bsize: number, blocks: number, bfree: number}} s
 * @returns {{diskUsed: number, diskTotal: number}}
 */
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
