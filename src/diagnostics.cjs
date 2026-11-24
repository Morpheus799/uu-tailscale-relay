'use strict';

const {privateFile} = require('./config.cjs');
const {resolveProvider} = require('./accounts.cjs');
const {peerSnapshot, permissionSummary} = require('./peers.cjs');
const tailscale = require('./tailscale.cjs');
const uu = require('./uu.cjs');
const turn = require('./turn.cjs');
const relay = require('./relay.cjs');

function checkProvider(config, vault, accounts) {
  const selected = resolveProvider(config.provider, vault, accounts);
  if (config.provider.type === 'turn-file') {
    turn.candidates(JSON.parse(privateFile(config.provider.credentialFile)));
  }
  return selected;
}

async function probeRelay(config, provider, snapshot) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let lease;
  try { lease = await uu.credentials(provider); }
  catch { return {ok: false, stage: 'credentials', durationMs: elapsed()}; }
  const credentialMs = elapsed();
  const stats = relay.relayStats();
  let allocation;
  try { allocation = await relay.allocate(lease, config, snapshot, stats); }
  catch (error) {
    const timing = {credentialMs, durationMs: elapsed()};
    if (error.code === 'NO_TURN_PERMISSIONS') {
      return {ok: false, stage: 'permissions', turnAllocation: true, ...timing, ...permissionSummary(snapshot)};
    }
    return {ok: false, stage: 'allocation', ...timing};
  }
  try {
    const permissions = permissionSummary(snapshot, allocation);
    const ok = permissions.activePermissions === permissions.requestedIPv4;
    return {ok, stage: ok ? 'complete' : 'permissions', turnAllocation: true, transport: allocation.transport,
      credentialMs, durationMs: elapsed(), permissionRequests: stats.permissionRequests,
      batchesAccepted: stats.batchesAccepted, ...permissions};
  } finally { await allocation.close(); }
}

async function accountLogins(provider) {
  const roles = Object.entries({controller: provider.controller, host: provider.host}).filter(([, account]) => account);
  const checks = await Promise.allSettled(roles.map(([, {identity, signingKey}]) => uu.verifyLogin(identity, signingKey)));
  return Object.fromEntries(checks.map((result, index) => [
    roles[index][0], result.status === 'rejected' ? 'unavailable' : result.value ? 'valid' : 'invalid',
  ]));
}

async function diagnose(config, vault, stateDir, {service, runtime, probe}) {
  const report = {ok: false, service, selectedSlot: null, runningSlot: runtime?.runningSlot ?? null};
  let selected;
  try {
    const accounts = config.provider.type === 'slot' ? vault.accounts() : undefined;
    report.selectedSlot = accounts?.selected ?? null;
    selected = checkProvider(config, vault, accounts);
    report.account = {state: 'configured', provider: config.provider.type, selected: selected.selection,
      hostConfigured: Boolean(selected.provider.host)};
  } catch {
    report.account = {state: 'unavailable', provider: config.provider.type,
      hint: config.provider.type === 'slot' ? '请用 uurelay slot 查看登录，再用 uurelay choose 选择账号。' : '请检查 TURN 凭据文件。'};
  }

  let snapshot;
  const active = runtime?.ready && (!runtime.expiresAt || Date.parse(runtime.expiresAt) > Date.now());
  try {
    const map = await tailscale.netmap(config);
    snapshot = peerSnapshot(map, config);
    const {current} = await tailscale.assertAvailable(config, stateDir);
    report.tailscale = {state: 'ready', relayPort: current.port, advertisedEndpoints: current.endpoints};
    const endpoint = runtime?.endpoint;
    if (active && current.port === config.relayPort && current.endpoints.includes(endpoint)) {
      const target = map.SelfNode.Name.replace(/\.$/, '');
      report.clientCheck = {
        command: ['tailscale', ...tailscale.routeArgs(target)],
        uurelayCommand: ['uurelay', 'doctor', '--target', target, '--endpoint', endpoint],
        expectedPeerRelayEndpoint: endpoint,
      };
    }
  } catch {
    report.tailscale = {state: 'unavailable', hint: '请检查 Tailscale 登录、Peer Relay 设置和设备列表。'};
  }

  const permissions = active
    ? {requestedIPv4: runtime.requestedIPv4, activePermissions: runtime.activePermissions, peers: runtime.peers}
    : snapshot && permissionSummary(snapshot);
  report.relay = {state: active ? 'reported-active' : 'unavailable', ready: Boolean(active),
    endpoint: runtime?.endpoint, transport: runtime?.transport, expiresAt: runtime?.expiresAt, updatedAt: runtime?.updatedAt,
    lastRefreshAt: runtime?.lastRefreshAt, refreshError: runtime?.refreshError, stats: runtime?.stats,
    timing: runtime?.timing, ...permissions};

  const available = Boolean(selected && report.tailscale.state === 'ready');
  if (probe) {
    if (!available) report.probe = {ok: false, stage: 'prerequisites'};
    else {
      const logins = await accountLogins(selected.provider);
      if (Object.keys(logins).length) report.account.logins = logins;
      report.probe = Object.values(logins).every(state => state === 'valid')
        ? await probeRelay(config, selected.provider, snapshot)
        : {ok: false, stage: 'login'};
    }
  }
  report.ok = available && (!probe || report.probe.ok);
  return report;
}

module.exports = {checkProvider, diagnose, probeRelay};
