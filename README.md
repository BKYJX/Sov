# SOV Chat (front-end) README
## By [BCquqi](https://github.com/BCquqi)

> 
> 项目路径：`https://github.com/BKYJX/Sov`
> 预览访问地址：`none yet`
> 对接后端：`https://chat.bkyjx.top`（sov‑serverside Go后端）

## 项目文件结构

```
├─ index.html          # HTML骨架，只保留DOM结构，不包含CSS、JS
├─ style.css           # 全部样式、主题、消息分组样式
├─ script.js           # 全部业务逻辑、UI渲染、后端对接、主题切换
└─ README.md           # 本说明文档
```

## 当前已实现功能

### UI聊天功能

1. **黑白主题系统**
   - 白天 / 黑夜 / 自适应（跟随系统）
   - `data-theme`挂载在`<html>`根节点，整页面背景同步切换，修复白天模式大背景黑色Bug
   - 主题配置本地存储，页面刷新自动记忆
2. **消息渲染规则（Discord风格）**
   - 同一用户连续多条消息：仅第一条展示头像、用户名、时间；后续消息仅展示文本，头像位置留白对齐
   - 分隔横线**只渲染在不同说话者的消息组之间**；同一人连续消息组内部无分割线；页面最后一条消息下方无多余横线
   - 消息操作按钮（回复、编辑）悬浮在消息块**右上角**，鼠标悬浮消息才显示，减少空白间隙
3. **输入框能力**
   - 使用`textarea`支持多行文本；`Shift+Enter`换行，`Enter`发送消息
   - 输入框聚焦有视觉高亮反馈；全空格内容提交会被拦截并清空输入框
   - XSS防护：所有用户输入做HTML转义，防止脚本注入
4. **其他UI组件**
   - @提及高亮渲染
   - 消息日期分隔条渲染
   - 侧边栏频道列表（静态骨架，预留切换接口）
   - 侧边成员列表，收到新用户消息自动新增成员
   - 空状态提示（暂无消息）
   - 消息发送完成自动滚动到底部

### 后端对接模块

> 
> 后端仓库：sov‑serverside，Go语言实现E2EE群组服务

1. **配置开关**
   - `CONFIG.backendEnabled = true`：开启真实后端对接；设置为`false`切换纯内存模拟模式（本地调试UI，不请求网络）
2. **认证方式**
   - 请求头携带自定义Header：`X‑User‑Id`、`X‑Password`，和后端账号匹配
3. **接口清单**| 接口 | 方法 | 作用 |
| --- | --- | --- |
| `/health` | GET | 后端健康探测 |
| `/chat/messages` | GET | 拉取历史加密消息，支持`since`时间戳做增量轮询 |
| `/chat/send` | POST | 发送加密消息payload到后端 |
| `/members/list` | GET | 拉取群组成员列表 |
4. **消息发送逻辑**
   - **乐观渲染**：点击发送，前端立刻渲染消息，提升体验
   - 请求后端失败：自动回滚，删除刚刚渲染的消息；控制台输出错误日志
5. **增量轮询**
   - 定时轮询后端获取新消息；基于消息ID做去重，不会重复渲染同一条消息
6. **消息解析规则**
   - 后端原始行格式：`timestamp|senderId|ciphertext|keysJson`
   - 前端解析拆分字段；E2EE解密逻辑预留占位，待后续实现

## script.js 核心配置区

```
const CONFIG = {
    // 后端基础地址
    api:{
        baseUrl:"[https://chat.bkyjx.top](https://chat.bkyjx.top)",
    },
    // 是否启用后端，false=本地内存模拟模式（仅调试UI）
    backendEnabled:true,
    // 用户认证信息，必须和sov‑serverside服务启动账号保持一致
    user:{
        userId:"",
        password:""
    },
    pollInterval:3000 //轮询间隔，单位ms
}
```

## 部署 & 联调关键注意事项

### 1. CORS跨域问题（高频踩坑）

前端页面地址：`[http://10.66.1.98](http://10.66.1.98)`；后端域名`[https://chat.bkyjx.top](https://chat.bkyjx.top)`，属于跨域。

1. Go后端必须添加全局CORS中间件，**不能直接设置`Access‑Control‑Allow‑Origin: *`**（项目使用自定义请求头`X‑User‑Id/X‑Password`，*不兼容）
2. 如果后端前置Nginx反向代理，**Nginx层也需要处理CORS与OPTIONS预检请求**；只修改Go代码无效
3. 修改后端配置后，建议浏览器使用无痕窗口测试，规避OPTIONS预检缓存

> 
> Go CORS中间件参考代码

```
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "[http://10.66.1.98](http://10.66.1.98)")
        w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "X-User-Id,X-Password,Content-Type")
        w.Header().Set("Access-Control-Allow-Credentials", "true")
        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusOK)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

### 2. 本地调试模式

修改`CONFIG.backendEnabled = false`，关闭网络请求，消息保存在浏览器内存。

> 
> 提示：内存模式刷新页面消息全部丢失，仅用于UI效果调试。

### 3. 联调测试方式

打开浏览器F12开发者工具：

1. Console面板：查看报错，例如发送失败、解析异常
2. Network面板：查看fetch请求，确认请求头、返回内容；`net::ERR_CONNECTION_REFUSED`代表后端不可访问；CORS报错代表跨域配置问题

快速验证脚本（浏览器控制台执行，填入真实账号）：

```
fetch("[https://chat.bkyjx.top/chat/messages](https://chat.bkyjx.top/chat/messages)",{
  method:"GET",
  headers:{
    "X-User-Id":"你的userId",
    "X-Password":"你的password"
  }
}).then(r=>r.json()).then(res=>{console.log("成功",res)}).catch(e=>console.error("失败",e))
```

## 当前待实现清单

1. 回复、编辑消息完整业务逻辑（当前仅UI，无提交后端）
2. 真正E2EE解密实现（当前ciphertext仅占位）
3. 正在输入提示
4. 附件、图片上传发送
5. 消息搜索
6. 频道切换历史缓存
7. 断线重连、WebSocket备选方案
8. 用户离线/在线状态展示
9. Toast用户可见错误提示（当前仅console输出）

## 自测指引

1. 主题切换：切换白天黑夜自适应，检查全部页面背景、组件样式是否正常
2. 连续消息发送：同一账号连续发送多条，确认分组、头像隐藏、分割线位置正确
3. 跨用户消息：模拟不同用户消息，确认分割线出现在不同用户之间
4. 发送：空内容、全空格拦截；Shift+Enter多行换行；回车/按钮发送
5. 后端联调：开启`backendEnabled=true`，观察乐观渲染+失败回滚行为

## 更新记录

> 
> 后续所有**工作任务模式**产出的变更，仅更新本文档，旧迭代历史不保留。
> 修改完成后同步更新此README：功能、配置、注意事项、待实现清单。