'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createArchives, jsonFile } = require('../archive');
const { messageType } = require('../chat-content');

function temporaryExports(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'chatkeepsake-archives-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), parent);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('lists all saved chats, including older exports, and skips an incomplete manifest', t => {
  const directory = temporaryExports(t);
  const ids = [];
  for (let index = 0; index < 35; index++) {
    const id = '2026-01-01_00-00-00_' + index.toString(16).padStart(8, '0');
    ids.push(id);
    const folder = path.join(directory, id);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, '导出说明.json'), JSON.stringify({
      schema: 1, id, name: '虚构示例', counts: { messages: 1, images: 0, imageFiles: 0, voices: 0, voiceFiles: 0 }
    }));
  }
  const incompleteId = '2026-01-01_00-00-00_ffffffff';
  const incomplete = path.join(directory, incompleteId);
  fs.mkdirSync(incomplete);
  fs.writeFileSync(path.join(incomplete, '导出说明.json'), JSON.stringify({ schema: 1, id: incompleteId }));
  assert.deepEqual(createArchives(directory).list().map(record => record.id), ids.reverse());
});

test('keeps the conversation when a voice retry fails after writing a partial file', async t => {
  const directory = temporaryExports(t);
  const session = 'fixture';
  const sample = path.join(__dirname, '../demo/media/demo/voice.wav');
  const messages = [
    { localType: 1, content: '周六见' },
    { localType: messageType.voice, platformMessageId: '1', createTime: 1767225600 },
    { localType: messageType.voice, platformMessageId: '2', createTime: 1767225601 }
  ];
  let failedFile;
  const backend = {
    async run(args) {
      if (args[0] === 'export') {
        const output = args[args.indexOf('--out') + 1];
        fs.writeFileSync(path.join(output, session + '.json'), JSON.stringify({ messages }));
        return { ok: true };
      }
      if (args[1] === 'message') return { ok: true, data: { localId: 1 } };
      assert.equal(args[1], 'voice-data');
      const output = args[args.indexOf('--out') + 1];
      if (args[args.indexOf('--server-id') + 1] === '1') {
        failedFile = path.basename(output);
        fs.writeFileSync(output, 'partial audio');
        throw new Error('Simulated interruption');
      }
      fs.copyFileSync(sample, output);
      return { ok: true };
    }
  };
  const archives = createArchives(directory);
  const { id, counts } = await archives.exportChat({ session, images: false, voices: true }, backend, () => {});
  const { directory: saved } = archives.get(id);
  const document = JSON.parse(fs.readFileSync(path.join(saved, jsonFile), 'utf8'));
  assert.equal(document.messages[0].content, '周六见');
  assert.equal(document.messages[1].voiceRecoveryStatus, 'missing');
  assert.equal(document.messages[2].voiceRecoveryStatus, 'verified');
  assert.equal(counts.voiceFiles, 1);
  const voice = path.join(saved, document.messages[2].content);
  assert.deepEqual(fs.readFileSync(voice), fs.readFileSync(sample));
  assert.ok(failedFile);
  assert.equal(fs.existsSync(path.join(path.dirname(voice), failedFile)), false);
});
