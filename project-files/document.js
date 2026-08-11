const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

function failure(error) {
  return { ok: false, error };
}

function fileError(error, fallback = 'unreadable') {
  if (error && error.code === 'ENOENT') return 'deleted';
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return 'permission-denied';
  return fallback;
}

function revision(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decode(bytes) {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (_) {
    return failure('not-text');
  }
  if (raw.includes('\0')) return failure('not-text');
  const counts = [
    ['\r\n', (raw.match(/\r\n/g) || []).length],
    ['\n', (raw.match(/(?<!\r)\n/g) || []).length],
    ['\r', (raw.match(/\r(?!\n)/g) || []).length],
  ];
  counts.sort((left, right) => right[1] - left[1]);
  const lineEnding = counts[0][1] ? counts[0][0] : '\n';
  return {
    ok: true,
    content: raw.replace(/\r\n?/g, '\n'),
    format: {
      bom,
      lineEnding,
      trailingNewline: /(?:\r\n|\r|\n)$/.test(raw),
    },
  };
}

function readBytes(target, io) {
  let fd;
  try {
    const before = io.statSync(target.real);
    if (!before.isFile()) return failure('not-file');
    if (before.size > MAX_BYTES) return failure('too-large');
    fd = io.openSync(target.real, 'r');
    const opened = io.fstatSync(fd);
    if (!opened.isFile()) return failure('not-file');
    if (opened.size > MAX_BYTES) return failure('too-large');

    const chunks = [];
    let total = 0;
    while (total <= MAX_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, (MAX_BYTES + 1) - total));
      const count = io.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      chunks.push(chunk.subarray(0, count));
    }
    if (total > MAX_BYTES) return failure('too-large');
    return { ok: true, bytes: Buffer.concat(chunks, total), mode: opened.mode };
  } catch (error) {
    return failure(fileError(error));
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch (_) { /* best effort after a read failure */ }
    }
  }
}

function readDocument(target, options = {}) {
  const io = options.fs || fs;
  const snapshot = readBytes(target, io);
  if (!snapshot.ok) return snapshot;
  const decoded = decode(snapshot.bytes);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    content: decoded.content,
    revision: revision(snapshot.bytes),
    format: decoded.format,
  };
}

function encode(content, format) {
  if (content.includes('\0')) return failure('not-text');
  const normalized = content.replace(/\r\n?/g, '\n');
  const body = Buffer.from(normalized.replace(/\n/g, format.lineEnding), 'utf8');
  const bytes = format.bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body;
  if (bytes.length > MAX_BYTES) return failure('too-large');
  return { ok: true, bytes };
}

function sameResolvedTarget(left, right) {
  return Boolean(left && right && left.real === right.real);
}

function tempPath(target) {
  const directory = path.dirname(target.real);
  const name = path.basename(target.real);
  return path.join(directory, `.${name}.tabdesk-${crypto.randomUUID()}.tmp`);
}

function writeAll(io, fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = io.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!count) throw Object.assign(new Error('short write'), { code: 'EIO' });
    offset += count;
  }
}

async function writeDocument(target, request, options = {}) {
  const io = options.fs || fs;
  const revalidate = options.revalidate || (async () => target);
  let fd;
  let temp;

  try {
    const firstTarget = await revalidate();
    if (!firstTarget || firstTarget.error) return failure(firstTarget?.error || 'unreadable');
    const current = readBytes(firstTarget, io);
    if (!current.ok) return current;
    const currentDecoded = decode(current.bytes);
    if (!currentDecoded.ok) return currentDecoded;
    const baseRevision = revision(current.bytes);
    if (!request.overwrite && baseRevision !== request.expectedRevision) return failure('conflict');

    const encoded = encode(request.content, currentDecoded.format);
    if (!encoded.ok) return encoded;

    temp = tempPath(firstTarget);
    fd = io.openSync(temp, 'wx', current.mode & 0o7777);
    io.fchmodSync(fd, current.mode & 0o7777);
    writeAll(io, fd, encoded.bytes);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;

    if (options.beforeReplace) await options.beforeReplace();

    const finalTarget = await revalidate();
    if (!finalTarget || finalTarget.error) return failure(finalTarget?.error || 'unreadable');
    if (!sameResolvedTarget(firstTarget, finalTarget)) return failure('conflict');
    const finalSnapshot = readBytes(finalTarget, io);
    if (!finalSnapshot.ok) return finalSnapshot;
    const finalDecoded = decode(finalSnapshot.bytes);
    if (!finalDecoded.ok) return finalDecoded;
    if (revision(finalSnapshot.bytes) !== baseRevision) return failure('conflict');

    io.renameSync(temp, finalTarget.real);
    temp = undefined;
    return { ok: true, revision: revision(encoded.bytes) };
  } catch (error) {
    return failure(fileError(error, 'write-failed'));
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch (_) { /* best effort before exact temp cleanup */ }
    }
    if (temp) {
      try { io.unlinkSync(temp); } catch (_) { /* unlink only the temp created above */ }
    }
  }
}

module.exports = {
  MAX_BYTES,
  readDocument,
  writeDocument,
};
