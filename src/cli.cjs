#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createInterface} = require('node:readline/promises');
const {Writable} = require('node:stream');
const {setTimeout: sleep} = require('node:timers/promises');
const {version} = require('../package.json');
const {Vault, configFile, stateDir, slotNumber, atomicWrite} = require('./vault.cjs');
const {privateFile, publicIPv4, readJson, validateConfig} = require('./config.cjs');
const uu = require('./uu.cjs');
const tailscale = require('./tailscale.cjs');
const {selfRelayGrant, configureSelfRelay, configureStun, localSelfRelayStatus, policyAccessToken,
  readManagementCredential, saveManagementCredential, verifyPolicyAccess} = require('./policy.cjs');
const {assertUuLinuxBackend, resolveProvider} = require('./accounts.cjs');
const {loginPair} = require('./slot-login.cjs');
const {resolveSigningKey} = require('./signing.cjs');
const {diagnose} = require('./diagnostics.cjs');
const {findPeer, reportedIpv4} = require('./peers.cjs');
const {DEFAULT_UU_STUN, parseStunEndpoint} = require('./stun.cjs');
const {errorMessage, formatDoctor, formatDoctorIp, formatDoctorRoute, formatQuick, formatSlot, formatStun} = require('./format.cjs');
const {updateCommand} = require('./update.cjs');

const execute = promisify(execFile);
const service = 'uu-tailscale-relay.service';
const help = `UU Tailscale 中转

用法
  uurelay version
  uurelay update [--check] [--repo OWNER/REPO]
  uurelay update enable [--repo OWNER/REPO]
  uurelay update disable
  uurelay init [--target NAME | --host-slot N] [--tailnet NAME]
  uurelay slot N [--json]
  uurelay login N
  uurelay logout N
  uurelay choose N
  uurelay choose uulinux [--uulinux-config PATH]
  uurelay start | stop | refresh
  uurelay doctor [--quick | --probe] [--json]
  uurelay doctor ip HOST_OR_IP [--json]
  uurelay doctor --target NAME_OR_IP --endpoint IPV4:PORT [--json]
  uurelay setstun [--stun IPV4:PORT] [--tailnet NAME] [--json]

槽位编号为 1–10。账号和服务操作请使用 sudo。
在中转 Linux 上运行 doctor ip，可查看指定设备上报的公网 IPv4。
若设备的 UU STUN 映射地址不同且 UU 连不上，运行 sudo uurelay setstun。`;

function printReport(report, json, format) {
  console.log(json ? JSON.stringify(report, null, 2) : format(report));
}

