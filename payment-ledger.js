'use strict';

const { cell, workbookSheets, workbookBytes } = require('./export-excel');

const ledgerFile = '转账与红包总账.xlsx';
const confirmedStatuses = new Set(['已收款', '已领取']);

function mergeEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.transactionId
      ? [entry.kind, entry.transactionId, entry.kind === 'red-packet' ? entry.receiver?.id : ''].join(':')
      : [entry.kind, entry.session, entry.messageId].join(':');
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const merged = [];
  for (const group of groups.values()) {
    const first = group[0];
    const confirmed = group.find(item => confirmedStatuses.has(item.status));
    const returned = group.find(item => item.status === '已退回');
    const amounts = new Set(group.map(item => item.amountFen).filter(value => value != null));
    const payers = new Set(group.map(item => item.payer?.id).filter(Boolean));
    const receivers = new Set(group.map(item => item.receiver?.id).filter(Boolean));
    const conflict = amounts.size > 1 || payers.size > 1 || receivers.size > 1;
    const reference = returned || confirmed || first;
    const status = conflict ? '记录有冲突' : reference.status;
    const amountFen = amounts.size === 1 ? amounts.values().next().value : null;
    const payer = reference.payer || group.find(item => item.payer)?.payer;
    const receiver = reference.receiver || group.find(item => item.receiver)?.receiver;
    const counted = confirmedStatuses.has(status) && amountFen != null && payer && receiver && payer.id !== receiver.id;
    merged.push({
      ...reference, status, amountFen, payer, receiver, counted: Boolean(counted),
      chat: [...new Set(group.map(item => item.chat))].join('、'),
      memo: group.find(item => item.memo)?.memo || ''
    });
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

function summaryRows(entries) {
  const people = new Map([['self', { name: '我', income: 0, expense: 0 }]]);
  const others = { name: '他人合计', income: 0, expense: 0 };
  function add(party, field, amount) {
    if (!people.has(party.id)) people.set(party.id, { name: party.name, income: 0, expense: 0 });
    people.get(party.id)[field] += amount;
    if (party.id !== 'self') others[field] += amount;
  }
  for (const entry of entries) {
    if (!entry.counted) continue;
    add(entry.payer, 'expense', entry.amountFen);
    add(entry.receiver, 'income', entry.amountFen);
  }
  const [me, ...participants] = people.values();
  const nameCounts = new Map();
  for (const person of participants) nameCounts.set(person.name, (nameCounts.get(person.name) || 0) + 1);
  for (const [id, person] of people) {
    if (id !== 'self' && (nameCounts.get(person.name) > 1 || person.name === '我')) person.name += '（' + id + '）';
  }
  return [me, others, ...participants.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))];
}

function number(value) {
  return value == null ? null : { type: Number, value: value / 100, format: '#,##0.00' };
}

function widths(values) {
  return values.map(width => ({ width }));
}

async function makeLedger(rawEntries, { start, end, saved, skipped }) {
  const entries = mergeEntries(rawEntries);
  const counted = entries.filter(entry => entry.counted).length;
  const unknownAmounts = entries.filter(entry => entry.amountFen == null).length;
  const summary = workbookSheets('收支汇总', ['人员', '收入（元）', '支出（元）', '净收入（元）'],
    widths([32, 17, 17, 17]), summaryRows(entries),
    person => [cell(person.name), number(person.income), number(person.expense), number(person.income - person.expense)]);
  const notes = [
    ['范围', '本次成功导出的 ' + saved + ' 段聊天，日期 ' + (start || '不限') + ' 至 ' + (end || '不限') + '。'],
    ['记账规则', '仅计算聊天中确认已收、金额和双方明确的人民币记录。'],
    ['覆盖情况', '共 ' + entries.length + ' 笔，计入收支 ' + counted + ' 笔，金额未记录或无法确认 ' + unknownAmounts + ' 笔。'],
    ['他人合计', '汇总明细中其他人的收支，包含聊天中可确认的群成员之间的往来。']
  ];
  if (skipped) notes.push(['未导出的聊天', skipped + ' 段，未计入这份总账。']);
  summary.at(-1).data.push([], ...notes.map(([label, value]) => [
    cell(label), { ...cell(value), columnSpan: 3, wrap: false }, null, null
  ]));
  const detail = workbookSheets('交易明细', ['时间', '聊天', '类型', '付款方', '收款方', '金额（元）', '状态', '计入收支', '备注'],
    widths([23, 26, 12, 23, 23, 15, 16, 14, 39]), entries,
    entry => [
      cell(entry.time), cell(entry.chat), cell(entry.kind === 'transfer' ? '转账' : '红包'),
      cell(entry.payer?.name), cell(entry.receiver?.name), number(entry.amountFen) ?? cell('未确认'),
      cell(entry.status), cell(entry.counted ? '是' : '否'), cell(entry.memo)
    ]);
  return workbookBytes([...summary, ...detail]);
}

module.exports = { ledgerFile, makeLedger };
