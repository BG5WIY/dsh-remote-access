# dsh-remote-access

DeepSeek Harness（DSH）插件：把 DSH Web GUI 安全地开放到外网。

- **只走 HTTPS**：插件自己开一个 TLS 监听并反向代理到本机 DSH，没有明文入口。
- **cookie 配对**：每个外网浏览器第一次访问会拿到 `dsh_ra` cookie，但只能看到等待页。
- **5 分钟有效期**：未确认的 cookie 5 分钟后自动失效；重新访问会得到新的配对码。
- **持久化**：已确认会话写入 `$DSH_HOME/remote-access/sessions.json`（0600），重启 DSH 后不用重新配对。
- **到期清理**：每个 cookie 默认 30 天后到期，只清理到期的会话，不做全局重置。
- **临时密钥**：内网设置页生成一次性密钥，外网设备在等待页输入后只获得本次浏览器会话；关闭浏览器即失效，下次仍需密钥或内网确认。
- **只允许域名**：配置 `publicHost` 后，用 IP 或其他域名访问一律返回 421。
- **IPv6 双栈**：默认监听 `::`，域名有 AAAA 记录时 IPv6 公网可直连。
- **只能内网确认**：确认/拒绝操作只接受局域网或本机来源；外网（经代理）打开设置页时只有只读提示，没有确认按钮，Host 也会拒绝。
- **设置页确认**：DSH「设置 → 外网访问」里核对配对码并确认，之后该浏览器才被转发到真正的 DSH 页面。

## 工作方式

```
外网浏览器 ── HTTPS ──> dsh-remote-access (TLS 监听 :8443)
                          │  未确认 cookie → 等待页（不转发）
                          │  已确认 cookie → 反向代理
                          ▼
                    127.0.0.1:3080 (DSH Web)
                          ▲
内网浏览器 ── HTTP ────────┘  设置 → 外网访问 → 确认配对码
```

代理会用自己的 `dsh-auth` cookie 登录本机 DSH（复用 DSH 的 launch token），
外网浏览器永远拿不到这个 cookie。转发时会重写 `Host`、删除 `Origin`/`Referer`，
并强制覆盖 `x-dsh-ra-proxy: 1` —— Host API 靠这个头判断「请求来自外网」。

## 安装

插件目录：`~/dsh-remote-access`。让 web profile 加载它：

```bash
ln -s ~/dsh-remote-access ~/.dsh/profiles/web/node_modules/dsh-remote-access
```

在 `~/.dsh/profiles/web/package.json` 中：

```json
{
  "dependencies": {
    "dsh-remote-access": "file:/home/hu-hangyi/dsh-remote-access"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-remote-access"
      ]
    }
  }
}
```

然后重启 `dsh web`。启动日志里会出现：

```
[dsh-remote-access] HTTPS 0.0.0.0:8443 -> 127.0.0.1:3080 (self-signed: ~/.dsh/remote-access/tls/cert.pem)
```

## 手机端

「外网访问」分区在 ≤768px 时变成整行列表：状态行是「标签 / 值」，会话项是配对码 + 信息 + 全宽按钮。样式只用 DSH 主题变量并带兜底色，跟随深浅色主题。

设置面板本身的全屏化（顶部标题、横向分类标签、内容区单列）由 [`dsh-mobile-ui`](../dsh-mobile-ui) 负责；没有安装它时，设置面板保持 DSH 原样，本分区仍然可用。

## 使用

1. 在路由器/防火墙把公网 **TCP 8443** 放行到这台机器（端口可在配置里改）。
2. 外网打开 `https://<公网地址>:8443/`。首次访问是等待页，页面上有 6 位配对码。
3. 在**内网/本机**打开 DSH，进入「设置 → 外网访问」。
4. 核对配对码（来源 IP、UA 也会显示），点「确认」。

如果外网设备不方便让人在内网确认，可以在「设置 → 外网访问 → 临时密钥」里生成一个一次性密钥（可选 10 分钟 / 1 小时 / 24 小时有效），让对方在等待页的输入框里填入。临时密钥登录只维持本次浏览器会话：关闭浏览器即失效，且服务端最多保留 12 小时；下次仍要新密钥或内网确认。
5. 外网页面 2 秒内自动进入 DSH。之后同一个浏览器在 24 小时内免确认（可配置）。
6. 换浏览器、清 cookie、撤销会话或重启 DSH 后需要重新配对。

自签证书第一次访问会有浏览器警告。使用 CA 证书时，把证书链和私钥放到固定位置并配置：

