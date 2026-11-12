'use strict';

const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { runProcess } = require('./run-process');

const megabyte = 1000000;
const parallelDownloads = 4;
const rangeBytes = 16 * 1024 * 1024;
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const curl = path.join(system32, 'curl.exe');
const windowsPowerShell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function fileSize(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat.size : -1;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    return -1;
  }
}

async function verified(file, asset) {
  if (fileSize(file) !== asset.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === asset.sha256;
}

async function windowsProxy(url) {
  if (process.platform !== 'win32' || process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy) return '';
  try {
    const result = await runProcess(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', [
      "$ErrorActionPreference = 'Stop'",
      '$address = [uri]$env:CHATKEEPSAKE_DOWNLOAD_URL',
      '$proxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($address)',
      'if ($proxy -and $proxy.AbsoluteUri -ne $address.AbsoluteUri -and !$proxy.UserInfo) {',
      '  [Console]::Write($proxy.AbsoluteUri)',
      '}'
    ].join('\n')], {
      env: { ...process.env, CHATKEEPSAKE_DOWNLOAD_URL: url },
      signal: AbortSignal.timeout(6000)
    });
    if (result.code !== 0 || !result.stdout.trim()) return '';
    const proxy = new URL(result.stdout.trim());
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) return '';
    return proxy.origin;
  } catch {
    return '';
  }
}

function downloadError(asset, result, partialBytes, checksumFailed) {
  if (result?.code === 23) return '没能把下载的文件写到电脑上。请检查磁盘空间。';
  const host = new URL(asset.url).hostname;
  const site = { 'github.com': 'GitHub', 'huggingface.co': 'Hugging Face 模型下载站' }[host] || host;
  const httpStatus = Number(result?.stdout);
  if (checksumFailed) return '从 ' + site + ' 下载的文件没通过校验。';
  if (httpStatus >= 400 && httpStatus <= 599) return site + ' 返回了错误（HTTP ' + httpStatus + '）。';
  if ([51, 60, 77].includes(result?.code)) return '无法验证与 ' + site + ' 的连接。';
  if (partialBytes > 0) return '从 ' + site + ' 下载时中断。重试时会尝试接着下载。';
  return '暂时连不上 ' + site + '。';
}

function fetchFile(asset, proxy, output, bytes, options) {
  const args = [
    '-q', '--fail', '--location', '--silent', '--show-error',
    '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '15', '--speed-time', '45', '--speed-limit', '1024',
    '--max-filesize', String(bytes), '--output', output, ...options
  ];
  if (proxy) args.push('--proxy', proxy, '--noproxy', '');
  return runProcess(curl, [...args, asset.url], {});
}

async function downloadRange(asset, proxy, part) {
  const range = part.start + '-' + (part.start + part.bytes - 1);
  try {
    const result = await fetchFile(asset, proxy, part.file, part.bytes, [
      '--range', range, '--dump-header', '-', '--max-time', '150'
    ]);
    if (result.code !== 0 || fileSize(part.file) !== part.bytes) return false;
    const headers = result.stdout.trim().split(/\r?\n\r?\n/).at(-1);
    const received = /^content-range:\s*bytes\s+(\d+-\d+\/\d+)\s*$/im.exec(headers);
    return /^HTTP\/\S+ 206\b/.test(headers) && received?.[1] === range + '/' + asset.bytes;
  } catch {
    return false;
  }
}

async function downloadRanges(asset, partial, partFiles, proxy, onBytes) {
  let completed = fileSize(partial);
  const removePart = file => files.rm(file, { force: true });
  try {
    while (completed < asset.bytes) {
      const count = Math.min(parallelDownloads, Math.ceil((asset.bytes - completed) / rangeBytes));
      const parts = partFiles.slice(0, count).map((file, index) => {
        const start = completed + index * rangeBytes;
        return { file, start, bytes: Math.min(rangeBytes, asset.bytes - start) };
      });
      const timer = setInterval(() => {
        const received = parts.reduce((total, part) => total + Math.max(0, Math.min(part.bytes, fileSize(part.file))), 0);
        onBytes(completed + received);
      }, 800);
      let available;
      try {
        available = await Promise.all(parts.map(part => downloadRange(asset, proxy, part)));
      } finally {
        clearInterval(timer);
      }
      // Keep a contiguous prefix so the normal downloader can resume it after a failure.
      for (const [index, part] of parts.entries()) {
        if (!available[index]) return;
        await pipeline(fs.createReadStream(part.file), fs.createWriteStream(partial, { flags: 'a' }));
        completed += part.bytes;
        await removePart(part.file);
      }
      onBytes(completed);
    }
  } finally {
    await Promise.all(partFiles.map(removePart));
    onBytes(Math.max(0, Math.min(asset.bytes, fileSize(partial))));
  }
}

