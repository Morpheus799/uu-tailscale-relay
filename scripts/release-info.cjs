'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {isDeepStrictEqual, parseArgs} = require('node:util');
const {version: packageVersion} = require('../package.json');

const root = path.join(__dirname, '..');
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const githubRepository = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;

function packageNames(version) {
  return {
    deb: `uu-tailscale-relay_${version}_all.deb`,
    tar: `uu-tailscale-relay-v${version}-linux.tar.gz`,
    npm: `uu-tailscale-relay-${version}.tgz`,
  };
}

function changelogNotes(changelog, version) {
  if (!stableVersion.test(version)) throw new Error('发布版本应为 x.y.z。');
  const sections = [...changelog.matchAll(/^##[ \t]+([^\r\n]+)\r?$/gm)];
  const versions = new Set([version, `v${version}`, `[${version}]`, `[v${version}]`]);
  const matches = sections.flatMap((section, index) =>
    versions.has(section[1].trim().split(/[ \t]+/)[0]) ? [index] : []);
  if (matches.length !== 1) throw new Error(`请在 CHANGELOG.md 中添加唯一的 ## ${version} 段落。`);
  const index = matches[0];
  const notes = changelog.slice(sections[index].index + sections[index][0].length, sections[index + 1]?.index).trim();
  if (!notes) throw new Error(`CHANGELOG.md 中 ${version} 的更新说明为空。`);
  return notes;
}

function githubSource(override) {
  if (override) return override;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  let remote;
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return undefined; }
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/i.exec(remote)?.[1];
}

function writeReleaseInfo({repository, directory, version = packageVersion, changelog, check = false}) {
  if (typeof repository !== 'string' || !githubRepository.test(repository) || /\/\.{1,2}$/.test(repository)) {
    throw new Error('请配置 GitHub origin，或用 --repo OWNER/REPO 指定发布仓库。');
  }
  const log = changelogNotes(changelog, version).replace(/\r\n/g, '\n');
  const tag = `v${version}`;
  const prefix = `https://github.com/${repository}/releases/download/${tag}`;
  const downloads = Object.fromEntries(Object.entries(packageNames(version)).map(([kind, name]) => [kind, `${prefix}/${name}`]));
  const info = {version, tag, log, download_url: downloads.deb, downloads};
  const filename = path.join(directory, 'version.json');
  if (check) {
    let checkedIn;
    try {
      checkedIn = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (!isDeepStrictEqual(checkedIn, info)) {
      throw new Error(`请运行 npm run release:info 并提交生成的版本文件（${filename}）。`);
    }
  } else {
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(filename, `${JSON.stringify(info, null, 2)}\n`);
  }
  return info;
}

if (require.main === module) {
  try {
    const {values} = parseArgs({options: {
      repo: {type: 'string'},
      output: {type: 'string', default: path.join(root, 'publish')},
      check: {type: 'boolean'},
    }});
    const directory = path.resolve(values.output);
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const info = writeReleaseInfo({repository: githubSource(values.repo), directory, changelog, check: values.check});
    console.log(`${info.tag} 更新信息已${values.check ? '校验' : '生成'}，目录为 ${directory}。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {changelogNotes, packageNames, writeReleaseInfo};
