'use strict';

const $ = id => document.getElementById(id);
const tokenFromAddress = location.hash.slice(1);
const token = /^[a-f0-9]{64}$/.test(tokenFromAddress) ? tokenFromAddress : sessionStorage.getItem('chatKeepsakeToken') || '';
if (tokenFromAddress) {
  sessionStorage.setItem('chatKeepsakeToken', token);
  history.replaceState(null, '', location.pathname);
}

let environment = {};
let sessions = [];
let records = [];
let locations = [];
let lastConnected = '';
let lastProfile = {};
let currentWeChat = null;
let connected = false;
let setupNeeded = false;
let checking = false;
let requesting = false;
let running = false;
let poll = null;

function notice(message, kind = 'idle') {
  if ($('status').textContent !== message) $('status').textContent = message;
  $('status-dot').dataset.kind = kind;
}

async function call(operation, body = {}, isFile = false) {
  let response;
  try {
    response = await fetch('/api/' + operation, {
      method: 'POST',
      headers: {
        'Content-Type': isFile ? 'application/octet-stream' : 'application/json',
        'X-Local-Token': token
      },
      body: isFile ? body : JSON.stringify(body)
    });
  } catch {
    throw new Error('工具没有响应。请看看启动时打开的窗口是否还在。');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
  return result;
}

function selectedRecord() {
  return records.find(record => record.id === $('archive').value);
}

function updateControls() {
  const busy = requesting || running || checking;
  const installed = Boolean(environment.installed);
  const selected = selectedRecord();
  const savePath = selected?.directory || environment.exportsDirectory || '';
  $('save-location').hidden = !savePath;
  if ($('output-path').textContent !== savePath) $('output-path').textContent = savePath;
  $('component-actions').hidden = installed;
  $('install-help').hidden = !environment.supported;
  $('install').disabled = busy || !environment.supported;
  $('install-file').disabled = busy || !environment.supported;
  $('component-help').textContent = environment.supported === false
    ? '保存微信聊天需要一台 64 位 Windows 电脑。你可以先打开示例。'
    : '首次保存微信聊天时，工具会自动下载约 12 MB 并安装。';
  $('connection').hidden = !installed;
  $('connection').disabled = busy || !installed;
  $('use-current').hidden = !currentWeChat;
  $('connect-next').hidden = !setupNeeded;
  $('export-fields').hidden = !connected;
  $('export-fields').disabled = busy || !connected;
  $('export-help').textContent = connected ? '选一个人或群，再点「保存这段聊天」。' : '连上微信后，这里会显示你聊过的人和群。';
  $('save-account').disabled = !$('account').value;
  $('export').disabled = !$('session').value;
  $('archive').disabled = busy || records.length === 0;
  $('saved-controls').hidden = records.length === 0;
  $('refresh').disabled = busy;
  $('open-reader').disabled = busy || !selected;
  $('open-folder').disabled = busy || !selected;
  $('open-exports').disabled = busy || !environment.exportsDirectory;
  const hasVoice = Boolean(selected?.counts.voiceFiles);
  const canTranscribe = hasVoice && (environment.voiceSupported || environment.voiceReady);
  $('voice-setup').hidden = !hasVoice;
  $('transcribe').disabled = busy || !canTranscribe;
  $('language').disabled = busy || !canTranscribe;
  if (environment.voiceReady) {
    $('voice-help').textContent = '语音在本机转写。默认逐条识别中英文，文字会显示在语音下面。';
  } else if (environment.voiceSupported) {
    $('voice-help').textContent = '首次点击会自动下载约 ' + environment.voiceDownloadMb + ' MB。准备好后会接着转写，之后可离线使用。';
  } else {
    $('voice-help').textContent = '语音转文字需要 64 位 Windows。';
  }
}

async function loadEnvironment() {
  const info = await call('info');
  if (info.apiVersion !== 7) {
    throw new Error('旧版 ChatKeepsake 还在运行。请关闭原来的启动窗口，再双击「启动 ChatKeepsake」。');
  }
  environment = info;
  $('download').href = environment.download;
  updateControls();
}

function setOptions(select, entries, placeholder, preferred = '') {
  select.replaceChildren(new Option(placeholder, ''));
  for (const { id, name } of entries) select.add(new Option(name, id));
  if (entries.some(entry => entry.id === preferred)) select.value = preferred;
}

function renderSessions() {
  const query = $('search').value.trim().toLowerCase();
  const previous = $('session').value;
  const matches = sessions.filter(session => (session.name + ' ' + session.id).toLowerCase().includes(query));
  const names = new Map();
  for (const session of matches) names.set(session.name, (names.get(session.name) || 0) + 1);
  setOptions($('session'), matches.map(session => ({
    id: session.id,
    name: names.get(session.name) > 1 ? session.name + '（' + session.id + '）' : session.name
  })), matches.length ? '请选择一个人或群' : (connected ? '没有找到匹配的聊天' : '连上微信后才能选择'), previous);
  if (matches.length === 1 && !$('session').value) $('session').value = matches[0].id;
  updateControls();
}

function renderRecord() {
  const record = selectedRecord();
  const missingImages = record?.images ? record.counts.images - record.counts.imageFiles : 0;
  $('archive-image-help').hidden = missingImages <= 0;
  $('archive-file-help').hidden = true;
  if (!record) {
    $('archive-summary').textContent = '保存好以后，聊天就会出现在这里。';
  } else {
    const counts = record.counts;
    const details = ['已保存 ' + counts.messages + ' 条消息'];
    if (record.images && counts.images) details.push('图片：已保存 ' + counts.imageFiles + ' 张' + (missingImages > 0 ? '，' + missingImages + ' 张没能保存' : ''));
    if (record.voices && counts.voices) details.push(counts.voiceFiles + ' 条语音' + (counts.voiceFiles < counts.voices ? '（有 ' + (counts.voices - counts.voiceFiles) + ' 条找不到）' : ''));
    for (const [enabled, total, saved, label] of [
      [record.files, counts.files, counts.savedFiles, '文件'],
      [record.videos, counts.videos, counts.videoFiles, '视频']
    ]) {
      if (!enabled || !total) continue;
      const missing = total - saved;
      details.push(label + '：已保存 ' + saved + ' 个' + (missing ? '，' + missing + ' 个没能保存' : ''));
      if (missing > 0) $('archive-file-help').hidden = false;
    }
    if (record.transcription) details.push(record.transcription.recognized + ' 条语音已转成文字');
    $('archive-summary').textContent = details.join(' · ');
  }
  updateControls();
}

async function refreshRecords(preferred = $('archive').value) {
  const result = await call('archives');
  records = result.archives;
  const items = records.map(record => {
    const savedImages = record.counts.imageFiles;
    const imageLabel = record.images && record.counts.images
      ? ' · ' + (savedImages ? savedImages + ' 张图片' : '图片未保存')
      : '';
    const time = new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false });
    return { id: record.id, name: record.name + imageLabel + ' · ' + time };
  });
  setOptions($('archive'), items, items.length ? '选择一段已保存的聊天' : '还没有保存过聊天', preferred);
  if (items.length && !$('archive').value) $('archive').value = items[0].id;
  renderRecord();
}

