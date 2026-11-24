# UU Tailscale Relay

Linux 上的 UU TURN → Tailscale Peer Relay 转接服务。在 Linux 平台上安装配置之后可以使全部内网设备通过 UU 转接连接该 Linux。

```text
Tailscale 客户端 ──原生 UDP──> UU TURN ──> Linux 转接 ──> tailscaled Peer Relay
```

## 安装

Debian 或 Ubuntu 需要 systemd、系统路径中的 Node.js 22+，以及已经登录的 Tailscale 1.104+。

```sh
sudo apt install ./uu-tailscale-relay_....._all.deb
sudo uurelay init
```

也可使用 npm 模块形式安装。全局安装到系统路径后，`uurelay init` 会安装 systemd 单元。

```sh
sudo npm install -g ./uu-tailscale-relay-1.0.0.tgz
sudo uurelay init
```

## 用自己的 UU 帐号

```sh
sudo uurelay login 1
sudo uurelay slot 1
sudo uurelay choose 1
sudo uurelay start
sudo uurelay doctor --quick
```

槽位为 1–10。每个新槽位同时保存同一 UU 帐号的**主控和被控两个设备身份**。`login` 只需输入一次中国大陆手机号，然后按提示依次输入主控和被控的两条短信验证码。被控登录中断后，可重新运行同一个 `login` 命令。主控仍有效时会继续复用。

`slot` 分别检查两套登录状态，网络错误会显示为暂时无法验证。`choose` 选择下次启动或刷新使用的槽位。服务已运行时，执行 `sudo uurelay refresh`。服务拿到新分配后才更换正在使用的帐号和入口。使用配对槽位时，服务自行短暂创建被控房间并申请 TURN 凭据。

已有 UU Linux 时可用 `sudo uurelay choose uulinux`，命令会检查 `uuremote-server` 是否存在，并按 `$UU_CONFIG`、`$XDG_CONFIG_HOME/uuremote/config.json` 和调用者的 `~/.config/uuremote/config.json` 顺序查找登录配置。非标准安装可用 `UURELAY_UULINUX_BINARY` 指定可执行文件，或用 `--uulinux-config /path/to/config.json` 指定配置。启动或刷新时会重新读取并检查这份登录状态。UU Linux 是可选导入来源。

复用限于网易默认 API 的登录。使用自定义 `base_url` 登录过的 UU Linux 可在默认后端重新登录后导入。

使用 UU Linux 的登录身份时，可用 `sudo uurelay init --target '设备名'` 指定在线的外部被控端，或用 `sudo uurelay init --host-slot 2` 选择另一个已登录槽位的设备。

`sudo uurelay logout 1` 会尝试解绑并注销该槽自行注册的两套设备身份，并分别报告服务端确认情况。`uulinux` 选择项通过另选已登录的数字槽切换，原帐号由 UU Linux 管理。

## Tailscale 权限和选路

`sudo uurelay init` 会引导配置 Tailscale OAuth。按提示在管理后台创建 OAuth 客户端，启用 **Policy File 写权限**（`policy_file`）以及要求的 `devices:posture_attributes` 和 `devices:core:read`，然后输入 Client ID 和 Client Secret。Secret 采用隐藏输入。首次设置可按 Enter 跳过，按提示将自中继授权合并到 [Tailscale 管理后台](https://login.tailscale.com/admin/acls) 的 `grants` 数组。 [OAuth 设置](https://tailscale.com/docs/features/oauth-clients) · [权限说明](https://tailscale.com/docs/reference/trust-credentials)

验证成功后，OAuth 客户端凭据按 tailnet 加密写入 `/var/lib/uu-tailscale-relay/tailscale-api.enc`。后续在同一 Linux 主机用 `sudo uurelay setstun` 时，程序会按需换取短期访问令牌并在内存中使用。已有凭据时，交互式 `sudo uurelay init` 会询问是否覆盖。输入 `n` 保留，输入 `y` 可填写新的 ID 和 Secret。

选路沿用 Tailscale 的顺序：**直连 → 可用的 Peer Relay → DERP**。本节点发布的 UU 入口是连接本节点时的一条 Peer Relay 候选。如果同网还有其他合格的 Peer Relay，客户端会自行择优。刚连上时也可能先用 DERP 完成协商，再切到 UU。 [Tailscale Peer Relay](https://tailscale.com/docs/features/peer-relay)

如果某台设备一直走 DERP，在中转 Linux 上运行 `uurelay doctor ip <主机名或 Tailscale IP>`，查看“上报的公网 IPv4”。在目标设备上，用 STUN 工具向 `61.174.14.99:2480` 发 UDP 探测。有 `stunclient` 时可运行 `stunclient --protocol udp 61.174.14.99 2480`。取结果中的映射 IPv4，忽略端口，再与上报列表比较。[stunclient 使用说明](https://github.com/jselbie/stunserver/blob/master/resources/stunclient.md)

如果映射 IPv4 不在列表中且 UU 连不上，可显式运行 `sudo uurelay setstun`，将 STUN 节点加入整个 tailnet 的 `derpMap`。命令使用 `sudo uurelay init` 保存的 OAuth 凭据校验策略后做条件写入。缺少凭据时会提示先运行 `init`。它默认使用 `61.174.14.99:2480`，可用 `--stun IPv4:PORT` 指定别的服务器。配置下发后，重新运行带设备名的 `doctor ip`，再通过原生 Tailscale 探测确认实际选路。

## 日常操作

| 命令 | 作用 |
|---|---|
| `uurelay version` | 查看已安装的 CLI 版本 |
| `uurelay update --check` | 检查仓库里的版本信息和更新日志 |
| `sudo uurelay update` | 立即将本机 Linux 服务安装升级到最新正式版本 |
| `sudo uurelay update enable` | 启用每日自动更新 |
| `sudo uurelay update disable` | 关闭每日自动更新 |
| `uurelay doctor --quick` | 快速查看 systemd 状态、已选和运行中的槽位、刷新结果及转发计数 |
| `uurelay doctor` | 检查本机配置、已发布的入口和逐设备 IPv4 许可 |
| `uurelay doctor --probe` | 验证 UU 登录并测试独立临时 TURN 分配和许可 |
| `uurelay doctor ip HOST_OR_IP` | 列出指定设备的 Tailscale 上报地址和手动 STUN 检查命令 |
| `uurelay setstun` | 在 tailnet 策略中添加或更新 uurelay 的 STUN 节点 |
| `uurelay refresh` | 重新声明公网 IPv4 许可并发布入口。帐户没变时复用现有分配 |
| `uurelay stop` | 停止服务并撤下本服务发布的入口 |
| `uurelay start` | 启动服务。查询到 UU 入口后可以测试连接 |
| `systemctl enable uu-tailscale-relay` | 按需开启开机启动 |

服务端 `sudo uurelay doctor` 默认以中文显示服务状态、UU 入口和逐设备许可。日常查看用 `--quick`，并可用 `--probe` 主动检查 UU 登录和独立的临时 TURN 分配。探测完成后会释放该分配。脚本可对 `doctor`、`slot` 和 `setstun` 加 `--json` 读取结构化数据。

从要测试的客户端运行报告“在客户端核对选路”给出的命令。当 `tailscale ping` 显示的 `peer-relay(IP:端口:vni:…)` 与报告里的 UU 入口一致时，该次响应走的是 UU。安装了 `uurelay` 的 Linux 客户端也可用 `uurelay doctor --target NAME_OR_IP --endpoint IPV4:PORT` 查看选路统计。

换网测试时，`lastPermission.latencyMs` 表示服务端从发现新公网 IPv4 到确认许可有效的时间，`lastPermission.peers` 列出使用该地址的设备。`lastRecoveryMs` 表示旧分配到期至新入口发布的时间。客户端的 `firstUuObservedMs` 另行测量实际选路，计时从运行客户端探测命令开始。

## 自动更新

```sh
uurelay update --check
sudo uurelay update
sudo uurelay update enable
```

自动更新默认关闭。启用后，systemd 每天读取仓库里的 [`publish/version.json`](publish/version.json)。发现新版时，程序确认对应的 GitHub Release 已公开，再使用 GitHub API 提供的包大小和 SHA-256 摘要核对下载。Debian 和手动安装沿用原安装方式。正在运行的中转会短暂重启，配置、加密账号和 OAuth 数据沿用原路径。升级日志可用 `journalctl -u uu-tailscale-relay-update` 查看。

已安装仍从 Release 附件读取 `update.json` 的旧版时，首次切换到仓库更新源需要手动安装一次新包。

用 npm 安装的用户也可以用 `uurelay update --check` 查看新版和发布说明，再用 npm 安装对应的 `.tgz`。如果该 npm 安装还通过 `init` 部署了中转服务，可从新包用 `packaging/install.sh --service-only` 更新服务文件，再按需重启中转。

## 构建

```sh
npm ci
npm test
npm run release
npm run deb
npm pack --pack-destination dist
```

## 发布新版本

1. 更新 `package.json` 和 `package-lock.json` 的版本，在 `CHANGELOG.md` 加入对应的 `## x.y.z` 段落。
2. 执行 `npm run release:info`，把版本、更新日志和下载链接写到 `publish/version.json`。一起提交这些改动。
3. 推送到 `main`。CI 查找当前版本的 `vX.Y.Z` 标签，尚未打标签的正式版本会用对应更新日志发布三个安装包。Release 的安装包摘要由 GitHub 生成。
