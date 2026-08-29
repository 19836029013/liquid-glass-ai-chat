# DSH Remote Discovery

扫描和实现日期：2026-08-23

## DSH 端结论

当前 Android 工作区不是 DSH 本体源码。DSH 本体位于：

```text
C:\Users\CHJ19\Documents\ChatGPT\电脑整理\deepseek-harness
```

实际可用的原生远程插件是：

```text
packages/hooks/hooks-remote/
```

它通过 DSH 的 session、agent、tool、terminal、approval 和 assistant 事件发送统一协议；控制端口为 `127.0.0.1:8789`。

## Bridge

```text
C:\Users\CHJ19\Documents\ChatGPT\dsAPP\dsh-remote-bridge
```

Bridge 已实现：

- `GET /health`
- `GET /snapshot`
- `POST /events`
- `POST /control`
- `GET /ws`
- WebSocket 首包 `session.snapshot`
- 事件广播和控制结果串行化
- token 鉴权、请求/帧大小限制、控制超时
- WLAN 绑定 `0.0.0.0:8788`

Android 不再使用旧群聊协议；它直接使用 Bridge `/ws`，并把控制消息转回 DSH 原生控制入口。

## Android 端实现

入口：

```text
app/src/main/java/com/dsapp/liquidglasschat/MainActivity.java
app/src/main/java/com/dsapp/liquidglasschat/RemoteService.java
app/src/main/assets/index.html
app/src/main/assets/app.js
app/src/main/assets/styles.css
```

- `RemoteService` 是 Android 前台服务，维护原生 WebSocket、重连、snapshot 缓存、控制消息和 ongoing notification。
- `MainActivity` 只负责 WebView 工作台和 JavaScript Bridge；Activity 重建不会结束服务。
- notification 根据真实状态映射为 `✦ 思考中`、`⌘ 调用工具`、`> 构建中`、`! 等待批准`、`✓ 已完成`、`× 失败`。
- 审批通知包含允许/拒绝按钮；工作状态包含停止按钮。
- 未发现可在当前 compileSdk 中稳定使用的荣耀私有 SDK，因此采用已在荣耀真机验证过的标准 ongoing notification / Live Update 路线。

## 当前验证证据

- DSH 原生插件已经向 Bridge 发送真实事件并生成 snapshot。
- Bridge 测试全部通过：事件规范化、结构化输出探针、HTTP 鉴权、控制转发、超时、WebSocket snapshot 和串行控制共 7 项。
- Android Debug APK 已通过 Gradle clean build。
- 设备安装测试需要 Android 手机或 adb 设备；当前构建环境未发现已连接设备，因此保留安装后真机验证项，不将其伪称为已完成。
