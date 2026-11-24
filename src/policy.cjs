'use strict';

const net = require('node:net');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {getNodeValue, parseTree} = require('jsonc-parser');
const {parseStunEndpoint} = require('./stun.cjs');

const RELAY_CAPABILITY = 'tailscale.com/cap/relay';
const API = 'https://api.tailscale.com/api/v2';
const HUJSON = 'application/hujson';
const STUN_REGION_CODE = 'uu-stun';
const STUN_REGION_NAME = 'uurelay STUN';
const STUN_HOSTNAME = 'uurelay-stun.invalid';
const MANAGEMENT_RECORD = 'tailscale-api';
const policyActions = {read: '读取', validate: '校验', validation: '校验', update: '保存'};
const execute = promisify(execFile);

function normalizeIp(ip) {
  if (typeof ip !== 'string') return undefined;
  const family = net.isIP(ip);
  if (family === 4) return ip;
  if (family !== 6 || ip.includes('%')) return undefined;
  return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
}

function selfRelayGrant(selfIp) {
  const ip = normalizeIp(selfIp);
  if (!ip) throw new Error('设置自中继授权需要有效的本机 Tailscale IP。');
  return {src: [ip], dst: [ip], app: {[RELAY_CAPABILITY]: []}};
}

async function localSelfRelayStatus({tailscaleBinary = '/usr/bin/tailscale', tailscaleSocket, execImpl = execute} = {}) {
  const socketArgs = tailscaleSocket ? [`--socket=${tailscaleSocket}`] : [];
  async function cli(args) {
    try {
      const {stdout} = await execImpl(tailscaleBinary, [...socketArgs, ...args], {timeout: 12000, maxBuffer: 8 * 1024 * 1024});
      return JSON.parse(stdout);
    } catch {
      throw new Error('无法读取本机 Tailscale 状态，请检查 tailscaled 是否运行及套接字权限。');
    }
  }

  const status = await cli(['status', '--json']);
  const ips = (status?.TailscaleIPs ?? status?.Self?.TailscaleIPs ?? []).map(normalizeIp).filter(Boolean);
  if (status?.BackendState !== 'Running' || !ips.length) throw new Error('请先让本机登录目标 tailnet，再设置自中继授权。');
  const servers = await cli(['debug', 'peer-relay-servers']);
  if (!Array.isArray(servers)) throw new Error('本机 Tailscale 未返回 Peer Relay 候选列表。');
  return {selfIp: ips.find(ip => net.isIPv4(ip)) ?? ips[0], tailnet: status.CurrentTailnet?.Name,
    enabled: servers.some(ip => ips.includes(normalizeIp(ip)))};
}

function field(object, name) {
  const key = Object.keys(object ?? {}).find(key => key.toLowerCase() === name);
  return key === undefined ? undefined : object[key];
}

function selectorMatches(selector, ip, hosts) {
  if (selector === '*') return true;
  if (typeof selector !== 'string') return false;
  const host = Object.hasOwn(hosts, selector) ? hosts[selector] : selector;
  if (typeof host !== 'string') return false;
  const [address, length, extra] = host.split('/');
  const normalized = normalizeIp(address);
  if (!normalized || extra !== undefined || net.isIP(normalized) !== net.isIP(ip)) return false;
  if (length === undefined) return normalized === ip;
  const bits = net.isIP(ip) === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(length) || Number(length) > bits) return false;
  const type = bits === 32 ? 'ipv4' : 'ipv6';
  const subnet = new net.BlockList();
  subnet.addSubnet(normalized, Number(length), type);
  return subnet.check(ip, type);
}

function includesSelf(selectors, ip, hosts) {
  return Array.isArray(selectors) && selectors.some(selector => selectorMatches(selector, ip, hosts));
}

function grantPresent(policy, selfIp) {
  const [ip] = selfRelayGrant(selfIp).src;
  const grants = field(policy, 'grants');
  const hosts = field(policy, 'hosts') ?? {};
  if (!Array.isArray(grants)) return false;

  // Leave any existing condition, such as a source posture, in effect. This
  // checks for an applicable configured grant, rather than evaluating policy.
  return grants.some(rule => Array.isArray(field(rule, 'app')?.[RELAY_CAPABILITY]) &&
    includesSelf(field(rule, 'src'), ip, hosts) && includesSelf(field(rule, 'dst'), ip, hosts));
}

function parsePolicy(source) {
  const errors = [];
  const tree = parseTree(source, errors, {allowTrailingComma: true});
  if (errors.length || tree?.type !== 'object') {
    throw new Error('Tailscale 返回的策略格式无效，已停止修改。');
  }
  const properties = tree.children ?? [];
  const grants = properties.filter(property => property.children[0].value.toLowerCase() === 'grants');
  if (grants.length > 1 || (grants.length === 1 && grants[0].children[1].type !== 'array')) {
    throw new Error('Tailscale 策略只能有一个 grants 数组，已停止修改。');
  }
  return {tree, grants: grants[0]?.children[1], policy: getNodeValue(tree)};
}

