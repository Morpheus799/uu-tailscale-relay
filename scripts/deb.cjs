'use strict';

const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {version} = require('../package.json');

if (process.platform !== 'linux') {
  console.error('Building the Debian package requires Linux with dpkg-deb.');
  process.exit(1);
}

const build = spawnSync('sh', [path.join(__dirname, '../packaging/build-deb.sh'), version], {
  stdio: 'inherit',
});
if (build.error) console.error(build.error.message);
process.exitCode = build.status ?? 1;
