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

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs);
}

async function readBytes(target, io, revalidate) {
  let fd;
  try {
    const before = io.statSync(target.real);
    if (!before.isFile()) return failure('not-file');
    if (before.size > MAX_BYTES) return failure('too-large');
    let readFlags = 'r';
    if (process.platform === 'linux') {
      if (!io.constants || !Number.isInteger(io.constants.O_RDONLY)
        || !Number.isInteger(io.constants.O_NOFOLLOW)
        || !Number.isInteger(io.constants.O_NONBLOCK)) {
        return failure('unreadable');
      }
      readFlags = io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK;
    } else if (io.constants && Number.isInteger(io.constants.O_NOFOLLOW)) {
      readFlags = io.constants.O_RDONLY | io.constants.O_NOFOLLOW;
    }
    fd = io.openSync(target.real, readFlags);
    const opened = io.fstatSync(fd);
    if (!opened.isFile()) return failure('not-file');
    if (opened.size > MAX_BYTES) return failure('too-large');
    if (!sameFileIdentity(before, opened)) return failure('unreadable');
    if (revalidate) {
      const current = await revalidate();
      if (!current || current.error) return failure(current?.error || 'unreadable');
      if (!sameResolvedTarget(target, current)) return failure('unreadable');
    }
    const after = io.statSync(target.real);
    if (!after.isFile() || !sameFileIdentity(opened, after)) return failure('unreadable');

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
    return { ok: true, bytes: Buffer.concat(chunks, total), mode: opened.mode, dev: opened.dev };
  } catch (error) {
    return failure(fileError(error));
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch (_) { /* best effort after a read failure */ }
    }
  }
}