async function downloadAsset(asset, folder, proxyFor, onBytes, timeoutSeconds) {
  const target = path.join(folder, asset.name);
  if (await verified(target, asset)) {
    onBytes(asset.bytes);
    return;
  }
  const partial = target + '.part';
  if (fileSize(partial) < 0 || fileSize(target) < 0) throw new Error('下载文件的保存位置不可用。');
  const partFiles = asset.bytes < 2 * rangeBytes ? [] :
    Array.from({ length: parallelDownloads }, (_, index) => partial + '.range-' + index);
  await Promise.all(partFiles.map(file => files.rm(file, { force: true })));
  let checksumFailed = false;
  async function finishPartial() {
    if (fileSize(partial) < asset.bytes) return false;
    if (await verified(partial, asset)) {
      await files.rename(partial, target);
      onBytes(asset.bytes);
      return true;
    }
    checksumFailed = true;
    await files.rm(partial, { force: true });
    return false;
  }

  if (await finishPartial()) return;
  const proxy = await proxyFor(asset.url);
  onBytes(fileSize(partial));
  if (asset.bytes - fileSize(partial) >= 2 * rangeBytes) {
    try {
      await downloadRanges(asset, partial, partFiles, proxy, onBytes);
    } catch (error) {
      if (error.code === 'ENOSPC') throw new Error(downloadError(asset, { code: 23 }, 0, false));
      throw error;
    }
    if (await finishPartial()) return;
  }
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    const offset = fileSize(partial);
    if (offset < 0) throw new Error('下载文件的保存位置不可用。');
    const update = () => onBytes(Math.max(0, Math.min(asset.bytes, fileSize(partial))));
    const timer = setInterval(update, 800);
    try {
      const args = ['--write-out', '%{http_code}', '--max-time', String(timeoutSeconds)];
      if (offset) args.push('--continue-at', '-');
      result = await fetchFile(asset, proxy, partial, asset.bytes, args);
    } catch {
      result = null;
    } finally {
      clearInterval(timer);
      update();
    }
    if (await finishPartial()) return;
    const rangeRefused = [33, 36].includes(result?.code) || result?.stdout === '416';
    if (offset > 0 && rangeRefused) {
      await files.rm(partial, { force: true });
    }
    if (result?.code === 23) break;
  }
  throw new Error(downloadError(asset, result, fileSize(partial), checksumFailed));
}

async function downloadGroup(group, folder, progress, label, { batchSize = parallelDownloads, timeoutSeconds = 2700 } = {}) {
  await files.mkdir(folder, { recursive: true });
  const totalBytes = group.reduce((sum, asset) => sum + asset.bytes, 0);
  const total = Math.ceil(totalBytes / megabyte);
  const proxies = new Map();
  function proxyFor(url) {
    const origin = new URL(url).origin;
    if (!proxies.has(origin)) proxies.set(origin, windowsProxy(url));
    return proxies.get(origin);
  }
  const received = new Map();
  const queue = [...group].sort((a, b) => b.bytes - a.bytes);
  let last = '';
  for (let index = 0; index < queue.length; index += batchSize) {
    const batch = queue.slice(index, index + batchSize);
    const results = await Promise.allSettled(batch.map(asset => downloadAsset(asset, folder, proxyFor, bytes => {
      received.set(asset.name, bytes);
      const downloaded = [...received.values()].reduce((sum, count) => sum + count, 0);
      const current = downloaded === totalBytes ? total : Math.floor(downloaded / megabyte);
      const message = label + ' ' + current + ' / ' + total + ' MB。';
      if (message !== last) progress(message);
      last = message;
    }, timeoutSeconds)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

module.exports = { downloadGroup, fileSize };
