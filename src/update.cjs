'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');
const {atomicWrite} = require('./vault.cjs');
const {detectInstallation, installUpdate} = require('./update-install.cjs');

const repoFile = '/etc/uu-tailscale-relay/update-repository';
const unit = 'uu-tailscale-relay-update';
const unitDirectory = '/etc/systemd/system';
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const maxAssetBytes = 32 * 1024 * 1024;
const downloadHosts = new Set([
  'raw.githubusercontent.com', 'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);
const defaultRepository = typeof __UURELAY_UPDATE_REPOSITORY__ === 'string' ? __UURELAY_UPDATE_REPOSITORY__ : '';

const timerFiles = {
  service: `[Unit]
Description=Update UU Tailscale Relay
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=10min
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/bin/sh -ec 'if [ -x /opt/uu-tailscale-relay/node ]; then exec /opt/uu-tailscale-relay/node /opt/uu-tailscale-relay/uurelay.cjs update; fi; exec /usr/bin/env node /opt/uu-tailscale-relay/uurelay.cjs update'
`,
  timer: `[Unit]
Description=Check daily for UU Tailscale Relay updates

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
`,
};

function repositoryName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(value) ||
      /\/\.{1,2}$/.test(value)) throw new Error('请用 --repo 所有者/仓库 指定 GitHub 发布来源。');
  return value;
}

function compareVersions(a, b) {
  if (!stableVersion.test(a) || !stableVersion.test(b)) throw new Error('更新仅支持 x.y.z 正式版本。');
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function packageNames(version) {
  return {
    deb: `uu-tailscale-relay_${version}_all.deb`,
    tar: `uu-tailscale-relay-v${version}-linux.tar.gz`,
    npm: `uu-tailscale-relay-${version}.tgz`,
  };
}

function releaseDownload(repository, tag, filename) {
  return `https://github.com/${repository}/releases/download/${tag}/${filename}`;
}

function validateVersionInfo(value, repository) {
  const version = value?.version;
  if (typeof version !== 'string' || !stableVersion.test(version) ||
      value.tag !== `v${version}` || typeof value.log !== 'string') {
    throw new Error('仓库的 publish/version.json 格式无效。');
  }
  for (const [kind, name] of Object.entries(packageNames(version))) {
    const expected = releaseDownload(repository, value.tag, name);
    if (typeof value.downloads?.[kind] !== 'string' || value.downloads[kind].toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`仓库版本信息中的 ${kind} 下载地址与正式版本不一致。`);
    }
  }
  if (value.download_url !== value.downloads.deb) throw new Error('仓库版本信息中的默认下载地址与 Debian 包不一致。');
  return value;
}

async function fetchBytes(address, limit, fetcher = fetch) {
  let url = new URL(address);
  const signal = AbortSignal.timeout(60000);
  for (let hops = 0; hops < 5; hops++) {
    if (url.protocol !== 'https:' || !downloadHosts.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error('更新下载跳转到了未经信任的地址。');
    }
    const headers = url.hostname === 'api.github.com' ? {accept: 'application/vnd.github+json'} : {};
    const response = await fetcher(url, {redirect: 'manual', signal, headers});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('更新下载跳转缺少目标地址。');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      const error = new Error(`下载 GitHub 更新文件失败（HTTP ${response.status}）。`);
      error.httpStatus = response.status;
      throw error;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('更新文件超出了允许的大小。');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error('更新下载跳转次数过多。');
}

async function fetchJson(address, limit, fetcher) {
  const bytes = await fetchBytes(address, limit, fetcher);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('GitHub 返回的更新信息不是有效的 JSON。'); }
}

async function readVersionInfo(repository, fetcher) {
  repositoryName(repository);
  const value = await fetchJson(`https://raw.githubusercontent.com/${repository}/refs/heads/main/publish/version.json`,
    256 * 1024, fetcher);
  return validateVersionInfo(value, repository);
}

async function readRelease(repository, version, fetcher) {
  repositoryName(repository);
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error('发布版本格式无效。');
  const tag = `v${version}`;
  const release = await fetchJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, 1024 * 1024, fetcher);
  if (release?.tag_name !== tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('GitHub 返回的 Release 与请求的正式版本不一致。');
  }
  return release;
}

async function readAsset(repository, version, release, kind, fetcher) {
  repositoryName(repository);
  const tag = `v${version}`;
  const names = packageNames(version);
  if (typeof version !== 'string' || !stableVersion.test(version) || release?.tag_name !== tag ||
      !Array.isArray(release.assets) || !Object.hasOwn(names, kind)) {
    throw new Error('安装包版本或类型无效。');
  }
  const name = names[kind];
  const asset = release.assets.find(candidate => candidate?.name === name && candidate.state === 'uploaded');
  const {digest, size} = asset ?? {};
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(digest) ||
      !Number.isSafeInteger(size) || size < 1 || size > maxAssetBytes) {
    throw new Error(`GitHub Release 缺少 ${name} 的有效大小或 SHA-256 摘要。`);
  }
  const bytes = await fetchBytes(releaseDownload(repository, tag, name), size, fetcher);
  if (bytes.length !== size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest.toLowerCase()) {
    throw new Error('安装包大小或 SHA-256 与 GitHub Release 摘要不一致。');
  }
  return {name, bytes};
}

