'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {createInterface} = require('node:readline');
const {promisify} = require('node:util');
const execute = promisify(execFile);

function cli(config, args) {
  const socket = config.tailscaleSocket ? ['--socket=' + config.tailscaleSocket] : [];
  return execute(config.tailscaleBinary ?? 'tailscale', [...socket, ...args], {
    timeout: 12000, maxBuffer: 8 * 1024 * 1024,
  });
}

function readOwner(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function saveOwner(filename, value) {
  const staged = filename + '.next';
  fs.writeFileSync(staged, JSON.stringify(value), {mode: 0o600});
  fs.renameSync(staged, filename);
}

function equal(a, b) {
  return a?.port === b?.port && JSON.stringify(a?.endpoints) === JSON.stringify(b?.endpoints);
}

async function getAdvertisement(config) {
  const {stdout} = await cli(config, ['debug', 'prefs']);
  const prefs = JSON.parse(stdout);
  return {port: prefs.RelayServerPort ?? null, endpoints: prefs.RelayServerStaticEndpoints ?? []};
}

function owned(current, record) {
  return equal(current, record.current) || equal(current, record.pending);
}

async function assertAvailable(config, stateDir) {
  const filename = path.join(stateDir, 'advertisement.json');
  const record = readOwner(filename);
  const current = await getAdvertisement(config);
  if ((current.port !== null || current.endpoints.length) && !owned(current, record)) {
    throw new Error('Tailscale already has a Peer Relay configuration managed elsewhere');
  }
  return {filename, record, current};
}

async function publish(config, stateDir, endpoint) {
  const {filename, record, current} = await assertAvailable(config, stateDir);
  const next = {port: config.relayPort, endpoints: [endpoint]};
  saveOwner(filename, {current: owned(current, record) ? current : undefined, pending: next});
  await cli(config, ['set', `--relay-server-port=${next.port}`, `--relay-server-static-endpoints=${endpoint}`]);
  saveOwner(filename, {current: next});
}

async function withdraw(config, stateDir) {
  const filename = path.join(stateDir, 'advertisement.json');
  const record = readOwner(filename);
  if (!record.current && !record.pending) return;
  const current = await getAdvertisement(config);
  if (owned(current, record)) await cli(config, ['set', '--relay-server-port=', '--relay-server-static-endpoints=']);
  fs.rmSync(filename, {force: true});
}

async function netmap(config) {
  const {stdout} = await cli(config, ['debug', 'netmap']);
  return JSON.parse(stdout);
}

async function status(config = {}) {
  const {stdout} = await cli(config, ['status', '--json']);
  return JSON.parse(stdout);
}

function routeArgs(target) {
  return ['ping', '--c=10', '--until-direct=false', '--timeout=2s', target];
}

function routeFromPing(line, endpoint) {
  const path = /^pong from .+ via (\S+) in \S+$/.exec(line)?.[1];
  if (!path) return null;
  const peerRelay = /^peer-relay\((.+)\)$/.exec(path)?.[1];
  if (peerRelay) {
    const address = peerRelay.split(':vni:', 1)[0];
    return {path: address === endpoint ? 'uu' : 'other-peer-relay', endpoint: address};
  }
  if (/^DERP\(.+\)$/.test(path)) return {path: 'derp'};
  if (/:\d+$/.test(path)) return {path: 'direct'};
  return {path: 'unknown'};
}

async function checkClientRoute(target, endpoint) {
  const started = performance.now();
  const samples = [];
  const error = await new Promise(resolve => {
    const child = execFile('tailscale', routeArgs(target), {timeout: 35000, maxBuffer: 128 * 1024, windowsHide: true},
      error => resolve(error));
    const lines = createInterface({input: child.stdout});
    lines.on('line', line => {
      const sample = routeFromPing(line, endpoint);
      if (sample) samples.push({...sample, observedAfterMs: Math.round(performance.now() - started)});
    });
  });
  const firstUuObservedMs = samples.find(sample => sample.path === 'uu')?.observedAfterMs;
  const ok = firstUuObservedMs !== undefined;
  const state = ok ? 'confirmed' : error && !samples.length ? 'unavailable' : 'not-observed';
  return {ok, state, target, expectedPeerRelayEndpoint: endpoint, firstUuObservedMs, samples};
}

function watch(config, onChange) {
  let stopped = false;
  let request;
  let retry;
  function connect() {
    if (stopped) return;
    request = http.get({socketPath: config.tailscaleSocket, path: '/localapi/v0/watch-ipn-bus?mask=49152',
      headers: {Host: 'local-tailscaled.sock'}}, response => {
      if (response.statusCode !== 200) { response.resume(); return; }
      onChange();
      let partial = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        partial += chunk;
        if (partial.length > 4 * 1024 * 1024) { response.destroy(); return; }
        const messages = partial.split('\n');
        partial = messages.pop();
        for (const message of messages) {
          let event;
          try { event = JSON.parse(message); } catch { continue; }
          if (event.InitialStatus || event.PeersChanged?.length || event.PeersRemoved?.length ||
              event.PeerChangedPatch?.some(patch => Object.hasOwn(patch, 'Endpoints') || Object.hasOwn(patch, 'Online'))) onChange();
        }
      });
      response.on('error', () => {});
    });
    request.on('error', () => {});
    request.on('close', () => { if (!stopped) retry = setTimeout(connect, 5000); });
  }
  connect();
  return () => { stopped = true; clearTimeout(retry); request?.destroy(); };
}

module.exports = {netmap, status, assertAvailable, publish, withdraw, routeArgs, routeFromPing, checkClientRoute, watch};
