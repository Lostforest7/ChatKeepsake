'use strict';

const messageType = Object.freeze({
  image: 3,
  voice: 34,
  video: 43,
  file: 6 * 2 ** 32 + 49,
  transfer: 2000 * 2 ** 32 + 49,
  redPacket: 2001 * 2 ** 32 + 49
});

function paymentKind(message) {
  if (message.localType === messageType.transfer || message.type === '转账消息' || message.appMsgKind === 'transfer') return 'transfer';
  if (message.localType === messageType.redPacket || message.type === '红包消息' || message.appMsgKind === 'red-packet') return 'red-packet';
  return message.localType === 49 && typeof message.content === 'string' && /^\[红包\]/.test(message.content) ? 'red-packet' : null;
}

function yuan(amountFen) {
  return (amountFen / 100).toFixed(2) + ' 元';
}

function paymentText(message) {
  const payment = message.payment;
  if (!payment) return '';
  const label = payment.kind === 'transfer' ? '转账' : '红包';
  const parts = [label, payment.amountFen == null ? '金额未记录' : yuan(payment.amountFen), payment.status];
  if (payment.payer && payment.receiver) parts.push(payment.payer + ' → ' + payment.receiver);
  if (payment.memo) parts.push(payment.memo);
  return parts.join(' · ');
}

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

module.exports = { messageType, paymentKind, paymentText, yuan, isFileMessage, fileName, httpUrl, linkCard, forwardedRecord };
