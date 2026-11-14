'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createArchives } = require('./archive');

function localFolder(directory) {
  return typeof directory === 'string' && directory.length <= 4096 &&
    !/[\x00-\x1f]/.test(directory) && path.isAbsolute(directory) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(directory));
}

function checkWritable(directory) {
  const probe = path.join(directory, '.wechat-chats-to-files-write-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  const file = fs.openSync(probe, 'wx');
  fs.closeSync(file);
  fs.unlinkSync(probe);
}

function resolveFolder(directory) {
  const canonical = fs.realpathSync.native(directory);
  if (!localFolder(canonical) || !fs.statSync(canonical).isDirectory()) throw new Error('Invalid save folder');
  return canonical;
}

function createSaveLocation(dataDirectory, previousDataDirectory) {
  const defaultFolder = path.join(path.resolve(dataDirectory), 'exports');
  const previousDefault = previousDataDirectory && path.join(previousDataDirectory, 'exports');
  const settingsFile = path.join(dataDirectory, 'save-location.json');
  const folderKey = folder => process.platform === 'win32' ? folder.toLowerCase() : folder;
  let current = defaultFolder;
  let folders = previousDefault ? [defaultFolder, previousDefault] : [defaultFolder];
  for (const directory of [dataDirectory, previousDataDirectory].filter(Boolean)) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(directory, 'save-location.json'), 'utf8'));
      if (localFolder(saved?.current)) {
        const folder = path.normalize(saved.current);
        if (directory === dataDirectory || folderKey(folder) !== folderKey(previousDefault)) current = folder;
      }
      if (Array.isArray(saved?.folders)) {
        folders.push(...saved.folders.filter(localFolder).map(folder => path.normalize(folder)));
      }
      break;
    } catch {
      // A new installation has no saved location.
    }
  }
  folders = [...new Map([...folders, current].map(folder => [folderKey(folder), folder])).values()];

  function select(directory) {
    const typed = typeof directory === 'string' ? directory.trim().replace(/^"(.*)"$/, '$1') : '';
    if (!localFolder(typed)) throw new Error('请填写电脑上的文件夹路径，例如 D:\\聊天记录。');
    let canonical;
    try {
      canonical = resolveFolder(typed);
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
        if (!records.has(record.id)) records.set(record.id, record);
      }
    }
    return [...records.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  function get(id, batch = '') {
    if (typeof id !== 'string') throw new Error('请选择已完成的导出记录。');
    for (const folder of folders) {
      try {
        const archives = createArchives(resolveFolder(folder));
        return { ...archives.get(id, batch), archives };
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

module.exports = { createSaveLocation };
