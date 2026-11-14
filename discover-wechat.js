'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runProcess } = require('./run-process');
const { validId } = require('./archive');

const configFiles = [
  'Tencent/xwechat/config/51a1fffea11325a1e4104c6b3de47af7.ini',
  'Tencent/WeChat/All Users/config/3ebffe94.ini'
];

async function children(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
}

function absoluteLocal(value) {
  return typeof value === 'string' && path.isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
}

function readPath(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^["']|["']$/g, '').replace(/%([A-Z_]+)%/gi, (all, key) => process.env[key] || all);
}

async function configuredPaths(roamingFolders) {
  const locations = [];
  for (const file of configFiles) {
    for (const folder of roamingFolders) {
      try {
        const source = path.join(folder, file);
        if ((await fs.stat(source)).size > 4096) continue;
        const data = await fs.readFile(source);
        let text;
        if (data[0] === 0xff && data[1] === 0xfe || data[1] === 0 && data[3] === 0) {
          text = new TextDecoder('utf-16le').decode(data);
        } else {
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
          catch { text = new TextDecoder('gb18030').decode(data); }
        }
        const location = readPath(text);
        if (absoluteLocal(location) && !/[\x00-\x1f]/.test(location)) locations.push(location);
      } catch {
        // A missing or unreadable client setting is expected on some installs.
      }
    }
  }
  return locations;
}

async function windowsLocations() {
  const home = os.homedir();
  const roamingFolders = [...new Set([process.env.APPDATA, path.join(home, 'AppData', 'Roaming')].filter(Boolean))];
  const configured = await configuredPaths(roamingFolders);
  const defaults = [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')];
  if (process.platform !== 'win32') return { configured, defaults, drives: [] };

  const script = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "$savePaths = foreach ($key in @('HKCU:\\Software\\Tencent\\WeChat', 'HKCU:\\Software\\Tencent\\Weixin')) {",
    '  (Get-ItemProperty -LiteralPath $key -Name FileSavePath -ErrorAction SilentlyContinue).FileSavePath',
    '}',
    '$drives = [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [IO.DriveType]::Fixed -and $_.IsReady } | ForEach-Object Name',
    '[pscustomobject]@{ documents = [Environment]::GetFolderPath("MyDocuments"); saved = @($savePaths); drives = @($drives) } | ConvertTo-Json -Compress'
  ].join('\n');
  try {
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      signal: AbortSignal.timeout(5000)
    });
    const { documents, saved, drives } = JSON.parse(result.stdout);
    return {
      configured: configured.concat((saved || []).map(readPath)),
      defaults: [documents, ...defaults],
      drives: (drives || []).filter(value => /^[a-z]:\\$/i.test(value))
    };
  } catch {
    return { configured, defaults, drives: [] };
  }
}

async function databaseInfo(accountDirectory) {
  const messageDirectory = path.join(accountDirectory, 'db_storage', 'message');
  let hasDatabase = false;
  const messages = [];
  for (const entry of await children(messageDirectory)) {
    if (!entry.isFile() || !/^message_\d+\.db(?:-wal)?$/i.test(entry.name)) continue;
    try {
      const file = path.join(messageDirectory, entry.name);
      const stat = await fs.stat(file);
      if (stat.size === 0) continue;
      if (/\.db$/i.test(entry.name)) hasDatabase = true;
      messages.push({ file, updatedAt: stat.mtimeMs });
    } catch {}
  }
  if (!hasDatabase) return null;
  messages.sort((a, b) => b.updatedAt - a.updatedAt);
  const files = messages.slice(0, 6).map(item => item.file);
  const storage = path.join(accountDirectory, 'db_storage');
  files.push(path.join(storage, 'session', 'session.db'), path.join(storage, 'session', 'session.db-wal'),
    path.join(storage, 'contact', 'contact.db'));
  return { updatedAt: messages[0].updatedAt, files };
}

async function windowsOpenDatabases(accounts) {
  if (process.platform !== 'win32' || !accounts.length) return [];
  const candidates = accounts.slice(0, 12).map(({ files }) => ({ files }));
  const payload = JSON.stringify(candidates);
  if (payload.length > 30000) return [];
  try {
    const probe = await fs.readFile(path.join(__dirname, 'scripts', 'wechat-open-databases.ps1'), 'utf8');
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      env: { ...process.env, WECHAT_CHATS_TO_FILES_DB_PROBE: payload }, signal: AbortSignal.timeout(6500)
    });
    if (result.code !== 0) return [];
    const matches = JSON.parse(result.stdout);
    return Array.isArray(matches) ? matches.filter(index => Number.isInteger(index) && index >= 0 && index < candidates.length) : [];
  } catch {
    return [];
  }
}

