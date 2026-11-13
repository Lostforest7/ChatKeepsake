'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createServer } = require('../server');
const { createWeFlow } = require('../weflow');
const { discoverWeChatAccounts, configuredPaths } = require('../discover-wechat');
const { paymentBackend, bob, group, missing, inaccessible } = require('../fixtures/payment');

const demo = path.resolve(__dirname, '../demo');

test('exports several chats and one ledger, preserves partial successes, and omits the ledger when disabled', async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chatkeepsake-payments-')));
  const backend = paymentBackend();
  const opened = [];
  const { server, token } = createServer({ dataDirectory: directory, backend, openPath: target => opened.push(target) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(operation, body = {}, expected = 200) {
    const response = await fetch(base + '/api/' + operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Local-Token': token },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, expected, result.error);
    return result;
  }
  async function complete() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const job = await call('status');
      if (job.state !== 'running') return job;
      await delay(40);
    }
    assert.fail('Export did not finish');
  }
  const settings = { images: false, voices: false, payments: true, start: '2026-01-01', end: '2026-01-02' };
  await call('export', { ...settings, sessions: [] }, 400);
  await call('export', { ...settings, sessions: [bob, '../outside'] }, 400);
  await call('export', { ...settings, sessions: [bob, group], payments: 'yes' }, 400);

  await call('export', { ...settings, sessions: [bob, bob, group, missing, inaccessible] });
  const result = await complete();
  assert.equal(result.state, 'done', result.message);
  assert.match(result.message, /已保存 2 段聊天。1 段在所选日期没有消息。1 段没能保存/);
  assert.deepEqual(result.skipped, [missing, inaccessible]);
  assert.deepEqual(backend.commands.filter(args => args[0] === 'export').map(args => args[2]), [bob, group, missing, inaccessible]);
  assert.equal(backend.commands.filter(args => args[0] === 'config' && args[2] === 'wxid').length, 1);
  const { archives } = await call('archives');
  assert.deepEqual(archives.map(record => record.name).sort(), ['周末出游', '小林']);
  const privateChat = archives.find(record => record.name === '小林');
  const groupChat = archives.find(record => record.name === '周末出游');
  assert.equal(privateChat.batch, groupChat.batch);
  assert.equal(privateChat.ledger, true);
  const batch = path.dirname(privateChat.directory);
  const ledger = '转账与红包总账.xlsx';
  assert.equal(fs.readFileSync(path.join(batch, ledger)).subarray(0, 2).toString(), 'PK');
  assert.equal(fs.existsSync(path.join(privateChat.directory, ledger)), false);
  const document = JSON.parse(fs.readFileSync(path.join(privateChat.directory, '聊天记录.json'), 'utf8'));
  const payments = document.messages.filter(message => message.payment);
  assert.deepEqual(payments.map(message => message.payment.amountFen), [1250, 1250, 1250, 123450, 123450, 234, 5000, 5000, 88, 168, null, 999]);
  assert.equal(payments.at(-1).payment.status, '状态未确认');
  assert.equal(payments[8].payment.receiver, '我');
  assert.equal(payments[8].payment.memo, '周末快乐 & 顺利');
  assert.equal(document.messages.at(-1).payment, undefined);
  const html = fs.readFileSync(path.join(privateChat.directory, '完整聊天记录.html'), 'utf8');
  assert.match(html, /红包 · 0\.88 元 · 已领取/);
  assert.match(html, /红包 · 金额未记录/);
  assert.doesNotMatch(html, /wxpay:\/\//);
  const groupDoc = JSON.parse(fs.readFileSync(path.join(groupChat.directory, '聊天记录.json'), 'utf8'));
  assert.equal(groupDoc.messages[2].payment.receiver, '我');
  assert.equal(groupDoc.messages[4].payment, undefined, 'Split bills are excluded');
  assert.equal(groupChat.payments, 4);
  await call('open', { id: privateChat.id, batch: privateChat.batch, target: 'folder' });
  assert.equal(opened.at(-1), privateChat.directory);
  await call('open', { id: groupChat.id, batch: groupChat.batch, target: 'reader' });
  assert.equal(opened.at(-1), path.join(groupChat.directory, '完整聊天记录.html'));
  await call('open', { id: groupChat.id, batch: '../', target: 'reader' }, 400);

  const lookups = backend.commands.filter(args => args[1] === 'message').length;
  await call('export', { ...settings, sessions: [bob, group], payments: false });
  const unchecked = await complete();
  assert.equal(unchecked.state, 'done', unchecked.message);
  const record = (await call('archives')).archives.find(item => item.id === unchecked.id);
  assert.equal(record.ledger, false);
  assert.equal(fs.existsSync(path.join(path.dirname(record.directory), ledger)), false);
  assert.equal(backend.commands.filter(args => args[1] === 'message').length, lookups);

  await call('export', { ...settings, sessions: [bob] });
  const single = await complete();
  assert.equal(single.state, 'done', single.message);
  assert.ok(fs.existsSync(path.join(directory, 'exports', single.id, ledger)));
});

test('a clean install rejects an unknown component archive', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatkeepsake-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backend = createWeFlow(directory);
  assert.equal(backend.isInstalled(), false);
  await assert.rejects(backend.install(Buffer.from('invalid ZIP')), /助手安装包|64 位 Windows/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the launcher reuses a compatible process and warns about an older one', { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatkeepsake-launcher-'));
  const localAppData = path.join(directory, '另一位用户', 'AppData', 'Local');
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function launch() {
    const env = { ...process.env, LOCALAPPDATA: localAppData, CHATKEEPSAKE_NO_OPEN: '1' };
    delete env.CHATKEEPSAKE_DATA_DIR;
    const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    return { child, address: () => output.match(/http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}/)?.[0], errors: () => errors };
  }

  const first = launch();
  for (let attempts = 0; attempts < 100 && !first.address(); attempts++) await delay(50);
  assert.ok(first.address(), 'The primary launcher should report a local address');
  assert.ok(fs.statSync(path.join(localAppData, 'ChatKeepsake', 'exports')).isDirectory());
  const second = launch();
  const [code] = await once(second.child, 'close');
  assert.equal(code, 0);
  assert.ok(second.address() === first.address(), 'Both launches should report the same local address');
  assert.equal(first.child.exitCode, null);

  const lockFile = path.join(localAppData, 'ChatKeepsake', 'running.lock');
  const olderState = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  delete olderState.apiVersion;
  fs.writeFileSync(lockFile, JSON.stringify(olderState));
  const incompatible = launch();
  const [incompatibleCode] = await once(incompatible.child, 'close');
  assert.equal(incompatibleCode, 1);
  assert.equal(incompatible.address(), undefined);
  assert.match(incompatible.errors(), /请关闭原来的启动窗口/);
  assert.equal(first.child.exitCode, null);
});

