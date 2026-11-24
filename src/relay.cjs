'use strict';

const dgram = require('node:dgram');
const {publicIPv4} = require('./config.cjs');
const turn = require('./turn.cjs');

const permissionLifetime = 300000;

function relayStats() {
  return {received: 0, sent: 0, permissionRequests: 0, batchesAccepted: 0, permissionErrors: 0, socketErrors: 0};
}

class Allocation {
  constructor(client, config, stats) {
    this.client = client;
    this.config = config;
    this.stats = stats;
    this.endpoint = client.turn.relayedAddress.join(':');
    this.permissions = new Map();
    this.retryAfter = new Map();
    this.mappings = new Map();
    this.closed = false;
    this.scheduleRefresh(client.lifetime);
  }

  scheduleRefresh(lifetime) {
    this.expiresAt = Date.now() + lifetime * 1000;
    this.refreshAt = Date.now() + Math.min(120000, lifetime * 500);
  }

  async update(ips, force = false) {
    const desired = new Set(ips);
    const now = Date.now();
    for (const [ip, permission] of this.permissions) {
      if (desired.has(ip)) delete permission.retireAt;
      else permission.retireAt ??= now + 45000;
      if (permission.expiresAt <= now || permission.retireAt && permission.retireAt <= now) this.permissions.delete(ip);
    }
    const pending = ips.filter(ip => {
      const permission = this.permissions.get(ip);
      return force || ((!permission || permission.refreshAt <= now) && (this.retryAfter.get(ip) ?? 0) <= now);
    });
    for (let offset = 0; offset < pending.length; offset += 32) await this.applyBatch(pending.slice(offset, offset + 32));
    for (const ip of this.retryAfter.keys()) if (!desired.has(ip)) this.retryAfter.delete(ip);
    for (const [key, mapping] of this.mappings) {
      if (!this.isPermitted(mapping.ip) || now - mapping.usedAt >= 600000) this.removeMapping(key);
    }
  }

  async applyBatch(ips) {
    this.stats.permissionRequests++;
    try {
      await turn.permit(this.client.turn, ips);
      const now = Date.now();
      if (ips.length > 1) this.stats.batchesAccepted++;
      for (const ip of ips) {
        this.permissions.set(ip, {expiresAt: now + permissionLifetime, refreshAt: now + this.config.permissionRefreshSeconds * 1000});
        this.retryAfter.delete(ip);
      }
    } catch (error) {
      const code = error.response?.getAttributeValue('ERROR-CODE')?.[0];
      if (ips.length > 1 && [400, 403, 420, 508].includes(code)) {
        const middle = Math.ceil(ips.length / 2);
        await this.applyBatch(ips.slice(0, middle));
        await this.applyBatch(ips.slice(middle));
      } else {
        this.stats.permissionErrors++;
        for (const ip of ips) this.retryAfter.set(ip, Date.now() + 30000);
      }
    }
  }

  isPermitted(ip) {
    const entry = this.permissions.get(ip);
    const now = Date.now();
    return !this.closed && entry && now < entry.expiresAt && (!entry.retireAt || now < entry.retireAt);
  }

  removeMapping(key) {
    const mapping = this.mappings.get(key);
    if (!mapping) return;
    this.mappings.delete(key);
    try { mapping.socket.close(); } catch { /* Not bound yet. */ }
  }

  forward(packet, peer) {
    if (!this.isPermitted(peer[0]) || packet.length > 2048) return;
    const key = peer.join(':');
    let mapping = this.mappings.get(key);
    if (!mapping) {
      if (this.mappings.size >= this.config.maxPeers * 4) return;
      const socket = dgram.createSocket('udp4');
      mapping = {socket, ip: peer[0], usedAt: Date.now()};
      this.mappings.set(key, mapping);
      socket.on('error', () => { this.stats.socketErrors++; this.removeMapping(key); });
      socket.on('message', (response, source) => {
        if (source.address !== '127.0.0.1' || source.port !== this.config.relayPort || !this.isPermitted(peer[0])) return;
        this.client.turn.sendData(response, peer).then(() => { this.stats.sent++; }, () => { this.stats.socketErrors++; });
      });
    }
    mapping.usedAt = Date.now();
    this.stats.received++;
    mapping.socket.send(packet, this.config.relayPort, '127.0.0.1');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const key of this.mappings.keys()) this.removeMapping(key);
    await turn.close(this.client.turn);
  }
}

async function allocate(lease, config, snapshot, stats) {
  let lastError;
  let deniedPermissions = false;
  for (const candidate of turn.candidates(lease)) {
    let allocation;
    try {
      const client = await turn.open(candidate);
      allocation = new Allocation(client, config, stats);
      allocation.transport = candidate.transport;
      const [address, port] = client.turn.relayedAddress;
      if (!publicIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('TURN did not allocate a usable public IPv4 endpoint');
      }
      await allocation.update(snapshot.ips);
      if (snapshot.ips.length && !allocation.permissions.size) {
        deniedPermissions = true;
        throw new Error('TURN granted no peer permissions');
      }
      client.turn.onData.subscribe((packet, peer) => allocation.forward(packet, peer));
      return allocation;
    } catch (error) {
      lastError = error;
      await allocation?.close().catch(() => {});
    }
  }
  const error = new Error('No usable TURN allocation', {cause: lastError});
  if (deniedPermissions) error.code = 'NO_TURN_PERMISSIONS';
  throw error;
}

module.exports = {allocate, relayStats};
