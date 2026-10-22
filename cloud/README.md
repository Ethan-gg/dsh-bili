# 云桥参考云端（cloud/）

> 方案 §6 的"云端"只要求**一个 HTTP 端点**（`src/sync/contract.md`）。这里是它的**参考实现**：
> 零依赖、单文件、本机就能跑。给两种人用：
> ① 想自己搭云端的人 —— 照它接协议；② 调试插件的人 —— 本机起一个，把"出站 → 云端 → 入站 → 叫醒她 → 回群"整条链跑通。

## 跑起来

```bash
# 密钥：跟插件设置页「显示密钥」里那串一模一样
# 入站地址：设置页「显示密钥 / 入站地址」里给的
set CLOUD_SECRET=<插件那把 secret>          # macOS/Linux: export CLOUD_SECRET=...
set PLUGIN_INBOUND_URL=http://127.0.0.1:5803/api/bili-duty/sync/inbound
node cloud/server.mjs
```

它会打印 `云桥参考云端已开：http://127.0.0.1:8791`。然后把插件设置页「云桥」的：

- 传输方式 → `http`
- 云端地址 → `http://127.0.0.1:8791`
- 点「发一条测试」→ 云端这边 `GET /sync/v1/events` 应该能看到一条 `message.out`

## 三个端点

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/sync/v1/events` | 收插件出站事件：验 HMAC、按 `id` 幂等去重、落 `data/events.jsonl` |
| POST | `/sync/v1/inbound` | 桥梁**把消息推进插件**：body `{type, payload}`，云端用同一把密钥签名后 POST 给插件入站地址 |
| GET | `/sync/v1/events?since=&limit=` | 排障：读回已收事件 |

## 模拟"群里有人 @ 她"

```bash
curl -X POST http://127.0.0.1:8791/sync/v1/inbound \
  -H "content-type: application/json" \
  -d '{"type":"message.in","payload":{"convId":"c1","userName":"小明","text":"在吗"}}'
```

插件会收到签名事件 → 唤醒常驻会话（素材格式，不是指令）→ 她想回就用 `bili_say` →
插件出站 `message.out` → 云端 `GET /sync/v1/events` 能看到回的那句话。这就是 M4 的"@ 她 → ≤30 秒回群"闭环。

## 边界（别把它当生产）

- 没有后台鉴权、没有 TLS、没有多租户；只绑 `127.0.0.1`。
- `CLOUD_SECRET` 只能走环境变量，别写进前端 / 仓库。
- 真正接 IM（飞书 / 微信 / 企微）的那层 webhook **不在这个文件里**：它负责把群消息转成
  `{type:"message.in", payload:{convId,userName,userId,text}}` 再调 `/sync/v1/inbound`。
