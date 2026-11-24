'use strict';

const serviceStates = {active: '运行中', inactive: '已停止', failed: '故障', activating: '启动中',
  deactivating: '停止中', reloading: '重载中', unavailable: '无法读取'};
const loginStates = {valid: '已登录', invalid: '登录已失效', unavailable: '暂时无法验证',
  empty: '空槽位', 'not-logged-in': '未登录', 'logged-in': '已登录',
  'invalid-or-expired': '登录已失效', 'verification-unavailable': '暂时无法验证'};
const peerStates = {permitted: '已许可', partial: '部分许可', pending: '待许可', 'no-public-ipv4': '无公网 IPv4'};
const probeStages = {prerequisites: '配置或 Tailscale 检查未通过', login: 'UU 登录校验未通过',
  credentials: '无法获取 UU TURN 凭据', allocation: 'TURN 分配失败', permissions: 'IPv4 许可不完整'};
const pathNames = {uu: 'UU 中转', direct: '直连', derp: 'DERP', 'other-peer-relay': '其他 Peer Relay', unknown: '未知路径'};

function slotName(slot) {
  return slot === 'uulinux' ? 'UU Linux' : slot ?? '无';
}

function dateTime(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', {hour12: false});
}

function quickLines(report) {
  const {service, relay} = report;
  const lines = [
    `中转服务  ${serviceStates[service] ?? '未知状态'}`,
    `账号槽位  已选 ${slotName(report.selectedSlot)}，运行 ${slotName(report.runningSlot)}`,
  ];
  if (relay?.ready && relay.endpoint) {
    lines.push(`UU 入口  ${relay.endpoint}${relay.transport ? `（${relay.transport.toUpperCase()}）` : ''}`);
  } else if (service === 'active') lines.push('UU 入口  尚未就绪');
  if (Number.isInteger(relay?.requestedIPv4)) {
    lines.push(`公网 IPv4 许可  ${relay.activePermissions ?? 0}/${relay.requestedIPv4}`);
  }
  if (relay?.lastRefreshAt) {
    lines.push(`最近刷新  ${dateTime(relay.lastRefreshAt)}，${relay.refreshError ? '失败' : '成功'}`);
  }
  if (relay?.stats) lines.push(`转发包数  收 ${relay.stats.received ?? 0}，发 ${relay.stats.sent ?? 0}`);
  return lines;
}

function formatQuick(report) {
  return quickLines(report).join('\n');
}

function formatDoctor(report) {
  const lines = quickLines(report);
  lines.push(report.account.state === 'configured' ? 'UU 账号配置  已找到' : `UU 账号配置  ${report.account.hint}`);
  lines.push(report.tailscale.state === 'ready' ? 'Tailscale  检查通过' : `Tailscale  ${report.tailscale.hint}`);
  for (const [role, state] of Object.entries(report.account.logins ?? {})) {
    lines.push(`${role === 'host' ? '被控端' : '主控端'}  ${loginStates[state]}`);
  }
  for (const peer of report.relay.peers ?? []) {
    const coverage = Number.isInteger(peer.permitted) ? `（${peer.permitted}/${peer.candidates}）` : '';
    lines.push(`${peer.name}  ${peerStates[peer.state] ?? '已发现'}${coverage}`);
  }
  const timing = report.relay.timing;
  if (Number.isFinite(timing?.lastPermission?.latencyMs)) lines.push(`最近 IP 许可耗时  ${timing.lastPermission.latencyMs} ms`);
  if (Number.isFinite(timing?.lastRecoveryMs)) lines.push(`最近中转恢复耗时  ${timing.lastRecoveryMs} ms`);
  if (report.probe) {
    const {ok, stage, durationMs} = report.probe;
    const duration = Number.isFinite(durationMs) ? `，耗时 ${durationMs} ms` : '';
    lines.push(`主动探测  ${ok ? '通过' : (probeStages[stage] ?? '失败')}${duration}`);
    if (Number.isInteger(report.probe.requestedIPv4)) {
      lines.push(`探测 IPv4 许可  ${report.probe.activePermissions ?? 0}/${report.probe.requestedIPv4}`);
    }
  }
  if (report.clientCheck) lines.push(`在客户端核对选路  ${report.clientCheck.command.join(' ')}`);
  return lines.join('\n');
}

function formatDoctorIp(report) {
  return [
    `设备  ${report.target}`,
    `Tailscale 上报的公网 IPv4  ${report.reportedIPv4.join('、') || '暂无'}`,
    `在目标设备执行  ${report.probeOnTarget}`,
    report.next,
  ].join('\n');
}

function formatDoctorRoute(report) {
  const paths = new Map();
  for (const sample of report.samples) paths.set(sample.path, (paths.get(sample.path) ?? 0) + 1);
  const lines = [
    `目标  ${report.target}`,
    `预期 UU 入口  ${report.expectedPeerRelayEndpoint}`,
    `结果  ${report.ok ? '已走 UU 中转' : report.state === 'unavailable' ? '无法探测' : '未观察到 UU 中转'}`,
  ];
  if (paths.size) lines.push(`实测路径  ${[...paths].map(([type, count]) => `${pathNames[type] ?? '未知路径'} ${count} 次`).join('、')}`);
  if (Number.isFinite(report.firstUuObservedMs)) lines.push(`首次观察到 UU  ${report.firstUuObservedMs} ms`);
  return lines.join('\n');
}

function formatSlot(report) {
  if (report.state === 'empty') return `槽位 ${report.slot}  空`;
  const lines = [`槽位 ${report.slot}${report.selected ? '（已选）' : ''}`];
  if (report.account) lines.push(`手机号  ${report.account}`);
  lines.push(`主控端  ${loginStates[report.state]}`);
  if (report.hostState) lines.push(`被控端  ${loginStates[report.hostState]}`);
  return lines.join('\n');
}

function formatStun(report) {
  const status = report.changed ? '已配置' : '已存在';
  return `UU STUN ${status}  ${report.stun}（区域 ${report.regionID}）`;
}

function errorMessage(error) {
  if (Number.isInteger(error?.status) && typeof error.code === 'number') {
    return `UU 拒绝了请求（HTTP ${error.status}，错误码 ${Number.isFinite(error.code) ? error.code : '未知'}）`;
  }
  if (error instanceof SyntaxError) return '无法解析配置文件或服务响应，请检查格式。';
  if (error?.code === 'ENOENT' && /(?:accounts\.enc|vault\.key)$/.test(error.path ?? '')) {
    return '找不到账号库或主密钥，请先运行 sudo uurelay init。';
  }
  if (error?.message === 'fetch failed') return '无法连接远端服务，请检查网络后重试。';
  const detail = String(error?.message ?? error).replace(/(?:https?|wss?):[^\s]+/gi, '[地址]');
  return /\p{Script=Han}/u.test(detail) ? detail : `操作失败（${error?.code ?? detail}）`;
}

module.exports = {errorMessage, formatDoctor, formatDoctorIp, formatDoctorRoute, formatQuick, formatSlot, formatStun};
