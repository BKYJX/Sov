# Sov(frontend) By BCquqi
The sovereign, end-to-end encrypted chat client.

## 前端

- `index.html` — 页面结构（侧边栏 / 成员列表 / 消息区 / 输入框 / 主题切换）
- `style.css` — 全部样式（深/浅主题变量、消息分组、日期分隔、操作按钮）
- `script.js` — 全部逻辑（渲染 / 发送 / 轮询 / 成员 / 主题 / 后端对接）
- `preview.html` — 旧静态预览页

## 后端对接（sov-serverside）

后端仓库：<https://github.com/BKYJX/sov-serverside>（Go，单进程单群组，文件存储，Docker 部署）。

### 部署要求（服务器端）

1. 启动：`docker run -d -p 8443:8443 -v $(pwd)/data:/data --name sov-server sov-server -port=8443 -dir=/data -admin=You -admin-pass=<密码> -name=BKYJX`
   - 初始管理员账号须与前端 `CONFIG.user.id` 一致（默认 `You`），密码须与 `CONFIG.user.password` 一致
2. **必须启用 CORS**：前端页面运行在 `http://<host>:80`，后端在 `:8443`，跨端口请求会被浏览器拦截。`sov-serverside` 的 `main.go` 已包含 `corsMiddleware`（允许任意来源，开发期），部署时请确认生效；生产环境应改为白名单。

### 接口约定（前端已实现）

| 用途 | 接口 | 认证 |
|---|---|---|
| 健康检查 | `GET /health` | 无 |
| 历史/增量消息 | `GET /chat/messages?date=YYYY-MM-DD&since=<unix秒>` | X-User-Id + X-Password |
| 发送消息 | `POST /chat/send` | X-User-Id + X-Password |
| 成员列表 | `GET /members/list` | 无 |

消息行格式：`timestamp|senderId|ciphertext|encryptedKeysJson`

### 消息加密（当前为传输占位）

服务器按 Opaque 字符串存储 `ciphertext`，不解密内容。当前客户端约定：

```
ciphertext = base64( JSON.stringify({ v: 1, content: "消息文本" }) )
```

真正的 E2EE（成员公钥加密 + `encryptedKeys` 密钥分发）待后续实现，届时只需替换 `script.js` 中的 `encodePayload` / `decodePayload`，服务器无需改动。

### 前端工作流

- 启动即拉取当天全部历史消息，之后每 3 秒增量轮询 `since=<最后一条时间戳>`
- 行级去重：`timestamp|senderId|ciphertext前32位` 作为消息唯一 id；本地已发送的消息通过 `pendingSent` 缓存跳过轮询重复
- 收到的他人消息自动加入成员列表；新成员可动态加入（`receiveMessage` 入口）
- 频道：`general` 对接后端群组；`开发` / `语音` 为本地隔离频道（后端暂为单群组设计）