function insertMember(source, scope, member) {
  const indentation = source.slice(source.lastIndexOf('\n', scope.offset - 1) + 1, scope.offset).match(/^[\t ]*/)[0];
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const offset = scope.offset + 1;
  const comma = scope.children?.length ? ',' : '';
  // Inserting a single member keeps the policy's comments, trailing commas,
  // and original bytes intact outside this insertion.
  return source.slice(0, offset) + newline + indentation + '  ' + member + comma + newline + source.slice(offset);
}

function preparePolicy(source, selfIp) {
  const parsed = parsePolicy(source);
  const grant = selfRelayGrant(selfIp);
  if (grantPresent(parsed.policy, selfIp)) return {changed: false, source, grant};

  const selected = parsed.grants ?? parsed.tree;
  const member = parsed.grants ? JSON.stringify(grant) : `"grants": [${JSON.stringify(grant)}]`;
  return {changed: true, source: insertMember(source, selected, member), grant};
}

function objectChild(parent, name) {
  const entries = (parent?.children ?? []).filter(entry => entry.children[0].value.toLowerCase() === name.toLowerCase());
  if (entries.length > 1 || (entries.length && entries[0].children[1].type !== 'object')) {
    throw new Error(`Tailscale 策略只能有一个 ${name} 对象，已停止修改。`);
  }
  return entries[0]?.children[1];
}

function stunNode(regionID, {host, port}) {
  return {Name: `${regionID}uu`, RegionID: regionID, HostName: STUN_HOSTNAME,
    IPv4: host, IPv6: 'none', STUNPort: port, STUNOnly: true};
}

function prepareStunPolicy(source, endpoint) {
  const target = parseStunEndpoint(endpoint);
  const {tree} = parsePolicy(source);
  const derpMap = objectChild(tree, 'derpMap');
  const regions = objectChild(derpMap, 'Regions');
  const entries = regions?.children ?? [];
  const managed = entries.filter(entry => field(getNodeValue(entry.children[1]), 'regioncode') === STUN_REGION_CODE);
  if (managed.length > 1) throw new Error('策略中有多个 uu-stun 区域，已停止修改。');
  const entry = managed[0];
  const used = new Set(entries.map(e => Number(e.children[0].value)));
  let regionID = entry ? Number(entry.children[0].value) : 900;
  if (!entry) while (used.has(regionID)) regionID++;
  if (!Number.isInteger(regionID) || regionID < 900 || regionID > 999) {
    throw new Error('900–999 范围内没有可用的 UU STUN 区域编号，已停止修改。');
  }

  const node = stunNode(regionID, target);
  const region = {RegionID: regionID, RegionCode: STUN_REGION_CODE, RegionName: STUN_REGION_NAME, Nodes: [node]};
  if (entry) {
    const valueNode = entry.children[1];
    const old = getNodeValue(valueNode);
    const saved = old.Nodes?.[0];
    if (old.RegionID !== regionID || old.RegionName !== STUN_REGION_NAME || !Array.isArray(old.Nodes) ||
        old.Nodes.length !== 1 || saved?.Name !== node.Name || saved.RegionID !== regionID ||
        saved.HostName !== STUN_HOSTNAME || saved.STUNOnly !== true || saved.IPv6 !== 'none') {
      throw new Error('uu-stun 区域已被其他配置占用，已停止修改。');
    }
    if (saved.IPv4 === target.host && saved.STUNPort === target.port) {
      return {changed: false, source, regionID, target};
    }
    return {changed: true, source: source.slice(0, valueNode.offset) +
      JSON.stringify({...old, Nodes: [{...saved, IPv4: target.host, STUNPort: target.port}]}) +
      source.slice(valueNode.offset + valueNode.length), regionID, target};
  }

  const member = `"${regionID}": ${JSON.stringify(region)}`;
  const addition = regions ? member : derpMap ? `"Regions": {${member}}` : `"derpMap": {"Regions": {${member}}}`;
  return {changed: true, source: insertMember(source, regions ?? derpMap ?? tree, addition), regionID, target};
}

function authorization(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token) ||
      token.startsWith('tskey-auth-') || token.startsWith('tskey-client-')) {
    throw new Error('需要 Tailscale API 访问令牌或短期 OAuth 访问令牌。');
  }
  return token.startsWith('tskey-api-') ? `Basic ${Buffer.from(`${token}:`).toString('base64')}` : `Bearer ${token}`;
}

