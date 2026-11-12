'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const assets = require('../voice-assets.json');
const processes = require('../run-process');

test('the voice model downloader verifies ranges and resumes after a failed segment', {
  skip: process.platform !== 'win32' || process.arch !== 'x64'
}, async t => {
  const segmentBytes = 16 * 1024 * 1024;
  const model = Buffer.alloc(2 * segmentBytes + 71, 0x01);
  model.fill(0x42, segmentBytes, 2 * segmentBytes);
  model.fill(0x87, 2 * segmentBytes);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const asset = { name: 'model.bin', bytes: model.length, sha256: sha256(model), url: 'https://example.com/model.bin' };
  const originalModel = assets.model;
  assets.model = [asset];
  t.after(() => { assets.model = originalModel; });

  const ranges = [];
  const offsets = [];
  let active = 0;
  let peak = 0;
  let faultyRange = -1;
  let corruptRange = -1;
  t.mock.method(processes, 'runProcess', async (_program, args) => {
    const outputIndex = args.indexOf('--output');
    if (outputIndex === -1) return { code: 0, stdout: '' }; // Local runtime check or proxy lookup.
    const output = args[outputIndex + 1];
    const rangeIndex = args.indexOf('--range');
    if (rangeIndex !== -1) {
      const [start, end] = args[rangeIndex + 1].split('-').map(Number);
      const index = ranges.push(start) - 1;
      active++;
      peak = Math.max(peak, active);
      await delay(10);
      const payload = index === corruptRange ? Buffer.alloc(end - start + 1) : model.subarray(start, end + 1);
      await fs.writeFile(output, payload);
      active--;
      const from = index === faultyRange ? start + 1 : start;
      const headers = 'HTTP/1.1 302 Found\r\nLocation: https://example.com/content\r\n\r\n' +
        'HTTP/2 206\r\nContent-Range: bytes ' + from + '-' + end + '/' + model.length + '\r\n\r\n';
      return { code: 0, stdout: headers };
    }
    const resume = args.includes('--continue-at');
    const offset = resume ? (await fs.stat(output)).size : 0;
    offsets.push(offset);
    await fs.writeFile(output, model.subarray(offset), { flag: resume ? 'a' : 'w' });
    return { code: 0, stdout: resume ? '206' : '200' };
  });
  const { createVoiceRuntime } = require('../voice-runtime');

  async function prepare(test, prefix) {
    ranges.length = 0;
    offsets.length = 0;
    peak = 0;
    const temp = await fs.realpath(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(temp, 'chatkeepsake-model-'));
    test.after(async () => {
      const target = await fs.realpath(directory);
      assert.equal(path.dirname(target), temp);
      await fs.rm(target, { recursive: true, force: true });
    });
    const runtime = path.join(directory, 'voice-runtime-' + assets.runtimeId);
    const modules = path.join(runtime, 'Lib/site-packages/faster_whisper');
    const folder = path.join(directory, 'voice-model-small');
    await fs.mkdir(modules, { recursive: true });
    await fs.mkdir(folder);
    for (const file of [path.join(runtime, '.ready'), path.join(runtime, 'python.exe'), path.join(modules, '__init__.py')]) {
      await fs.writeFile(file, 'test runtime');
    }
    if (prefix) {
      await fs.writeFile(path.join(folder, asset.name + '.part'), model.subarray(0, prefix));
      await fs.writeFile(path.join(folder, asset.name + '.part.range-0'), 'interrupted range');
    }
    const voice = createVoiceRuntime(directory);
    await voice.prepare(() => {});
    assert.equal(voice.ready(), true);
    assert.equal(sha256(await fs.readFile(path.join(folder, asset.name))), asset.sha256);
    assert.deepEqual((await fs.readdir(folder)).sort(), ['.verified-' + assets.modelRevision, asset.name]);
  }

  await t.test('transfers independent ranges concurrently and assembles the final partial segment', async test => {
    await prepare(test, 0);
    assert.deepEqual(ranges, [0, segmentBytes, 2 * segmentBytes]);
    assert.equal(peak, 3);
    assert.deepEqual(offsets, []);
  });

  await t.test('rejects the wrong Content-Range and resumes from the last consecutive byte', async test => {
    faultyRange = 1;
    await prepare(test, 17);
    assert.deepEqual(ranges, [17, 17 + segmentBytes, 17 + 2 * segmentBytes]);
    assert.deepEqual(offsets, [17 + segmentBytes]);
  });

  await t.test('restarts a transfer that fails the full checksum', async test => {
    faultyRange = -1;
    corruptRange = 0;
    await prepare(test, 0);
    assert.deepEqual(offsets, [0]);
  });

  await t.test('cleans up old segments when the remainder can be downloaded in one transfer', async test => {
    corruptRange = -1;
    const prefix = 2 * segmentBytes + 17;
    await prepare(test, prefix);
    assert.deepEqual(ranges, []);
    assert.deepEqual(offsets, [prefix]);
  });
});
