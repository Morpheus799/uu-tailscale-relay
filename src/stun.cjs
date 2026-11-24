'use strict';

const {publicIPv4} = require('./config.cjs');

const DEFAULT_UU_STUN = '61.174.14.99:2480';

function parseStunEndpoint(value = DEFAULT_UU_STUN) {
  const match = /^(\d+(?:\.\d+){3}):([1-9]\d{0,4})$/.exec(value);
  if (!match || !publicIPv4(match[1]) || Number(match[2]) > 65535) {
    throw new Error('请用 --stun IPv4:PORT 指定 STUN 的公网 IPv4 和 UDP 端口。');
  }
  return {host: match[1], port: Number(match[2])};
}

module.exports = {DEFAULT_UU_STUN, parseStunEndpoint};