function readManagementCredential(vault) {
  try {
    const record = vault.read(MANAGEMENT_RECORD);
    if (typeof record?.tailnet !== 'string' || !record.credential) {
      throw new Error('保存的 Tailscale OAuth 凭据无效，请运行 sudo uurelay init 更换。');
    }
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function saveManagementCredential(vault, tailnet, credential) {
  vault.write(MANAGEMENT_RECORD, {tailnet, credential});
}

async function policyAccessToken(credential, fetchImpl = globalThis.fetch) {
  const {clientId, clientSecret} = credential ?? {};
  if (typeof clientSecret !== 'string' || !/^tskey-client-[\x21-\x7e]+$/.test(clientSecret) ||
      typeof clientId !== 'string' || !/^[\x21-\x7e]+$/.test(clientId)) {
    throw new Error('请提供有效的 Tailscale OAuth Client ID 和 Client Secret。');
  }
  const body = new URLSearchParams({grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret});
  let response;
  try {
    response = await fetchImpl(API + '/oauth/token', {method: 'POST', body, redirect: 'error',
      headers: {'content-type': 'application/x-www-form-urlencoded'}, signal: AbortSignal.timeout(15000)});
  } catch {
    throw new Error('无法连接 Tailscale OAuth 令牌接口。');
  }
  if (!response.ok) throw new Error(`Tailscale OAuth 换取令牌失败（HTTP ${response.status}）。`);
  let issued;
  try { issued = await response.json(); }
  catch { throw new Error('无法解析 Tailscale 返回的 OAuth 令牌。'); }
  if (typeof issued?.scope === 'string' && !issued.scope.split(/\s+/).some(scope => ['policy_file', 'acl'].includes(scope))) {
    throw new Error('Tailscale OAuth 凭据缺少 Policy File 写权限。');
  }
  authorization(issued?.access_token);
  return issued.access_token;
}

function policyUrl(tailnet) {
  if (typeof tailnet !== 'string' || !/^(?:-|[\da-z][\da-z.@_+-]*)$/i.test(tailnet)) {
    throw new Error('Tailscale tailnet 名称无效。');
  }
  return `${API}/tailnet/${encodeURIComponent(tailnet)}/acl`;
}

async function request(fetchImpl, url, headers, method, body, operation) {
  try {
    // Refuse redirects so the credential is only sent to the API origin.
    return await fetchImpl(url, {method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15000)});
  } catch {
    // Do not copy request details or remote response text to an exception.
    throw new Error(`无法${policyActions[operation]} Tailscale 策略，请检查能否访问 api.tailscale.com。`);
  }
}

function requireSuccess(response, operation) {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Tailscale 拒绝${policyActions[operation]}策略，请检查授权范围和 tailnet。`);
  }
  throw new Error(`${policyActions[operation]} Tailscale 策略失败（HTTP ${response.status}）。`);
}

async function readText(response, operation) {
  try { return await response.text(); }
  catch { throw new Error(`无法读取 Tailscale 策略${policyActions[operation]}响应。`); }
}

function strongEtag(response) {
  const etag = response.headers.get('etag');
  if (!etag || !/^(?:"[\x21\x23-\x7e]+"|[\da-z_-]+)$/i.test(etag)) {
    throw new Error('Tailscale 未提供有效的策略版本，已停止修改。');
  }
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

async function verifyPolicyAccess({token, tailnet, fetchImpl = globalThis.fetch}) {
  const response = await request(fetchImpl, policyUrl(tailnet), {accept: HUJSON, authorization: authorization(token)},
    'GET', undefined, 'read');
  requireSuccess(response, 'read');
  await response.body?.cancel().catch(() => {});
}

async function configurePolicy({token, tailnet = '-', fetchImpl = globalThis.fetch}, prepare) {
  const url = policyUrl(tailnet);
  const readHeaders = {accept: HUJSON, authorization: authorization(token)};
  const writeHeaders = {...readHeaders, 'content-type': HUJSON};

  // A concurrent editor gets priority. Start again from the newest file, never
  // repost a stale revision or use an unconditional write.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(fetchImpl, url, readHeaders, 'GET', undefined, 'read');
    requireSuccess(response, 'read');
    const {source, ...update} = prepare(await readText(response, 'read'));
    if (!update.changed) return update;
    const revision = strongEtag(response);

    const validation = await request(fetchImpl, `${url}/validate`, writeHeaders, 'POST', source, 'validate');
    requireSuccess(validation, 'validate');
    const body = (await readText(validation, 'validation')).trim();
    if (body) {
      let result;
      try { result = JSON.parse(body); } catch { throw new Error('无法解析 Tailscale 策略校验结果。'); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.message ||
          result.errors?.length || result.data?.some?.(entry => entry?.errors?.length)) {
        throw new Error('Tailscale 策略未通过校验，已停止修改。');
      }
    }

    const updateResponse = await request(fetchImpl, url, {...writeHeaders, 'if-match': revision}, 'POST', source, 'update');
    if (updateResponse.status === 412 || updateResponse.status === 409) {
      await updateResponse.body?.cancel().catch(() => {});
      continue;
    }
    requireSuccess(updateResponse, 'update');
    await updateResponse.body?.cancel().catch(() => {});
    return update;
  }
  throw new Error('Tailscale 策略正在被其他操作更新，请稍后重试。');
}

function configureSelfRelay({selfIp, ...options}) {
  selfRelayGrant(selfIp);
  return configurePolicy(options, source => preparePolicy(source, selfIp));
}

function configureStun({endpoint, ...options}) {
  parseStunEndpoint(endpoint);
  return configurePolicy(options, source => prepareStunPolicy(source, endpoint));
}

module.exports = {configureSelfRelay, configureStun, grantPresent, localSelfRelayStatus, policyAccessToken,
  preparePolicy, prepareStunPolicy, readManagementCredential, saveManagementCredential, selfRelayGrant, verifyPolicyAccess};
