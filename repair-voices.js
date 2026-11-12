'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { messageType } = require('./chat-content');
const { mediaFile, voiceExtensions } = require('./media');

async function recoverVoice(directory, session, targetDir, message, audio, runBackend) {
  const serverId = String(message.platformMessageId || '');
  const timestamp = String(message.createTime || '');
  if (!/^[1-9]\d{0,19}$/.test(serverId) || !/^[1-9]\d{0,11}$/.test(timestamp)) return '';
  let localId = audio?.name.match(/\/voice_(\d+)\.wav$/)?.[1];
  if (!localId) {
    const lookup = await runBackend(['chat', 'message', session, '--server-id', serverId, '--parsed']);
    const id = lookup.data?.localId;
    if (!lookup.ok || !Number.isSafeInteger(id) || id <= 0) return '';
    localId = String(id);
  }

  const filename = 'voice_' + localId + '_' + timestamp + '_' + serverId + '.wav';
  const output = path.join(targetDir, filename);
  const relative = 'media/' + session + '/voices-verified/' + filename;
  let saved = false;
  try {
    const attempt = await runBackend(['chat', 'voice-data', session, localId, '--create-time', timestamp,
      '--server-id', serverId, '--out', output]);
    saved = attempt.ok && Boolean(mediaFile(directory, relative, voiceExtensions));
    return saved ? relative : '';
  } finally {
    if (!saved) fs.rmSync(output, { force: true });
  }
}

// WeFlow local IDs are unique within a database shard. Exported WAV names can
// repeat across shards, so re-read ambiguous or missing audio by message ID.
async function repairVoices(directory, session, messages, runBackend, progress) {
  const voices = messages.filter(message => message.localType === messageType.voice);
  const references = voices.map(message => ({ message, audio: mediaFile(directory, message.content, voiceExtensions) }));
  const counts = new Map();
  for (const { audio } of references) {
    if (audio) counts.set(audio.file, (counts.get(audio.file) || 0) + 1);
  }
  const toRepair = references.filter(({ audio }) => !audio || counts.get(audio.file) > 1);
  if (!toRepair.length) return;

  const targetDir = path.join(directory, 'media', session, 'voices-verified');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [index, { message, audio }] of toRepair.entries()) {
    let relative = '';
    try {
      relative = await recoverVoice(directory, session, targetDir, message, audio, runBackend);
    } catch {
      // Preserve the rest of the chat when a voice lookup or read fails.
    }
    message.content = relative || '[语音未能取得或核对]';
    message.voiceRecoveryStatus = relative ? 'verified' : 'missing';
    progress(index + 1, toRepair.length);
  }
}

module.exports = { repairVoices };
