#!/usr/bin/env bash
# ???? ? ????????????Ubuntu/Debian/CentOS?
set -e
APP_DIR=/opt/yingzi-sync
SERVICE=yingzi-sync
PORT=${PORT:-8787}
if [ -z "$SYNC_TOKEN" ]; then
  SYNC_TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "?????????: $SYNC_TOKEN"
  echo "????????App ????????????"
else
  echo "??????????"
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "?? root ? sudo ?????"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "?? Node.js..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    echo "?????? Node.js??????????"
    exit 1
  fi
fi

mkdir -p "$APP_DIR" "$APP_DIR/data/convs" "$APP_DIR/data/attachments"
cp "$(dirname "$0")/server.js" "$APP_DIR/server.js"
cp "$(dirname "$0")/package.json" "$APP_DIR/package.json" 2>/dev/null || true

cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Yingzi group sync server
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=SYNC_TOKEN=$SYNC_TOKEN
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE

if command -v ufw >/dev/null 2>&1; then
  ufw allow $PORT/tcp || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=$PORT/tcp || true
  firewall-cmd --reload || true
fi

echo "????"
echo "????: http://?????IP:$PORT"
echo "????: http://?????IP:$PORT/health"
echo "????: $SYNC_TOKEN"
