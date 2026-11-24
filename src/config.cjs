'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const reserved = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) reserved.addSubnet(address, prefix);

function publicIPv4(ip) {
  return net.isIPv4(ip) && !reserved.check(ip);
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function privateFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('凭据文件必须使用绝对路径。');
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('凭据文件权限应为 0600 或 0400。');
  return fs.readFileSync(filename, 'utf8');
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min} 至 ${max} 的整数。`);
  return value;
}

function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须是 JSON 对象。');
  const config = {
    relayPort: integer(raw.relayPort ?? 48472, 'relayPort', 1024, 65535),
    permissionRefreshSeconds: integer(raw.permissionRefreshSeconds ?? 180, 'permissionRefreshSeconds', 30, 240),
    credentialRefreshSeconds: integer(raw.credentialRefreshSeconds ?? 7200, 'credentialRefreshSeconds', 60, 86400),
    maxPeers: integer(raw.maxPeers ?? 64, 'maxPeers', 1, 512),
    tailscaleBinary: raw.tailscaleBinary ?? '/usr/bin/tailscale',
    tailscaleSocket: raw.tailscaleSocket ?? '/run/tailscale/tailscaled.sock',
    peers: raw.peers ?? [],
    extraIpv4: raw.extraIpv4 ?? [],
    provider: raw.provider,
  };
  for (const key of ['tailscaleBinary', 'tailscaleSocket']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`${key} 必须是绝对路径。`);
  }
  if (!Array.isArray(config.peers) || !config.peers.every(name => typeof name === 'string' && /^[a-z0-9.-]+$/i.test(name))) {
    throw new Error('peers 必须是 Tailscale 主机名或完整 DNS 名称的列表。');
  }
  if (!Array.isArray(config.extraIpv4) || !config.extraIpv4.every(entry =>
    typeof entry.peer === 'string' && publicIPv4(entry.whenReported) && Array.isArray(entry.ips) && entry.ips.every(publicIPv4))) {
    throw new Error('extraIpv4 每项都需要 peer、whenReported 和公网 IPv4 列表。');
  }
  const provider = config.provider;
  if (provider?.type === 'slot') {
    if (provider.targetName !== undefined && (typeof provider.targetName !== 'string' || !provider.targetName.trim())) {
      throw new Error('provider.targetName 必须是设备名。');
    }
    if (provider.hostSlot !== undefined) integer(provider.hostSlot, 'provider.hostSlot', 1, 10);
    if (provider.targetUnit !== undefined && !/^[a-zA-Z0-9_.-]+\.service$/.test(provider.targetUnit)) {
      throw new Error('provider.targetUnit 必须是 systemd 服务名。');
    }
    if (provider.hostSlot && (provider.targetName || provider.targetUnit)) {
      throw new Error('请在本地被控槽位和外部 UU 设备中选择一项。');
    }
  } else if (provider?.type === 'turn-file') {
    if (typeof provider.credentialFile !== 'string' || !path.isAbsolute(provider.credentialFile)) {
      throw new Error('provider.credentialFile 必须是绝对路径。');
    }
  } else {
    throw new Error('provider.type 必须是 slot 或 turn-file。');
  }
  return config;
}

module.exports = {publicIPv4, readJson, privateFile, validateConfig};
