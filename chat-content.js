'use strict';

const messageType = Object.freeze({
  image: 3,
  voice: 34,
  video: 43,
  file: 6 * 2 ** 32 + 49
});

function isFileMessage(message) {
  return message.type === '文件消息' || message.appMsgKind === 'file' || message.localType === messageType.file;
}

function fileName(message) {
  return message.attachment?.name || String(message.content ?? '').replace(/^\[文件\]\s*/, '').trim() || '聊天文件';
}

function httpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return '';
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password ? '' : value;
  } catch {
    return '';
  }
}

function linkCard(message) {
  if (message.type !== '链接消息' && message.appMsgKind !== 'link') return null;
  const [heading, address] = String(message.content ?? '').split(/\r?\n/, 2);
  const url = httpUrl(message.linkUrl) || httpUrl(address?.trim());
  if (!url) return null;
  const title = message.linkTitle || heading.replace(/^\[链接\]\s*/, '').trim();
  return { title: title || '网页链接', url };
}

function forwardedRecord(message) {
  if (message.type !== '聊天记录' && message.appMsgKind !== 'chat-record') return null;
  const content = String(message.content ?? '');
  const newline = content.indexOf('\n');
  const heading = newline === -1 ? content : content.slice(0, newline);
  return {
    title: heading.replace(/^\[转发的聊天记录\]\s*/, '').trim() || '聊天记录',
    text: newline === -1 ? '' : content.slice(newline + 1)
  };
}

module.exports = { messageType, isFileMessage, fileName, httpUrl, linkCard, forwardedRecord };
