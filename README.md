# dsh-remote-access

DeepSeek Harness（DSH）插件：把 DSH Web GUI 安全地开放到外网。

- **只走 HTTPS**：插件自己开一个 TLS 监听并反向代理到本机 DSH，没有明文入口。
- **cookie 配对**：每个外网浏览器第一次访问会拿到 `dsh_ra` cookie，但只能看到等待页。
- **5 分钟有效期**：未确认的 cookie 5 分钟后自动失效；重新访问会得到新的配对码。
- **持久化**：已确认会话写入 `$DSH_HOME/remote-access/sessions.json`（0600），重启 DSH 后不用重新配对。
- **定期全部清理**：默认每 7 天把所有已确认会话一起作废，强制重新配对（可配置）。
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

## 使用

1. 在路由器/防火墙把公网 **TCP 8443** 放行到这台机器（端口可在配置里改）。
2. 外网打开 `https://<公网地址>:8443/`。首次访问是等待页，页面上有 6 位配对码。
3. 在**内网/本机**打开 DSH，进入「设置 → 外网访问」。
4. 核对配对码（来源 IP、UA 也会显示），点「确认」。
5. 外网页面 2 秒内自动进入 DSH。之后同一个浏览器在 24 小时内免确认（可配置）。
6. 换浏览器、清 cookie、撤销会话或重启 DSH 后需要重新配对。

自签证书第一次访问会有浏览器警告。要消除警告，配置自己的证书：

```yaml
- id: remote-web-access
  name: 'dsh-remote-access'
  config:
    listenPort: 8443
    tlsCertFile: /etc/dsh/tls/fullchain.pem
    tlsKeyFile: /etc/dsh/tls/privkey.pem
```

## 配置

在 profile 的 `cordis.patch.yml` 里给 `remote-web-access` 条目加 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `listenHost` | `0.0.0.0` | 公网监听地址 |
| `listenPort` | `8443` | 公网 TLS 端口 |
| `tlsCertFile` / `tlsKeyFile` | — | PEM 证书链与私钥；不填则自动生成自签证书 |
| `certNames` | `[]` | 自签证书额外 SAN，例如 `["dsh.example.com"]` |
| `pendingTtlMs` | `300000`（5 分钟） | 未确认 cookie 有效期 |
| `sessionTtlMs` | `2592000000`（30 天） | 单个已确认 cookie 有效期 |
| `clearAllIntervalMs` | `604800000`（7 天） | 定期把全部已确认会话作废；`0` 关闭 |
| `statePath` | `$DSH_HOME/remote-access/sessions.json` | 持久化文件路径 |

## 安全边界

- 未确认 cookie 的请求**不会**到达 DSH：代理只返回等待页。
- 确认接口只在非代理来源、且来源地址属于回环/私有网段时可用，并要求
  `x-dsh-ra: 1` 请求头；跨站表单无法伪造。
- 外网打开设置页时 `status.internal === false`，界面只显示提示，不渲染确认/撤销按钮。
- 已确认会话持久化到 0600 文件（目录 0700）。这个文件里保存的就是 cookie 值，等同凭证；备份或拷贝它等于拷贝访问权。
- 未确认会话不落盘：重启后仍需在 5 分钟内重新配对。
- 定期全清从 `clearedAt` 起算，每 `clearAllIntervalMs` 把**全部**会话（包括刚确认的）一起作废。
- `dsh_ra` cookie 是 `Secure; HttpOnly; SameSite=Lax`，只在 TLS 监听上使用。
- 上层 DSH 的 `dsh-auth` cookie 由代理独占，不会出现在外网响应里。

## 自检

```bash
node lib/self-check.mjs
```

覆盖：未确认不转发、确认后转发、Host 重写与标记头、cookie 到期换新、撤销失效、
WebSocket upgrade 的同一套规则；以及持久化重启恢复、未确认会话不落盘、定期全清。

## 已知限制

- 定期全清是固定周期，不做单设备滑动续期；到期后所有外网浏览器都要重新配对。
- 代理不处理 HTTP/2、gzip 再压缩或证书自动续期；DSH 自己的压缩原样透传。
- 只保护经本插件端口的访问。若直接把 `dsh web` 绑定到公网地址，会绕过这套验证。
