# 英子起飞 · 群聊同步服务器

跑在你电脑上的小服务，让两台手机通过 Tailscale 虚拟局域网实时同步群聊，不再依赖 ntfy。

## 启动

1. 电脑需要安装 Node.js（推荐 18 以上）。
2. 双击 `start-server.bat`，或命令行运行：

   ```bash
   node server.js
   ```

3. 看到 `群聊同步服务器已启动` 即可。默认端口 `8787`，可用环境变量 `PORT` 修改。

## 验证

浏览器打开 `http://127.0.0.1:8787/health`，看到 `{"ok":true}` 就成功了。

## 数据

对话保存在 `data/convs/`，图片和文件保存在 `data/attachments/`。重启服务器不丢数据。
