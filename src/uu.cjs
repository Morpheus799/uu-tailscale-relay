'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout: sleep} = require('node:timers/promises');
const WebSocket = require('ws');
const {privateFile} = require('./config.cjs');

const execute = promisify(execFile);
const apiBase = 'https://api.nrd.nie.163.com';
const version = '4.45.0.4318';

class UuApiError extends Error {
  constructor(status, code) {
    super(`UU API rejected the request (HTTP ${status}, code ${Number.isSafeInteger(code) ? code : 'unknown'})`);
    this.status = status;
    this.code = code;
  }
}

async function api(controller, method, route, value, fetchImpl = fetch) {
  const {identity, signingKey} = controller;
  const body = value === undefined ? '' : JSON.stringify(value);
  const fields = {
    'x-param-plat': '1', 'x-param-vn': identity.client_version || version,
    'x-param-vc': String(identity.version_code || '4318'),
    'x-param-pkgn': 'com.netease.gameviewer', 'x-param-chn': 'gwqd',
    'x-param-lang': 'zh-CN', 'x-param-cnt': 'CN', 'x-param-ts': String(Math.floor(Date.now() / 1000)),
  };
  for (const key of ['device_id', 'client_id', 'system_id', 'user_id']) {
    if (identity[key]) fields['x-param-' + key.replaceAll('_', '-')] = identity[key];
  }
  const sorted = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
  const signature = crypto.createHmac('sha256', signingKey).update(method + route + sorted + body).digest('hex');
  const headers = {...fields, 'x-param-sign': signature, 'Content-Type': 'application/json',
    Accept: 'application/json', 'User-Agent': 'UURemote/4.45.0'};
  if (identity.token) {
    headers.Authorization = 'Bearer ' + identity.token;
    if (identity.csrf) {
      headers['X-CSRF-TOKEN'] = identity.csrf;
      headers.Cookie = `nrd_access_token=${identity.token}; nrd_csrf_access_token=${identity.csrf}`;
    }
  }
  const response = await fetchImpl(apiBase + route, {
    method, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(12000),
    headers,
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('UU API 返回的数据格式无效。'); }
  if (!response.ok || result.code !== 0) {
    throw new UuApiError(response.status, Number(result.code));
  }
  return result.data;
}

function varint(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function integer(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function string(field, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}

function signalUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'wss:') throw new Error('UU signaling must use TLS');
  url.pathname = url.pathname.replace(/\/$/, '') + '/socket.io/';
  url.search = '?transport=websocket&EIO=4';
  return url;
}

function exchange(endpoint, token, target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalUrl(endpoint), {headers: {'X-NRD-AUTH': token}, handshakeTimeout: 8000, maxPayload: 1024 * 1024});
    const timer = setTimeout(() => finish(new Error('UU signaling timed out')), 14000);
    let done = false;
    let binaryAck;
    const attachments = [];

    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        setTimeout(() => ws.terminate(), 500).unref();
      } else ws.terminate();
      if (error) reject(error);
      else resolve(value);
    }

    function accept(frame) {
      const [result, payload] = frame;
      if (result !== 'success' || payload?.code || !payload?.iceServers?.length) {
        finish(new Error('UU signaling returned no TURN credentials'));
        return;
      }
      finish(undefined, {issuedAt: new Date().toISOString(), iceServers: payload.iceServers});
    }

    function fill(value) {
      if (!value || typeof value !== 'object') return value;
      if (value._placeholder === true) return attachments[value.num];
      if (Array.isArray(value)) return value.map(fill);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]));
    }

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          if (!binaryAck) return;
          attachments.push(Buffer.from(data).toString('base64'));
          if (attachments.length === binaryAck.count) accept(fill(binaryAck.value));
          return;
        }
        const message = data.toString();
        if (message.startsWith('2')) { ws.send('3' + message.slice(1)); return; }
        if (message.startsWith('0')) { ws.send('40'); return; }
        if (message.startsWith('40')) {
          const id = crypto.randomUUID();
          const header = {app_control_id: id, app_data: {_placeholder: true, num: 0}, streamer_data: JSON.stringify({
            control_id: id, device_capability: {display_info: [], ice_id: '', video_codec_capability: []},
          })};
          ws.send('451-11' + JSON.stringify(['control', header]));
          ws.send(Buffer.concat([integer(1, 9), integer(8, 3), string(9, target), integer(10, 1), string(12, version)]));
          return;
        }
        if (message.startsWith('4311[')) accept(JSON.parse(message.slice(4)));
        const binary = message.match(/^46([1-8])-11(\[.*)$/s);
        if (binary) binaryAck = {count: Number(binary[1]), value: JSON.parse(binary[2])};
      } catch { finish(new Error('Invalid UU signaling message')); }
    });
    ws.on('error', () => finish(new Error('UU signaling connection failed')));
    ws.on('close', () => finish(new Error('UU signaling closed without TURN credentials')));
  });
}

