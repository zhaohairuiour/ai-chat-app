# AI Chat 后端部署说明

单文件 Express + better-sqlite3 服务，无反向代理依赖，直接监听端口即可。

## 1. 运行环境

- Node.js 18 / 20 / 22（推荐 22 LTS）
- `better-sqlite3` 是原生模块：无预编译包时需 `python3`、`make`、`g++`
- 服务器需放行 `48168/tcp`（云厂商安全组 + 本机 iptables/ufw 两层都要开）

```bash
# Debian/Ubuntu 装编译工具
sudo apt-get update && sudo apt-get install -y build-essential python3
# CentOS/RHEL
sudo yum groupinstall -y "Development Tools" && sudo yum install -y python3
```

## 2. 安装与启动

```bash
mkdir -p /opt/ai-chat && cd /opt/ai-chat
# 上传本目录全部内容后：
npm install --omit=dev

# 前台试跑（确认端口和日志正常）
PORT=48168 node server.js

# 或后台常驻
PORT=48168 nohup node server.js > app.log 2>&1 &
```

验证：

```bash
curl -i http://127.0.0.1:48168/api/me      # 期望 401 {"error":"未登录"}
curl -i http://<your-server-ip>:48168/api/me  # 从外网验证，能通说明安全组已放行
```

## 3. 目录与数据

```
/opt/ai-chat/
├── server.js
├── package.json
├── public/               # 网站端静态文件（express.static 挂载，必须存在）
│   ├── index.html
│   ├── app.js
│   ├── local-core.js
│   ├── style.css
│   ├── favicon.svg
│   └── vendor/           # marked / highlight / github-dark 主题
├── data/                 # 有状态目录
│   ├── app.db            # 已含迁移快照：用户 / 会话 / 消息 / 注销状态
│   ├── spend.json        # 当日额度累计（首次计费时生成）
│   └── projects/         # 项目式编程产物（首次使用时生成）
└── app.log
```

`public/` 是网站端的页面本体，`server.js` 用 `express.static(__dirname/public)` 挂载根路径；**APK 不依赖它**（前端已打进 APK 的 assets），但网站端访问 `http://<your-server-ip>:48168/` 必须有这个目录，否则 404。

- `data/` 是唯一有状态目录，迁移服务器时整目录拷走即可。
- `app.db` 使用 WAL 模式，存在 `app.db-wal`、`app.db-shm`，**备份要先停进程或用 `sqlite3 app.db ".backup"`**，直接 cp 三个文件可能拿到不一致快照。

## 4. systemd（推荐）

```ini
# /etc/systemd/system/ai-chat.service
[Unit]
Description=AI Chat Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-chat
Environment=PORT=48168
ExecStart=/usr/bin/node /opt/ai-chat/server.js
Restart=always
RestartSec=3
StandardOutput=append:/opt/ai-chat/app.log
StandardError=append:/opt/ai-chat/app.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-chat
sudo systemctl status ai-chat
```

## 5. 反向代理（可选）

若要挂域名走 443，Nginx 需关闭缓冲，否则 SSE 流式输出会被攒成一次性吐：

```nginx
location / {
    proxy_pass http://127.0.0.1:48168;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
}
```

## 6. 内置配置（改这些要动代码）

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 监听端口 | `const PORT = process.env.PORT || 3000` | 用 `PORT=48168` 覆盖 |
| 数据库路径 | `path.join(__dirname, 'data')` | 跟随 server.js 所在目录 |
| SMTP | 文件头部 `MAIL_USER` / `MAIL_PASS` | 163 邮箱授权码，非登录密码；失效会导致注册验证码收不到 |
| 模型上游 | `UPSTREAM_ENDPOINTS`、`ZHIPU_KEY` 等常量 | 轮询/故障转移依赖这些 key |
| 每日额度 | `SPEND_LIMIT_YUAN` | 免费模型也计入，单价见 `FREE_MODEL_PRICE` |

## 7. 本版相对旧版的行为差异

1. **注销冷静期只拦业务接口**：`/api/me`、`/api/deactivate`、`/api/logout`、`/api/login`、`/api/register`、`/api/auth/*`、`/api/profile`、`/api/spend`、`/api/verify` 全部放行。旧版把 `/api/logout` 也拦了，导致冷静期内无法退出登录。
2. **免费模型计费**：`/api/chat` 的计费条件从 `isPaidZhipu && lastUsage` 改为 `billMeta`，免费模型按 `{ in: 1, out: 2 }` 元/百万 token 计，`done` 事件带 `spend`，前端额度条才会动。

## 8. 常见问题

- **外网连不上但本地 curl 正常**：安全组/防火墙没放行 48168。
- **`better-sqlite3` 编译失败**：Node 版本与预编译包不匹配，装 `build-essential python3` 后 `npm rebuild better-sqlite3`。
- **SSE 卡住不输出**：前面有 Nginx/Cloudflare 缓冲，按第 5 节关缓冲；Cloudflare 需保持 HTTP 长连接，不建议套 CDN。
- **注册收不到验证码**：SMTP 授权码失效，或 163 拒绝外发（检查 `app.log` 中 `[mail]`）。
