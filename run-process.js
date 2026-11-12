'use strict';

const { spawn } = require('node:child_process');

function runProcess(executable, args, options, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let exceeded = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 24 * 1024 * 1024) exceeded = true;
      if (!exceeded) stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-8000);
      const lines = (progressBuffer + chunk).split(/\r?\n/);
      progressBuffer = lines.pop().slice(-8000);
      for (const line of lines) onLine(line);
    });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr, exceeded }));
  });
}

module.exports = { runProcess };