function optionalJson(filename) {
  try { return readJson(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('此操作需要在交互终端中输入。');
  if (hidden) process.stderr.write(label);
  const output = hidden ? new Writable({write(chunk, encoding, callback) { callback(); }}) : process.stderr;
  const rl = createInterface({input: process.stdin, output, terminal: true});
  try {
    return (await rl.question(hidden ? '' : label)).trim();
  } finally {
    rl.close();
    if (hidden) process.stderr.write('\n');
  }
}

function parseOptions(arguments_, allowed) {
  const options = {};
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    if (!Object.hasOwn(allowed, flag) || Object.hasOwn(options, flag)) throw new Error(`未知或重复的选项 ${flag}。`);
    if (allowed[flag]) {
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error(`请给 ${flag} 指定参数值。`);
      options[flag] = value;
    } else options[flag] = true;
  }
  return options;
}

async function systemctl(args) {
  try {
    const {stdout} = await execute('/usr/bin/systemctl', args, {timeout: 40000, maxBuffer: 1024 * 1024});
    return stdout.trim();
  } catch {
    throw new Error(`systemctl ${args[0]} 执行失败，请运行 journalctl -u ${service} 查看日志。`);
  }
}

async function ensureService() {
  if (['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'].some(directory => fs.existsSync(path.join(directory, service)))) return;
  const installer = path.resolve(__dirname, '../packaging/install.sh');
  if (!fs.existsSync(installer)) throw new Error('找不到 systemd 服务单元，请重新安装 Linux 包。');
  await execute('/bin/sh', [installer, '--service-only'], {timeout: 30000});
}

async function sudoHome() {
  const user = process.env.SUDO_USER;
  if (!user || user === 'root') return os.homedir();
  const {stdout} = await execute('/usr/bin/getent', ['passwd', user], {timeout: 5000});
  const home = stdout.trim().split(':')[5];
  if (!home || !path.isAbsolute(home)) throw new Error('找不到调用者的用户目录。');
  return home;
}

async function importUuLinux(override) {
  const home = await sudoHome();
  const executables = [process.env.UURELAY_UULINUX_BINARY, path.join(home, '.local/bin/uuremote-server'),
    '/usr/bin/uuremote-server', '/usr/local/bin/uuremote-server', '/opt/uu-remote-linux/bin/uuremote-server',
    ...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(directory => path.join(directory, 'uuremote-server'))].filter(Boolean);
  if (!executables.some(filename => {
    if (!path.isAbsolute(filename)) return false;
    try { fs.accessSync(filename, fs.constants.X_OK); return fs.statSync(filename).isFile(); }
    catch { return false; }
  })) throw new Error('找不到 UU Linux 的 uuremote-server。');
  const candidates = override ? [override] : [process.env.UU_CONFIG,
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'uuremote/config.json'),
    path.join(home, '.config/uuremote/config.json')].filter(Boolean);
  const file = candidates.find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate));
  if (!file) throw new Error('找不到当前用户的 UU Linux 登录配置。');
  const identity = JSON.parse(privateFile(file));
  assertUuLinuxBackend(identity);
  if (!uu.haveLogin(identity)) throw new Error('UU Linux 登录无效，请先在 UU Linux 登录。');
  return {identity, file};
}

async function updateImported(vault) {
  const accounts = vault.accounts();
  if (accounts.selected !== 'uulinux') return;
  const key = resolveSigningKey(accounts);
  const entry = await importUuLinux(accounts.imported?.source);
  if (!await uu.verifyLogin(entry.identity, key)) throw new Error('UU Linux 登录已失效，请重新登录。');
  vault.change(value => {
    if (value.selected !== 'uulinux') throw new Error('校验期间所选账号已改变，请重试。');
    value.imported = {identity: entry.identity, source: entry.file, importedAt: new Date().toISOString()};
  });
}

function config() {
  const raw = optionalJson(configFile);
  if (!raw) throw new Error('请先运行 sudo uurelay init。');
  return validateConfig(raw);
}

function selectTailnet(local, requested, saved) {
  if (local && requested && local.toLowerCase() !== requested.toLowerCase()) {
    throw new Error('指定的 tailnet 与本机登录的 tailnet 不一致。');
  }
  const tailnet = requested ?? local ?? saved;
  if (!tailnet) throw new Error('无法识别本机的 tailnet，请用 --tailnet 指定。');
  return tailnet;
}

function credentialFor(record, tailnet) {
  return record?.tailnet.toLowerCase() === tailnet.toLowerCase() ? record.credential : undefined;
}

async function confirmOAuthReplacement() {
  for (;;) {
    const answer = (await prompt('是否覆盖已保存的 Tailscale OAuth 凭据？[y/n] ')).toLowerCase();
    if (answer === 'y') return true;
    if (answer === 'n') return false;
    console.log('请输入 y 或 n。');
  }
}

async function promptManagementCredential(replacing) {
  console.log('请在 Tailscale 管理后台创建 OAuth 客户端，授予 Policy File 写权限（policy_file）。');
  console.log('同时勾选 devices:posture_attributes 和 devices:core:read。');
  console.log('配置说明  https://tailscale.com/docs/features/oauth-clients');
  const clientId = await prompt(replacing
    ? '输入 OAuth Client ID（回车取消覆盖） '
    : '输入 OAuth Client ID（回车跳过，稍后手动配置策略） ');
  if (!clientId) return;
  const clientSecret = await prompt('输入 OAuth Client Secret（隐藏输入） ', true);
  return {clientId, clientSecret};
}

