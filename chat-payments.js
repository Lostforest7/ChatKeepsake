'use strict';

const { SaxesParser } = require('saxes');
const { paymentKind } = require('./chat-content');
const { lookupMessage } = require('./weflow');

const statuses = new Map([
  ['1', '待收款'], ['3', '已收款'], ['4', '已退回']
]);
const unknownStatus = '状态未确认';
const moneyFields = new Set([
  'feedesc', 'fee_type', 'total_fee', 'redenvelopereceiveamount', 'paysubtype',
  'payer_username', 'receiver_username', 'transferid', 'transcationid',
  'transactionid', 'paymsgid', 'pay_memo', 'receivertitle', 'sendertitle'
]);

function readPaymentFields(content) {
  if (typeof content !== 'string' || content.length > 256_000) return {};
  const decoded = content.includes('<') ? content : content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const start = decoded.indexOf('<');
  if (start < 0) return {};
  const fields = Object.create(null);
  const tags = [];
  let value = '';
  function isField() {
    const base = tags[0] === 'msg' ? 1 : 0;
    if (tags[base] !== 'appmsg' || tags[base + 1] !== 'wcpayinfo') return false;
    const field = tags.at(-1);
    return (tags.length === base + 3 && moneyFields.has(field)) ||
      (tags.length === base + 4 && field === 'newaatype' && tags.at(-2) === 'newaa');
  }
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('Unexpected XML doctype'); });
  parser.on('opentag', tag => {
    tags.push(tag.name.toLowerCase());
    if (tags.length > 32) throw new Error('Unexpected XML depth');
    if (isField()) value = '';
  });
  function append(text) { if (isField()) value += text; }
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    if (isField()) {
      const field = tags.at(-1);
      if (Object.hasOwn(fields, field) && fields[field] !== value.trim()) throw new Error('Conflicting payment fields');
      fields[field] = value.trim();
    }
    tags.pop();
  });
  try {
    // Some older cards contain literal ampersands in URL text.
    const xml = decoded.slice(start).replace(/<!\[CDATA\[[\s\S]*?\]\]>|&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[\da-f]+);)/gi,
      match => match === '&' ? '&amp;' : match);
    parser.write(xml).close();
    return fields;
  } catch {
    return {};
  }
}

function identity(value) {
  return typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) ? value.toLowerCase() : '';
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  return a === b || (a.startsWith(b + '_') && a.length === b.length + 5) ||
    (b.startsWith(a + '_') && b.length === a.length + 5);
}

function minorUnits(value) {
  if (!/^[1-9]\d{0,11}$/.test(value ?? '')) return null;
  return Number(value);
}