async function track(job) {
  clearTimeout(poll);
  running = job.state === 'running';
  if (job.message) notice(job.message, job.state);
  if (!running && (job.kind === 'transcribe' || job.kind === 'install')) await loadEnvironment();
  updateControls();
  if (running) {
    poll = setTimeout(async () => {
      try { await track(await call('status')); }
      catch (error) { running = false; updateControls(); notice(error.message, 'error'); }
    }, 850);
  } else if (job.kind === 'install') {
    if (job.state === 'done') await findAccounts('');
    else $('install-help').open = true;
  } else if (job.kind === 'key' && job.state === 'done') {
    await checkConnection();
  } else if (job.id) {
    await refreshRecords(job.id);
    if (job.kind === 'export' && job.state === 'done') $('archives-title').scrollIntoView({ block: 'nearest' });
  }
}

async function perform(work) {
  if (requesting || running) return;
  requesting = true;
  updateControls();
  try { await work(); }
  catch (error) { notice(error.message, 'error'); }
  finally { requesting = false; updateControls(); }
}

function bind(id, work) {
  $(id).addEventListener('click', () => perform(work));
}

bind('install', async () => track(await call('install-online')));
$('install-file').addEventListener('click', () => $('component-file').click());
$('component-file').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  perform(async () => {
    notice('正在安装助手。', 'running');
    await track(await call('install', file, true));
  });
});

function showSelectedAccount() {
  $('account-id-details').hidden = !$('account').value;
  $('selected-account-id').textContent = $('account').value;
  updateControls();
}

function showLocation(preferred = '') {
  const selected = locations[Number($('location').value)];
  const details = selected?.accountDetails || (selected?.accounts || []).map(id => ({ id }));
  const accounts = details.map((item, index) => {
    const verified = item.directory && item.directory.toLowerCase() === lastConnected.toLowerCase();
    const labels = [];
    if (item.inUse) labels.push('当前登录的微信');
    if (verified && lastProfile.nickname) labels.push(lastProfile.nickname);
    if (verified && lastProfile.alias && lastProfile.alias !== lastProfile.nickname) labels.push('微信号 ' + lastProfile.alias);
    if (!labels.length) labels.push('其他微信 ' + (index + 1));
    if (verified) labels.push('上次连过');
    if (Number.isFinite(item.updatedAt)) labels.push('记录更新于 ' + new Date(item.updatedAt).toLocaleString('zh-CN', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }));
    return { id: item.id, name: labels.join(' · ') };
  });
  $('found-directory').textContent = selected?.directory || '';
  const active = locations.flatMap(item => item.accountDetails || []).filter(item => item.inUse);
  if (!preferred && active.length === 1 && details.includes(active[0])) preferred = active[0].id;
  setOptions($('account'), accounts, accounts.length ? '请选择要使用的微信' : '没有找到其他微信', preferred);
  if (accounts.length === 1) $('account').value = accounts[0].id;
  showSelectedAccount();
}