async function readDocument(target, options = {}) {
  const io = options.fs || fs;
  const snapshot = await readBytes(target, io, options.revalidate);
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

function writeFailure(message) {
  return Object.assign(new Error(message), { code: 'EIO' });
}

function directoryFlags(io) {
  const constants = io.constants;
  if (process.platform !== 'linux' || !constants
    || !Number.isInteger(constants.O_RDONLY) || !Number.isInteger(constants.O_DIRECTORY)
    || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw writeFailure('descriptor-bound directory operations unavailable');
  }
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function tempFlags(io) {
  const constants = io.constants;
  if (!constants || !Number.isInteger(constants.O_WRONLY) || !Number.isInteger(constants.O_CREAT)
    || !Number.isInteger(constants.O_EXCL) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw writeFailure('descriptor-bound file operations unavailable');
  }
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
}

function closeQuietly(io, fd) {
  if (fd === undefined) return;
  try { io.closeSync(fd); } catch (_) { /* best effort after the operation failed */ }
}

function openDirectory(io, real, expected) {
  const before = io.statSync(real);
  if (!before.isDirectory() || (expected && !sameFileIdentity(before, expected))) {
    throw writeFailure('directory identity changed');
  }
  let fd;
  try {
    fd = io.openSync(real, directoryFlags(io));
    const opened = io.fstatSync(fd);
    if (!opened.isDirectory() || !sameFileIdentity(before, opened)) {
      throw writeFailure('opened directory identity changed');
    }
    const descriptorPath = `/proc/self/fd/${fd}`;
    const link = io.lstatSync(descriptorPath);
    const throughProc = io.statSync(descriptorPath);
    if (!link.isSymbolicLink() || !throughProc.isDirectory()
      || !sameFileIdentity(opened, throughProc)) {
      throw writeFailure('procfs descriptor path unavailable');
    }
    return { fd, descriptorPath, real, identity: opened };
  } catch (error) {
    closeQuietly(io, fd);
    throw error;
  }
}

function tempName(target) {
  return `.${path.basename(target.real)}.tabdesk-${crypto.randomUUID()}.tmp`;
}

function currentDirectory(io, directory) {
  const stats = io.statSync(directory.real);
  return stats.isDirectory() && sameFileIdentity(stats, directory.identity);
}

async function revalidateWriteTarget(firstTarget, root, parent, io, revalidate, changedError) {
  const current = await revalidate();
  if (!current || current.error) return failure(current?.error || 'unreadable');
  if (!sameResolvedTarget(firstTarget, current)) return failure(changedError);
  try {
    if (!currentDirectory(io, root) || path.dirname(current.real) !== parent.real
      || !currentDirectory(io, parent)) {
      return failure(changedError);
    }
    if (root.identity.dev !== parent.identity.dev) return failure('write-failed');
  } catch (error) {
    return failure(fileError(error, changedError));
  }
  return { ok: true, target: current };
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
  let rootDirectory;
  let parentDirectory;
  let tempFd;
  let temp;

  try {
    if (process.platform !== 'linux' || !options.root) return failure('write-failed');
    const firstTarget = await revalidate();
    if (!firstTarget || firstTarget.error) return failure(firstTarget?.error || 'unreadable');
    rootDirectory = openDirectory(io, options.root.real, options.root);
    parentDirectory = openDirectory(io, path.dirname(firstTarget.real));
    if (rootDirectory.identity.dev !== parentDirectory.identity.dev) return failure('write-failed');
    const admitted = await revalidateWriteTarget(
      firstTarget, rootDirectory, parentDirectory, io, revalidate, 'unreadable',
    );
    if (!admitted.ok) return admitted;

    const current = await readBytes(firstTarget, io, revalidate);
    if (!current.ok) return current;
    if (current.dev !== rootDirectory.identity.dev) return failure('write-failed');
    const currentDecoded = decode(current.bytes);
    if (!currentDecoded.ok) return currentDecoded;
    const baseRevision = revision(current.bytes);
    if (!request.overwrite && baseRevision !== request.expectedRevision) return failure('conflict');

    const encoded = encode(request.content, currentDecoded.format);
    if (!encoded.ok) return encoded;

    const beforeTemp = await revalidateWriteTarget(
      firstTarget, rootDirectory, parentDirectory, io, revalidate, 'unreadable',
    );
    if (!beforeTemp.ok) return beforeTemp;
    const candidate = path.join(rootDirectory.descriptorPath, tempName(firstTarget));
    tempFd = io.openSync(candidate, tempFlags(io), 0o600);
    temp = candidate;
    const tempStats = io.fstatSync(tempFd);
    if (!tempStats.isFile() || tempStats.dev !== rootDirectory.identity.dev
      || (tempStats.mode & 0o077) !== 0) {
      throw writeFailure('unsafe temporary file');
    }
    writeAll(io, tempFd, encoded.bytes);
    io.fsyncSync(tempFd);

    if (options.beforeReplace) await options.beforeReplace();

    const finalTarget = await revalidateWriteTarget(
      firstTarget, rootDirectory, parentDirectory, io, revalidate, 'conflict',
    );
    if (!finalTarget.ok) return finalTarget;
    const finalSnapshot = await readBytes(finalTarget.target, io, revalidate);
    if (!finalSnapshot.ok) return finalSnapshot;
    if (finalSnapshot.dev !== rootDirectory.identity.dev) return failure('write-failed');
    const finalDecoded = decode(finalSnapshot.bytes);
    if (!finalDecoded.ok) return finalDecoded;
    if (revision(finalSnapshot.bytes) !== baseRevision) return failure('conflict');

    const destination = path.join(parentDirectory.descriptorPath, path.basename(firstTarget.real));
    io.fchmodSync(tempFd, current.mode & 0o7777);
    io.fsyncSync(tempFd);
    const beforeRename = await revalidateWriteTarget(
      firstTarget, rootDirectory, parentDirectory, io, revalidate, 'conflict',
    );
    if (!beforeRename.ok) return beforeRename;
    io.renameSync(temp, destination);
    temp = undefined;
    return { ok: true, revision: revision(encoded.bytes) };
  } catch (error) {
    return failure(fileError(error, 'write-failed'));
  } finally {
    closeQuietly(io, tempFd);
    if (temp) {
      try { io.unlinkSync(temp); } catch (_) { /* unlink only the temp created above */ }
    }
    closeQuietly(io, parentDirectory?.fd);
    closeQuietly(io, rootDirectory?.fd);
  }
}

module.exports = {
  MAX_BYTES,
  readDocument,
  writeDocument,
};