```yaml
- id: remote-web-access
  name: 'dsh-remote-access'
  config:
    listenPort: 8443
    tlsCertFile: /etc/dsh/tls/fullchain.pem
    tlsKeyFile: /etc/dsh/tls/privkey.pem
```

### CA 证书续期

Let's Encrypt 证书默认 90 天。续期后覆盖两个文件并让插件重载（DSH 插件热加载，或重启 `dsh web`）：

```bash
# fullchain 必须包含叶证书 + 中间证书（含交叉根，如果 CA 提供）
cp ~/下载/Certple_hugengron_cn.pem ~/.dsh/remote-access/tls/fullchain.pem
cp ~/下载/Certple_hugengron_cn.key ~/.dsh/remote-access/tls/privkey.pem
chmod 600 ~/.dsh/remote-access/tls/privkey.pem
```

可用 `openssl s_client -connect 127.0.0.1:8443 -servername hugengron.cn` 检查实际提供的证书。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `remote-web-access` 条目加 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `listenHost` | `::` | 公网监听地址；`::` 同时接受 IPv4 与 IPv6 |
| `publicHost` | — | 只允许该域名访问，并用于展示公网地址；未配置则不限制 |
| `listenPort` | `8443` | 公网 TLS 端口 |
| `tlsCertFile` / `tlsKeyFile` | — | PEM 证书链与私钥；不填则自动生成自签证书 |
| `certNames` | `[]` | 自签证书额外 SAN，例如 `["dsh.example.com"]` |
| `pendingTtlMs` | `300000`（5 分钟） | 未确认 cookie 有效期 |
| `sessionTtlMs` | `2592000000`（30 天） | 内网确认后的 cookie 有效期；到期自动清理 |
| `tempKeyTtlMs` | `600000`（10 分钟） | 临时密钥本身的有效期 |
| `tempSessionTtlMs` | `43200000`（12 小时） | 临时密钥登录后会话的上限；cookie 仍是 session cookie |
| `statePath` | `$DSH_HOME/remote-access/sessions.json` | 持久化文件路径 |

## 安全边界

- 未确认 cookie 的请求**不会**到达 DSH：代理只返回等待页。
- 确认接口只在非代理来源、且来源地址属于回环/私有网段时可用，并要求
  `x-dsh-ra: 1` 请求头；跨站表单无法伪造。
- 外网打开设置页时 `status.internal === false`，界面只显示提示，不渲染确认/撤销按钮。
- 已确认会话持久化到 0600 文件（目录 0700）。这个文件里保存的就是 cookie 值，等同凭证；备份或拷贝它等于拷贝访问权。
- 未确认会话不落盘：重启后仍需在 5 分钟内重新配对。
- 清理只按每个会话自己的 `expiresAt` 进行（30 天），不会把其他会话一起作废。
- 临时密钥一次性（使用即删除），默认 10 分钟有效；同一来源每分钟最多 10 次尝试。
- 临时密钥登录的会话不设 cookie `Max-Age`，浏览器关闭即失效；服务端另有 `tempSessionTtlMs` 上限，不能当长期凭据。
- `dsh_ra` cookie 是 `Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`，只在 TLS 监听上使用；浏览器关闭标签页后仍会保留，直到服务端过期。
- 配置 `publicHost` 后，代理只接受 Host 等于该域名的请求；IP、`www.` 前缀或缺失 Host 都返回 421。
- IPv6 需要域名有 AAAA 记录；`https://<IPv6 字面量>:8443` 会被域名限制拒绝，这是刻意行为。
- 上层 DSH 的 `dsh-auth` cookie 由代理独占，不会出现在外网响应里。

## 自检

```bash
node lib/self-check.mjs
```

覆盖：未确认不转发、确认后转发、Host 重写与标记头、cookie 到期换新、撤销失效、
WebSocket upgrade 的同一套规则；持久化重启恢复、未确认会话不落盘、到期清理；
以及配置 `publicHost` 后 IP/其他域名返回 421。

## 已知限制

- 会话不做滑动续期：每个 cookie 从确认时刻起固定 30 天，到期后该浏览器要重新配对。
- 临时密钥只存在进程内存里：插件重启后，尚未使用的密钥会失效（已登录的会话仍按 `tempSessionTtlMs` 保留）。
- IPv6 公网可达还取决于路由器/防火墙放行 8443 以及 AAAA 记录是否正确。
- 代理不处理 HTTP/2、gzip 再压缩或证书自动续期；DSH 自己的压缩原样透传。
- 只保护经本插件端口的访问。若直接把 `dsh web` 绑定到公网地址，会绕过这套验证。