function configuredRepository(override) {
  if (override) return repositoryName(override);
  try {
    const stat = fs.lstatSync(repoFile);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('更新来源文件必须是 root 持有的普通文件。');
    return repositoryName(fs.readFileSync(repoFile, 'utf8').trim());
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
  }
  return repositoryName(defaultRepository);
}

function systemctl(...args) {
  execFileSync('/usr/bin/systemctl', args, {timeout: 40000, stdio: 'inherit'});
}

function enableTimer(repository) {
  fs.mkdirSync(path.dirname(repoFile), {recursive: true, mode: 0o700});
  const directory = fs.lstatSync(path.dirname(repoFile));
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022)) {
    throw new Error('更新来源目录必须由 root 持有，且只允许 root 写入。');
  }
  for (const [suffix, contents] of Object.entries(timerFiles)) {
    const filename = path.join(unitDirectory, `${unit}.${suffix}`);
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || fs.readFileSync(filename, 'utf8') !== contents) {
        throw new Error(`已存在自定义单元 ${filename}，请先核对该文件。`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const [suffix, contents] of Object.entries(timerFiles)) {
    atomicWrite(path.join(unitDirectory, `${unit}.${suffix}`), contents, 0o644);
  }
  atomicWrite(repoFile, repository + '\n');
  systemctl('daemon-reload');
  systemctl('enable', '--now', `${unit}.timer`);
}

function runLocked(cliPath, originalArgs) {
  const result = spawnSync('/usr/bin/flock',
    ['--nonblock', '--conflict-exit-code', '75', '/run/uu-tailscale-relay-update.lock', process.execPath, cliPath, 'update', ...originalArgs],
    {stdio: 'inherit', env: {...process.env, UURELAY_UPDATE_LOCKED: '1'}});
  if (result.error) throw result.error;
  if (result.status === 75) throw new Error('另一个 uurelay 更新操作正在运行。');
  process.exitCode = result.status ?? 1;
}

async function updateCommand({action, check, repo, cliPath, currentVersion, originalArgs}) {
  if (!check) {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) throw new Error('请在 Linux 上用 sudo 执行更新操作。');
    if (process.env.UURELAY_UPDATE_LOCKED !== '1') return runLocked(cliPath, originalArgs);
  }
  if (action === 'disable') {
    const timer = path.join(unitDirectory, `${unit}.timer`);
    if (fs.existsSync(timer)) systemctl('disable', '--now', `${unit}.timer`);
    console.log('自动更新已关闭。');
    return;
  }
  const repository = configuredRepository(repo);
  const kind = check ? undefined : await detectInstallation(cliPath, currentVersion);
  if (kind === 'external') throw new Error('此安装由 npm 或其他外部方式管理。请用 update --check 检查，再用原方式升级。');
  if (action === 'enable') {
    enableTimer(repository);
    console.log(`自动更新已启用，每天检查 ${repository} 的正式发布。`);
    return;
  }
  const info = await readVersionInfo(repository);
  if (compareVersions(info.version, currentVersion) <= 0) {
    console.log(`当前版本 ${currentVersion}，没有更新的正式版本。`);
    return;
  }
  let release;
  try { release = await readRelease(repository, info.version); }
  catch (error) {
    if (error.httpStatus !== 404) throw error;
    console.log(`仓库已登记 ${info.version}，GitHub Release 尚未发布。当前版本 ${currentVersion}。`);
    return;
  }
  console.log(`发现新版本 ${info.version}（当前 ${currentVersion}）`);
  const notes = info.log.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
  if (notes) console.log(notes);
  if (check) return;
  const scratch = fs.mkdtempSync('/tmp/uurelay-update-');
  try {
    const candidate = await readAsset(repository, info.version, release, kind);
    const file = path.join(scratch, candidate.name);
    fs.writeFileSync(file, candidate.bytes, {mode: 0o600, flag: 'wx'});
    let previousDeb;
    if (kind === 'deb') {
      try {
        const previous = await readRelease(repository, currentVersion);
        const rollback = await readAsset(repository, currentVersion, previous, 'deb');
        previousDeb = path.join(scratch, rollback.name);
        fs.writeFileSync(previousDeb, rollback.bytes, {mode: 0o600, flag: 'wx'});
      } catch (error) {
        if (error.httpStatus !== 404) throw error;
      }
    }
    await installUpdate({kind, version: info.version, currentVersion, file, previousDeb});
    console.log(`uurelay 已升级到 ${info.version}。`);
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}

module.exports = {compareVersions, validateVersionInfo, readVersionInfo, readRelease, readAsset, updateCommand};
