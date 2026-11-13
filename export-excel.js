'use strict';

const { messageType, isFileMessage, fileName, linkCard, forwardedRecord } = require('./chat-content');
const { mediaFile, attachmentFile, imageExtensions, voiceExtensions, videoExtensions } = require('./media');
const { sender } = require('./make-viewer');

const excelFile = '聊天记录.xlsx';
const rowsPerSheet = 1_048_575; // Excel allows one more row for the headings.
const cellLimit = 32_767;
const headings = ['时间', '发送人', '类型', '内容', '附件路径', '语音转文字'];
const columns = [23, 21, 15, 62, 38, 55].map(width => ({ width }));
const mediaTypes = new Map([
  [messageType.image, ['图片', imageExtensions]],
  [messageType.voice, ['语音', voiceExtensions]],
  [messageType.video, ['视频', videoExtensions]]
]);

function cell(value) {
  // Chat content must remain literal text, even when it starts with "=".
  const text = String(value ?? '').toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '');
  const suffix = '…（完整内容见 JSON）';
  const display = text.length > cellLimit ? text.slice(0, cellLimit - suffix.length).toWellFormed() + suffix : text;
  return display ? { type: String, value: display, wrap: true, alignVertical: 'top' } : null;
}

function row(directory, message) {
  let type = message.type || (message.localType === 1 ? '文字' : '其他');
  let text = message.content;
  let attachment = '';
  const media = mediaTypes.get(message.localType);
  if (media) {
    const [label, extensions] = media;
    type = label;
    attachment = mediaFile(directory, message.content, extensions)?.name || '';
    text = '[' + label + ']';
  } else if (isFileMessage(message)) {
    type = '文件';
    text = fileName(message);
    attachment = attachmentFile(directory, message.attachment)?.name || '';
  } else {
    const link = linkCard(message);
    const forwarded = forwardedRecord(message);
    if (link) text = link.title + '\n' + link.url;
    else if (forwarded) text = [forwarded.title, forwarded.text].filter(Boolean).join('\n');
  }
  return [message.formattedTime, sender(message), type, text, attachment, message.voiceTranscript].map(cell);
}

async function excelBytes(directory, messages) {
  const header = headings.map(value => ({ value, fontWeight: 'bold', color: '#FFFFFF', backgroundColor: '#276447' }));
  const sheets = [];
  for (let offset = 0; offset < messages.length; offset += rowsPerSheet) {
    const sheet = messages.length > rowsPerSheet ? '聊天记录 ' + (sheets.length + 1) : '聊天记录';
    const data = [header];
    for (let index = offset; index < Math.min(offset + rowsPerSheet, messages.length); index++) {
      data.push(row(directory, messages[index]));
    }
    sheets.push({ sheet, columns, data, stickyRowsCount: 1 });
  }
  try {
    const writeExcelFile = require('write-excel-file/node');
    return await writeExcelFile(sheets, { fontFamily: 'Microsoft YaHei', fontSize: 11 }).toBuffer();
  } catch (error) {
    throw new Error('没能生成 Excel 文件，请重试。', { cause: error });
  }
}

module.exports = { excelBytes, excelFile };
