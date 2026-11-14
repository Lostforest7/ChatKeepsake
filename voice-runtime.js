'use strict';

const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { runProcess } = require('./run-process');
const { downloadGroup, fileSize } = require('./download-assets');
const assets = require('./voice-assets.json');

const megabyte = 1000000;
const runtimeAssets = [assets.python, assets.pip, assets.vc, ...assets.wheels];
const totalBytes = [...runtimeAssets, ...assets.model].reduce((total, asset) => total + asset.bytes, 0);
const downloadMb = Math.ceil(totalBytes / (10 * megabyte)) * 10;
const supported = process.platform === 'win32' && process.arch === 'x64';
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const windowsPowerShell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function readable(file) {
  if (fileSize(file) <= 0) return false;
  try {
    fs.closeSync(fs.openSync(file, 'r'));
    return true;
  } catch {
    return false;
  }
}

async function removeBuild(directory, dataDirectory, expectedName) {
  const target = await files.realpath(directory);
  if (path.dirname(target) !== await files.realpath(dataDirectory) || path.basename(target) !== expectedName) {
    throw new Error('语音组件的保存位置不可用。');
  }
  await files.rm(target, { recursive: true, force: true });
}

async function checkPython(python) {
  try {
    const result = await runProcess(python, ['-c', 'from faster_whisper import WhisperModel; import av, numpy, onnxruntime'], {
      signal: AbortSignal.timeout(30000),
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function downloadVoiceAssets(group, folder, progress, label, options) {
  try {
    await downloadGroup(group, folder, progress, label, options);
  } catch (error) {
    throw new Error(error.message + '再点一次「把语音变成文字」即可重试。', { cause: error });
  }
}

function createVoiceRuntime(dataDirectory) {
  const model = path.join(dataDirectory, 'voice-model-small');
  const modelStamp = path.join(model, '.verified-' + assets.modelRevision);
  const runtimeName = 'voice-runtime-' + assets.runtimeId;
  const runtime = path.join(dataDirectory, runtimeName);
  const managedPython = path.join(runtime, 'python.exe');
  const previousRuntime = path.join(dataDirectory, 'voice-runtime-' + assets.downloadId);
  const legacyRoot = path.join(dataDirectory, 'voice-env');
  const legacyPython = path.join(legacyRoot, 'Scripts', 'python.exe');
  const downloads = path.join(dataDirectory, 'voice-downloads', assets.downloadId);
  let checkedPython = '';

  const modelPresent = () => assets.model.every(asset => fileSize(path.join(model, asset.name)) === asset.bytes);
  function runtimeCandidates() {
    const candidates = [runtime, previousRuntime].filter(directory => readable(path.join(directory, '.ready')) &&
      readable(path.join(directory, 'Lib/site-packages/faster_whisper/__init__.py')))
      .map(directory => path.join(directory, 'python.exe'));
    if (readable(path.join(legacyRoot, 'Lib/site-packages/faster_whisper/__init__.py'))) candidates.push(legacyPython);
    return candidates.filter(readable);
  }
  const ready = () => modelPresent() && runtimeCandidates().length > 0;

  async function installRuntime(progress) {
    await downloadVoiceAssets(runtimeAssets, downloads, progress, '首次准备语音转写，正在下载组件');
    progress('正在准备语音组件。');
    const stage = await files.mkdtemp(path.join(dataDirectory, 'voice-build-'));
    try {
      const extraction = await runProcess(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '[IO.Compression.ZipFile]::ExtractToDirectory($env:WECHAT_CHATS_TO_FILES_VOICE_ZIP, $env:WECHAT_CHATS_TO_FILES_VOICE_BUILD)',
        '$vc = [IO.Compression.ZipFile]::OpenRead($env:WECHAT_CHATS_TO_FILES_VOICE_VC)',
        'try {',
        '  foreach ($entry in $vc.Entries) {',
        "    if ($entry.FullName -match '^msvc_runtime-[^/]+\\.data/data/([a-z0-9_]+\\.dll)$') {",
        '      $target = Join-Path $env:WECHAT_CHATS_TO_FILES_VOICE_BUILD $Matches[1]',
        '      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)',
        "    } elseif ($entry.FullName -match '^msvc_runtime-[^/]+\\.dist-info/licenses/LICENSE$') {",
        "      $target = Join-Path $env:WECHAT_CHATS_TO_FILES_VOICE_BUILD 'MSVC-LICENSE.txt'",
        '      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)',
        '    }',
        '  }',
        '} finally { $vc.Dispose() }'
      ].join('\n')], {
        env: {
          ...process.env, WECHAT_CHATS_TO_FILES_VOICE_ZIP: path.join(downloads, assets.python.name),
          WECHAT_CHATS_TO_FILES_VOICE_VC: path.join(downloads, assets.vc.name), WECHAT_CHATS_TO_FILES_VOICE_BUILD: stage
        },
        signal: AbortSignal.timeout(60000)
      });
      if (extraction.code !== 0 || fileSize(path.join(stage, 'msvcp140.dll')) <= 0) {
        throw new Error('语音组件没能解压。请检查磁盘空间后重试。');
      }
      const sitePackages = path.join(stage, 'Lib', 'site-packages');
      await files.mkdir(sitePackages, { recursive: true });
      await files.writeFile(path.join(stage, assets.pythonTag + '._pth'), [
        assets.pythonTag + '.zip', '.', 'Lib\\site-packages', 'import site', ''
      ].join('\r\n'));
      const python = path.join(stage, 'python.exe');
      const pip = 'import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("pip", run_name="__main__")';
      const installed = await runProcess(python, [
        '-c', pip, path.join(downloads, assets.pip.name), '--isolated', '--disable-pip-version-check',
        // --prefix writes into the staging directory. --target moves packages
        // from pip's private temp directory and can retain its elevated ACLs.
        'install', '--no-index', '--no-deps', '--no-input', '--no-compile', '--prefix', stage,
        ...assets.wheels.map(asset => path.join(downloads, asset.name))
      ], {
        env: { ...process.env, PIP_CONFIG_FILE: 'nul' },
        signal: AbortSignal.timeout(180000)
      });
      if (installed.code !== 0 || !await checkPython(python)) {
        throw new Error('这台电脑没能启动语音组件。请检查磁盘空间，重开 WeChat Chats to Files 后再试。');
      }
      await files.writeFile(path.join(stage, '.ready'), assets.runtimeId + '\n');
      if (fs.existsSync(runtime)) await removeBuild(runtime, dataDirectory, runtimeName);
      await files.rename(stage, runtime);
    } finally {
      if (fs.existsSync(stage)) await removeBuild(stage, dataDirectory, path.basename(stage));
    }
    return managedPython;
  }

  async function prepare(progress) {
    if (!supported && !ready()) throw new Error('自动准备语音转写需要 64 位 Windows。');
    let python = '';
    for (const candidate of runtimeCandidates()) {
      if (candidate === checkedPython || await checkPython(candidate)) {
        python = candidate;
        break;
      }
    }
    if (!python) python = await installRuntime(progress);
    checkedPython = python;
    if (!modelPresent() || fileSize(modelStamp) <= 0) {
      progress('正在准备语音模型。');
      await downloadVoiceAssets(assets.model, model, progress, '首次准备语音转写，正在下载模型', { batchSize: 1 });
      await files.writeFile(modelStamp, assets.modelRevision + '\n');
    }
    return { python, model };
  }

  return { supported, downloadMb, ready, prepare };
}

module.exports = { createVoiceRuntime };
