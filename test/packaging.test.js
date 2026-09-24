// The Docker image only contains src/, views/, public/ and package.json
// (see Dockerfile). Make sure the app starts from exactly that set of files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('app starts with only the files copied into the Docker image', () => {
  const root = path.join(__dirname, '..');
  const copied = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').match(/^COPY (?!--from)(\S+) /gm).map((l) => l.split(' ')[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-pkg-'));
  try {
    for (const item of copied) fs.cpSync(path.join(root, item), path.join(dir, item), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    const out = execFileSync(
      process.execPath,
      ['-e', "require('./src/app').createApp(); require('./src/seed'); console.log('ok'); process.exit(0)"],
      { cwd: dir, env: { ...process.env, DATA_DIR: path.join(dir, 'data'), DATABASE_URL: '' }, encoding: 'utf8' }
    );
    assert.match(out, /ok/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
