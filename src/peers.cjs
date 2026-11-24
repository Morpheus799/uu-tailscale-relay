'use strict';

const net = require('node:net');
const {publicIPv4} = require('./config.cjs');

function peerIdentity(value) {
  const name = value.toLowerCase().replace(/\.$/, '');
  return net.isIPv6(name) ? new URL(`http://[${name}]/`).hostname.slice(1, -1) : name;
}

function findPeer(map, target) {
  const identity = peerIdentity(target);
  const matches = (map.Peers || []).filter(peer => {
    if (net.isIP(identity)) {
      return (peer.Addresses || []).some(address => peerIdentity(address.split('/')[0]) === identity);
    }
    const name = peer.Name && peerIdentity(peer.Name);
    return name && (name === identity || name.split('.')[0] === identity);
  });
  if (matches.length !== 1) throw new Error('请用完整主机名或 Tailscale IP 指定一台设备。');
  return matches[0];
}

function reportedIpv4(endpoints = []) {
  return new Set(endpoints.map(endpoint => endpoint.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)?.[1]).filter(publicIPv4));
}

function peerSnapshot(map, config) {
  const self = map.SelfNode?.Name?.toLowerCase().replace(/\.$/, '');
  const suffix = self?.slice(self.indexOf('.') + 1);
  if (!suffix?.endsWith('.ts.net') || suffix === self) throw new Error('找不到本机登录的 Tailscale DNS 域。');
  const allowed = new Set(config.peers.map(name => name.toLowerCase().replace(/\.$/, '')));
  const peers = [];
  const ips = new Set();
  for (const peer of map.Peers || []) {
    const name = peer.Name?.toLowerCase().replace(/\.$/, '');
    if (!peer.Online || peer.Expired || peer.Sharer || !name?.endsWith('.' + suffix)) continue;
    const machine = name.slice(0, -(suffix.length + 1));
    if (allowed.size && !allowed.has(name) && !allowed.has(machine)) continue;
    const reported = reportedIpv4(peer.Endpoints ?? []);
    const endpoints = new Set(reported);
    for (const entry of config.extraIpv4) {
      if ([machine, name].includes(entry.peer.toLowerCase().replace(/\.$/, '')) && reported.has(entry.whenReported)) {
        for (const ip of entry.ips) endpoints.add(ip);
      }
    }
    peers.push({name, ipv4: [...endpoints]});
    for (const ip of endpoints) ips.add(ip);
  }
  if (peers.filter(peer => peer.ipv4.length).length > config.maxPeers) {
    throw new Error('在线设备数超过 maxPeers，请指定 peers 列表或提高 maxPeers。');
  }
  return {peers, ips: [...ips]};
}

function permissionSummary(snapshot, allocation) {
  const permitted = new Set(snapshot.ips.filter(ip => allocation?.isPermitted(ip)));
  const peers = snapshot.peers.map(({name, ipv4}) => {
    const count = ipv4.filter(ip => permitted.has(ip)).length;
    let state = 'pending';
    if (!ipv4.length) state = 'no-public-ipv4';
    else if (count === ipv4.length) state = 'permitted';
    else if (count) state = 'partial';
    return {name, candidates: ipv4.length, permitted: count, state};
  });
  return {requestedIPv4: snapshot.ips.length, activePermissions: permitted.size, peers};
}

function trackPermissionTiming() {
  let known = new Set();
  const pending = new Map();
  let lastGrant;
  return {
    observe(ips, now = Date.now()) {
      const current = new Set(ips);
      for (const ip of pending.keys()) if (!current.has(ip)) pending.delete(ip);
      for (const ip of current) if (!known.has(ip)) pending.set(ip, now);
      known = current;
    },
    sample(allocation, peers, now = Date.now()) {
      for (const [ip, observed] of pending) {
        if (!allocation?.isPermitted(ip)) continue;
        lastGrant = {
          observedAt: new Date(observed).toISOString(),
          permittedAt: new Date(now).toISOString(),
          latencyMs: Math.max(0, now - observed),
          peers: peers.filter(peer => peer.ipv4.includes(ip)).map(peer => peer.name),
        };
        pending.delete(ip);
      }
      return lastGrant;
    },
  };
}

module.exports = {findPeer, peerSnapshot, permissionSummary, reportedIpv4, trackPermissionTiming};