async function issue(config) {
  const {controller} = config;
  let device = config.targetDeviceId;
  if (!device) {
    const devices = await api(controller, 'GET', '/api/v1/device/list');
    const owned = devices.my_binded_devices || [];
    const matches = config.targetName
      ? [...owned, ...(devices.others_shared_devices || [])].filter(entry => Object.values(entry).includes(config.targetName))
      : owned.filter(entry => entry.status === 'CONNECTED' && entry.device_id !== controller.identity.device_id);
    if (matches.length !== 1 || !matches[0].device_id) {
      throw new Error('Cannot identify one UU target; set a target device name or a separate native host slot with uurelay init');
    }
    device = matches[0].device_id;
  }
  if (device === controller.identity.device_id) throw new Error('UU host and controller must have separate device IDs');
  const room = await api(controller, 'POST', '/api/v1/room/join/by_device/' + encodeURIComponent(device), {force_join: false});
  for (const endpoint of (room.signaling_list || []).slice(0, 3)) {
    try { return {...await exchange(endpoint, room.token, device), tlsServerName: 'relay.nrd.nie.163.com'}; }
    catch { /* Try the next signaling endpoint from the authenticated API. */ }
  }
  throw new Error('No UU signaling endpoint issued TURN credentials');
}

function openNativeRoom(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalUrl(room.signaling_server), {headers: {'X-NRD-AUTH': room.token},
      handshakeTimeout: 8000, maxPayload: 1024 * 1024});
    let ready = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('UU target room registration timed out')); }, 12000);
    const close = () => { clearTimeout(timer); ws.terminate(); };
    ws.on('error', () => { if (!ready) { close(); reject(new Error('UU target signaling failed')); } });
    ws.on('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('UU target room closed')); } });
    ws.on('message', (data, binary) => {
      if (binary || ws.readyState !== WebSocket.OPEN) return;
      const message = data.toString();
      if (message.startsWith('0')) ws.send('40');
      else if (message.startsWith('2')) ws.send('3' + message.slice(1));
      else if (message.startsWith('40')) ws.send('421["room_info"]');
      else if (message.startsWith('431') && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve(close);
      }
    });
  });
}

