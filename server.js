'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { launch } = require('./launcher');
const { runProcess } = require('./run-process');
const { createWeFlow, version, archiveName, release, download, maxArchiveSize } = require('./weflow');
const { createArchives, validId, validDate, readerFile, jsonFile } = require('./archive');
const { messageType } = require('./chat-content');
const { mediaFile, voiceExtensions } = require('./media');
const { renderViewer } = require('./make-viewer');
const { discoverWeChatAccounts } = require('./discover-wechat');
const { createVoiceRuntime } = require('./voice-runtime');
const { createSaveLocation } = require('./save-location');

const root = __dirname;
const apiVersion = 8;
const demoDir = path.join(root, 'demo');
const defaultDataDirectory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ChatKeepsake');
const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/privacy/', ['public/privacy.html', 'text/html; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/demo/media/demo/trail.png', ['demo/media/demo/trail.png', 'image/png']],
  ['/demo/media/demo/voice.wav', ['demo/media/demo/voice.wav', 'audio/wav']]
]);

function reply(response, status, data, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extraHeaders
  });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new Error('文件或请求超过大小限制。');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('文件或请求超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function directoryExists(value) {
  try { return typeof value === 'string' && path.isAbsolute(value) && fs.statSync(value).isDirectory(); }
  catch { return false; }
}

function accountName(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : '';
}

function mediaSummary(total, saved, unit, label) {
  if (!total) return '';
  const missing = total - saved;
  return '已保存 ' + saved + ' ' + unit + label + (missing ? '，' + missing + ' ' + unit + '没能保存。' : '。');
}

