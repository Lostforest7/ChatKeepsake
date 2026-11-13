'use strict';

// Synthetic chat exports and the matching local reader responses.

const fs = require('node:fs');
const path = require('node:path');
const { messageType } = require('../chat-content');

const testTime = 1767225600;
const me = 'wxid_demo';
const bob = 'wxid_bob';
const ada = 'wxid_ada';
const carol = 'wxid_carol';
const group = 'friends@chatroom';
const missing = 'wxid_empty';
const inaccessible = 'wxid_unavailable';
const names = { [me]: '演示用户', [bob]: '小林', [ada]: '小周', [carol]: '小陈' };
const title = { [bob]: '小林', [group]: '周末出游', [missing]: '日期内无记录', [inaccessible]: '暂不可读取' };
const fields = new Map();

function payment(id, sender, kind, xml, content = kind === 'transfer' ? '[转账]' : '[红包] 微信红包') {
  const message = {
    platformMessageId: String(id),
    createTime: testTime + id,
    formattedTime: '2026-01-01 08:' + String(Math.floor(id / 60)).padStart(2, '0') + ':' + String(id % 60).padStart(2, '0'),
    localType: kind === 'transfer' ? messageType.transfer : messageType.redPacket,
    isSend: Number(sender === me), senderUsername: sender, senderDisplayName: names[sender], content
  };
  if (xml) fields.set(String(id), '<msg><appmsg><type>' + (kind === 'transfer' ? '2000' : '2001') +
    '</type><wcpayinfo>' + xml + '</wcpayinfo></appmsg></msg>');
  return message;
}

function transfer(id, sender, order, subtype, amount, payer, receiver, memo = '') {
  const xml = '<transferid>' + order + '</transferid><paysubtype>' + subtype + '</paysubtype><feedesc><![CDATA[' + amount +
    ']]></feedesc><payer_username>' + payer + '</payer_username><receiver_username>' + receiver +
    '</receiver_username><pay_memo><![CDATA[' + memo + ']]></pay_memo>';
  return payment(id, sender, 'transfer', xml, '[转账] (' + names[payer] + ' 转账给 ' + names[receiver] + ') ' + amount + ' 午餐');
}

const chats = {
  [bob]: [
    transfer(1, me, 't-lunch', 1, '￥12.50', me, bob, '=1+1'),
    transfer(2, bob, 't-lunch', 3, '￥12.50', me, bob),
    transfer(3, bob, 't-lunch', 3, '￥12.50', me, bob),
    transfer(4, bob, 't-ticket', 1, '¥1,234.50', bob, me),
    transfer(5, me, 't-ticket', 3, '¥1,234.50', bob, me),
    transfer(6, me, 't-pending', 1, '￥2.34', me, bob),
    transfer(7, bob, 't-refund', 1, '￥50.00', bob, me),
    transfer(8, me, 't-refund', 4, '￥50.00', bob, me),
    payment(9, bob, 'red-packet', '<paymsgid>hb-in</paymsgid><redenvelopereceiveamount>88</redenvelopereceiveamount>' +
      '<receivertitle><![CDATA[周末快乐 & 顺利]]></receivertitle><nativeurl>wxpay://example?x=1&y=2</nativeurl>'),
    payment(10, me, 'red-packet', '<paymsgid>hb-out</paymsgid><redenvelopereceiveamount>168</redenvelopereceiveamount>'),
    payment(11, bob, 'red-packet', '<paymsgid>hb-unknown</paymsgid><redenvelopereceiveamount>-1</redenvelopereceiveamount>' +
      '<total_fee>(null)</total_fee><receivertitle>祝你2026快乐</receivertitle>'),
    payment(12, bob, 'transfer', '', '[转账收款] (小林 转账给 我) ￥9.99 模拟原详情不可用'),
    { localType: 1, content: '[转账] ￥99999.99', isSend: 0, senderUsername: bob }
  ],
  [group]: [
    transfer(21, ada, 't-group', 1, '￥20.00', ada, carol),
    transfer(22, carol, 't-group', 3, '￥20.00', ada, carol),
    payment(23, ada, 'red-packet', '<paymsgid>hb-group</paymsgid><total_fee>2000</total_fee><redenvelopereceiveamount>218</redenvelopereceiveamount>'),
    payment(24, me, 'red-packet', '<paymsgid>hb-mine</paymsgid><total_fee>300</total_fee><redenvelopereceiveamount>-1</redenvelopereceiveamount>'),
    payment(25, ada, 'red-packet', '<newaa><newaatype>2</newaatype></newaa><total_fee>550</total_fee>'),
    { localType: 1, content: '周末见', isSend: 0, senderUsername: carol, senderDisplayName: names[carol] }
  ]
};

function paymentBackend() {
  const commands = [];
  return {
    supported: true,
    isInstalled: () => true,
    commands,
    async run(args) {
      commands.push(args);
      if (args[0] === 'config') return { ok: true, data: args[2] === 'wxid' ? me : {} };
      if (args[0] === 'db') return { ok: true, data: {} };
      if (args[1] === 'sessions') return {
        ok: true, data: { sessions: Object.entries(title).map(([username, displayName]) => ({ username, displayName })) }
      };
      if (args[1] === 'message') {
        const id = args[args.indexOf('--server-id') + 1];
        const message = chats[args[2]]?.find(item => item.platformMessageId === id);
        const content = fields.get(id);
        return message && content && !args.includes('--parsed')
          ? { ok: true, data: { message: { serverId: id, localType: message.localType, createTime: message.createTime, content } } }
          : { ok: false };
      }
      if (args[0] === 'export') {
        const session = args[2];
        if (session === missing) return { ok: false, code: 'no_messages' };
        if (session === inaccessible) return { ok: false, code: 'runtime_error' };
        const file = path.join(args[args.indexOf('--out') + 1], session + '.json');
        fs.writeFileSync(file, JSON.stringify({ session: { wxid: session, displayName: title[session] }, messages: chats[session] }));
        return { ok: true };
      }
      throw new Error('Unexpected fixture command');
    }
  };
}

module.exports = { paymentBackend, bob, group, missing, inaccessible };