async function credentials(config) {
  if (config.type === 'turn-file') {
    const lease = JSON.parse(privateFile(config.credentialFile));
    return {...lease, issuedAt: new Date().toISOString()};
  }
  if (config.host) {
    if (config.host.identity.device_id === config.controller.identity.device_id) {
      throw new Error('UU host and controller must have separate device IDs');
    }
    const room = await api(config.host, 'POST', '/api/v1/room/create', {});
    if (!room?.signaling_server || !room.token) throw new Error('UU did not return a host room');
    const close = await openNativeRoom(room);
    try {
      await sleep(1200);
      return await issue({...config, targetDeviceId: config.host.identity.device_id});
    } finally { close(); }
  }
  if (!config.targetUnit) return issue(config);
  const options = {timeout: 20000};
  const state = await execute('/usr/bin/systemctl', ['show', config.targetUnit, '--property=ActiveState', '--value'], options);
  const alreadyRunning = ['active', 'activating', 'reloading'].includes(state.stdout.trim());
  if (!alreadyRunning) await execute('/usr/bin/systemctl', ['start', config.targetUnit], options);
  try {
    let lastError;
    for (const delay of [1200, 2500, 5000]) {
      await sleep(delay);
      try { return await issue(config); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  } finally {
    if (!alreadyRunning) await execute('/usr/bin/systemctl', ['stop', config.targetUnit], options);
  }
}

function haveLogin(identity) {
  return Boolean(identity?.token && identity.device_id && identity.user_id && identity.csrf);
}

function isExpired(error) {
  return error instanceof UuApiError && (error.status === 401 || error.code === 1120);
}

async function verifyLogin(identity, signingKey, fetchImpl) {
  if (!haveLogin(identity)) return false;
  try {
    await api({identity, signingKey}, 'GET', '/api/v1/user/info', undefined, fetchImpl);
    return true;
  } catch (error) {
    if (isExpired(error)) return false;
    throw error;
  }
}

async function registerDevice(slot, signingKey, fetchImpl, role = 'controller') {
  if (!/^(?:[1-9]|10)$/.test(String(slot))) throw new Error('UU 账号槽位无效。');
  if (role !== 'controller' && role !== 'host') throw new Error('UU 设备角色无效。');
  const hostname = os.hostname().toLowerCase();
  const label = hostname.replace(/[^a-z0-9]+/g, '-').slice(0, 12).replace(/^-|-$/g, '') || 'linux';
  const suffix = crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 6);
  const name = `uurelay-${label}-${suffix}-${slot}-${role === 'controller' ? 1 : 2}`;
  const identity = {name, client_id: crypto.randomUUID(), system_id: crypto.randomUUID().toUpperCase(), machine_guid: crypto.randomUUID()};
  const response = await api({identity, signingKey}, 'POST', '/api/v1/device/windows/init', {
    ...identity, os: process.platform === 'linux' ? 'Linux' : process.platform, base_board: 'uurelay', cpu: process.arch,
    video: [], mac: '', memory: Math.round(os.totalmem() / 1048576), screen: '1920x1080',
  }, fetchImpl);
  if (!response?.device_id) throw new Error('UU 未能注册设备。');
  return {...identity, device_id: response.device_id};
}

function sendCode(identity, signingKey, mobile, fetchImpl) {
  if (!/^1\d{10}$/.test(mobile)) throw new Error('请输入 11 位中国大陆手机号。');
  return api({identity, signingKey}, 'POST', '/api/v1/security/mobile/code', {country_code: '86', mobile, type: 'login'}, fetchImpl);
}

async function signIn(identity, signingKey, mobile, code, fetchImpl) {
  if (!/^1\d{10}$/.test(mobile) || !/^\d{4,8}$/.test(code)) throw new Error('手机号或验证码格式无效。');
  const value = await api({identity, signingKey}, 'POST', '/api/v1/login/by_mobile', {country_code: '86', mobile, code}, fetchImpl);
  let csrf = value?.csrf;
  if (!csrf && typeof value?.token === 'string') {
    try { csrf = JSON.parse(Buffer.from(value.token.split('.')[1], 'base64url').toString()).csrf; }
    catch { /* A malformed token is rejected below. */ }
  }
  const next = {...identity, token: value?.token, user_id: value?.user_id, csrf};
  if (!haveLogin(next)) throw new Error('UU 返回的登录凭据不完整。');
  return next;
}

function identityId(value) {
  if (typeof value === 'string' && value && value === value.trim() && value !== '.' && value !== '..') return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

async function requestUnbind(identity, targetDeviceId, signingKey, fetchImpl) {
  try {
    await api({identity, signingKey}, 'POST', '/api/v1/device/' + encodeURIComponent(targetDeviceId) + '/unbind', undefined, fetchImpl);
    return true;
  } catch (error) {
    return error instanceof UuApiError && error.code === 5003;
  }
}

async function unbindDevice(controllerIdentity, targetIdentity, signingKey, fetchImpl) {
  const controllerDeviceId = identityId(controllerIdentity?.device_id);
  const targetDeviceId = identityId(targetIdentity?.device_id);
  if (!haveLogin(controllerIdentity) || !controllerDeviceId || !targetDeviceId) throw new Error('UU 设备身份不完整。');
  const controllerUserId = identityId(controllerIdentity.user_id);
  if (!controllerUserId || controllerUserId !== identityId(targetIdentity.user_id)) throw new Error('两台 UU 设备必须属于同一账号。');
  if (controllerDeviceId === targetDeviceId) throw new Error('解绑 UU 设备需要使用另一台主控端。');
  return requestUnbind(controllerIdentity, targetDeviceId, signingKey, fetchImpl);
}

async function endSession(identity, signingKey, fetchImpl) {
  if (!haveLogin(identity)) return false;
  try {
    await api({identity, signingKey}, 'POST', '/api/v1/user/logout', undefined, fetchImpl);
    return true;
  } catch (error) {
    return isExpired(error);
  }
}

async function signOut(identity, signingKey, fetchImpl) {
  if (!haveLogin(identity)) return {unbound: false, sessionEnded: false};
  const targetDeviceId = identityId(identity.device_id);
  const unbound = targetDeviceId ? await requestUnbind(identity, targetDeviceId, signingKey, fetchImpl) : false;
  const sessionEnded = await endSession(identity, signingKey, fetchImpl);
  return {unbound, sessionEnded};
}

module.exports = {apiBase, credentials, haveLogin, verifyLogin, registerDevice, sendCode, signIn, unbindDevice, endSession, signOut};
