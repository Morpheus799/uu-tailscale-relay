'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {privateFile} = require('./config.cjs');

const SLOT_COUNT = 10;
const configFile = process.env.UU_RELAY_CONFIG || '/etc/uu-tailscale-relay/config.json';
const stateDir = process.env.UU_RELAY_STATE_DIR || '/var/lib/uu-tailscale-relay';
const keyFile = process.env.UU_RELAY_VAULT_KEY_FILE || path.join(path.dirname(configFile), 'vault.key');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) throw new Error('服务配置或数据路径不是普通目录。');
  if (process.platform !== 'win32' && (stat.uid !== process.geteuid() || (stat.mode & 0o022))) {
    throw new Error('配置和数据目录须由服务用户持有，且只允许该用户写入。');
  }
}

function readProtected(filename) {
  if (process.platform !== 'win32') return privateFile(filename);
  // Source tests use temporary local files on Windows; the service is Linux-only.
  return fs.readFileSync(filename, 'utf8');
}

function atomicWrite(filename, contents, mode = 0o600) {
  const staged = `${filename}.next-${crypto.randomBytes(8).toString('hex')}`;
  try {
    const handle = fs.openSync(staged, 'wx', mode);
    try {
      fs.writeFileSync(handle, contents);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(staged, filename);
  } finally { fs.rmSync(staged, {force: true}); }
}

function slotNumber(value) {
  if (!/^(?:[1-9]|10)$/.test(String(value))) throw new Error('槽位编号必须在 1–10 之间。');
  return Number(value);
}

class Vault {
  constructor(directory = stateDir, master = keyFile) {
    this.directory = directory;
    this.keyFile = master;
  }

  init() {
    ensureDirectory(this.directory);
    ensureDirectory(path.dirname(this.keyFile));
    if (!fs.existsSync(this.keyFile)) {
      if (fs.existsSync(this.file('accounts')) || fs.existsSync(this.file('tailscale-api'))) {
        throw new Error('发现已有加密数据，请先恢复原来的 vault.key。');
      }
      try { fs.writeFileSync(this.keyFile, crypto.randomBytes(32).toString('base64') + '\n', {mode: 0o600, flag: 'wx'}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    this.key();
    if (!fs.existsSync(this.file('accounts'))) this.change(() => {});
  }

  key() {
    const key = Buffer.from(readProtected(this.keyFile).trim(), 'base64');
    if (key.length !== 32) { key.fill(0); throw new Error('加密库主密钥无效。'); }
    return key;
  }

  file(name) { return path.join(this.directory, name + '.enc'); }

  read(name) {
    const encrypted = JSON.parse(readProtected(this.file(name)));
    if (encrypted.version !== 1) throw new Error('不支持此加密库格式。');
    const key = this.key();
    try {
      const iv = Buffer.from(encrypted.iv, 'base64');
      const tag = Buffer.from(encrypted.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('加密库文件头无效。');
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {authTagLength: 16});
      cipher.setAAD(Buffer.from('uurelay-v1:' + name));
      cipher.setAuthTag(tag);
      const plaintext = Buffer.concat([cipher.update(Buffer.from(encrypted.data, 'base64')), cipher.final()]);
      try { return JSON.parse(plaintext); } finally { plaintext.fill(0); }
    } catch { throw new Error(`无法解密 ${name}，请检查 vault.key 和加密文件是否匹配。`); }
    finally { key.fill(0); }
  }

  write(name, value) {
    const key = this.key();
    const iv = crypto.randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify(value));
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {authTagLength: 16});
      cipher.setAAD(Buffer.from('uurelay-v1:' + name));
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      atomicWrite(this.file(name), JSON.stringify({version: 1, iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')}) + '\n');
    } finally { key.fill(0); plaintext.fill(0); }
  }

  accounts() {
    const value = this.read('accounts');
    if (!Array.isArray(value.slots) || value.slots.length !== SLOT_COUNT) throw new Error('账号库格式无效。');
    return value;
  }

  provisionUuClient(filename) {
    let handle;
    try {
      const {O_RDONLY, O_NOFOLLOW, O_NONBLOCK} = fs.constants;
      handle = fs.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'ELOOP') throw new Error('UU 授权文件必须是普通文件。');
      throw error;
    }

    let key;
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile()) throw new Error('UU 授权文件必须是普通文件。');
      if (process.platform !== 'win32' && (stat.uid !== process.geteuid() || ![0o400, 0o600].includes(stat.mode & 0o777))) {
        throw new Error('UU 授权文件须由服务用户持有，权限应为 0400 或 0600。');
      }
      key = fs.readFileSync(handle, 'utf8').trim();
      if (!key) throw new Error('预置的 UU 授权文件为空。');
    } finally { fs.closeSync(handle); }

    this.change(accounts => { accounts.signingKey = key; });
  }

  change(update) {
    const lockDir = fs.mkdtempSync(path.join(this.directory, '.vault-lock-'));
    const lock = path.join(this.directory, 'accounts.lock');
    const owner = path.join(lockDir, 'owner');
    let locked = false;
    try {
      fs.writeFileSync(owner, String(process.pid), {mode: 0o600});
      // Linking the pre-written inode avoids a window with an unreadable owner.
      try { fs.linkSync(owner, lock); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('另一项操作正在更新账号库，请稍后重试。');
        throw error;
      }
      locked = true;
      const accounts = fs.existsSync(this.file('accounts')) ? this.accounts() : {
        slots: Array(SLOT_COUNT).fill(null), selected: null, imported: null,
      };
      const result = update(accounts);
      this.write('accounts', accounts);
      return result;
    } finally {
      if (locked) fs.rmSync(lock, {force: true});
      fs.rmSync(owner, {force: true});
      fs.rmdirSync(lockDir);
    }
  }
}

module.exports = {Vault, configFile, stateDir, keyFile, slotNumber, SLOT_COUNT, atomicWrite};
