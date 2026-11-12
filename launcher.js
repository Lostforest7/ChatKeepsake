'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { runProcess } = require('./run-process');

function readInstance(file) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const instance = typeof record === 'number' ? { pid: record, legacy: true } : record;
  if (!Number.isSafeInteger(instance?.pid) || instance.pid < 1) throw new Error('无效的启动记录');
  return instance;
}

function claimInstance(file) {
  const initial = JSON.stringify({ pid: process.pid });
  try {
    fs.writeFileSync(file, initial, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = readInstance(file); }
    catch { return false; }
    let exited = false;
    try { process.kill(previous.pid, 0); } catch (probe) { exited = probe.code === 'ESRCH'; }
    if (!exited || readInstance(file).pid !== previous.pid) return false;
    fs.unlinkSync(file);
    fs.writeFileSync(file, initial, { flag: 'wx' });
  }
  process.once('exit', () => {
    try { if (readInstance(file).pid === process.pid) fs.unlinkSync(file); } catch {}
  });
  return true;
}

function pageAddress({ port, token }) {
  return 'http://127.0.0.1:' + port + '/#' + token;
}

async function runningPage(file, apiVersion) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const state = readInstance(file);
      if (state.legacy) break;
      if (Number.isInteger(state.port) && state.port > 0 && state.port <= 65535 &&
          typeof state.token === 'string' && /^[a-f0-9]{64}$/.test(state.token)) {
        const base = 'http://127.0.0.1:' + state.port;
        const response = await fetch(base + '/api/status', {
          method: 'POST',
          headers: { Origin: base, 'X-Local-Token': state.token },
          signal: AbortSignal.timeout(1000)
        });
        if (response.ok && (await response.json()).state) {
          if (state.apiVersion === apiVersion) return pageAddress(state);
          break;
        }
      }
    } catch {}
    await delay(150);
  }
  throw new Error('已有 ChatKeepsake 在运行。请关闭原来的启动窗口，再双击「启动 ChatKeepsake」。');
}

async function showPage(url, reused = false) {
  console.log((reused ? '正在打开已有的 ChatKeepsake 页面。' : 'ChatKeepsake 已启动。请保持此窗口打开。') + '\n' + url);
  if (process.platform !== 'win32' || process.env.CHATKEEPSAKE_NO_OPEN) return true;
  try {
    const result = await runProcess('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:CHATKEEPSAKE_BROWSER_URL"
    ], { env: { ...process.env, CHATKEEPSAKE_BROWSER_URL: url }, signal: AbortSignal.timeout(10000) });
    if (result.code === 0) return true;
  } catch {}
  console.error('无法打开默认浏览器。请复制上方完整地址到浏览器打开。');
  return false;
}

async function launch({ createServer, dataDirectory, apiVersion }) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const file = path.join(dataDirectory, 'running.lock');
  if (!claimInstance(file)) {
    if (!await showPage(await runningPage(file, apiVersion), true)) process.exitCode = 1;
    return;
  }
  const { server, token } = createServer({ dataDirectory });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const state = { pid: process.pid, port: server.address().port, token, apiVersion };
  try {
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (error) {
    server.close();
    throw error;
  }
  await showPage(pageAddress(state));
}

module.exports = { launch };
