'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {constants} = require('node:fs');
const {setTimeout: sleep} = require('node:timers/promises');
const {promisify} = require('node:util');
const {readJson, validateConfig} = require('./config.cjs');
const {configFile, stateDir} = require('./vault.cjs');
const {getAdvertisement} = require('./tailscale.cjs');

const execute = promisify(execFile);
const packageName = 'uu-tailscale-relay';
const service = `${packageName}.service`;
const target = '/opt/uu-tailscale-relay';
const targetCli = path.join(target, 'uurelay.cjs');
const files = [
  {name: 'relay.cjs', mode: 0o644},
  {name: 'uurelay.cjs', mode: 0o755},
  {name: 'THIRD_PARTY_LICENSES.txt', mode: 0o644},
];

async function run(binary, args, failure, options = {}) {
  try {
    const {stdout} = await execute(binary, args, {timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options});
    return stdout;
  } catch (error) {
    throw new Error(failure, {cause: error});
  }
}

async function detectInstallation(cliPath, currentVersion) {
  if (process.platform !== 'linux' || !cliPath) return 'external';
  const real = await fs.realpath(cliPath).catch(() => null);
  if (real !== targetCli) return 'external';
  const directory = await fs.lstat(target);
  const cli = await fs.lstat(targetCli);
  const portable = await fs.stat(path.join(target, 'node')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const rootOwned = stat => stat.uid === 0 && !(stat.mode & 0o022);
  if (!directory.isDirectory() || !cli.isFile() || !rootOwned(directory) || !rootOwned(cli) ||
      (portable && (!portable.isFile() || !rootOwned(portable)))) {
    throw new Error('安装目录、命令和便携 Node 必须由 root 管理。');
  }
  try {
    const {stdout} = await execute('/usr/bin/dpkg-query', ['-W', '-f=${Status}\n${Version}', packageName], {
      timeout: 5000, env: {...process.env, LC_ALL: 'C'},
    });
    const [status, installedVersion] = stdout.trim().split('\n');
    if (status === 'hold ok installed') throw new Error('Debian 软件包已被锁定，请用原包管理器更改锁定状态。');
    if (status === 'install ok installed') {
      const {stdout: owned} = await execute('/usr/bin/dpkg-query', ['-L', packageName], {timeout: 5000});
      if (!owned.split('\n').includes(real)) return 'external';
      if (installedVersion !== currentVersion) throw new Error('Debian 软件包记录与当前命令版本不一致，请先重新安装对应的 .deb。');
      return 'deb';
    }
    if (status.endsWith(' config-files') || status.endsWith(' not-installed')) return 'tar';
    throw new Error('Debian 包状态不完整，请先运行 sudo dpkg --audit 查看。');
  } catch (error) {
    if (error.code === 'ENOENT' ||
        (error.code === 1 && String(error.stderr).includes(`no packages found matching ${packageName}`))) return 'tar';
    if (error.code == null) throw error;
    throw new Error('无法确认 Debian 安装状态，请先运行 sudo dpkg --audit 查看。', {cause: error});
  }
}

async function validateDeb(filename, version) {
  const field = name => run('/usr/bin/dpkg-deb', ['--field', filename, name], '无法读取 Debian 安装包。');
  const [name, packagedVersion, architecture] = await Promise.all([field('Package'), field('Version'), field('Architecture')]);
  if (name.trim() !== packageName || packagedVersion.trim() !== version || architecture.trim() !== 'all') {
    throw new Error('Debian 安装包的名称、版本或架构与发布信息不一致。');
  }
}

async function stageTar(filename, version, stage) {
  await fs.mkdir(stage, {mode: 0o700});
  const prefix = `${packageName}-v${version}-linux`;
  for (const {name, mode} of files) {
    const data = await run('/usr/bin/tar', ['-xOzf', filename, '--', `${prefix}/${name}`],
      `无法从发布包读取 ${name}。`, {encoding: 'buffer'});
    const output = path.join(stage, name);
    await fs.writeFile(output, data, {flag: 'wx', mode});
    await fs.chmod(output, mode);
  }
}

async function copyFiles(source, destination) {
  await fs.mkdir(destination, {mode: 0o700});
  for (const {name} of files) {
    try {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      const {mode} = await fs.stat(from);
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      await fs.chmod(to, mode & 0o777);
    } catch (error) {
      if (name !== 'THIRD_PARTY_LICENSES.txt' || error.code !== 'ENOENT') throw error;
    }
  }
}

async function replaceFiles(source, restoring = false) {
  for (const {name} of files) {
    const destination = path.join(target, name);
    try {
      await fs.rename(path.join(source, name), destination);
    } catch (error) {
      if (!restoring || name !== 'THIRD_PARTY_LICENSES.txt' || error.code !== 'ENOENT') throw error;
      await fs.rm(destination, {force: true});
    }
  }
}

function systemctl(args) {
  return run('/usr/bin/systemctl', [...args, service], `systemctl ${args[0]} 失败，请通过 journalctl -u ${service} 查看。`,
    {timeout: 50000});
}

async function waitForRelay(config, startedAt) {
  const deadline = Date.now() + 75000;
  do {
    const status = await fs.readFile(path.join(stateDir, 'status.json'), 'utf8')
      .then(JSON.parse)
      .catch(error => {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      });
    if (status?.ready && typeof status.endpoint === 'string' && Date.parse(status.updatedAt) >= startedAt) {
      const advertisement = await getAdvertisement(config);
      if (advertisement.port === config.relayPort && advertisement.endpoints.includes(status.endpoint)) {
        const state = (await systemctl(['show', '--property=ActiveState', '--value'])).trim();
        if (state === 'active') return;
      }
    }
    await sleep(1000);
  } while (Date.now() < deadline);
  throw new Error('新版服务未能在等待期间发布有效的 UU 中转入口。');
}

async function checkCli(filename, version) {
  const installed = await run(process.execPath, [filename, 'version'], '无法读取新版本 uurelay。');
  if (installed.trim() !== version) throw new Error('安装后的 uurelay 版本与发布信息不一致。');
}

function installDeb(filename) {
  return run('/usr/bin/dpkg', ['--install', filename], 'Debian 包安装失败，请运行 sudo dpkg --audit 查看。',
    {timeout: 120000});
}

async function installUpdate({kind, version, currentVersion, file, previousDeb}) {
  if (process.platform !== 'linux' || process.geteuid() !== 0) throw new Error('请在 Linux 上用 sudo 执行更新。');
  if (!['tar', 'deb'].includes(kind)) throw new Error('这类安装需要使用原包管理器升级。');
  if (![version, currentVersion].every(value => /^\d+\.\d+\.\d+$/.test(value))) throw new Error('发布版本格式无效。');
  const targetStat = await fs.lstat(target);
  if (!targetStat.isDirectory() || targetStat.uid !== 0 || (targetStat.mode & 0o022)) {
    throw new Error('安装目录必须由 root 持有，且只允许 root 写入。');
  }
  const active = (await systemctl(['show', '--property=ActiveState', '--value'])).trim();
  if (!['active', 'inactive', 'failed'].includes(active)) throw new Error('服务正在切换状态，请稍后重试。');
  const wasActive = active === 'active';
  const config = wasActive ? validateConfig(readJson(configFile)) : null;
  await checkCli(targetCli, currentVersion);
  const root = await fs.mkdtemp(path.join(target, '.update-'));
  const backup = path.join(root, 'previous');
  let retainBackup = false;
  let installStarted = false;
  let stopAttempted = false;
  try {
    let staged;
    if (kind === 'deb') {
      await validateDeb(file, version);
      if (previousDeb) await validateDeb(previousDeb, currentVersion);
      await run('/usr/bin/dpkg-deb', ['--extract', file, path.join(root, 'deb')], '无法展开 Debian 安装包进行预检。');
      staged = path.join(root, 'deb', 'opt', packageName);
    } else {
      staged = path.join(root, 'tar');
      await stageTar(file, version, staged);
    }
    for (const name of ['uurelay.cjs', 'relay.cjs']) {
      await run(process.execPath, ['--check', path.join(staged, name)], `新版 ${name} 未通过语法检查。`);
    }
    await checkCli(path.join(staged, 'uurelay.cjs'), version);
    if (wasActive) {
      await run(process.execPath, [path.join(staged, 'relay.cjs'), '--check'], '新版服务未通过现有配置、账号与 Tailscale 预检。');
    }
    await copyFiles(target, backup);

    if (wasActive) {
      stopAttempted = true;
      await systemctl(['stop']);
    }
    installStarted = true;
    if (kind === 'deb') await installDeb(file);
    else await replaceFiles(staged);
    await checkCli(targetCli, version);

    if (wasActive) {
      const startedAt = Date.now();
      await systemctl(['start']);
      await waitForRelay(config, startedAt);
    }
  } catch (error) {
    if (!installStarted && !stopAttempted) throw error;
    try {
      if (installStarted) {
        if (wasActive) await systemctl(['stop']);
        if (kind === 'deb' && previousDeb) await installDeb(previousDeb);
        else {
          const restore = path.join(root, 'restore');
          await copyFiles(backup, restore);
          await replaceFiles(restore, true);
        }
      }
      if (wasActive) await systemctl(['start']);
    } catch (rollbackError) {
      retainBackup = true;
      throw new Error(`${error.message} 自动回滚失败。请检查服务，原文件备份在 ${backup}。`, {cause: rollbackError});
    }
    const note = kind === 'deb' && installStarted && !previousDeb
      ? '已恢复原程序文件，Debian 包记录可能仍需修复。请重新安装旧版 .deb。'
      : '已恢复更新前的程序和服务状态。';
    throw new Error(`${error.message} ${note}`, {cause: error});
  } finally {
    if (!retainBackup) await fs.rm(root, {recursive: true, force: true});
  }
}

module.exports = {detectInstallation, installUpdate};