function launchExplorer(target) {
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [target], { shell: false, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function createServer({
  dataDirectory = process.env.CHATKEEPSAKE_DATA_DIR || defaultDataDirectory,
  backend = createWeFlow(dataDirectory),
  voiceRuntime = createVoiceRuntime(dataDirectory),
  openPath = launchExplorer,
  transcribeProcess = runProcess,
  findAccounts = discoverWeChatAccounts
} = {}) {
  const lastConnectionFile = path.join(dataDirectory, 'last-connected.json');
  fs.mkdirSync(path.join(dataDirectory, 'exports'), { recursive: true });
  const saveLocation = createSaveLocation(dataDirectory);
  const token = crypto.randomBytes(32).toString('hex');
  let activity = { state: 'idle' };
  let handlingAction = false;

  function begin(kind, message, work) {
    const job = activity = { kind, state: 'running', message };
    setImmediate(async () => {
      try {
        const result = await work(update => { job.message = update; });
        Object.assign(job, result, { state: 'done' });
      } catch (error) {
        job.state = 'error';
        job.message = error.message;
      }
    });
    return job;
  }

  async function backendData(args, errorMessage) {
    const result = await backend.run(args);
    if (!result.ok) throw new Error(errorMessage);
    return result.data;
  }

  async function action(route, body) {
    if (route === '/api/install-online') {
      if (!backend.supported) throw new Error('这个助手需要 64 位 Windows 电脑。');
      const message = '读取助手已装好。正在查找你的微信。';
      if (backend.isInstalled()) return { kind: 'install', state: 'done', message };
      return begin('install', '正在准备下载读取助手。', async progress => {
        await backend.installOnline(progress);
        return { message };
      });
    }

    if (route === '/api/accounts') {
      if (!backend.isInstalled()) throw new Error('请先在第 1 步安装助手。');
      const locations = await findAccounts(backend, typeof body.path === 'string' ? body.path.trim() : '');
      let lastConnected = '';
      let lastProfile = {};
      try {
        const saved = JSON.parse(fs.readFileSync(lastConnectionFile, 'utf8'));
        if (typeof saved.directory === 'string') {
          lastConnected = saved.directory;
          lastProfile = { nickname: accountName(saved.nickname), alias: accountName(saved.alias) };
        }
      } catch {}
      return { directory: locations[0]?.directory || '', accounts: locations[0]?.accounts || [], locations, lastConnected, lastProfile };
    }

    if (route === '/api/configure') {
      if (!directoryExists(body.path) || !validId(body.account)) throw new Error('请先查找并选择一个微信账号。');
      const folder = fs.realpathSync(body.path);
      const id = crypto.createHash('sha256').update(folder.toLowerCase() + '\0' + body.account).digest('hex').slice(0, 24);
      const errorMessage = '没能记住所选微信。请点「重新查找」，再选一次。';
      await backendData(['config', 'set', 'current_profile', 'chatkeepsake-' + id], errorMessage);
      await backendData(['config', 'set', 'db_path', folder], errorMessage);
      await backendData(['config', 'set', 'wxid', body.account], errorMessage);
      return { message: '已选好微信。现在可以检查能不能读取聊天。' };
    }

    if (route === '/api/key') {
      if (!backend.isInstalled()) throw new Error('请先在第 1 步安装助手。');
      return begin('key', '现在从屏幕右下角的微信图标退出微信。等几秒再打开，请在约 3 分钟内重新登录。', async () => {
        await backendData(['key', 'db', '--save'], '这次没连上。请确认工具是以管理员身份打开的，并在点「开始连接」后退出微信、重新登录。');
        return { message: '重新登录成功。正在检查能不能读取聊天。' };
      });
    }

    if (route === '/api/image-key') {
      if (!backend.isInstalled()) throw new Error('请先在第 1 步安装助手。');
      return begin('image-key', '正在准备保存图片。', async () => {
        await backendData(['key', 'image', '--save'], '图片还没准备好。请在电脑版微信打开几张原图，保持微信打开，再试一次。');
        return { message: '图片已准备好。请勾选「同时保存图片」，再保存一次聊天。' };
      });
    }

    if (route === '/api/test') {
      const result = await backendData(['db', 'test'], '还不能读取聊天。请按第 1 步的「第一次连接微信」操作。');
      const directory = result?.accountDir || result?.account_dir;
      let lastConnected = '';
      let lastProfile = {};
      if (typeof directory === 'string' && path.isAbsolute(directory)) {
        try {
          lastConnected = fs.realpathSync(directory);
          const config = await backend.run(['config', 'get', 'wxid']);
          const id = config.data;
          if (config.ok && validId(id)) {
            const contact = await backend.run(['chat', 'contact', id]);
            if (contact.ok && contact.data?.username === id) {
              lastProfile = {
                nickname: accountName(contact.data.nick_name || contact.data.nickName || contact.data.nickname),
                alias: accountName(contact.data.alias)
              };
            }
          }
        } catch {}
        if (lastConnected) {
          try { fs.writeFileSync(lastConnectionFile, JSON.stringify({ directory: lastConnected, ...lastProfile }), 'utf8'); }
          catch {}
        }
      }
      return { message: '已经可以读取聊天。', lastConnected, lastProfile };
    }

    if (route === '/api/sessions') {
      const data = await backendData(['chat', 'sessions'], '没能打开聊天列表。请回到第 1 步再连一次微信。');
      const entries = Array.isArray(data) ? data : data?.sessions || [];
      return { sessions: entries.filter(item => validId(item.username)).map(item => ({
        id: item.username, name: item.displayName || item.username
      })) };
    }

    if (route === '/api/export') {
      const { session, start = '', end = '', images, voices, files = false, videos = false } = body;
      if (!validId(session)) throw new Error('请先选一个人或群。');
      if (!validDate(start) || !validDate(end) || (start && end && start > end)) throw new Error('请检查日期，开始日期要在结束日期之前或同一天。');
      if ([images, voices, files, videos].some(value => typeof value !== 'boolean')) throw new Error('请确认要一起保存哪些内容。');
      if (!backend.isInstalled()) throw new Error('请先在第 1 步安装助手。');
      const archives = createArchives(saveLocation.ready());
      return begin('export', '正在保存聊天。请保持启动窗口打开。', async progress => {
        const record = await archives.exportChat({ session, start, end, images, voices, files, videos }, backend, progress);
        const counts = record.counts;
        const details = [
          images && mediaSummary(counts.images, counts.imageFiles, '张', '图片'),
          files && mediaSummary(counts.files, counts.savedFiles, '个', '文件'),
          videos && mediaSummary(counts.videos, counts.videoFiles, '个', '视频')
        ].filter(Boolean).join('');
        return { id: record.id, message: '聊天已保存。' + details + '去第 3 步点「打开聊天记录」。' };
      });
    }

    if (route === '/api/transcribe') {
      const { directory, manifest, archives } = saveLocation.get(body.id);
      const { language = 'auto' } = body;
      if (!manifest.counts.voiceFiles) throw new Error('这段聊天没有保存到语音。');
      if (!['auto', 'zh', 'en'].includes(language)) throw new Error('请选择语音语言。');
      if (!voiceRuntime.ready()) {
        if (!voiceRuntime.supported) throw new Error('语音转文字需要 64 位 Windows。');
        const { messages } = JSON.parse(fs.readFileSync(path.join(directory, jsonFile), 'utf8'));
        if (!Array.isArray(messages) || !messages.some(message =>
          message.localType === messageType.voice && mediaFile(directory, message.content, voiceExtensions))) {
          throw new Error('找不到这段聊天的语音文件。请重新保存聊天后再试。');
        }
      }
      return begin('transcribe', '正在检查语音组件。', async progress => {
        const { python, model } = await voiceRuntime.prepare(progress);
        progress('正在本机读取语音，准备转写。');
        const result = await transcribeProcess(python, ['-u', path.join(root, 'transcribe.py'), directory, model, language], {
          env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' }
        }, line => {
          const match = /^progress (\d+)\/(\d+)$/.exec(line);
          if (match) progress('正在本机转写语音，已处理 ' + match[1] + ' / ' + match[2] + ' 条。');
        });
        if (result.code !== 0) throw new Error('这次没能完成语音转文字。请检查语音文件是否还在，再试一次。');
        const counts = await archives.applyTranscripts(manifest.id);
        const summary = '聊天已更新。' + counts.recognized + ' 条语音生成文字';
        return {
          id: manifest.id,
          message: counts.unsuccessful ? summary + '，有 ' + counts.unsuccessful + ' 条没能转成文字，可以播放原来的语音。' : summary + '。'
        };
      });
    }

    if (route === '/api/save-location') {
      return { exportsDirectory: saveLocation.select(body.directory), message: '保存位置已更新，下次导出会存到这里。' };
    }

    if (route === '/api/open-exports') {
      const directory = saveLocation.ready();
      try {
        await openPath(directory);
      } catch {
        throw new Error('没能打开保存位置，请重试。');
      }
      return { message: '已打开保存位置。每次保存的聊天都在一个单独的文件夹里。' };
    }

    if (route === '/api/open') {
      const { directory, archives } = saveLocation.get(body.id);
      if (body.target === 'excel') {
        const workbook = await archives.saveExcel(body.id);
        try { await openPath(workbook); }
        catch { throw new Error('Excel 文件已保存，请点「打开文件夹」找到它。'); }
        return { message: '已打开 Excel 文件。' };
      }
      if (!['folder', 'reader'].includes(body.target)) throw new Error('请选择要打开的文件。');
      const target = body.target === 'reader' ? path.join(directory, readerFile) : directory;
      if (!fs.existsSync(target)) throw new Error('聊天文件已移走。请看看原来的文件夹。');
      try { await openPath(target); } catch { throw new Error('没能打开文件。请在文件资源管理器里找到保存好的聊天。'); }
      return { message: '已在电脑上打开。' };
    }

    return null;
  }

  const server = http.createServer(async (request, response) => {
    const host = '127.0.0.1:' + server.address().port;
    const base = 'http://' + host;
    if (request.headers.host !== host) return reply(response, 403, { error: '仅可从本机启动地址访问。' });
    let route;
    try { route = new URL(request.url, base).pathname; }
    catch { return reply(response, 400, { error: '地址无效。' }); }
    if (request.method === 'GET' && staticFiles.has(route)) {
      const [file, contentType] = staticFiles.get(route);
      const headers = contentType.startsWith('text/html') ? {
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      } : {};
      try { return reply(response, 200, fs.readFileSync(path.join(root, file)), contentType, headers); }
      catch { return reply(response, 404, { error: '项目文件不完整，请重新解压。' }); }
    }
    if (request.method === 'GET' && route === '/demo/') {
      try {
        const fixture = JSON.parse(fs.readFileSync(path.join(demoDir, 'chat.json'), 'utf8'));
        return reply(response, 200, renderViewer(demoDir, fixture, { demo: true }), 'text/html; charset=utf-8');
      } catch {
        return reply(response, 404, { error: '示例文件不完整，请重新解压项目。' });
      }
    }
    if (request.method !== 'POST' || request.headers.origin !== base || request.headers['x-local-token'] !== token) {
      return reply(response, 403, { error: '这个页面已经过期。请从 ChatKeepsake 文件夹重新打开工具。' });
    }
    if (route === '/api/status') return reply(response, 200, activity);
    if (route === '/api/info') {
      return reply(response, 200, {
        apiVersion, supported: backend.supported, installed: backend.isInstalled(), version, archiveName, release, download,
        voiceReady: voiceRuntime.ready(), voiceSupported: voiceRuntime.supported, voiceDownloadMb: voiceRuntime.downloadMb,
        exportsDirectory: saveLocation.current
      });
    }
    if (route === '/api/archives') {
      try {
        return reply(response, 200, { archives: saveLocation.list() });
      }
      catch { return reply(response, 400, { error: '没能找到保存好的聊天。请检查存放它们的文件夹是否还能打开。' }); }
    }
    if (handlingAction || activity.state === 'running') return reply(response, 409, { error: '已有任务在运行，请等待完成。' });
    handlingAction = true;
    try {
      if (route === '/api/install') {
        if (request.headers['content-type'] !== 'application/octet-stream') throw new Error('请选择刚下载的助手文件。');
        await backend.install(await readBody(request, maxArchiveSize));
        activity = { kind: 'install', state: 'done', message: '读取助手已装好。正在查找你的微信。' };
        return reply(response, 200, activity);
      }
      if (request.headers['content-type'] !== 'application/json') throw new Error('请求格式错误。');
      const body = JSON.parse(await readBody(request, 16000));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式错误。');
      const result = await action(route, body);
      if (!result) return reply(response, 404, { error: '找不到该操作。' });
      return reply(response, 200, result);
    } catch (error) {
      return reply(response, 400, { error: error instanceof SyntaxError ? '请求或文件格式错误。' : error.message });
    } finally {
      handlingAction = false;
    }
  });
  return { server, token };
}

if (require.main === module) {
  const dataDirectory = path.resolve(process.env.CHATKEEPSAKE_DATA_DIR || defaultDataDirectory);
  launch({ createServer, dataDirectory, apiVersion }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer };
