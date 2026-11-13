'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { messageType, paymentText, isFileMessage, fileName, httpUrl, linkCard, forwardedRecord } = require('./chat-content');
const { mediaFile, attachmentFile, imageExtensions, voiceExtensions, videoExtensions } = require('./media');

const viewerAssets = path.join(__dirname, 'viewer');
const readerStyles = fs.readFileSync(path.join(viewerAssets, 'reader.css'), 'utf8').trimEnd();
// Browsers normalize line endings before checking the hash of an inline script.
const searchScript = fs.readFileSync(path.join(viewerAssets, 'search.js'), 'utf8').replace(/\r\n?/g, '\n').trimEnd();
const scriptHash = crypto.createHash('sha256').update(searchScript).digest('base64');

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const sender = message => message.senderDisplayName || (message.isSend ? '我' : '对方');

function webLink(url, label) {
  return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(label) + '</a>';
}

function linkify(value) {
  const text = String(value ?? '');
  let result = '';
  let end = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，。！？；：“”‘’（）【】《》]+/gi)) {
    let url = match[0].replace(/[.,!?;:]+$/, '');
    while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) {
      url = url.slice(0, -1);
    }
    if (!httpUrl(url)) continue;
    result += escapeHtml(text.slice(end, match.index)) + webLink(url, url);
    end = match.index + url.length;
  }
  return result + escapeHtml(text.slice(end));
}

function renderFile(directory, message, options) {
  const file = attachmentFile(directory, message.attachment);
  const name = escapeHtml(fileName(message));
  if (file) {
    return '<p class="attachment">文件 · <a href="' + escapeHtml(file.url) + '">' + name + '</a></p>';
  }
  const reason = options.files ? '文件未保存' : '未选择保存文件';
  return '<p class="attachment">文件 · ' + name + '</p><p class="note">' + reason + '</p>';
}

function renderBody(directory, message, options) {
  if (message.payment) return '<div class="content">' + escapeHtml(paymentText(message)) + '</div>';
  if (message.localType === messageType.image) {
    const image = mediaFile(directory, message.content, imageExtensions);
    return image
      ? '<a href="' + escapeHtml(image.url) + '"><img loading="lazy" src="' + escapeHtml(image.url) + '" alt="查看聊天图片"></a>'
      : '<p class="note">' + (options.images === false ? '未选择保存图片' : '这张图片没能保存') + '</p>';
  }
  if (message.localType === messageType.voice) {
    const audio = mediaFile(directory, message.content, voiceExtensions);
    let body = audio
      ? '<audio controls preload="none" src="' + escapeHtml(audio.url) + '"></audio>'
      : '<p class="note">' + (options.voices === false ? '未选择导出语音' : '本地语音不可用') + '</p>';
    if (message.voiceTranscript) body += '<p class="note">语音转成的文字 · ' + escapeHtml(message.voiceTranscript) + '</p>';
    else if (message.voiceTranscriptStatus === 'empty' || message.voiceTranscriptStatus === 'error') {
      body += '<p class="note">这条语音没能变成文字，可以播放原来的语音。</p>';
    }
    return body;
  }
  if (message.localType === messageType.video) {
    const video = mediaFile(directory, message.content, videoExtensions);
    if (!video) return '<p class="note">' + (options.videos ? '这个视频没能保存' : '未选择保存视频') + '</p>';
    const url = escapeHtml(video.url);
    return '<video controls playsinline preload="none" src="' + url + '"></video>' +
      '<p class="note"><a href="' + url + '">打开视频文件</a></p>';
  }
  if (isFileMessage(message)) return renderFile(directory, message, options);
  const forwarded = forwardedRecord(message);
  if (forwarded) {
    return '<details class="forward"><summary>合并转发 · ' + escapeHtml(forwarded.title) + '</summary>' +
      (forwarded.text ? '<div class="content">' + linkify(forwarded.text) + '</div>'
        : '<p class="note">微信未提供里面的消息。</p>') + '</details>';
  }
  const link = linkCard(message);
  if (link) {
    return '<div class="content">' + webLink(link.url, link.title) + '<br>' + escapeHtml(link.url) + '</div>';
  }
  return '<div class="content">' + linkify(message.content) + '</div>';
}

function renderViewer(directory, document, options = {}) {
  const title = escapeHtml(document.session?.displayName || '聊天记录');
  const rows = document.messages.map(message =>
    '<article class="' + (message.isSend ? 'mine' : '') + '"><div class="meta">' +
    escapeHtml(message.formattedTime) + ' · ' + escapeHtml(sender(message)) + '</div>' +
    renderBody(directory, message, options) + '</article>');
  const missingImages = options.images && options.counts ? options.counts.images - options.counts.imageFiles : 0;
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' file:; media-src \'self\' file:; style-src \'unsafe-inline\'; script-src \'sha256-' + scriptHash + '\'; base-uri \'none\'; form-action \'none\'">\n' +
    '<title>' + title + ' · ChatKeepsake</title>\n' +
    '<style>\n' + readerStyles + '\n</style>\n</head>\n<body>\n<header><div>' +
    '<h1>' + title + '</h1><p class="note">' +
    (options.demo ? '示例聊天，可以试着看图、听语音和搜索。' : '要移动这段聊天，请把整个文件夹一起移动。语音下面的文字可能有听错的地方。') +
    '</p><input id="query" type="search" aria-label="搜索聊天记录" placeholder="搜索消息、日期或语音转成的文字">' +
    '<span id="matches" role="status">显示 ' + rows.length + ' 条</span></div></header>\n<main>\n' +
    (missingImages > 0 ? '<p class="note">已保存 ' + options.counts.imageFiles + ' 张图片，' + missingImages +
      ' 张没能保存。可以在电脑版微信打开这些图片，再保存一次聊天。</p>\n' : '') +
    rows.join('\n') + '\n</main>\n<script>' + searchScript + '</script>\n</body>\n</html>\n';
}

module.exports = { renderViewer, sender };
