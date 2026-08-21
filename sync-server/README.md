# 英子起飞 · 群聊同步服务器

跑在你电脑或云服务器上的小服务，让两台手机实时同步群聊，不再依赖 ntfy。

## 本地 / Tailscale 使用

1. 电脑安装 Node.js（推荐 18 以上），双击 `start-server.bat`，或运行 `node server.js`。
2. 电脑与两台手机都安装 Tailscale 并登录同一账号，组成虚拟局域网。
3. App 设置 → 群聊服务器地址填 `http://电脑TailscaleIP:8787`（可选填群聊同步密钥）。

## 国内云服务器部署（推荐，无需 VPN）

两台手机不在同一地点时，租一台国内轻量云服务器，2 核 2G 即可，地域选离你们近的城市，系统选 Ubuntu 22.04 / Debian。

1. 把本目录的 `server.js`、`package.json`、`deploy.sh` 上传到服务器，例如 `/root`。
2. SSH 登录后运行：

   ```bash
   chmod +x deploy.sh
   SYNC_TOKEN=你的访问密钥 ./deploy.sh
   ```

3. 在云厂商控制台安全组放行 `8787/TCP`。
4. App 设置 → 群聊服务器地址填 `http://服务器公网IP:8787`，群聊同步密钥填刚才的 `SYNC_TOKEN`。
5. 新建群聊并分享链接，朋友点击即自动带地址和密钥加入。

密钥通过环境变量 `SYNC_TOKEN` 设置；不设置则不校验（仅建议内网使用）。

## 验证

浏览器打开 `http://127.0.0.1:8787/health`，看到 `{"ok":true}` 就成功了。

## 数据

对话保存在 `data/convs/`，图片和文件保存在 `data/attachments/`。重启服务器不丢数据。
