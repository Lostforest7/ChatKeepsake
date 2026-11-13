'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderViewer, sender } = require('./make-viewer');
const { messageType, paymentText, isFileMessage, fileName, linkCard } = require('./chat-content');
const { mediaFile, attachmentFile, imageExtensions, voiceExtensions, videoExtensions } = require('./media');
const { repairVoices } = require('./repair-voices');
const { repairVideos } = require('./repair-videos');
const { saveAttachments } = require('./save-attachments');
const { excelBytes, excelFile } = require('./export-excel');
const { ownIdentity, readChatPayments } = require('./chat-payments');
const { ledgerFile, makeLedger } = require('./payment-ledger');

const readerFile = '完整聊天记录.html';
const jsonFile = '聊天记录.json';
const manifestFile = '导出说明.json';
const transcriptFile = 'voice-transcripts.json';
const batchManifest = '批次说明.json';
const archiveId = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{8}$/;
const batchId = /^批量导出_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{8})$/;

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

function identifier(now) {
  return now.slice(0, 19).replace('T', '_').replace(/:/g, '-') + '_' + crypto.randomBytes(4).toString('hex');
}

async function withDraft(base, work) {
  const draft = fs.mkdtempSync(path.join(base, '.pending-'));
  try {
    return await work(draft);
  } finally {
    try {
      if (fs.realpathSync.native(draft) === draft && fs.lstatSync(draft).isDirectory()) {
        fs.rmSync(draft, { recursive: true, force: true });
      }
    } catch {
      // A disconnected drive can leave an incomplete folder, which list() skips.
    }
  }
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

async function writeArchive(directory, document, manifest) {
  const lines = document.messages.map(message => {
    let body = paymentText(message) || String(message.content ?? '');
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
  const workbook = await excelBytes(directory, document.messages);
  commitFiles(directory, [
    [excelFile, workbook],
    [readerFile, renderViewer(directory, document, manifest)],
    ['聊天记录.txt', lines.join('\n\n') + '\n'],
    [jsonFile, JSON.stringify(document, null, 2) + '\n'],
    [manifestFile, JSON.stringify(manifest, null, 2) + '\n']
  ]);
}

// Prepare every replacement first. If an open reader or workbook prevents a
// rename, restore the originals before reporting the error.
function commitFiles(directory, files) {
  const suffix = '.' + crypto.randomBytes(6).toString('hex');
  const staged = [];
  try {
    for (const [name, content] of files) {
      const target = path.join(directory, name);
      const entry = { target, temporary: target + suffix + '.tmp', backup: target + suffix + '.bak' };
      staged.push(entry);
      fs.writeFileSync(entry.temporary, content, { flag: 'wx' });
    }
    for (const entry of staged) {
      try {
        if (!fs.lstatSync(entry.target).isFile()) throw new Error('导出文件位置已有同名目录或链接。');
        fs.renameSync(entry.target, entry.backup);
        entry.original = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.renameSync(entry.temporary, entry.target);
      entry.replaced = true;
    }
  } catch (error) {
    for (const entry of staged.slice().reverse()) {
      if (entry.replaced) fs.rmSync(entry.target, { force: true });
      if (entry.original) fs.renameSync(entry.backup, entry.target);
    }
    if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
      throw new Error('无法更新聊天文件。请关闭已打开的 Excel 或其他导出文件，再重试。', { cause: error });
    }
    throw error;
  } finally {
    for (const entry of staged) {
      fs.rmSync(entry.temporary, { force: true });
    }
  }
  for (const entry of staged) {
    if (entry.original) fs.rmSync(entry.backup, { force: true });
  }
}

function createArchives(exportsDirectory) {
  function get(id, batch = '') {
    if (typeof id !== 'string' || !archiveId.test(id) || typeof batch !== 'string' || (batch && !batchId.test(batch))) {
      throw new Error('请选择已完成的导出记录。');
    }
    try {
      const relative = path.join(batch, id);
      const base = fs.realpathSync.native(exportsDirectory);
      const directory = fs.realpathSync.native(path.join(base, relative));
      if (path.relative(base, directory) !== relative) throw new Error('Invalid archive path');
      const manifest = readJson(path.join(directory, manifestFile));
      const totalMessages = manifest?.counts?.messages;
      if (manifest?.schema !== 1 || manifest.id !== id ||
          !Number.isSafeInteger(totalMessages) || totalMessages < 0) throw new Error('Invalid archive manifest');
      return { directory, manifest, batch };
    } catch {
      throw new Error('找不到这次导出。请刷新导出列表。');
    }
  }

  function list() {
    const results = [];
    function add(id, batch, ledger) {
      try {
        const { directory, manifest } = get(id, batch);
        results.push({ ...manifest, directory, ...(batch ? { batch, ledger } : {}) });
      } catch {
        // An incomplete export does not hide other saved chats.
      }
    }
    for (const entry of fs.readdirSync(exportsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (archiveId.test(entry.name)) {
        add(entry.name, '', false);
      } else if (batchId.test(entry.name)) {
        try {
          const batch = readJson(path.join(exportsDirectory, entry.name, batchManifest));
          if (batch.schema !== 1 || !Array.isArray(batch.records)) continue;
          for (const id of batch.records) add(id, entry.name, batch.ledger === true);
        } catch {
          // A batch folder may have been moved or manually removed.
        }
      }
    }
    return results.sort((a, b) => b.id.localeCompare(a.id));
  }

  async function writeChat(draft, options, backend, progress, getOwnIdentity) {
    const { session, start, end, images, voices, files = false, videos = false, payments = false } = options;
    const args = ['export', 'messages', session, '--out', draft, '--format', 'json', '--progress'];
    const media = [images && 'image', voices && 'voice', videos && 'video'].filter(Boolean);
    if (media.length) args.push('--media', media.join(','));
    if (start) args.push('--start', start);
    if (end) args.push('--end', end);
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
    if (report.code === 'no_messages') return null;
    if (!report.ok) throw new Error('没能保存这段聊天。请重新连接微信后再试。');
    const source = path.join(draft, session + '.json');
    if (!fs.existsSync(source)) return null;
    const document = readJson(source);
    if (!Array.isArray(document.messages)) throw new Error('没能读取导出的聊天，请重试。');
    if (!document.messages.length) return null;
    if (voices) {
      progress('正在核对语音对应的消息');
      await repairVoices(draft, session, document.messages, backend.run, (done, total) => {
        progress('正在核对语音，进度 ' + done + ' / ' + total);
      });
    }
    if (files) await saveAttachments(draft, session, document.messages, backend, progress);
    if (videos) await repairVideos(draft, session, document.messages, backend, progress);
    const entries = payments ? await readChatPayments(session, document, backend, getOwnIdentity, progress) : [];

    const now = new Date().toISOString();
    const id = identifier(now);
    const manifest = {
      schema: 1, id, createdAt: now, name: document.session?.displayName || session,
      start, end, images, voices, files, videos, counts: tally(draft, document.messages),
      ...(payments ? { payments: entries.length } : {})
    };
    await writeArchive(draft, document, manifest);
    fs.unlinkSync(source);
    return { manifest, entries };
  }

  async function exportChat(options, backend, progress) {
    const base = fs.realpathSync.native(exportsDirectory);
    return withDraft(base, async draft => {
      const result = await writeChat(draft, options, backend, progress, () => ownIdentity(backend));
      if (!result) throw new Error('这些日期里没有聊天。请换一个日期范围，或把日期留空。');
      if (options.payments) {
        progress('正在生成转账与红包总账。');
        const ledger = await makeLedger(result.entries, { ...options, saved: 1, skipped: 0 });
        fs.writeFileSync(path.join(draft, ledgerFile), ledger, { flag: 'wx' });
      }
      fs.renameSync(draft, path.join(base, result.manifest.id));
      return result.manifest;
    });
  }

  async function exportBatch(sessions, options, backend, progress) {
    const base = fs.realpathSync.native(exportsDirectory);
    return withDraft(base, async draft => {
      const records = [];
      const entries = [];
      const skipped = [];
      let account;
      const getOwnIdentity = () => account ??= ownIdentity(backend);
      for (const [index, session] of sessions.entries()) {
        const label = '第 ' + (index + 1) + ' / ' + sessions.length + ' 段聊天。';
        progress('正在保存' + label);
        await withDraft(draft, async chat => {
          try {
            const result = await writeChat(chat, { ...options, session }, backend, message => progress(label + message), getOwnIdentity);
            if (!result) {
              skipped.push({ session, empty: true });
              return;
            }
            fs.renameSync(chat, path.join(draft, result.manifest.id));
            records.push(result.manifest);
            for (const entry of result.entries) entries.push(entry);
          } catch {
            skipped.push({ session, empty: false });
          }
        });
      }
      if (!records.length) {
        if (skipped.every(item => item.empty)) throw new Error('这些日期里没有聊天。请换一个日期范围，或把日期留空。');
        throw new Error('没能保存选中的聊天。请检查保存位置和微信连接，再试一次。');
      }
      if (options.payments) {
        progress('正在生成转账与红包总账。');
        const ledger = await makeLedger(entries, { ...options, saved: records.length, skipped: skipped.length });
        fs.writeFileSync(path.join(draft, ledgerFile), ledger, { flag: 'wx' });
      }
      fs.writeFileSync(path.join(draft, batchManifest), JSON.stringify({
        schema: 1, records: records.map(record => record.id), ledger: options.payments === true
      }) + '\n', { flag: 'wx' });
      const batch = '批量导出_' + identifier(new Date().toISOString());
      fs.renameSync(draft, path.join(base, batch));
      return { records, skipped, batch };
    });
  }

  async function saveExcel(id, batch = '') {
    const { directory } = get(id, batch);
    const file = path.join(directory, excelFile);
    try { if (fs.lstatSync(file).isFile()) return file; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { messages } = readJson(path.join(directory, jsonFile));
    if (!Array.isArray(messages) || !messages.length) throw new Error('找不到这段聊天的消息，无法生成 Excel。');
    commitFiles(directory, [[excelFile, await excelBytes(directory, messages)]]);
    return file;
  }

  async function applyTranscripts(id, batch = '') {
    const { directory, manifest } = get(id, batch);
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
    await writeArchive(directory, document, manifest);
    return manifest.transcription;
  }

  return { get, list, exportChat, exportBatch, saveExcel, applyTranscripts };
}

module.exports = { createArchives, validId, validDate, readerFile, jsonFile, transcriptFile };
