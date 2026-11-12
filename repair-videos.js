'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { messageType } = require('./chat-content');
const { mediaFile, videoExtensions } = require('./media');
const { lookupMessage } = require('./weflow');

async function repairVideos(directory, session, messages, backend, progress) {
  // The per-message lookup can see the cache name in WeChat's packed metadata.
  const missing = messages.filter(message => message.localType === messageType.video &&
    !mediaFile(directory, message.content, videoExtensions));
  if (!missing.length) return;
  progress('正在补查没存下来的视频。');
  for (const [index, message] of missing.entries()) {
    const relative = 'media/videos-verified/video_' + (index + 1) + '.mp4';
    const target = path.join(directory, relative);
    let saved = false;
    try {
      const detail = await lookupMessage(backend, session, message);
      if (detail?.localType === messageType.video && Number.isSafeInteger(detail.localId) && detail.localId > 0) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const report = await backend.run(['chat', 'video-data', session, String(detail.localId),
          '--create-time', String(message.createTime), '--out', target]);
        saved = report.ok && Boolean(mediaFile(directory, relative, videoExtensions));
        if (saved) message.content = relative;
      }
    } catch {
      // A missing video leaves the message in the archive with a visible note.
    }
    if (!saved) fs.rmSync(target, { force: true });
    progress('正在补查视频 ' + (index + 1) + ' / ' + missing.length + '。');
  }
}

module.exports = { repairVideos };
