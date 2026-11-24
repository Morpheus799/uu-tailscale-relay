'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {readJson, validateConfig} = require('./config.cjs');
const {peerSnapshot, permissionSummary, trackPermissionTiming} = require('./peers.cjs');
const tailscale = require('./tailscale.cjs');
const {credentials} = require('./uu.cjs');
const turn = require('./turn.cjs');
const {allocate, relayStats} = require('./relay.cjs');
const {Vault, configFile, stateDir, atomicWrite} = require('./vault.cjs');
const {resolveProvider} = require('./accounts.cjs');
const {checkProvider, probeRelay} = require('./diagnostics.cjs');

const stats = relayStats();

function log(event, error) {
  const code = error?.cause?.response?.getAttributeValue('ERROR-CODE')?.[0];
  const redact = value => value?.replace(/(?:https?|wss?|turns?):[^\s]+/gi, '[url]')?.slice(0, 200);
  console.log(JSON.stringify({event, message: redact(error?.message), turnCode: code}));
}

function store(name, value) {
  atomicWrite(path.join(stateDir, name), JSON.stringify(value) + '\n');
}

async function serve(config) {
  fs.mkdirSync(stateDir, {recursive: true, mode: 0o700});
  await tailscale.assertAvailable(config, stateDir);
  const vault = new Vault();
  vault.key().fill(0);
  let current = resolveProvider(config.provider, vault);
  let lease;
  try {
    const cached = vault.read('lease');
    if (cached.providerKey === current.fingerprint) lease = cached.lease;
  } catch (error) { if (error.code !== 'ENOENT') log('cached-credentials-unavailable', error); }

  let active;
  let retiring;
  let retiringUntil;
  let snapshot;
  let readAt = 0;
  let lastAttempt = 0;
  let requestedRefresh = 0;
  let completedRefresh = 0;
  let lastRefreshAt;
  let refreshError;
  let lastAllocation;
  let unavailableSince;
  let lastRecoveryMs;
  const permissionTiming = trackPermissionTiming();
  let dirty = true;
  let stopped = false;
  let running;
  let queued = false;

  async function switchAllocation(nextLease) {
    const started = performance.now();
    const next = await allocate(nextLease, config, snapshot, stats);
    try {
      if (stopped) throw new Error('Relay is stopping');
      await tailscale.publish(config, stateDir, next.endpoint);
    } catch (error) { await next.close().catch(() => {}); throw error; }
    const publishedAt = Date.now();
    lastAllocation = {publishedAt: new Date(publishedAt).toISOString(), setupMs: Math.round(performance.now() - started)};
    const expiredAt = active && active.expiresAt <= publishedAt ? active.expiresAt : unavailableSince;
    if (expiredAt !== undefined) lastRecoveryMs = Math.max(0, publishedAt - expiredAt);
    unavailableSince = undefined;
    if (retiring) await retiring.close().catch(() => {});
    retiring = active;
    retiringUntil = Date.now() + 90000;
    active = next;
    lease = nextLease;
    permissionTiming.sample(active, snapshot.peers, publishedAt);
    log('relay-ready');
  }

  async function refreshSelection() {
    const next = resolveProvider(config.provider, vault);
    if (next.fingerprint !== current.fingerprint || !active) {
      const renewed = await credentials(next.provider);
      await switchAllocation(renewed);
      current = next;
      vault.write('lease', {providerKey: current.fingerprint, lease: renewed});
      log('credentials-ready');
    } else {
      const permissionErrors = stats.permissionErrors;
      await active.update(snapshot.ips, true);
      permissionTiming.sample(active, snapshot.peers);
      if (stats.permissionErrors !== permissionErrors || !snapshot.ips.every(ip => active.isPermitted(ip))) {
        throw new Error('UU rejected some peer permissions');
      }
      await tailscale.publish(config, stateDir, active.endpoint);
    }
    lastAttempt = Date.now();
  }

  async function tick() {
    if (dirty || Date.now() - readAt >= 60000) {
      dirty = false;
      try {
        snapshot = peerSnapshot(await tailscale.netmap(config), config);
        readAt = Date.now();
        permissionTiming.observe(snapshot.ips, readAt);
      } catch (error) { dirty = true; throw error; }
    }
    const now = Date.now();
    if (retiring && now >= retiringUntil) {
      await retiring.close().catch(() => {});
      retiring = undefined;
    }
    if (active && active.expiresAt <= now) {
      unavailableSince ??= active.expiresAt;
      await tailscale.withdraw(config, stateDir);
      await active.close().catch(() => {});
      active = undefined;
    }
    if (active) {
      await active.update(snapshot.ips);
      permissionTiming.sample(active, snapshot.peers);
      if (now >= active.refreshAt) {
        try { active.scheduleRefresh(await turn.refresh(active.client.turn)); }
        catch (error) {
          active.refreshAt = now + 15000;
          log('turn-refresh-failed', error);
          try { await switchAllocation(lease); }
          catch (reconnectError) { log('turn-reconnect-failed', reconnectError); }
        }
      }
    }
    if (requestedRefresh > completedRefresh) {
      const request = requestedRefresh;
      try { await refreshSelection(); refreshError = false; }
      catch (error) { refreshError = true; log('manual-refresh-failed', error); }
      completedRefresh = request;
      lastRefreshAt = new Date().toISOString();
    }
    const shouldRenew = !lease || now - Date.parse(lease.issuedAt) >= config.credentialRefreshSeconds * 1000;
    if ((!active || shouldRenew) && now - lastAttempt >= 60000) {
      lastAttempt = now;
      try {
        if (!active && lease && !shouldRenew) await switchAllocation(lease);
        else {
          const renewed = await credentials(current.provider);
          await switchAllocation(renewed);
          vault.write('lease', {providerKey: current.fingerprint, lease: renewed});
          log('credentials-ready');
        }
      } catch (error) {
        log('renewal-failed', error);
        if (!active && lease) {
          try { await switchAllocation(lease); }
          catch (cachedError) { log('cached-allocation-failed', cachedError); }
        }
      }
    }
    store('status.json', {ready: !!active, endpoint: active?.endpoint, transport: active?.transport,
      expiresAt: active && new Date(active.expiresAt).toISOString(), runningSlot: active ? current.selection : null,
      lastRefreshAt, refreshError, ...permissionSummary(snapshot, active), stats,
      timing: {lastAllocation, lastRecoveryMs, lastPermission: permissionTiming.sample(active, snapshot.peers)},
      updatedAt: new Date().toISOString()});
  }

  function schedule() {
    if (stopped) return;
    if (running) { queued = true; return; }
    running = tick().catch(error => log('maintenance-failed', error)).finally(() => {
      running = undefined;
      if (queued) { queued = false; schedule(); }
    });
  }

  const timer = setInterval(schedule, 15000);
  const stopWatch = tailscale.watch(config, () => { dirty = true; schedule(); });
  process.on('SIGHUP', () => { dirty = true; requestedRefresh++; schedule(); });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stopWatch();
    await Promise.race([running, sleep(2500)]);
    try { await tailscale.withdraw(config, stateDir); }
    catch (error) { log('withdraw-failed', error); }
    await Promise.allSettled([active, retiring].filter(Boolean).map(entry => entry.close()));
    store('status.json', {ready: false, updatedAt: new Date().toISOString()});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  schedule();
}

async function main() {
  const action = process.argv[2];
  if (!['--check', '--withdraw', '--probe', undefined].includes(action)) throw new Error('Expected --check, --probe, or --withdraw');
  const config = validateConfig(readJson(configFile));
  if (action === '--withdraw') return tailscale.withdraw(config, stateDir);
  if (action === '--check' || action === '--probe') {
    const selected = checkProvider(config, new Vault());
    const snapshot = peerSnapshot(await tailscale.netmap(config), config);
    const result = {ok: true, onlinePeers: snapshot.peers.length, ipv4Candidates: snapshot.ips.length};
    if (action === '--probe') {
      const probe = await probeRelay(config, selected.provider, snapshot);
      if (!probe.ok) throw new Error('Relay probe failed at ' + probe.stage);
      Object.assign(result, probe);
    }
    console.log(JSON.stringify(result));
    return;
  }
  return serve(config);
}

main().catch(error => { log('failed', error); process.exitCode = 1; });