async function findAccounts(directory) {
  notice(directory ? '正在这里查找微信记录。' : '正在找这台电脑上登录的微信。', 'running');
  const result = await call('accounts', { path: directory });
  lastConnected = result.lastConnected || '';
  lastProfile = result.lastProfile || {};
  locations = result.locations || (result.directory ? [result] : []);
  $('location').replaceChildren(...locations.map((item, index) => new Option(item.directory, String(index))));
  $('location-field').hidden = locations.length < 2;
  const activeLocations = locations.filter(item => item.accountDetails?.some(account => account.inUse));
  if (activeLocations.length === 1) $('location').value = String(locations.indexOf(activeLocations[0]));
  const current = locations.flatMap(location => (location.accountDetails || []).filter(account => account.inUse)
    .map(account => ({ path: location.directory, account: account.id })));
  currentWeChat = current.length === 1 ? current[0] : null;
  showLocation();
  if (currentWeChat) {
    $('current-account-text').textContent = '找到了你电脑上正在用的微信。';
    notice('点「使用当前微信」继续。', 'done');
  } else if (locations.length) {
    $('current-account-text').textContent = '请先在电脑上登录微信，再点「重新查找」。也可以展开下面的选项，使用其他微信。';
    notice(directory ? '在这个位置找到了聊天记录。请选择要使用的微信。' : '暂时没认出当前登录的微信。');
  } else {
    $('current-account-text').textContent = '请先在电脑上登录微信，再点「重新查找」。';
    notice('这次没找到微信记录。', 'error');
  }
}

bind('find-accounts', () => findAccounts(''));
bind('find-in-directory', () => {
  const directory = $('directory').value.trim();
  if (!directory) throw new Error('请先粘贴微信设置中显示的存储位置。');
  return findAccounts(directory);
});
$('location').addEventListener('change', () => showLocation());
$('account').addEventListener('change', showSelectedAccount);

async function useWeChat(selection) {
  connected = false;
  setupNeeded = false;
  sessions = [];
  $('search').value = '';
  renderSessions();
  notice('正在连接你选择的微信。', 'running');
  await call('configure', selection);
  $('other-accounts').open = false;
  await checkConnection();
}

bind('use-current', () => useWeChat(currentWeChat));
bind('save-account', () => useWeChat({ path: locations[Number($('location').value)]?.directory, account: $('account').value }));
bind('key', async () => track(await call('key')));
bind('image-key', async () => track(await call('image-key')));

async function checkConnection() {
  checking = true;
  updateControls();
  notice('正在检查能不能读取聊天。', 'running');
  try {
    const result = await call('test');
    if (result.lastConnected) {
      lastConnected = result.lastConnected;
      lastProfile = result.lastProfile || {};
      showLocation($('account').value);
    }
    connected = true;
    setupNeeded = false;
  } catch (error) {
    connected = false;
    setupNeeded = true;
    notice(error.message, 'error');
  } finally {
    checking = false;
    updateControls();
  }
  if (connected) await loadSessions();
}

async function loadSessions() {
  notice('正在找你聊过的人和群。', 'running');
  sessions = (await call('sessions')).sessions;
  renderSessions();
  notice(sessions.length ? '微信已连上。现在可以选一段聊天保存。' : '微信已连上，但这台电脑上还没有聊天记录。', 'done');
}

bind('test', checkConnection);
bind('sessions', loadSessions);
$('search').addEventListener('input', renderSessions);
$('session').addEventListener('change', updateControls);
bind('export', async () => track(await call('export', {
  session: $('session').value, start: $('start').value, end: $('end').value,
  images: $('images').checked, voices: $('voices').checked, files: $('files').checked, videos: $('videos').checked
})));

$('archive').addEventListener('change', renderRecord);
bind('refresh', async () => {
  await loadEnvironment();
  await refreshRecords();
  notice('已更新保存好的聊天列表。', 'done');
});
bind('open-exports', async () => {
  const result = await call('open-exports');
  notice(result.message, 'done');
});
for (const target of ['reader', 'folder']) {
  bind('open-' + target, async () => {
    const result = await call('open', { id: $('archive').value, target });
    notice(result.message, 'done');
  });
}
bind('transcribe', async () => track(await call('transcribe', { id: $('archive').value, language: $('language').value })));

perform(async () => {
  await loadEnvironment();
  await refreshRecords();
  const job = await call('status');
  if (job.state === 'running' || (!environment.installed && job.kind === 'install' && job.state === 'error')) await track(job);
  else if (environment.installed) {
    await findAccounts('');
    if (job.kind === 'key' && job.state === 'done') await track(job);
  }
  else notice('可以先看示例，或安装读取助手开始保存聊天。');
});
