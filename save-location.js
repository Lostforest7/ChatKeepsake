'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createArchives } = require('./archive');
const { runProcess } = require('./run-process');

function localFolder(directory) {
  return typeof directory === 'string' && directory.length <= 4096 &&
    !/[\x00-\x1f]/.test(directory) && path.isAbsolute(directory) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(directory));
}

function checkWritable(directory) {
  const probe = path.join(directory, '.chatkeepsake-write-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  const file = fs.openSync(probe, 'wx');
  fs.closeSync(file);
  fs.unlinkSync(probe);
}

function resolveFolder(directory) {
  const canonical = fs.realpathSync.native(directory);
  if (!localFolder(canonical) || !fs.statSync(canonical).isDirectory()) throw new Error('Invalid save folder');
  return canonical;
}

function createSaveLocation(dataDirectory) {
  const defaultFolder = path.join(path.resolve(dataDirectory), 'exports');
  const settingsFile = path.join(dataDirectory, 'save-location.json');
  const folderKey = folder => process.platform === 'win32' ? folder.toLowerCase() : folder;
  let current = defaultFolder;
  let folders = [defaultFolder];
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (localFolder(saved.current)) current = path.normalize(saved.current);
    if (Array.isArray(saved.folders)) {
      for (const folder of saved.folders) {
        if (localFolder(folder)) folders.push(path.normalize(folder));
      }
    }
  } catch {
    // A new installation has no saved location.
  }
  folders = [...new Map([...folders, current].map(folder => [folderKey(folder), folder])).values()];

  function select(directory) {
    if (!localFolder(directory)) throw new Error('请选择电脑上的文件夹，例如 D:\\聊天记录。');
    let canonical;
    try {
      canonical = resolveFolder(directory);
      checkWritable(canonical);
    } catch {
      throw new Error('这个文件夹不可用或无法写入，请另选一个。');
    }

    const nextFolders = [canonical, ...folders.filter(folder => folderKey(folder) !== folderKey(canonical))];
    const temporary = settingsFile + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ current: canonical, folders: nextFolders }) + '\n', { flag: 'wx' });
      fs.renameSync(temporary, settingsFile);
    } catch (error) {
      throw new Error('没能记住保存位置，请重试。', { cause: error });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    current = canonical;
    folders = nextFolders;
    return current;
  }

  function list() {
    const records = new Map();
    for (const folder of folders) {
      let canonical;
      let archives;
      try {
        canonical = resolveFolder(folder);
        archives = createArchives(canonical).list();
      } catch {
        continue;
      }
      for (const record of archives) {
        if (!records.has(record.id)) records.set(record.id, { ...record, directory: path.join(canonical, record.id) });
      }
    }
    return [...records.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  function get(id) {
    if (typeof id !== 'string') throw new Error('请选择已完成的导出记录。');
    for (const folder of folders) {
      try {
        const archives = createArchives(resolveFolder(folder));
        return { ...archives.get(id), archives };
      } catch {
        // The folder may have moved or the drive may be disconnected.
      }
    }
    throw new Error('找不到这次导出。请刷新导出列表。');
  }

  function ready() {
    try {
      if (current === defaultFolder) fs.mkdirSync(current, { recursive: true });
      const canonical = resolveFolder(current);
      checkWritable(canonical);
      return canonical;
    } catch {
      throw new Error('当前保存位置不可用，请更改保存位置后重试。');
    }
  }

  return { get current() { return current; }, select, list, get, ready };
}

async function chooseSaveFolder(directory) {
  if (process.platform !== 'win32') throw new Error('选择保存位置需要 Windows。');
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object Windows.Forms.FolderBrowserDialog',
    '$owner = New-Object Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Opacity = 0',
    'try {',
    '  $dialog.Description = "ChatKeepsake"',
    '  $dialog.ShowNewFolderButton = $true',
    '  if ([IO.Directory]::Exists($env:CHATKEEPSAKE_FOLDER_START)) { $dialog.SelectedPath = $env:CHATKEEPSAKE_FOLDER_START }',
    '  $owner.Show()',
    '  if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
    '} finally { $dialog.Dispose(); $owner.Dispose() }'
  ].join('\n');
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      env: { ...process.env, CHATKEEPSAKE_FOLDER_START: directory },
      signal: AbortSignal.timeout(5 * 60 * 1000)
    });
    if (result.code === 0 && !result.exceeded) return result.stdout;
  } catch {
    // The UI can be reopened if the dialog times out or the user session ends.
  }
  throw new Error('没能打开文件夹选择窗口。请再点一次「更改保存位置」。');
}

module.exports = { createSaveLocation, chooseSaveFolder };
