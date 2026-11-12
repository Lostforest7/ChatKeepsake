'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderViewer, sender } = require('./make-viewer');
const { messageType, isFileMessage, fileName, linkCard } = require('./chat-content');
const { mediaFile, attachmentFile, imageExtensions, voiceExtensions, videoExtensions } = require('./media');
const { repairVoices } = require('./repair-voices');
const { repairVideos } = require('./repair-videos');
const { saveAttachments } = require('./save-attachments');

const readerFile = '完整聊天记录.html';
const jsonFile = '聊天记录.json';
const manifestFile = '导出说明.json';
const transcriptFile = 'voice-transcripts.json';
const archiveId = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{8}$/;

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_][\w@.-]{0,199}$/.test(value) &&
    !value.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
}

function validDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFile(file, content) {
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeJson(file, value) {
  writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

function tally(directory, messages) {
  const counts = { messages: messages.length, images: 0, imageFiles: 0, voices: 0, voiceFiles: 0,
    files: 0, savedFiles: 0, videos: 0, videoFiles: 0 };
  for (const message of messages) {
    if (message.localType === messageType.image) {
      counts.images++;
      if (mediaFile(directory, message.content, imageExtensions)) counts.imageFiles++;
    }
    if (message.localType === messageType.voice) {
      counts.voices++;
      if (mediaFile(directory, message.content, voiceExtensions)) counts.voiceFiles++;
    }
    if (message.localType === messageType.video) {
      counts.videos++;
      if (mediaFile(directory, message.content, videoExtensions)) counts.videoFiles++;
    }
    if (isFileMessage(message)) {
      counts.files++;
      if (attachmentFile(directory, message.attachment)) counts.savedFiles++;
    }
  }
  return counts;
}

function writeArchive(directory, document, manifest) {
  const lines = document.messages.map(message => {
    let body = String(message.content ?? '');
    if (message.localType === messageType.image) {
      const image = mediaFile(directory, message.content, imageExtensions);
      body = image ? '[图片] ' + image.name : (manifest.images ? '[图片没能保存]' : '[未选择保存图片]');
    }
    if (message.localType === messageType.voice) {
      const voice = mediaFile(directory, message.content, voiceExtensions);
      body = voice ? '[语音] ' + voice.name : (manifest.voices ? '[语音不可用]' : '[未导出语音]');
      if (message.voiceTranscript) body += '\n机器转写 · ' + message.voiceTranscript;
    }
    if (message.localType === messageType.video) {
      const video = mediaFile(directory, message.content, videoExtensions);
      body = video ? '[视频] ' + video.name : (manifest.videos ? '[视频没能保存]' : '[未选择保存视频]');
    }
    if (isFileMessage(message)) {
      const file = attachmentFile(directory, message.attachment);
      body = '[文件] ' + fileName(message) + '\n' + (file?.name || (manifest.files ? '[文件未保存]' : '[未选择保存文件]'));
    }
    const link = linkCard(message);
    if (link) body = '[链接] ' + link.title + '\n' + link.url;
    return (message.formattedTime || '') + ' ' + sender(message) + '\n' + body;
  });
  writeFile(path.join(directory, readerFile), renderViewer(directory, document, manifest));
  writeFile(path.join(directory, '聊天记录.txt'), lines.join('\n\n') + '\n');
  writeJson(path.join(directory, jsonFile), document);
  writeJson(path.join(directory, manifestFile), manifest);
}

function createArchives(exportsDirectory) {
  function get(id) {
    if (typeof id !== 'string' || !archiveId.test(id)) throw new Error('请选择已完成的导出记录。');
    try {
      const directory = fs.realpathSync(path.join(exportsDirectory, id));
      if (path.relative(fs.realpathSync(exportsDirectory), directory) !== id) throw new Error('Invalid archive path');
      const manifest = readJson(path.join(directory, manifestFile));
      const totalMessages = manifest?.counts?.messages;
      if (manifest?.schema !== 1 || manifest.id !== id ||
          !Number.isSafeInteger(totalMessages) || totalMessages < 0) throw new Error('Invalid archive manifest');
      return { directory, manifest };
    } catch {
      throw new Error('找不到这次导出。请刷新导出列表。');
    }
  }

  function list() {
    const ids = fs.readdirSync(exportsDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && archiveId.test(entry.name))
      .map(entry => entry.name).sort().reverse();
    const results = [];
    for (const id of ids) {
      try { results.push(get(id).manifest); }
      catch {
        // A missing or incomplete manifest does not hide other saved chats.
      }
    }
    return results;
  }

  async function exportChat(options, backend, progress) {
    const { session, start, end, images, voices, files = false, videos = false } = options;
    const draft = fs.mkdtempSync(path.join(exportsDirectory, '.pending-'));
    const args = ['export', 'messages', session, '--out', draft, '--format', 'json', '--progress'];
    const media = [images && 'image', voices && 'voice', videos && 'video'].filter(Boolean);
    if (media.length) args.push('--media', media.join(','));
    if (start) args.push('--start', start);
    if (end) args.push('--end', end);
    let completed = false;
    try {
      if (images) {
        progress('正在准备保存图片。');
        try {
          const profiles = await backend.run(['config', 'profiles']);
          const ready = profiles.ok && Array.isArray(profiles.data) &&
            profiles.data.some(profile => profile.current === true && profile.imageKeys === true);
          if (!ready) await backend.run(['key', 'image', '--save']);
        } catch {
          // Keep saving the chat even if its images cannot be prepared.
        }
      }
      const report = await backend.run(args, event => {
        if (Number.isSafeInteger(event.current) && Number.isSafeInteger(event.total) && event.total > 0) {
          progress('正在保存微信聊天，进度 ' + event.current + ' / ' + event.total);
        }
      });
      if (!report.ok) throw new Error('没能保存这段聊天。请重新连接微信，再选一个人或群重试。');
      const source = path.join(draft, session + '.json');
      if (!fs.existsSync(source)) throw new Error('这些日期里没有聊天。请换一个日期范围，或把日期留空。');
      const document = readJson(source);
      if (!Array.isArray(document.messages) || !document.messages.length) {
        throw new Error('这些日期里没有聊天。请换一个日期范围，或把日期留空。');
      }
      if (voices) {
        progress('正在核对语音对应的消息');
        await repairVoices(draft, session, document.messages, backend.run, (done, total) => {
          progress('正在核对语音，进度 ' + done + ' / ' + total);
        });
      }
      if (files) await saveAttachments(draft, session, document.messages, backend, progress);
      if (videos) await repairVideos(draft, session, document.messages, backend, progress);

      const now = new Date().toISOString();
      const id = now.slice(0, 19).replace('T', '_').replace(/:/g, '-') + '_' + crypto.randomBytes(4).toString('hex');
      const manifest = {
        schema: 1, id, createdAt: now, name: document.session?.displayName || session,
        start, end, images, voices, files, videos, counts: tally(draft, document.messages)
      };
      writeArchive(draft, document, manifest);
      fs.unlinkSync(source);
      fs.renameSync(draft, path.join(exportsDirectory, id));
      completed = true;
      return manifest;
    } finally {
      // draft comes from mkdtempSync in this call, and is never a user-selected path.
      if (!completed) fs.rmSync(draft, { recursive: true, force: true });
    }
  }

  function applyTranscripts(id) {
    const { directory, manifest } = get(id);
    const document = readJson(path.join(directory, jsonFile));
    const transcripts = readJson(path.join(directory, transcriptFile));
    const byAudio = new Map(transcripts.items.map(item => [item.audio, item]));
    let recognized = 0;
    let unsuccessful = 0;
    for (const message of document.messages) {
      if (message.localType !== messageType.voice) continue;
      const audio = mediaFile(directory, message.content, voiceExtensions);
      const item = audio && byAudio.get(audio.name);
      message.voiceTranscript = item?.text || '';
      message.voiceTranscriptStatus = item?.status || (audio ? 'pending' : 'missing_audio');
      message.voiceTranscriptSource = 'machine-generated';
      if (item?.status === 'ok') recognized++;
      else if (audio) unsuccessful++;
    }
    manifest.transcription = { recognized, unsuccessful, language: transcripts.language };
    writeArchive(directory, document, manifest);
    return manifest.transcription;
  }

  return { get, list, exportChat, applyTranscripts };
}

module.exports = { createArchives, validId, validDate, readerFile, jsonFile, transcriptFile };
