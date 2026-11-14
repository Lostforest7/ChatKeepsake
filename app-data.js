'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dataPaths() {
  const override = process.env.WECHAT_CHATS_TO_FILES_DATA_DIR || process.env.CHATKEEPSAKE_DATA_DIR;
  if (override) return { dataDirectory: path.resolve(override) };

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dataDirectory = path.resolve(local, 'WeChatChatsToFiles');
  // Keep existing data in place so previously saved paths and the old launcher's lock still work.
  const previousDataDirectory = path.resolve(local, 'ChatKeepsake');
  return {
    dataDirectory,
    previousDataDirectory: fs.statSync(previousDataDirectory, { throwIfNoEntry: false })?.isDirectory()
      ? previousDataDirectory
      : undefined
  };
}

async function profileName(backend, id) {
  const current = 'wechat-chats-to-files-' + id;
  const previous = 'chatkeepsake-' + id;
  const { ok, data } = await backend.run(['config', 'profiles']);
  if (ok && Array.isArray(data) && !data.some(profile => profile?.name === current) &&
      data.some(profile => profile?.name === previous)) return previous;
  return current;
}

module.exports = { dataPaths, profileName };