async function initPolicy(config, vault, requestedTailnet) {
  const local = process.stdin.isTTY ? await localSelfRelayStatus(config).catch(() => null) : null;
  if (!local) {
    if (process.stdin.isTTY) console.log('请先登录 Tailscale，再运行 uurelay init 配置策略管理。');
    const map = await tailscale.netmap(config).catch(() => null);
    const ip = map?.SelfNode?.Addresses?.find(value => /^100\.[0-9.]+\/32$/.test(value))?.split('/')[0];
    if (ip) console.log('请将以下自中继授权合并到 tailnet 策略的 grants 数组。\n' + JSON.stringify(selfRelayGrant(ip), null, 2));
    return;
  }

  const tailnet = selectTailnet(local.tailnet, requestedTailnet);
  let saved;
  let unreadable = false;
  try { saved = readManagementCredential(vault); }
  catch {
    unreadable = true;
    console.log('无法读取已保存的 Tailscale OAuth 凭据。');
  }
  const existing = credentialFor(saved, tailnet);
  const hasSaved = Boolean(saved) || unreadable;
  const replace = !hasSaved || await confirmOAuthReplacement();
  const credential = replace ? (await promptManagementCredential(hasSaved)) ?? existing : existing;
  if (!credential) {
    if (!local.enabled) {
      console.log('请将以下自中继授权合并到 tailnet 策略的 grants 数组。\n' + JSON.stringify(selfRelayGrant(local.selfIp), null, 2));
    }
    return;
  }

  const token = await policyAccessToken(credential);
  if (local.enabled) {
    await verifyPolicyAccess({token, tailnet});
    console.log('本机已获得 Tailscale 自中继授权。');
  } else {
    const result = await configureSelfRelay({token, tailnet, selfIp: local.selfIp});
    console.log(result.changed ? '已添加 Tailscale 自中继授权。' : '策略已有 Tailscale 自中继授权。');
  }
  if (credential !== existing) {
    saveManagementCredential(vault, tailnet, credential);
    console.log('已加密保存此 tailnet 的 OAuth 凭据。');
  }
}

async function init(args, vault) {
  const options = parseOptions(args, {'--target': true, '--host-slot': true,
    '--tailnet': true});
  if (options['--target'] && options['--host-slot']) throw new Error('请在 --target 和 --host-slot 中选择一项。');
  const previous = optionalJson(configFile);
  const previousProvider = previous?.provider;
  const provider = previousProvider?.type === 'slot' ? {...previousProvider} : {type: 'slot'};
  if (options['--target']) { provider.targetName = options['--target']; delete provider.hostSlot; }
  if (options['--host-slot']) {
    provider.hostSlot = slotNumber(options['--host-slot']);
    delete provider.targetName;
    delete provider.targetUnit;
  }
  const next = {...previous, provider};
  const validated = validateConfig(next);
  vault.init();
  vault.provisionUuClient(path.join(path.dirname(configFile), 'uu-client.credential'));
  await ensureService();
  atomicWrite(configFile, JSON.stringify(next, null, 2) + '\n');
  await initPolicy(validated, vault, options['--tailnet']);
  console.log('服务和加密账号库已初始化。');
}

async function login(vault, slot) {
  await loginPair({vault, slot, signingKey: resolveSigningKey(vault.accounts()), prompt, log: console.log});
}

