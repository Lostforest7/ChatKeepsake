'use strict';

const fs = require('node:fs');
const path = require('node:path');

const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
const voiceExtensions = ['.wav'];
const videoExtensions = ['.mp4'];

function safeFileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[ .]|$)/i.test(name);
}

function mediaFile(directory, value, extensions) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\\/g, '/');
  const parts = name.split('/');
  if (parts.length < 2 || parts[0] !== 'media' || parts.some(part => !safeFileName(part))) return null;
  if (extensions && !extensions.includes(path.extname(name).toLowerCase())) return null;
  try {
    const root = fs.realpathSync(directory);
    const file = fs.realpathSync(path.join(directory, ...parts));
    const relative = path.relative(root, file);
    if (!relative.startsWith('media' + path.sep)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || (extensions && stat.size <= (extensions === voiceExtensions ? 44 : 0))) return null;
    return { name, file, url: parts.map(encodeURIComponent).join('/') };
  } catch {
    return null;
  }
}

function attachmentFile(directory, attachment) {
  if (typeof attachment?.path !== 'string' || !/^media\/files\/[0-9]+\//.test(attachment.path)) return null;
  return mediaFile(directory, attachment.path);
}

module.exports = { mediaFile, attachmentFile, safeFileName, imageExtensions, voiceExtensions, videoExtensions };
