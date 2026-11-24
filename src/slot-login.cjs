'use strict';

const crypto = require('node:crypto');
const uu = require('./uu.cjs');

const roles = [
  {key: 'identity', owned: 'owned', role: 'controller', label: '主控端（1/2）'},
  {key: 'hostIdentity', owned: 'hostOwned', role: 'host', label: '被控端（2/2）'},
];

async function loginPair({vault, slot, signingKey, prompt, log, api = uu}) {
  const original = vault.accounts().slots[slot - 1];
  if (original?.owned === false) throw new Error(`槽位 ${slot} 使用的是导入账号，请先执行 uurelay logout ${slot}。`);
  const verified = [];
  for (const {key} of roles) verified.push(await api.verifyLogin(original?.[key], signingKey));
  if (verified.every(Boolean)) throw new Error(`槽位 ${slot} 的主控端和被控端均已登录。`);

  const mobile = await prompt('输入 UU 手机号（隐藏输入） ', true);
  if (!/^1\d{10}$/.test(mobile)) throw new Error('请输入 11 位中国大陆手机号。');
  const mobileMasked = mobile.slice(0, 3) + '****' + mobile.slice(-4);
  if (original?.mobileMasked && original.mobileMasked !== mobileMasked) {
    throw new Error(`槽位 ${slot} 使用了另一个手机号，请先执行 uurelay logout ${slot}。`);
  }
  const attempt = crypto.randomUUID();
  const entry = {...original, paired: true, mobileMasked, attempt};
  vault.change(value => {
    if (JSON.stringify(value.slots[slot - 1]) !== JSON.stringify(original)) {
      throw new Error('准备登录期间槽位已改变，请重试。');
    }
    value.slots[slot - 1] = entry;
  });
  function save(change) {
    vault.change(value => {
      const current = value.slots[slot - 1];
      if (current?.attempt !== attempt) throw new Error('登录期间槽位已改变，请重试。');
      change(current);
    });
  }

  for (const [index, {key, owned, role, label}] of roles.entries()) {
    if (verified[index]) {
      log(`${label}已登录，继续使用已有身份。`);
      continue;
    }
    const identity = entry[key] ? {...entry[key]} : await api.registerDevice(slot, signingKey, undefined, role);
    for (const field of ['token', 'csrf', 'user_id']) delete identity[field];
    save(current => { current[key] = identity; current[owned] = true; });
    await api.sendCode(identity, signingKey, mobile);
    log(`${label}短信验证码已发送。`);
    const code = await prompt(`输入${label}验证码（隐藏输入） `, true);
    const signedIn = await api.signIn(identity, signingKey, mobile, code);
    const other = vault.accounts().slots[slot - 1]?.[roles[1 - index].key];
    if (api.haveLogin(other) && (String(other.user_id) !== String(signedIn.user_id) || other.device_id === signedIn.device_id)) {
      await api.endSession(signedIn, signingKey);
      throw new Error('UU 返回了不同的账号或重复的设备身份。');
    }
    save(current => { current[key] = signedIn; });
  }

  const complete = vault.accounts().slots[slot - 1];
  for (const {key, label} of roles) {
    if (!await api.verifyLogin(complete[key], signingKey)) throw new Error(`${label}登录已失效，请重试 uurelay login ${slot}。`);
  }
  save(current => { delete current.attempt; current.loggedInAt = new Date().toISOString(); });
  log(`槽位 ${slot} 的主控端和被控端均已登录。执行 uurelay choose ${slot} 选择此槽位。`);
}

module.exports = {loginPair};
