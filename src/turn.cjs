'use strict';

const net = require('node:net');
const {TurnProtocol} = require('../node_modules/werift/lib/ice/src/turn/protocol.js');
const {UdpTransport, TcpTransport, TlsTransport} = require('../node_modules/werift/lib/common/src/transport.js');
const {Message} = require('../node_modules/werift/lib/ice/src/stun/message.js');
const {methods, classes} = require('../node_modules/werift/lib/ice/src/stun/const.js');

function candidates(lease) {
  if (!Array.isArray(lease?.iceServers)) throw new Error('TURN credentials lack an iceServers array');
  const endpoints = [];
  for (const server of lease.iceServers) {
    for (const input of [server.urls].flat()) {
      if (typeof input !== 'string' || !/^turns?:/i.test(input)) continue;
      const url = new URL(input.replace(/^(turns?):(?:\/\/)?/i, '$1://'));
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const transport = url.protocol === 'turns:' ? 'tls' : url.searchParams.get('transport') || 'udp';
      if (!['udp', 'tcp', 'tls'].includes(transport) || !server.username || !server.credential) continue;
      const servername = server.servername || (transport === 'tls' && net.isIP(host) ? lease.tlsServerName : undefined);
      endpoints.push({host, transport, port: Number(url.port || (transport === 'tls' ? 5349 : 3478)),
        username: server.username, credential: server.credential, servername});
    }
  }
  if (!endpoints.length) throw new Error('TURN credentials contain no supported endpoints');
  const priority = {udp: 0, tls: 1, tcp: 2};
  return endpoints.sort((a, b) => priority[a.transport] - priority[b.transport]);
}

async function open(endpoint) {
  const address = [endpoint.host, endpoint.port];
  const servername = endpoint.servername || (!net.isIP(endpoint.host) ? endpoint.host : undefined);
  const timeout = {connectTimeoutMs: 5000};
  async function connect(destination, domain) {
    if (endpoint.transport === 'udp') return UdpTransport.init('udp4');
    if (endpoint.transport === 'tcp') return TcpTransport.init(destination, timeout);
    return TlsTransport.init(destination, {rejectUnauthorized: true, servername: domain || servername}, timeout);
  }
  const transport = await connect(address);
  const turn = new TurnProtocol(address, endpoint.username, endpoint.credential, 3600, transport,
    {reconnect: endpoint.transport === 'udp' ? undefined : connect});
  let lifetime;
  turn.refresh = value => { lifetime = value; };
  turn.channelRefreshTime = 240;
  const deadline = setTimeout(() => turn.close().catch(() => {}), 12000);
  try {
    await turn.connectionMade();
    if (!Number.isInteger(lifetime) || lifetime <= 0) throw new Error('TURN did not grant a valid allocation lifetime');
    return {turn, lifetime};
  } catch (error) {
    await turn.close().catch(() => {});
    throw error;
  } finally { clearTimeout(deadline); }
}

class PermissionRequest extends Message {
  constructor(ips) {
    super(methods.CREATE_PERMISSION, classes.REQUEST);
    this.ips = ips;
  }

  get serializedAttributes() {
    // Keep every XOR-PEER-ADDRESS before MESSAGE-INTEGRITY.
    const peers = this.ips.flatMap(ip => new Message(methods.CREATE_PERMISSION, classes.REQUEST, this.transactionId)
      .setAttribute('XOR-PEER-ADDRESS', [ip, 9]).serializedAttributes);
    return peers.concat(super.serializedAttributes);
  }
}

function request(turn, message, timeout = 8000) {
  return turn.requestWithRetry(message, turn.serverEndpoint || turn.server, AbortSignal.timeout(timeout));
}

async function permit(turn, ips) {
  await request(turn, new PermissionRequest(ips));
  for (const ip of ips) turn.permissionByAddr[ip] = true;
}

async function refresh(turn) {
  const [response] = await request(turn, new Message(methods.REFRESH, classes.REQUEST).setAttribute('LIFETIME', 3600));
  const lifetime = response.getAttributeValue('LIFETIME');
  if (!Number.isInteger(lifetime) || lifetime <= 0) throw new Error('TURN allocation renewal failed');
  return lifetime;
}

async function close(turn) {
  try { await request(turn, new Message(methods.REFRESH, classes.REQUEST).setAttribute('LIFETIME', 0), 2500); }
  catch { /* The allocation will expire on the TURN server. */ }
  await turn.close();
}

module.exports = {candidates, open, PermissionRequest, permit, refresh, close};
