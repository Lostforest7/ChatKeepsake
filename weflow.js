'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./run-process');
const { downloadGroup } = require('./download-assets');

const version = '5.0.1';
const archiveName = `weflow-v${version}-windows-x64.zip`;
const release = `https://github.com/334456777/WeFlow/releases/tag/v${version}`;
const download = `https://github.com/334456777/WeFlow/releases/download/v${version}/${archiveName}`;
const zipSha256 = '8d88ca61c504c8d509fd7b6934e4d2261ba986f6a1e13df68c3732323e1b26fa';
const installer = { name: archiveName, url: download, bytes: 11376812, sha256: zipSha256 };
const exeSha256 = '35029f95e9823d25e56bf263db09e220a25000758d81c8a397925b293173b845';
const maxArchiveSize = 13 * 1024 * 1024;
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function createWeFlow(dataDirectory) {
  const home = path.join(dataDirectory, 'weflow-data');
  const component = path.join(dataDirectory, 'components', `weflow-${version}`);
  const executable = path.join(component, 'weflow.exe');
  const supported = process.platform === 'win32' && process.arch === 'x64' &&
    (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || '').toUpperCase() !== 'ARM64';
  let verifiedStat = '';

  function isInstalled() {
    if (!supported) return false;
    try {
      const stat = fs.statSync(executable);
      if (!stat.isFile() || stat.size !== 30134784) return false;
      const stamp = [stat.ino, stat.mtimeMs, stat.ctimeMs].join(':');
      if (verifiedStat === stamp) return true;
      const verified = sha256(fs.readFileSync(executable)) === exeSha256;
      verifiedStat = verified ? stamp : '';
      return verified;
    } catch {
      return false;
    }
  }

  async function install(zip) {
    if (!supported) throw new Error('这个助手需要 64 位 Windows 电脑。');
    if (zip.length > maxArchiveSize || sha256(zip) !== zipSha256) {
      throw new Error('助手安装包有误或没下载完整。请选择「安装遇到问题」里下载的 ZIP 原文件。');
    }
    if (isInstalled()) return;
    fs.mkdirSync(component, { recursive: true });
    const suffix = crypto.randomBytes(6).toString('hex');
    const zipFile = path.join(component, `upload-${suffix}.zip`);
    const tempExe = path.join(component, `weflow-${suffix}.tmp`);
    const tempLicense = path.join(component, `license-${suffix}.tmp`);
    try {
      fs.writeFileSync(zipFile, zip, { flag: 'wx' });
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '$bundle = [IO.Compression.ZipFile]::OpenRead($env:CHATKEEPSAKE_INSTALL_ZIP)',
        'try {',
        `  $exeEntry = $bundle.GetEntry('weflow-v${version}-windows-x64/weflow.exe')`,
        `  $licenseEntry = $bundle.GetEntry('weflow-v${version}-windows-x64/LICENSE')`,
        '  [IO.Compression.ZipFileExtensions]::ExtractToFile($exeEntry, $env:CHATKEEPSAKE_INSTALL_EXE, $false)',
        '  [IO.Compression.ZipFileExtensions]::ExtractToFile($licenseEntry, $env:CHATKEEPSAKE_INSTALL_LICENSE, $false)',
        '} finally { $bundle.Dispose() }'
      ].join('\n');
      const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, CHATKEEPSAKE_INSTALL_ZIP: zipFile, CHATKEEPSAKE_INSTALL_EXE: tempExe, CHATKEEPSAKE_INSTALL_LICENSE: tempLicense }
      });
      if (result.code !== 0 || sha256(fs.readFileSync(tempExe)) !== exeSha256) {
        throw new Error('助手没能安装好。请再点一次「安装读取助手」重试。');
      }
      fs.renameSync(tempLicense, path.join(component, 'LICENSE'));
      fs.renameSync(tempExe, executable);
    } finally {
      for (const file of [zipFile, tempExe, tempLicense]) fs.rmSync(file, { force: true });
    }
  }

  async function installOnline(progress) {
    if (!supported) throw new Error('这个助手需要 64 位 Windows 电脑。');
    if (isInstalled()) return;
    const downloads = path.join(dataDirectory, 'components', 'downloads');
    const zip = path.join(downloads, archiveName);
    try {
      await downloadGroup([installer], downloads, progress, '正在从 GitHub 下载读取助手', { timeoutSeconds: 120 });
    } catch (error) {
      throw new Error(error.message + '可以重试，或在「安装遇到问题」里手动选择 ZIP。', { cause: error });
    }
    progress('下载完成，正在安装读取助手。');
    await install(await fs.promises.readFile(zip));
    await fs.promises.rm(zip, { force: true }).catch(() => {});
  }

  async function run(args, onProgress) {
    if (!isInstalled()) throw new Error('请先在第 1 步安装助手。');
    const result = await runProcess(executable, [...args, '--json'], {
      env: { ...process.env, WEFLOW_HOME: home, WEFLOW_LANG: 'zh' }
    }, line => {
      if (!onProgress) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'progress') onProgress(event);
    });
    if (result.exceeded) return { ok: false, code: 'output_too_large' };
    let response;
    try { response = JSON.parse(result.stdout); } catch { return { ok: false, code: 'no_response' }; }
    const code = response.error?.code;
    return {
      ok: result.code === 0 && response.success === true,
      data: response.success === true ? response.data : undefined,
      code: typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : 'backend_error'
    };
  }

  return { supported, isInstalled, install, installOnline, run };
}

async function lookupMessage(backend, session, message) {
  const id = String(message.platformMessageId ?? '');
  const time = message.createTime;
  if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(time) || time <= 0) return null;
  const result = await backend.run(['chat', 'message', session, '--server-id', id, '--parsed']);
  return result.ok && result.data?.createTime === time ? result.data : null;
}

module.exports = { createWeFlow, lookupMessage, version, archiveName, release, download, maxArchiveSize };