test('export and transcribe a synthetic chat through the local API', { timeout: 20000 }, async t => {
  const directory = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'chatkeepsake-api-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const image = fs.readFileSync(path.join(demo, 'media/demo/trail.png'));
  const audio = fs.readFileSync(path.join(demo, 'media/demo/voice.wav'));
  const video = Buffer.from('synthetic MP4 payload');
  const commands = [];
  const opened = [];
  const customDirectory = path.join(directory, '保存位置 & 中文');
  fs.mkdirSync(customDirectory);
  let helperInstalled = false;
  let installAttempts = 0;
  let imagesReady = false;
  let canPrepareImages = true;
  const moved = path.join(directory, '另一个磁盘目录', 'xwechat_files');
  const other = path.join(directory, 'Documents', 'xwechat_files');
  const stale = path.join(directory, 'stale', 'xwechat_files');
  const validFolders = new Map([[moved, ['wxid_old', 'wxid_fixture']], [other, ['wxid_other']]]);
  for (const [root, ids] of validFolders) {
    for (const wxid of ids) {
      const messages = path.join(root, wxid + '_a123', 'db_storage', 'message');
      fs.mkdirSync(messages, { recursive: true });
      const file = path.join(messages, 'message_0.db');
      fs.writeFileSync(file, 'synthetic database marker');
      if (wxid === 'wxid_old') fs.utimesSync(file, 946684800, 946684800);
    }
  }
  const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const canonicalFolders = new Map([...validFolders].map(([folder, ids]) => [pathKey(folder), ids]));
  const accountFolder = path.join(moved, 'wxid_fixture_a123');
  const cache = path.join(accountFolder, 'msg', 'file', '2026-01');
  fs.mkdirSync(cache, { recursive: true });
  const name = '报价 #1 & 说明.pdf';
  const firstFile = Buffer.from('first version');
  const secondFile = Buffer.from('other version');
  fs.writeFileSync(path.join(cache, name), firstFile);
  fs.writeFileSync(path.join(cache, '报价 #1 & 说明(1).pdf'), secondFile);
  fs.writeFileSync(path.join(cache, '..', 'outside.xlsx'), firstFile);
  const fileMessages = [
    { id: '400', name, payload: firstFile },
    { id: '401', name, payload: secondFile },
    { id: '402', name, payload: Buffer.from('stale version') },
    { id: '403', name: '../outside.xlsx', payload: firstFile }
  ];
  fs.mkdirSync(stale, { recursive: true });
  const roaming = path.join(directory, 'Roaming');
  const config = path.join(roaming, 'Tencent/xwechat/config/51a1fffea11325a1e4104c6b3de47af7.ini');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '\uFEFF"' + path.dirname(moved) + '"\r\n', 'utf16le');
  assert.deepEqual(await configuredPaths([roaming]), [path.dirname(moved)]);
  const backend = {
    supported: true,
    isInstalled: () => helperInstalled,
    async installOnline(progress) {
      installAttempts++;
      progress('正在从 GitHub 下载读取助手。');
      if (installAttempts === 1) throw new Error('暂时连不上 GitHub。');
      helperInstalled = true;
    },
    async run(args) {
      commands.push(args);
      if (args[0] === 'db' && args[1] === 'detect') {
        return { ok: true, data: { candidates: [{ exists: true, path: stale }] } };
      }
      if (args[0] === 'db' && args[1] === 'wxid') {
        const ids = canonicalFolders.get(pathKey(args[2]));
        return ids
          ? { ok: true, data: { accounts: ids.map(wxid => ({ wxid, path: path.join(args[2], wxid + '_a123') })) } }
          : { ok: false };
      }
      if (args[0] === 'db' && args[1] === 'test') {
        return { ok: true, data: { accountDir: path.join(moved, 'wxid_fixture_a123') } };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'wxid') {
        return { ok: true, data: 'wxid_fixture' };
      }
      if (args[0] === 'config' && args[1] === 'profiles') {
        return { ok: true, data: [{ current: false, imageKeys: true }, { current: true, imageKeys: imagesReady }] };
      }
      if (args[0] === 'key' && args[1] === 'image' && args[2] === '--save') {
        imagesReady = canPrepareImages;
        return { ok: imagesReady };
      }
      if (args[0] === 'chat' && args[1] === 'contact' && args[2] === 'wxid_fixture') {
        return { ok: true, data: { username: 'wxid_fixture', nick_name: '小林', alias: 'lin-demo' } };
      }
      if (args[0] === 'chat' && args[1] === 'message') {
        if (args[4] === '450' || args[4] === '451') {
          return { ok: true, data: { localType: 43, localId: Number(args[4]), createTime: 300 } };
        }
        const file = fileMessages.find(item => item.id === args[4]);
        return { ok: true, data: { appMsgKind: 'file', createTime: Number(file.id), fileName: file.name,
          fileSize: file.payload.length, fileMd5: createHash('md5').update(file.payload).digest('hex') } };
      }
      if (args[0] === 'chat' && args[1] === 'video-data') {
        if (args[3] !== '450' || args[5] !== '300') return { ok: false };
        fs.writeFileSync(args[args.indexOf('--out') + 1], video);
        return { ok: true };
      }
      if (args[0] === 'config' || args[0] === 'db') return { ok: true, data: {} };
      if (args[1] === 'sessions') return { ok: true, data: { sessions: [{ username: 'fixture', displayName: '测试会话' }] } };
      if (args[1] === 'voice-data') {
        const target = args[args.indexOf('--out') + 1];
        const copy = Buffer.from(audio);
        copy[copy.length - 1] = Number(args[args.indexOf('--server-id') + 1]);
        fs.writeFileSync(target, copy);
        return { ok: true };
      }
      if (args[0] === 'export') {
        const output = args[args.indexOf('--out') + 1];
        const media = args.includes('--media') ? args[args.indexOf('--media') + 1].split(',') : [];
        const voices = 'media/fixture/voices/voice_1.wav';
        const picture = 'media/fixture/images/a.png';
        const videoPath = 'media/fixture/videos/clip.mp4';
        const saveVoice = media.includes('voice');
        const saveImage = media.includes('image') && imagesReady;
        const saveVideo = media.includes('video');
        for (const [relative, bytes] of [[saveVoice && voices, audio], [saveImage && picture, image], [saveVideo && videoPath, video]]) {
          if (!relative) continue;
          const file = path.join(output, relative);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bytes);
        }
        fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({
          session: { displayName: '测试会话' },
          messages: [
            { localType: 1, content: '<script>alert(1)</script>', formattedTime: '2026-01-01 12:00:00' },
            { localType: 3, content: saveImage ? picture : '[图片]' },
            { localType: 3, content: 'media/../导出说明.json.png' },
            { localType: 34, content: saveVoice ? voices : '[语音消息]', platformMessageId: '111', createTime: 100 },
            { localType: 34, content: saveVoice ? voices : '[语音消息]', platformMessageId: '222', createTime: 200 },
            ...fileMessages.map(file => ({ localType: 25769803825, type: '文件消息', content: '[文件]' + file.name,
              platformMessageId: file.id, createTime: Number(file.id), formattedTime: '2026-01-01 12:10:00' })),
            { localType: 43, content: saveVideo ? videoPath : '[视频]' },
            { localType: 43, content: '[视频]', platformMessageId: '450', createTime: 300 },
            { localType: 43, content: '[视频]', platformMessageId: '451', createTime: 300 },
            { localType: 49, type: '聊天记录', content: '[转发的聊天记录]安排\n小林: 周六见\n我: 湖边见' },
            { localType: 49, type: '链接消息', content: '[链接] 散步指南\nhttps://example.com/guide?a=1&b=2' },
            { localType: 49, type: '链接消息', content: '看一下 https://example.com/info。', linkUrl: 'javascript:alert(2)' }
          ]
        }));
        return { ok: true, data: {} };
      }
      throw new Error('Unexpected test command');
    }
  };

  const voicePaths = { python: path.join(directory, 'runtime', 'python.exe'), model: path.join(directory, 'model') };
  let voiceReady = false;
  let setupAttempts = 0;
  let transcriptionRuns = 0;
  const voiceRuntime = {
    supported: true,
    downloadMb: 600,
    ready: () => voiceReady,
    async prepare(progress) {
      if (!voiceReady) {
        setupAttempts++;
        progress('正在下载语音组件。');
        if (setupAttempts === 1) throw new Error('语音组件没下载完成。');
        voiceReady = true;
      }
      return voicePaths;
    }
  };

  async function transcribeProcess(python, args, options) {
    assert.equal(python, voicePaths.python);
    assert.equal(args[3], voicePaths.model);
    assert.equal(options.env.HF_HUB_OFFLINE, '1');
    transcriptionRuns++;
    const exportDirectory = args[2];
    const doc = JSON.parse(fs.readFileSync(path.join(exportDirectory, '聊天记录.json'), 'utf8'));
    const voices = doc.messages.filter(item => item.localType === 34);
    fs.writeFileSync(path.join(exportDirectory, 'voice-transcripts.json'), JSON.stringify({
      language: args[4],
      items: [
        { audio: voices[0].content, status: 'ok', text: '这是一条合成语音。' },
        { audio: voices[1].content, status: 'empty' }
      ]
    }));
    return { code: 0 };
  }

  const { server, token } = createServer({
    dataDirectory: directory, backend, voiceRuntime, transcribeProcess,
    findAccounts: (engine, manualPath) => discoverWeChatAccounts(engine, manualPath, async () => ({
      configured: await configuredPaths([roaming]), defaults: [stale, other], drives: []
    }), async details => details.flatMap((item, index) => item.id === 'wxid_fixture' ? [index] : [])),
    openPath: async target => opened.push(target)
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(route, body = {}, overrides = {}) {
    return fetch(base + '/api/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Local-Token': token, ...overrides },
      body: JSON.stringify(body)
    });
  }
  async function post(route, body) {
    const result = await call(route, body);
    const payload = await result.json();
    assert.equal(result.status, 200, JSON.stringify(payload));
    return payload;
  }
  async function complete(expected = 'done') {
    for (let n = 0; n < 30; n++) {
      const status = await post('status');
      if (status.state !== 'running') {
        assert.equal(status.state, expected, status.message);
        return status;
      }
      await delay(50);
    }
    assert.fail('Job did not finish');
  }

  assert.equal((await fetch(base + '/')).status, 200);
  const privacy = await fetch(base + '/privacy/');
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /聊天记录留在你的电脑上/);
  assert.match(privacy.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await (await fetch(base + '/demo/')).text(), /周末散步/);
  assert.equal((await call('info', {}, { 'X-Local-Token': 'invalid' })).status, 403);
  assert.equal((await call('info', {}, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await fetch(base + '/weflow-data/config.json')).status, 403);
  const info = await post('info');
  assert.equal(info.voiceReady, false);
  assert.equal(info.voiceSupported, true);
  assert.equal(info.voiceDownloadMb, 600);
  assert.equal(info.apiVersion, 9);
  assert.equal(info.exportsDirectory, path.join(directory, 'exports'));
  assert.equal(info.installed, false);
  assert.equal((await call('install-online', {}, { 'X-Local-Token': 'invalid' })).status, 403);
  assert.equal(installAttempts, 0);
  assert.equal((await post('install-online')).state, 'running');
  assert.match((await complete('error')).message, /暂时连不上 GitHub/);
  assert.equal((await post('info')).installed, false);
  assert.equal((await post('install-online')).state, 'running');
  await complete();
  assert.equal((await post('info')).installed, true);
  assert.equal((await post('install-online')).state, 'done');
  assert.equal(installAttempts, 2);
  assert.deepEqual(commands, [], 'Installing the helper must not run WeFlow.');
  assert.equal((await call('open-exports', {}, { 'X-Local-Token': 'invalid' })).status, 403);
  assert.equal((await call('save-location', {}, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await call('save-location')).status, 400);
  assert.equal((await call('save-location', { directory: path.join(directory, 'missing-folder') })).status, 400);
  assert.equal((await post('info')).exportsDirectory, path.join(directory, 'exports'));
  assert.equal((await post('info')).exportsDirectory, info.exportsDirectory);
  await post('open-exports', { path: directory });
  assert.deepEqual(opened, [path.join(directory, 'exports')]);
  const account = await post('accounts', { path: '' });
  assert.deepEqual(account.accounts, ['wxid_fixture', 'wxid_old']);
  assert.ok(account.locations[0].accountDetails[0].updatedAt > account.locations[0].accountDetails[1].updatedAt);
  assert.deepEqual(account.locations[0].accountDetails.map(item => item.inUse), [true, false]);
  assert.equal(pathKey(account.directory), pathKey(moved));
  assert.deepEqual(account.locations.map(item => pathKey(item.directory)), [moved, other].map(pathKey));
  const manual = await post('accounts', { path: path.join(moved, 'wxid_fixture_a123', 'db_storage') });
  assert.deepEqual(manual.accounts, ['wxid_fixture']);
  const scan = await discoverWeChatAccounts(backend, '', async () => ({ configured: [], defaults: [], drives: [directory] }), async () => []);
  assert.deepEqual(new Set(scan.map(item => pathKey(item.directory))), new Set([moved, other].map(pathKey)));
  await post('configure', { path: account.directory, account: account.accounts[0] });
  const checked = await post('test');
  assert.equal(pathKey(checked.lastConnected), pathKey(accountFolder));
  assert.deepEqual(checked.lastProfile, { nickname: '小林', alias: 'lin-demo' });
  const rediscovered = await post('accounts', { path: '' });
  assert.equal(rediscovered.lastConnected, checked.lastConnected);
  assert.deepEqual(rediscovered.lastProfile, checked.lastProfile);
  assert.deepEqual((await post('sessions')).sessions, [{ id: 'fixture', name: '测试会话' }]);
  assert.equal((await call('export', { session: 'fixture', start: '2026-02-30' })).status, 400);
  assert.equal((await call('export', { session: '../invalid' })).status, 400);

  await post('export', { session: 'fixture', start: '2026-01-01', end: '2026-01-31', images: true, voices: true,
    files: true, videos: true });
  const { id, message } = await complete();
  assert.match(message, /已保存 1 张图片，1 张没能保存/);
  assert.match(message, /已保存 2 个文件，2 个没能保存/);
  assert.match(message, /已保存 2 个视频，1 个没能保存/);
  const firstExport = commands.findIndex(args => args[0] === 'export');
  assert.deepEqual(commands.slice(firstExport - 2, firstExport), [['config', 'profiles'], ['key', 'image', '--save']]);
  const output = path.join(directory, 'exports', id);
  const readJson = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
  const html = () => fs.readFileSync(path.join(output, '完整聊天记录.html'), 'utf8');
  const manifest = readJson('导出说明.json');
  const excel = path.join(output, '聊天记录.xlsx');
  assert.ok(fs.statSync(excel).size > 0);
  assert.deepEqual(manifest.counts, { messages: 15, images: 2, imageFiles: 1, voices: 2, voiceFiles: 2,
    files: 4, savedFiles: 2, videos: 3, videoFiles: 2 });
  assert.equal(manifest.start, '2026-01-01');
  const repaired = readJson('聊天记录.json').messages.filter(item => item.localType === 34);
  assert.notEqual(repaired[0].content, repaired[1].content);
  assert.notDeepEqual(fs.readFileSync(path.join(output, repaired[0].content)), fs.readFileSync(path.join(output, repaired[1].content)));
  const attached = readJson('聊天记录.json').messages.filter(item => item.type === '文件消息');
  assert.notEqual(attached[0].attachment.path, attached[1].attachment.path);
  for (const [index, original] of [firstFile, secondFile].entries()) {
    const archived = attached[index].attachment.path;
    assert.equal(path.basename(archived), name);
    assert.deepEqual(fs.readFileSync(path.join(output, archived)), original);
  }
  assert.equal(attached[2].attachment.path, undefined);
  assert.equal(attached[3].attachment.path, undefined);
  assert.match(html(), /&lt;script&gt;alert/);
  assert.match(html(), /<audio controls/);
  assert.match(html(), /<img loading/);
  assert.match(html(), /<video controls[^>]+clip\.mp4/);
  assert.match(html(), /<video controls[^>]+videos-verified\/video_1\.mp4/);
  assert.match(html(), /%23[^\n]*%26[^\n]*\.pdf">/);
  assert.match(html(), /文件未保存/);
  assert.match(html(), /<details class="forward"><summary>合并转发 · 安排<\/summary>.*周六见\n我: 湖边见/);
  assert.match(html(), /href="https:\/\/example\.com\/guide\?a=1&amp;b=2"/);
  assert.match(html(), /href="https:\/\/example\.com\/info"[^>]*>https:\/\/example\.com\/info<\/a>。/);
  assert.doesNotMatch(html(), /href="javascript:/);
  assert.match(html(), /已保存 1 张图片，1 张没能保存/);
  assert.doesNotMatch(html(), /<script>alert|media\/\.\.\//);
  assert.deepEqual((await post('archives')).archives.map(record => [record.id, record.directory]), [[id, output]]);
  await post('open', { id, target: 'reader' });
  assert.deepEqual(opened, [path.join(directory, 'exports'), path.join(output, '完整聊天记录.html')]);
  assert.equal((await call('open', { id: '../../', target: 'folder' })).status, 400);

  // Older archives have no workbook and can be updated from their saved JSON.
  fs.unlinkSync(excel);
  await post('open', { id, target: 'folder' });
  assert.equal(opened.at(-1), output);
  const beforeTranscript = fs.readFileSync(excel);
  const newFolder = fs.realpathSync.native(customDirectory);
  assert.equal((await post('save-location', { directory: ' "' + customDirectory + '" ' })).exportsDirectory, newFolder);
  const restarted = createServer({ dataDirectory: directory });
  restarted.server.listen(0, '127.0.0.1');
  await once(restarted.server, 'listening');
  try {
    const address = 'http://127.0.0.1:' + restarted.server.address().port;
    const savedInfo = await fetch(address + '/api/info', {
      method: 'POST', headers: { Origin: address, 'X-Local-Token': restarted.token }
    });
    assert.equal((await savedInfo.json()).exportsDirectory, newFolder);
  } finally {
    restarted.server.closeAllConnections();
    await new Promise(resolve => restarted.server.close(resolve));
  }
  await post('open-exports');
  assert.equal(opened.at(-1), newFolder);
  assert.deepEqual((await post('archives')).archives.map(record => [record.id, record.directory]), [[id, output]]);

  assert.equal(setupAttempts, 0, 'Opening and exporting should not download the speech runtime');
  assert.equal((await call('transcribe', { id, language: 'invalid' })).status, 400);
  assert.equal(setupAttempts, 0);
  await post('transcribe', { id });
  assert.match((await complete('error')).message, /没下载完成/);
  assert.equal(transcriptionRuns, 0);
  await post('transcribe', { id });
  const result = await complete();
  assert.match(result.message, /1 条语音生成文字，有 1 条没能转成文字/);
  assert.match(html(), /这是一条合成语音/);
  assert.match(fs.readFileSync(path.join(output, '聊天记录.txt'), 'utf8'), /这是一条合成语音/);
  assert.notDeepEqual(fs.readFileSync(excel), beforeTranscript);
  assert.equal(readJson('导出说明.json').transcription.recognized, 1);
  assert.equal(readJson('导出说明.json').transcription.language, 'auto');
  assert.match(html(), /<video controls[^>]+clip\.mp4/);
  assert.equal((await post('info')).voiceReady, true);
  await post('transcribe', { id, language: 'en' });
  await complete();
  assert.equal(setupAttempts, 2);
  assert.equal(transcriptionRuns, 2);

  const repairCalls = commands.filter(args => args[1] === 'voice-data').length;
  const photoPrepCalls = () => commands.filter(args => args[0] === 'key' && args[1] === 'image').length;
  await post('export', { session: 'fixture', images: true, voices: false });
  await complete();
  assert.equal(photoPrepCalls(), 1, 'No need to prepare images again for the same profile');

  await post('export', { session: 'fixture', images: false, voices: false });
  const textOnly = await complete();
  assert.equal(commands.filter(args => args[1] === 'voice-data').length, repairCalls);
  assert.equal(photoPrepCalls(), 1);
  const textOnlyReader = fs.readFileSync(path.join(newFolder, textOnly.id, '完整聊天记录.html'), 'utf8');
  assert.ok(fs.statSync(path.join(newFolder, textOnly.id, '聊天记录.xlsx')).size > 0);
  assert.ok((await post('archives')).archives.some(record => record.id === id));
  assert.match(textOnlyReader, /未选择导出语音/);
  assert.match(textOnlyReader, /未选择保存文件/);
  assert.match(textOnlyReader, /未选择保存视频/);
  assert.doesNotMatch(textOnlyReader, /<video controls|\.pdf">/);

  imagesReady = canPrepareImages = false;
  await post('export', { session: 'fixture', images: true, voices: false });
  const withoutPictures = await complete();
  assert.match(withoutPictures.message, /已保存 0 张图片，2 张没能保存/);
  assert.match(fs.readFileSync(path.join(newFolder, withoutPictures.id, '完整聊天记录.html'), 'utf8'), /&lt;script&gt;alert/);
});
