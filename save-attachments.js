'use strict';

const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeFileName } = require('./media');
const { isFileMessage, fileName } = require('./chat-content');
const { lookupMessage } = require('./weflow');

async function cacheFiles(accountDir) {
  if (typeof accountDir !== 'string' || !path.isAbsolute(accountDir)) return [];
  const account = await fs.realpath(accountDir);
  const files = [];
  for (const parts of [['msg', 'file'], ['FileStorage', 'File']]) {
    const root = path.join(account, ...parts);
    try {
      if (path.relative(root, await fs.realpath(root)) !== '') continue;
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{4}-(0[1-9]|1[0-2])$/.test(entry.name)) continue;
        const month = path.join(root, entry.name);
        try {
          if (path.relative(month, await fs.realpath(month)) !== '') continue;
          for (const file of await fs.readdir(month, { withFileTypes: true })) {
            if (file.isFile() && safeFileName(file.name)) {
              files.push({ month: entry.name, directory: month, name: file.name, key: file.name.toLowerCase() });
            }
          }
        } catch {
          // A cache month may be removed while WeChat is open.
        }
      }
    } catch {
      // Each installation may have only one of these cache layouts.
    }
  }
  return files;
}

function matchesName(candidate, name) {
  if (candidate === name) return true;
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  if (path.extname(candidate) !== extension || !candidate.startsWith(stem)) return false;
  return /^ ?\(\d+\)$/.test(candidate.slice(stem.length, candidate.length - extension.length));
}

async function md5(file) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyMatch(draft, relative, candidates, expected) {
  const target = path.join(draft, relative);
  for (const candidate of candidates) {
    let copied = false;
    try {
      const source = path.join(candidate.directory, candidate.name);
      if (path.relative(source, await fs.realpath(source)) !== '') continue;
      const stat = await fs.lstat(source);
      if (!stat.isFile() || (expected.size !== undefined && stat.size !== expected.size)) continue;
      if (await md5(source) !== expected.digest) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      copied = true;
      if (await md5(target) === expected.digest) return true;
    } catch {
      // An unavailable or changing file should not prevent the chat from being saved.
    }
    if (copied) await fs.rm(target, { force: true });
  }
  return false;
}

async function saveAttachments(draft, session, messages, backend, progress) {
  const attachments = messages.filter(isFileMessage);
  if (!attachments.length) return;
  progress('正在查找微信里下载过的文件。');
  let cache;
  try {
    const report = await backend.run(['db', 'test']);
    if (!report.ok) return;
    cache = await cacheFiles(report.data?.accountDir || report.data?.account_dir);
  } catch {
    return;
  }
  if (!cache.length) return;

  for (const [index, message] of attachments.entries()) {
    try {
      const detail = await lookupMessage(backend, session, message);
      if (detail?.appMsgKind === 'file') {
        const name = typeof detail.fileName === 'string' && detail.fileName.trim() ? detail.fileName : fileName(message);
        const size = Number.isSafeInteger(detail.fileSize) && detail.fileSize >= 0 ? detail.fileSize : undefined;
        const attachment = message.attachment = { name, size };
        const digest = typeof detail.fileMd5 === 'string' ? detail.fileMd5.toLowerCase() : '';
        if (safeFileName(name) && /^[a-f0-9]{32}$/.test(digest)) {
          const month = String(message.formattedTime ?? '').slice(0, 7);
          const candidates = cache.filter(file => matchesName(file.key, name.toLowerCase()))
            .sort((a, b) => Number(b.month === month) - Number(a.month === month));
          const relative = ['media', 'files', String(index + 1), name].join('/');
          if (await copyMatch(draft, relative, candidates, { size, digest })) attachment.path = relative;
        }
      }
    } catch {
      // Keep the filename in the exported message even if its original can't be matched.
    }
    progress('正在核对并保存文件 ' + (index + 1) + ' / ' + attachments.length + '。');
  }
}

module.exports = { saveAttachments };
