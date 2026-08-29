# DSH Remote Android

DSH Remote 是 DSH 的手机远程工作台。它复用电脑端 `dsh-remote-bridge` 的 WLAN WebSocket，不创建第二套聊天或假进度。

## 已实现

- 连接电脑上的 Bridge `ws://<电脑局域网 IP>:8788/ws`。
- 首次连接后保存 endpoint 和 token，重新打开 App 自动重连。
- 接收 `session.snapshot` 和真实 DSH 事件：session、thinking、tool、terminal、file、approval、assistant、progress。
- 显示项目、会话、阶段、摘要、命令、文件变更、最终回复和实时活动。
- 手机控制当前 DSH 会话：发送 prompt、停止、继续、允许/拒绝审批。
- Android 前台服务维护 WebSocket，Activity 进入后台不会主动断开。
- 自动重连节奏：1 秒、2 秒、5 秒、10 秒、30 秒。
- 后台持续更新 ongoing notification，带任务进度和审批/停止操作；荣耀 MagicOS 可将其映射为灵动胶囊。
- 胶囊折叠态轮播思考、工具、命令和回复片段；展开态显示对话名称、当前动作、最近更新、项目和电脑名称。胶囊不显示百分比和进度条。
- 不同步隐藏 Chain-of-Thought，只显示 DSH 公开的步骤摘要。

## 电脑端启动

先启动已启用 `hooks-remote` 的 DSH，再启动 Bridge。当前工作区的示例配置：

```powershell
$env:BRIDGE_HOST = "0.0.0.0"
$env:BRIDGE_PORT = "8788"
$env:BRIDGE_TOKEN = "<strong-random-token>"
$env:DSH_CONTROL_ENDPOINT = "http://127.0.0.1:8789/control"
$env:DSH_CONTROL_TOKEN = "<strong-random-token>"
$env:DSH_CWD = "C:\path\to\project"
node dsh-remote-bridge/src/index.js
```

手机和电脑在同一 WLAN 时，在 App 设置中填写：

```text
地址：ws://<电脑局域网IP>:8788/ws
Token：与 BRIDGE_TOKEN 相同
```

App 会自动为 `http://` 或不带路径的地址补全 WebSocket `/ws`。

## 构建

需要 JDK 17 和 Android SDK：

```powershell
$env:ANDROID_HOME = "C:\Users\CHJ19\AppData\Local\Android\Sdk"
.\gradlew.bat clean assembleRelease
```

原始 Release 输出：

```text
app/build/outputs/apk/release/app-release.apk
```

交付文件：

```text
dist/DSH-Remote.apk
```

## 当前边界

- 当前传输是局域网 WebSocket；协议字段已保留未来切换到 WSS Relay 的空间。
- 进度只显示 DSH 明确提供的数值，没有真实百分比时显示状态文字。
- Bridge 的控制入口仍由 DSH 原生 `hooks-remote` 负责，Sidecar 只转发，不伪造控制成功。
