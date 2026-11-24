'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {version} = require('../package.json');

const root = path.join(__dirname, '..');
const name = `uu-tailscale-relay-v${version}-linux`;
const archive = path.join(root, 'dist', `${name}.tar.gz`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'uu-tailscale-relay-'));
const files = ['README.md', 'LICENSE', 'dist/THIRD_PARTY_LICENSES.txt', 'dist/relay.cjs', 'dist/uurelay.cjs',
  'packaging/install.sh', 'packaging/uninstall.sh', 'packaging/uu-tailscale-relay.service',
  'packaging/config.example.json'];

try {
  const directory = path.join(temporary, name);
  fs.mkdirSync(directory);
  for (const source of files) fs.copyFileSync(path.join(root, source), path.join(directory, path.basename(source)));
  execFileSync('tar', ['-czf', archive, '-C', temporary, name], {stdio: 'inherit'});
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(archive + '.sha256', `${digest}  ${path.basename(archive)}\n`);
  console.log(archive);
} finally {
  const directory = path.join(temporary, name);
  for (const source of files) fs.rmSync(path.join(directory, path.basename(source)), {force: true});
  fs.rmdirSync(directory);
  fs.rmdirSync(temporary);
}