async function logout(vault, slot) {
  const state = vault.accounts();
  const entry = state.slots[slot - 1];
  if (!entry) { console.log(`槽位 ${slot} 为空。`); return; }
  const signOutHost = entry.hostOwned && uu.haveLogin(entry.hostIdentity);
  const signOutController = entry.owned && uu.haveLogin(entry.identity);
  const key = resolveSigningKey(state);
  const current = config();
  const runtime = optionalJson(path.join(stateDir, 'status.json'));
  if (runtime?.runningSlot === slot || (runtime?.runningSlot == null && state.selected === slot) || current.provider.hostSlot === slot) {
    const active = await systemctl(['show', service, '--property=ActiveState', '--value']).catch(() => 'unknown');
    if (['active', 'activating', 'reloading', 'unknown'].includes(active)) await systemctl(['stop', service]);
  }
  const results = [];
  if (signOutHost) {
    let unbound = false;
    if (uu.haveLogin(entry.identity) && String(entry.identity.user_id) === String(entry.hostIdentity.user_id) &&
        entry.identity.device_id !== entry.hostIdentity.device_id) {
      unbound = await uu.unbindDevice(entry.identity, entry.hostIdentity, key);
    }
    const host = unbound ? {unbound: true, sessionEnded: await uu.endSession(entry.hostIdentity, key)}
      : await uu.signOut(entry.hostIdentity, key);
    results.push({role: 'host', ...host});
  }
  if (signOutController) {
    results.push({role: 'controller', ...await uu.signOut(entry.identity, key)});
  }
  vault.change(value => {
    const recent = value.slots[slot - 1];
    if (JSON.stringify(recent) !== JSON.stringify(entry)) {
      throw new Error('退出期间槽位已改变，请重试。');
    }
    value.slots[slot - 1] = null;
    if (value.selected === slot) value.selected = null;
  });
  console.log(`槽位 ${slot} 已清空。`);
  for (const result of results) {
    const role = result.role === 'host' ? '被控端' : '主控端';
    console.log(`${role}  ${result.unbound ? 'UU 已确认设备解绑' : 'UU 尚未确认设备解绑'}。`);
    if (!result.sessionEnded) console.log(`${role}  UU 尚未确认退出登录。`);
    if (!result.unbound || !result.sessionEnded) process.exitCode = 2;
  }
}

async function choose(vault, selection, args) {
  const current = config();
  if (current.provider.type !== 'slot') throw new Error('请运行 sudo uurelay init 启用账号槽位。');
  const options = parseOptions(args, selection === 'uulinux' ? {'--uulinux-config': true} : {});
  const state = vault.accounts();
  const entry = selection === 'uulinux' ? await importUuLinux(options['--uulinux-config']) : state.slots[selection - 1];
  if (selection !== 'uulinux' && !entry?.paired && current.provider.hostSlot === selection) {
    throw new Error('同一个槽位不能同时用作主控端和被控端。');
  }
  const key = resolveSigningKey(state);
  if (!await uu.verifyLogin(entry?.identity, key)) throw new Error('该 UU 登录无效或已过期，请重新登录。');
  if (entry?.paired && !await uu.verifyLogin(entry.hostIdentity, key)) {
    throw new Error(`被控端登录无效，请运行 sudo uurelay login ${selection}。`);
  }
  vault.change(value => {
    if (selection === 'uulinux') value.imported = {identity: entry.identity, source: entry.file, importedAt: new Date().toISOString()};
    else if (JSON.stringify(value.slots[selection - 1]) !== JSON.stringify(entry)) throw new Error('校验期间槽位已改变，请重试。');
    resolveProvider(current.provider, vault, {...value, selected: selection});
    value.selected = selection;
  });
  console.log(`已选择 ${selection === 'uulinux' ? 'UU Linux' : `槽位 ${selection}`}。`);
  console.log('服务已运行时用 sudo uurelay refresh 应用，服务已停止时用 sudo uurelay start 启动。');
}

async function refresh(vault) {
  const current = config();
  if (current.provider.type === 'slot') await updateImported(vault);
  const selected = resolveProvider(current.provider, vault);
  const previous = optionalJson(path.join(stateDir, 'status.json'))?.lastRefreshAt;
  const active = await systemctl(['show', service, '--property=ActiveState', '--value']);
  if (active !== 'active') throw new Error('中转服务未运行，请先执行 sudo uurelay start。');
  await systemctl(['kill', '--kill-who=main', '--signal=HUP', service]);
  const until = Date.now() + 35000;
  do {
    await sleep(1000);
    const state = optionalJson(path.join(stateDir, 'status.json'));
    if (!state?.lastRefreshAt || state.lastRefreshAt === previous) continue;
    if (state.refreshError) throw new Error(`刷新失败，请查看 journalctl -u ${service}。`);
    if (state.ready && state.runningSlot === selected.selection) { console.log('已刷新中转入口和 TURN 地址许可。'); return; }
  } while (Date.now() < until);
  console.log('刷新仍在进行，可用 sudo uurelay doctor --quick 查看结果。');
}