function displayedAmount(value) {
  const match = /^\s*(?:([￥¥]|CNY|RMB)\s*)?(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?(?:\s*(元))?(?=$|\s|[，。；;])/i.exec(value);
  if (!match || (!match[1] && !match[4])) return null;
  const [, , whole, fraction = ''] = match;
  return minorUnits(String(Number(whole.replaceAll(',', '')) * 100 + Number(fraction.padEnd(2, '0'))));
}

function transferAmount(fields, content) {
  const display = content.replace(/^\[转账(?:收款)?\]\s*(?:\([^\r\n]*? 转账给 [^\r\n]*?\)\s*)?/, '');
  return displayedAmount(fields.feedesc || '') ?? minorUnits(fields.total_fee) ??
    (display === content ? null : displayedAmount(display));
}

function partyName(id, context) {
  if (!id) return null;
  if (context.mine.has(id) || [...context.mine].some(mine => sameIdentity(mine, id))) {
    return { id: 'self', name: '我' };
  }
  if (id === context.peer) return { id, name: context.chatName };
  return { id, name: context.names.get(id) || '未显示昵称' };
}

function parties(message, fields, status, context, redPacket) {
  const sent = message.isSend === true || message.isSend === 1;
  const hasDirection = sent || message.isSend === false || message.isSend === 0;
  const senderId = identity(message.senderUsername);
  const sender = sent ? context.me : partyName(senderId || context.peer, context);
  const receiver = sent ? partyName(context.peer, context) : (hasDirection && context.peer ? context.me : null);
  const payerField = partyName(identity(fields.payer_username), context);
  const receiverField = partyName(identity(fields.receiver_username), context);
  if (redPacket) {
    return { payer: payerField || sender,
      receiver: receiverField || (status === '已领取' && !sent && hasDirection ? context.me : receiver) };
  }
  if (status === '待收款') {
    return { payer: payerField || sender, receiver: receiverField || receiver };
  }
  if (status === '已收款') {
    return { payer: payerField || receiver, receiver: receiverField || sender };
  }
  return { payer: payerField, receiver: receiverField };
}

function note(value) {
  return typeof value === 'string' && !/^(?:null|\(null\))$/i.test(value) ? value.slice(0, 500) : '';
}

function transactionId(fields, kind) {
  const values = kind === 'transfer' ? [fields.transferid, fields.transcationid, fields.transactionid] : [fields.paymsgid];
  return values.find(value => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{1,159}$/.test(value) && !/^0+$|^null$/i.test(value)) || '';
}

function paymentFrom(message, kind, fields, context) {
  // WeChat also stores split bills as app-message subtype 2001.
  if (kind === 'red-packet' && /^[1-9]\d*$/.test(fields.newaatype || '')) return null;
  const redPacket = kind === 'red-packet';
  const content = typeof message.content === 'string' ? message.content : '';
  const currency = fields.fee_type?.toUpperCase();
  const inYuan = !currency || /^(?:CNY|RMB|156|NULL|\(NULL\))$/.test(currency);
  const receivedFen = redPacket && inYuan ? minorUnits(fields.redenvelopereceiveamount) : null;
  let status;
  let amountFen;
  if (redPacket) {
    status = receivedFen != null ? '已领取' : unknownStatus;
    if (/^(?:红包)?(?:已退回|已退款|已过期)$/.test(fields.sendertitle || '')) status = '已退回';
    amountFen = inYuan ? receivedFen ?? minorUnits(fields.total_fee) ?? displayedAmount(fields.feedesc || '') : null;
  } else {
    status = statuses.get(fields.paysubtype) || unknownStatus;
    amountFen = inYuan ? transferAmount(fields, content) : null;
  }
  const sides = parties(message, fields, status, context, redPacket);
  return { kind, status, amountFen, ...sides,
    memo: note(redPacket ? fields.receivertitle : fields.pay_memo) };
}

async function ownIdentity(backend) {
  try {
    const result = await backend.run(['config', 'get', 'wxid']);
    return result.ok ? identity(result.data) : '';
  } catch {
    return '';
  }
}

async function readChatPayments(session, document, backend, getOwnIdentity, progress) {
  const candidates = document.messages.filter(paymentKind);
  if (!candidates.length) return [];
  const configured = await getOwnIdentity();
  const context = {
    mine: new Set(configured ? [configured] : []),
    names: new Map(),
    peer: identity(session),
    chatName: document.session?.displayName || session,
    me: { id: 'self', name: '我' }
  };
  for (const message of document.messages) {
    const id = identity(message.senderUsername);
    if (!id) continue;
    if (message.isSend === true || message.isSend === 1) context.mine.add(id);
    if (typeof message.senderDisplayName === 'string' && message.senderDisplayName) context.names.set(id, message.senderDisplayName);
  }

  const entries = [];
  for (const [index, message] of candidates.entries()) {
    progress('正在核对转账与红包，已检查 ' + (index + 1) + ' / ' + candidates.length + ' 条。');
    let raw;
    try { raw = await lookupMessage(backend, session, message, { parsed: false }); }
    catch { /* Keep the export when the local payment detail is unavailable. */ }
    const fields = readPaymentFields(raw?.content);
    const payment = paymentFrom(message, paymentKind(message), fields, context);
    if (!payment) continue;
    message.payment = {
      ...payment, payer: payment.payer?.name || null, receiver: payment.receiver?.name || null
    };
    entries.push({
      ...payment, transactionId: transactionId(fields, payment.kind), chat: context.chatName, session,
      time: message.formattedTime || '', timestamp: message.createTime || 0,
      messageId: String(message.platformMessageId || message.localId || index + 1)
    });
  }
  return entries;
}

module.exports = { ownIdentity, readChatPayments };
