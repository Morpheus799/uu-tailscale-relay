'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');

async function build() {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: {relay: 'src/service.cjs', uurelay: 'src/cli.cjs'},
    outdir: 'dist', outExtension: {'.js': '.cjs'},
    bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    legalComments: 'inline', metafile: true, external: ['bufferutil', 'utf-8-validate'],
    define: {__UURELAY_UPDATE_REPOSITORY__: JSON.stringify(process.env.GITHUB_REPOSITORY || '')},
    // The UMD entry resolves internal modules through a runtime factory.
    alias: {'jsonc-parser': path.join(root, 'node_modules/jsonc-parser/lib/esm/main.js')},
  });
  const cli = path.join(root, 'dist/uurelay.cjs');
  if (!fs.readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new Error('The uurelay bundle must start with the Node shebang');
  }

  const packages = new Set();
  for (const source of Object.keys(result.metafile.inputs)) {
    const match = source.match(/^.*?node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
  const notices = [];
  for (const name of [...packages].sort()) {
    const directory = path.join(root, 'node_modules', name);
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const files = fs.readdirSync(directory).filter(file => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(file));
    const paths = files.map(file => path.join(directory, file));
    if (name === 'werift' && meta.version === '0.27.0') {
      paths.push(path.join(root, 'third_party/werift-0.27.0.LICENSE'));
      const notice = path.join(directory, 'THIRD_PARTY_LICENSES_LIBWEBRTC.txt');
      if (fs.existsSync(notice)) paths.push(notice);
    }
    if (!paths.length) throw new Error(`No license notice found for ${name}`);
    const text = paths.map(file => fs.readFileSync(file, 'utf8').trim()).join('\n\n');
    notices.push(`${name} ${meta.version} (${meta.license})\n${text}`);
  }
  fs.writeFileSync(path.join(root, 'dist/THIRD_PARTY_LICENSES.txt'), notices.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n');
  console.log(`Built the Linux service and uurelay with notices for ${notices.length} bundled dependencies`);
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
