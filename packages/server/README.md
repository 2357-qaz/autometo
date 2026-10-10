# @automedo/server

单人自用的 AuTomeDo 同步服务器：SQLite 存储（Node 22 自带的 `node:sqlite`），同时可以托管网页版。

## 运行

```bash
# 在仓库根目录
npm install
npm run build                       # 构建网页版（可选，用于让服务器同时托管网页）
AUTOMEDO_TOKEN=<一串足够长的随机字符> \
AUTOMEDO_WEB_DIR=apps/web/dist \
npm run server
```

生成令牌：`openssl rand -base64 32`

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUTOMEDO_TOKEN` | （必填） | 访问令牌，至少 16 个字符。客户端在 `/sync` 里填写同一个值 |
| `AUTOMEDO_DB` | `./data/automedo.db` | 数据库文件 |
| `HOST` | `127.0.0.1` | 监听地址。要让其他设备访问，设为 `0.0.0.0` 并放在 HTTPS 反向代理后面 |
| `PORT` | `8787` | 端口 |
| `AUTOMEDO_WEB_DIR` | — | 设置后在 `/` 托管网页版（同源，手机直接打开即可） |
| `AUTOMEDO_VAPID_SUBJECT` | `mailto:automedo@example.com` | 推送的联系方式。Apple 的推送服务要求一个有效的 `mailto:` 或 `https:` 地址，建议改成你自己的邮箱 |
| `AUTOMEDO_INSECURE` | — | 设为 `1` 时不校验令牌，仅限本机开发 |

### Docker

```bash
docker build -t automedo .
docker run -d -p 8787:8787 -v automedo-data:/data -e AUTOMEDO_TOKEN=... automedo
```

### 手机访问

iOS 上的 PWA 需要 HTTPS。建议用 Caddy / Nginx / Cloudflare Tunnel / Tailscale 等给服务器加上 HTTPS，然后在手机 Safari 打开该地址，输入 `/sync` 填令牌。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/health` | 健康检查（无需令牌） |
| `POST` | `/v1/sync` | 同步：上传本地变更，返回其他设备的变更 |
| `GET` | `/v1/export` | 导出完整数据（JSON，可在网页版 `/import`） |
| `GET` | `/v1/stats` | 记录数、删除标记数、当前游标、推送订阅数 |
| `GET` | `/v1/push/key` | 推送公钥（VAPID，首次启动时自动生成并保存在数据库里） |
| `POST` | `/v1/push/subscribe` · `/unsubscribe` · `/test` | 设备订阅 / 取消 / 发送测试通知 |

所有 `/v1/*`（除 health）需要 `Authorization: Bearer <AUTOMEDO_TOKEN>`。

## 提醒

服务器每分钟检查一次：Goal 的 Checkpoint 到期、Plan 阶段过了目标日期、专注 Session 超过计划时长。每条提醒只发一次，发给所有开启了提醒的设备（网页里 `/sync` → 开启提醒）。

## 同步模型

数据拆成记录（计划信息、阶段、任务、版本、日志事件、Session……），每条带一个按时间排序的 `rev`。服务器按 `rev` 保留最新的一份；删除以删除标记同步。日志事件只增不改，各设备取并集。详见 `docs/v1-plan.md`。