async function doctor(args, vault) {
  const {'--quick': quick, '--probe': probe, '--json': json} = parseOptions(args, {'--quick': false, '--probe': false, '--json': false});
  if (quick && probe) throw new Error('请在 --quick 和 --probe 中选择一项。');
  const current = quick ? undefined : config();
  const active = await systemctl(['show', service, '--property=ActiveState', '--value']).catch(() => 'unavailable');
  const runtime = active === 'active' ? optionalJson(path.join(stateDir, 'status.json')) : null;
  if (quick) {
    const selectedSlot = fs.existsSync(vault.file('accounts')) ? vault.accounts().selected ?? null : null;
    printReport({service: active, selectedSlot, runningSlot: runtime?.runningSlot ?? null, relay: runtime}, json, formatQuick);
    return;
  }
  const report = await diagnose(current, vault, stateDir, {service: active, runtime, probe});
  printReport(report, json, formatDoctor);
  if (!report.ok) process.exitCode = 1;
}

async function doctorRoute(args) {
  const {'--target': target, '--endpoint': endpoint, '--json': json} = parseOptions(args,
    {'--target': true, '--endpoint': true, '--json': false});
  if (!target || (!net.isIP(target) && !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(target))) {
    throw new Error('请用 --target 指定中转主机名或 Tailscale IP。');
  }
  const address = /^(\d+(?:\.\d+){3}):([1-9]\d{0,4})$/.exec(endpoint ?? '');
  if (!address || !publicIPv4(address[1]) || Number(address[2]) > 65535) {
    throw new Error('请用 --endpoint 指定 UU 入口的 IPv4 地址和端口。');
  }
  const report = await tailscale.checkClientRoute(target, endpoint);
  printReport(report, json, formatDoctorRoute);
  if (!report.ok) process.exitCode = 1;
}

async function doctorIp(args) {
  const [target, ...flags] = args;
  if (!target || target.includes('%') || (!net.isIP(target) && !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(target))) {
    throw new Error('用法  uurelay doctor ip HOST_OR_IP [--json]');
  }
  const {'--json': json} = parseOptions(flags, {'--json': false});
  if (process.platform !== 'linux') throw new Error('请在中转 Linux 上运行 doctor ip。');
  const raw = process.geteuid?.() === 0 ? optionalJson(configFile) : null;
  const config = raw ? validateConfig(raw) : {};
  const map = await tailscale.netmap(config).catch(() => { throw new Error('无法读取 Tailscale 设备列表，请确认本机已登录。'); });
  const peer = findPeer(map, target);
  const {host, port} = parseStunEndpoint();
  printReport({
    target: peer.Name ?? target,
    reportedIPv4: [...reportedIpv4(peer.Endpoints ?? [])],
    stun: DEFAULT_UU_STUN,
    probeOnTarget: `stunclient --protocol udp ${host} ${port}`,
    next: '如果测到的映射 IPv4 不在上方列表中，且 UU 连不上，请在中转主机运行 sudo uurelay setstun。',
  }, json, formatDoctorIp);
}

async function setStun(args, vault) {
  const {'--stun': endpoint = DEFAULT_UU_STUN, '--tailnet': desired, '--json': json} = parseOptions(args,
    {'--stun': true, '--tailnet': true, '--json': false});
  parseStunEndpoint(endpoint);
  const saved = readManagementCredential(vault);
  if (!saved) throw new Error('Tailscale OAuth 尚未配置，请先运行 sudo uurelay init，再重试 setstun。');
  const raw = optionalJson(configFile);
  const status = await tailscale.status(raw ? validateConfig(raw) : undefined).catch(() => null);
  const tailnet = selectTailnet(status?.CurrentTailnet?.Name, desired, saved.tailnet);
  const credential = credentialFor(saved, tailnet);
  if (!credential) throw new Error('当前 tailnet 没有保存 OAuth 凭据，请先运行 sudo uurelay init。');
  const token = await policyAccessToken(credential);
  const result = await configureStun({token, tailnet, endpoint});
  printReport({changed: result.changed, stun: endpoint, regionID: result.regionID}, json, formatStun);
}

