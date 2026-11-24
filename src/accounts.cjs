'use strict';

const crypto = require('node:crypto');
const {apiBase, haveLogin} = require('./uu.cjs');
const {resolveSigningKey} = require('./signing.cjs');

function assertUuLinuxBackend(identity) {
  const base = identity?.base_url;
  if (base == null || (typeof base === 'string' && !base.trim())) return;
  const normalized = typeof base === 'string' ? base.trim().replace(/\/+$/, '') : '';
  if (!URL.canParse(normalized) || new URL(normalized).href !== apiBase + '/') {
    throw new Error('此 UU Linux 登录使用了不支持的 API 后端。请用网易默认后端登录后再导入。');
  }
}

function resolveProvider(provider, vault, accounts) {
  if (provider.type !== 'slot') return {provider, selection: null, fingerprint: JSON.stringify(provider)};
  const value = accounts || vault.accounts();
  const selection = value.selected;
  const slot = selection === 'uulinux' ? value.imported : (selection ? value.slots[selection - 1] : null);
  if (selection === 'uulinux') assertUuLinuxBackend(slot?.identity);
  const paired = selection !== 'uulinux' && (slot?.paired === true || Object.hasOwn(slot ?? {}, 'hostIdentity'));
  if (paired && (!haveLogin(slot.identity) || !haveLogin(slot.hostIdentity))) {
    throw new Error(`槽位 ${selection} 的配对登录尚未完成，请运行 uurelay login ${selection}。`);
  }
  if (!haveLogin(slot?.identity)) throw new Error('请用 uurelay choose 选择已登录的账号。');
  const signingKey = resolveSigningKey(value);
  const controller = {identity: slot.identity, signingKey};
  let hostIdentity;
  if (paired) {
    hostIdentity = slot.hostIdentity;
    if (String(hostIdentity.user_id) !== String(controller.identity.user_id)) {
      throw new Error(`槽位 ${selection} 的主控端和被控端必须属于同一账号。`);
    }
  } else if (provider.hostSlot) {
    hostIdentity = value.slots[provider.hostSlot - 1]?.identity;
    if (!haveLogin(hostIdentity)) throw new Error('设为被控端的槽位尚未登录。');
  }
  if (hostIdentity && String(hostIdentity.device_id) === String(controller.identity.device_id)) {
    throw new Error('主控端和被控端必须使用不同的 UU 设备身份。');
  }
  const host = hostIdentity ? {identity: hostIdentity, signingKey} : undefined;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([provider, selection,
    controller.signingKey, controller.identity.device_id, controller.identity.token, host?.identity.device_id, host?.identity.token])).digest('hex');
  const resolved = host ? {type: 'uu', controller, host} :
    {type: 'uu', controller, targetName: provider.targetName, targetUnit: provider.targetUnit};
  return {provider: resolved, selection, fingerprint};
}

module.exports = {assertUuLinuxBackend, resolveProvider};