const excluded = /^(?:\..*|system volume information|\$recycle\.bin|windows|windowsapps|program files(?: \(x86\))?|programdata|appdata|node_modules|users)$/i;

async function searchDrives(drives, inspect) {
  const deadline = Date.now() + 6500;
  const queue = drives.map(directory => ({ directory, depth: 0 }));
  const limit = 4500;
  for (let offset = 0; offset < queue.length && Date.now() < deadline;) {
    const batch = queue.slice(offset, offset + 16);
    offset += batch.length;
    await Promise.all(batch.map(async ({ directory, depth }) => {
      if (path.basename(directory).toLowerCase() === 'xwechat_files') {
        await inspect(directory);
      } else if (depth < 6) {
        for (const entry of await children(directory)) {
          if (queue.length >= limit) break;
          if (entry.isDirectory() && !excluded.test(entry.name)) {
            queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
          }
        }
      }
    }));
  }
}

async function discoverWeChatAccounts(backend, manualPath = '', locations = windowsLocations, findOpen = windowsOpenDatabases) {
  const groups = [];
  const checked = new Set();

  async function inspect(directory, onlyFolder = '') {
    try {
      if (!absoluteLocal(directory)) return;
      const canonical = await fs.realpath(directory);
      const key = canonical.toLowerCase();
      if (checked.has(key)) return;
      checked.add(key);
      if (!(await fs.stat(canonical)).isDirectory()) return;
      const entries = await children(canonical);
      const accountFolders = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink());
      const verified = new Map();
      for (const entry of accountFolders) {
        if (onlyFolder && entry.name.toLowerCase() !== onlyFolder.toLowerCase()) continue;
        const folder = path.join(canonical, entry.name);
        const info = await databaseInfo(folder);
        if (info) verified.set(folder.toLowerCase(), info);
      }
      if (!verified.size) return;
      const result = await backend.run(['db', 'wxid', canonical]);
      if (!result.ok || !Array.isArray(result.data?.accounts)) return;
      const details = [];
      for (const item of result.data.accounts) {
        if (!validId(item.wxid) || typeof item.path !== 'string') continue;
        const folder = path.resolve(canonical, item.path);
        const info = verified.get(folder.toLowerCase());
        if (info) details.push({ id: item.wxid, directory: folder, ...info });
      }
      details.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const accountDetails = details.filter((item, index) => details.findIndex(other => other.id === item.id) === index);
      if (accountDetails.length) groups.push({ directory: canonical, accounts: accountDetails.map(item => item.id), accountDetails });
    } catch {
      // Ignore stale hints, removable paths, and locations inaccessible to this user.
    }
  }

  async function inspectHint(hint) {
    if (!absoluteLocal(hint)) return;
    if (path.basename(hint).toLowerCase() === 'db_storage') hint = path.dirname(hint);
    if (await databaseInfo(hint)) {
      await inspect(path.dirname(hint), manualPath ? path.basename(hint) : '');
      return;
    }
    if (path.basename(hint).toLowerCase() !== 'xwechat_files') await inspect(path.join(hint, 'xwechat_files'));
    await inspect(hint);
  }

  if (manualPath) {
    await inspectHint(readPath(manualPath));
  } else {
    const { configured, defaults, drives } = await locations();
    for (const hint of [...configured, ...defaults]) await inspectHint(hint);
    if (!groups.length) {
      try {
        const detected = await backend.run(['db', 'detect']);
        for (const item of detected.data?.candidates || []) {
          if (item.exists) await inspectHint(item.path);
        }
      } catch {}
    }
    if (!groups.length) await searchDrives(drives, inspect);
  }
  const accounts = groups.flatMap(group => group.accountDetails);
  const active = new Set(await findOpen(accounts));
  for (const [index, account] of accounts.entries()) {
    account.inUse = active.has(index);
    delete account.files;
  }
  return groups;
}

module.exports = { discoverWeChatAccounts, configuredPaths };