async function main(args = process.argv.slice(2)) {
  const [command, parameter, ...rest] = args;
  if (!command || ['--help', '-h', 'help'].includes(command)) { console.log(help); return; }
  if (command === 'version') {
    if (args.length !== 1) throw new Error('用法  uurelay version');
    console.log(version);
    return;
  }
  if (command === 'update') {
    const action = ['enable', 'disable'].includes(parameter) ? parameter : undefined;
    const allowed = action === 'disable' ? {} : {'--repo': true};
    if (!action) allowed['--check'] = false;
    const {'--check': check, '--repo': repo} = parseOptions(args.slice(action ? 2 : 1), allowed);
    return updateCommand({action, check, repo, cliPath: fs.realpathSync(process.argv[1]), currentVersion: version,
      originalArgs: args.slice(1)});
  }
  if (command === 'doctor' && parameter === 'ip') return doctorIp(rest);
  if (command === 'doctor' && args.slice(1).some(arg => ['--target', '--endpoint'].includes(arg))) {
    return doctorRoute(args.slice(1));
  }
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) throw new Error('请在 Linux 上用 sudo 执行此命令。');
  const vault = new Vault();
  if (command === 'init') return init(args.slice(1), vault);
  if (command === 'setstun') return setStun(args.slice(1), vault);
  if (command === 'doctor') return doctor(args.slice(1), vault);
  if (command === 'choose') return choose(vault, parameter === 'uulinux' ? parameter : slotNumber(parameter), rest);
  if (['login', 'logout', 'slot'].includes(command)) {
    if (command !== 'slot' && rest.length) throw new Error('参数过多，请查看 uurelay --help。');
    const number = slotNumber(parameter);
    if (command === 'login') return login(vault, number);
    if (command === 'logout') return logout(vault, number);
    const {'--json': json} = parseOptions(rest, {'--json': false});
    const state = vault.accounts();
    const entry = state.slots[number - 1];
    const key = resolveSigningKey(state);
    let loginState = 'empty';
    if (entry && !uu.haveLogin(entry.identity)) loginState = 'not-logged-in';
    else if (entry) {
      try { loginState = await uu.verifyLogin(entry.identity, key) ? 'logged-in' : 'invalid-or-expired'; }
      catch { loginState = 'verification-unavailable'; }
    }
    let hostState;
    if (entry?.paired) {
      if (!uu.haveLogin(entry.hostIdentity)) hostState = 'not-logged-in';
      else {
        try { hostState = await uu.verifyLogin(entry.hostIdentity, key) ? 'logged-in' : 'invalid-or-expired'; }
        catch { hostState = 'verification-unavailable'; }
      }
    }
    printReport({slot: number, state: loginState, hostState, account: entry?.mobileMasked,
      selected: state.selected === number}, json, formatSlot);
    return;
  }
  if (args.length !== 1) throw new Error('参数过多，请查看 uurelay --help。');
  if (command === 'start') {
    const current = config();
    if (current.provider.type === 'slot') await updateImported(vault);
    resolveProvider(current.provider, vault);
    await systemctl(['start', service]);
    console.log('服务已启动。可用 sudo uurelay doctor --quick 查看 UU 入口是否就绪。');
  } else if (command === 'stop') {
    await systemctl(['stop', service]);
    console.log('中转服务已停止。');
  } else if (command === 'refresh') await refresh(vault);
  else throw new Error(`未知命令 ${command}，请查看 uurelay --help。`);
}

if (require.main === module) main().catch(error => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
