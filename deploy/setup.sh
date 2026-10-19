#!/usr/bin/env bash
# ANIHUB 一键部署（Ubuntu / Debian，支持 x86_64 与 arm64）
#
#   用法（在服务器上，root 或 sudo）：
#     bash setup.sh /path/to/anihub
#
#   它会做：装 Node 22 → 建 anihub 用户 → 拷代码到 /opt/anihub →
#   生成访问口令 → 装 systemd 服务（开机自启）→ 起服务 → 健康检查
#
#   装完打印的地址就是分享链接（带口令），把那条发给朋友即可。

set -euo pipefail

SRC="${1:-}"
NODE_MAJOR=22
APP_DIR=/opt/anihub
RUN_USER=anihub
SVC=anihub
PORT=7788

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
fail()  { red "!! $*"; exit 1; }

# ---------- 0. 前置检查 ----------

[ "$(id -u)" -eq 0 ] || fail "请用 root 运行：sudo bash setup.sh <anihub目录>"

[ -n "$SRC" ] || fail "用法：sudo bash setup.sh /path/to/anihub"
[ -f "$SRC/server.mjs" ] || fail "找不到 $SRC/server.mjs，第一个参数要指向 anihub 目录"

if ! command -v apt-get >/dev/null 2>&1; then
  fail "只支持 Debian / Ubuntu（没有 apt-get）"
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|aarch64|arm64) ;;
  *) fail "不支持的架构：$ARCH" ;;
esac

# 端口占用检查
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$PORT" | grep -q ":$PORT"; then
  fail "端口 $PORT 已被占用，先停掉占用者（ss -ltnp | grep :$PORT）"
fi

echo
green "ANIHUB 部署开始"
dim "  源目录 $SRC"
dim "  架构   $ARCH"
dim "  目标   $APP_DIR"
echo

# ---------- 1. Node ----------

need_node=1
if command -v node >/dev/null 2>&1; then
  cur=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$cur" -ge 20 ] 2>/dev/null; then
    green "已装 Node $(node -v)，跳过安装"
    need_node=0
  fi
fi

if [ "$need_node" -eq 1 ]; then
  dim "装 Node $NODE_MAJOR ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 || fail "NodeSource 源配置失败（检查外网）"
    apt-get install -y nodejs >/dev/null 2>&1 || fail "npm/nodejs 安装失败"
  else
    fail "没有 curl，先装：apt-get install -y curl"
  fi
  green "Node $(node -v) 装好了"
fi

NODE_BIN=$(command -v node)

# ---------- 2. 用户 ----------

if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$RUN_USER"
  dim "建了系统用户 $RUN_USER"
fi

# ---------- 3. 代码 ----------

mkdir -p "$APP_DIR"
# 排除本地缓存和运行时产物
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'data/cache.json' \
    --exclude 'data/running.json' \
    --exclude 'node_modules' \
    --exclude '.git' \
    "$SRC"/ "$APP_DIR"/
else
  apt-get install -y rsync >/dev/null 2>&1
  rsync -a --delete \
    --exclude 'data/cache.json' --exclude 'data/running.json' \
    --exclude 'node_modules' --exclude '.git' \
    "$SRC"/ "$APP_DIR"/
fi
mkdir -p "$APP_DIR/data"
green "代码已同步到 $APP_DIR"

# ---------- 4. 口令 ----------

ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ] && grep -q '^ANIHUB_TOKEN=' "$ENV_FILE"; then
  TOKEN=$(grep '^ANIHUB_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  dim "沿用已有口令（$ENV_FILE）"
else
  TOKEN=$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")
  cat > "$ENV_FILE" <<EOF
ANIHUB_TOKEN=$TOKEN

# 媒体分片直连（省流量）：开着的话，确认支持跨域的 CDN 分片
# 由浏览器直接拉，服务器只发 API 和 m3u8。实测量子/非凡/360 支持，
# 无尽/北斗/最大 不支持会自动退回代理，不会放不出来。
ANIHUB_DIRECT=1

# ANIHUB_CACHE=0      # 关掉聚合缓存的磁盘落盘
# PORT=7788
EOF
  chmod 600 "$ENV_FILE"
  green "生成了新口令"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ---------- 5. systemd ----------

cat > "/etc/systemd/system/$SVC.service" <<EOF
[Unit]
Description=ANIHUB anime aggregator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
ExecStart=$NODE_BIN --max-old-space-size=256 server.mjs --port $PORT
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

# 收紧权限：只需要写 data/
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
systemctl restart "$SVC"
dim "systemd 服务 $SVC 已启动"

# ---------- 6. 健康检查 ----------

ok=0
for _ in $(seq 1 40); do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
done

if [ "$ok" -ne 1 ]; then
  red "!! 服务没起来，看日志："
  journalctl -u "$SVC" -n 40 --no-pager
  exit 1
fi

# ---------- 7. 访问方式 ----------

IP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo
green "部署完成"
echo
dim "  本机：   http://127.0.0.1:$PORT"
[ -n "$IP" ] && dim "  公网 IP： http://$IP:$PORT"
echo
echo "  口令：   $TOKEN"
echo "  分享链接： http://${IP:-你的IP}:$PORT/?t=$TOKEN"
echo
dim "  常用命令："
dim "    systemctl status $SVC"
dim "    journalctl -u $SVC -f"
dim "    systemctl restart $SVC"
dim "  改口令：编辑 $ENV_FILE 后 systemctl restart $SVC"
echo
dim "  想上 HTTPS / 绑定域名 → 接着看 DEPLOY.md 的「云服务器」一节"
