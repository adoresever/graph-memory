#!/usr/bin/env bash
# ============================================================
#  graph-memory-pro 一键安装 / 升级脚本 v1.0  (Linux)
#
#  OpenClaw 知识图谱上下文引擎 Pro 版 Linux 安装器
#  复刻 Windows 版 OpenClaw-Graph-2.0.0-win-x64.exe 的安装效果：
#    - 便携式 Neo4j 5.24.2（解压到 ~/.graph-memory-pro/neo4j，免 sudo）
#    - APOC 5.24.2 + GDS 2.12.0 插件
#    - 安装 graph-memory-pro 插件并注册为 contextEngine
#    - 写入 ~/.openclaw/openclaw.json（备份 + jq 安全合并）
#
#  用法 / Usage：
#    bash setup-graph-memory-pro.sh                       # 全新安装（交互式填 API Key）
#    bash setup-graph-memory-pro.sh --dry-run             # 只展示，不执行
#    bash setup-graph-memory-pro.sh --uninstall           # 还原配置 + 停止 Neo4j + 清理自启
#    bash setup-graph-memory-pro.sh --skip-neo4j          # 复用已存在的 Neo4j（只装插件+写配置）
#    bash setup-graph-memory-pro.sh --skip-gds            # 不装 GDS（PageRank 会降级为均匀分）
#    bash setup-graph-memory-pro.sh --skip-autostart      # 不配置 Neo4j 开机自启
#    bash setup-graph-memory-pro.sh --assume-deps         # 跳过 curl/tar/jq/java 依赖检查
#    bash setup-graph-memory-pro.sh --neo4j-password XXX  # 指定 Neo4j 密码（非交互）
#    bash setup-graph-memory-pro.sh --neo4j-version 5.26.0 --apoc-version 5.26.0
#    bash setup-graph-memory-pro.sh --no-restart          # 装完不重启 gateway
#
#  开机自启 / Autostart（无 sudo 三级降级 / no-sudo 3-tier fallback）：
#    仅在自建 Neo4j（非 --skip-neo4j）时配置。优先级：
#      1) systemd --user unit（~/.config/systemd/user/graph-memory-pro-neo4j.service）
#         额外尝试 loginctl enable-linger（成功则开机即起，失败则降级 cron 兜底）
#      2) cron @reboot（总是作为兜底配置，无 linger 时由 cron 在开机时拉起）
#      3) shell rc hook（~/.bashrc / ~/.zshrc 幂等片段，仅在以上都不可用时降级）
#    卸载时（--uninstall）自动清理所有上述条目。
#
#  安全机制 / Safety：
#    - 改 openclaw.json 前自动备份
#    - 用 jq --arg 注入 API Key / 密码，杜绝命令注入
#    - Neo4j 只监听 127.0.0.1，不暴露公网
#    - 所有下载校验 HTTP 状态，失败即中止
#    - 自启动仅写入用户私有目录（~/.config、用户 crontab、~/.bashrc），不触碰系统服务
# ============================================================

set -euo pipefail

# ── 临时文件清理 ──
_TMPFILES=()
cleanup_tmp() { for f in "${_TMPFILES[@]+"${_TMPFILES[@]}"}"; do rm -f "$f" 2>/dev/null || true; done; }
trap cleanup_tmp EXIT

# ── 默认版本与下载地址（均已 HEAD 校验可下载） ──
NEO4J_VERSION="${NEO4J_VERSION:-5.24.2}"
APOC_VERSION="${APOC_VERSION:-5.24.2}"        # APOC 主次版本须与 Neo4j 对齐
GDS_VERSION="${GDS_VERSION:-2.12.0}"          # GDS 2.12.x 兼容 Neo4j 5.x
NEO4J_URL_BASE="https://dist.neo4j.org"
APOC_URL_BASE="https://github.com/neo4j/apoc/releases/download"
GDS_URL_BASE="https://github.com/neo4j/graph-data-science/releases/download"

# ── 路径常量 ──
GMP_HOME="${GMP_HOME:-$HOME/.graph-memory-pro}"
NEO4J_DIR="$GMP_HOME/neo4j"
PLUGIN_ID="graph-memory-pro"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$GMP_HOME" in
  ""|/|"$HOME")
    echo "[ERR] GMP_HOME 必须是 HOME 下的专用目录 / GMP_HOME must be a dedicated directory under HOME" >&2
    exit 1
    ;;
esac

# ── 参数解析 ──
DRY_RUN=false
UNINSTALL=false
SKIP_NEO4J=false
SKIP_GDS=false
SKIP_AUTOSTART=false
ASSUME_DEPS=false
NO_RESTART=false
NEO4J_PASSWORD=""
NEO4J_USER="neo4j"
NEO4J_URI=""                 # 留空 → 根据是否自建 Neo4j 自动决定
PLUGIN_REF=""
INTERACTIVE=true
PC=""                        # 嵌入式 provider 选择（1-7）；交互模式由 read 赋值，非交互留空
AUTOSTART_METHODS=()         # configure_autostart 写入；卸载与完成提示读取
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    --uninstall)      UNINSTALL=true ;;
    --skip-neo4j)     SKIP_NEO4J=true ;;
    --skip-gds)       SKIP_GDS=true ;;
    --skip-autostart) SKIP_AUTOSTART=true ;;
    --assume-deps)    ASSUME_DEPS=true ;;
    --no-restart)     NO_RESTART=true ;;
    --non-interactive) INTERACTIVE=false ;;
    --neo4j-version)  shift; NEO4J_VERSION="${1:?--neo4j-version 需要参数}" ;;
    --neo4j-version=*) NEO4J_VERSION="${1#*=}" ;;
    --apoc-version)   shift; APOC_VERSION="${1:?--apoc-version 需要参数}" ;;
    --apoc-version=*)  APOC_VERSION="${1#*=}" ;;
    --gds-version)    shift; GDS_VERSION="${1:?--gds-version 需要参数}" ;;
    --gds-version=*)   GDS_VERSION="${1#*=}" ;;
    --neo4j-password) shift; NEO4J_PASSWORD="${1:?--neo4j-password 需要参数}" ;;
    --neo4j-password=*) NEO4J_PASSWORD="${1#*=}" ;;
    --neo4j-user)     shift; NEO4J_USER="${1:?--neo4j-user 需要参数}" ;;
    --neo4j-user=*)    NEO4J_USER="${1#*=}" ;;
    --neo4j-uri)      shift; NEO4J_URI="${1:?--neo4j-uri 需要参数}" ;;
    --neo4j-uri=*)     NEO4J_URI="${1#*=}" ;;
    --ref)            shift; PLUGIN_REF="${1:?--ref 需要参数}" ;;
    --ref=*)           PLUGIN_REF="${1#*=}" ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[ERR] 未知参数 / Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

# ── 颜色输出 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()    { echo -e "${RED}[ERR]${NC}  $1" >&2; exit 1; }
dry()     { echo -e "${YELLOW}[DRY]${NC} 将会执行 / Would run: $1"; }

echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  graph-memory-pro Linux 安装向导 v1.0${NC}"
echo -e "${BOLD}  Neo4j ${NEO4J_VERSION} · APOC ${APOC_VERSION} · GDS ${GDS_VERSION}${NC}"
echo -e "${BOLD}========================================${NC}"
$DRY_RUN   && echo -e "${YELLOW}  ⚡ DRY-RUN：只展示操作，不实际执行${NC}"
$SKIP_NEO4J && echo -e "${CYAN}  ⊘ SKIP-NEO4J：复用已有 Neo4j${NC}"
echo ""

# ============================================================
#  公共函数
# ============================================================

# jq 安全写入：jq_safe_write [--arg name val ...] "filter" file
jq_safe_write() {
  local args=()
  while [[ "${1:-}" == --* ]]; do args+=("$1" "$2" "$3"); shift 3; done
  local filter="$1"; local target="$2"
  jq "${args[@]+"${args[@]}"}" "$filter" "$target" > "${target}.tmp" || { rm -f "${target}.tmp"; return 1; }
  if jq empty "${target}.tmp" 2>/dev/null; then
    mv "${target}.tmp" "$target" || { rm -f "${target}.tmp"; return 1; }
  else
    rm -f "${target}.tmp"; warn "jq 输出非法，已中止 / jq output invalid"; return 1
  fi
}

# 下载校验（失败即中止）
dl() { # dl <url> <out>
  if $DRY_RUN; then dry "curl -fL $1 -o $2"; return 0; fi
  mkdir -p "$(dirname "$2")"
  # 优先用本地暂存（绕过代理下载大文件失败 / bypass proxy for large files）
  local staged="$GMP_HOME/staging/$(basename "$2")"
  if [[ -f "$staged" && -s "$staged" ]]; then
    cp "$staged" "$2"; success "使用本地暂存 / using staged: $(basename "$2")"; return 0
  fi
  info "下载 / Download: $1"
  curl -fL --connect-timeout 20 --retry 5 --retry-delay 3 "$1" -o "$2" \
    || fail "下载失败 / Download failed: $1"
}

# TCP 端口探活
wait_port() { # wait_port <host> <port> <seconds>
  local host="$1" port="$2" secs="$3" i=0
  while (( i < secs )); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 1; ((i++))
  done
  return 1
}

# ── 开机自启：无 sudo 三级降级 ──────────────────────────────────
# systemd --user（首选）+ cron @reboot（兜底）+ shell rc hook（最低保障）
# 设计：cron 总是配置作为兜底，systemd --user 可用时额外提供 systemctl 管理接口
# 副作用：写入 ~/.config/systemd/user/、用户 crontab、~/.bashrc 或 ~/.zshrc
AUTOSTART_MARKER="# gmp-neo4j-autostart"
SYSTEMD_UNIT_NAME="graph-memory-pro-neo4j.service"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SYSTEMD_UNIT_FILE="$SYSTEMD_USER_DIR/$SYSTEMD_UNIT_NAME"

write_systemd_unit() {
  mkdir -p "$SYSTEMD_USER_DIR"
  cat > "$SYSTEMD_UNIT_FILE" <<UNIT
[Unit]
Description=graph-memory-pro Neo4j (user-level, no sudo)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=$NEO4J_DIR/bin/neo4j start
ExecStop=$NEO4J_DIR/bin/neo4j stop
PIDFile=$NEO4J_DIR/run/neo4j.pid
RemainAfterExit=yes
Restart=on-failure
RestartSec=10
Environment=HOME=$HOME

[Install]
WantedBy=default.target
UNIT
}

configure_autostart() {
  AUTOSTART_METHODS=()
  if $DRY_RUN; then
    dry "mkdir -p $SYSTEMD_USER_DIR && write $SYSTEMD_UNIT_FILE"
    dry "systemctl --user daemon-reload && systemctl --user enable $SYSTEMD_UNIT_NAME"
    dry "loginctl enable-linger $USER (best-effort, no sudo)"
    dry "crontab -l | grep -v $AUTOSTART_MARKER; add @reboot $NEO4J_DIR/bin/neo4j start"
    dry "shell rc fallback: append idempotent pgrep hook to ~/.bashrc (only if systemd+cron fail)"
    AUTOSTART_METHODS+=("dry-run preview")
    return 0
  fi

  # Tier 1: systemd --user（首选）
  if command -v systemctl &>/dev/null && systemctl --user list-units >/dev/null 2>&1; then
    write_systemd_unit
    if systemctl --user daemon-reload 2>/dev/null \
       && systemctl --user enable "$SYSTEMD_UNIT_NAME" >/dev/null 2>&1; then
      AUTOSTART_METHODS+=("systemd --user ($SYSTEMD_UNIT_NAME)")
      # linger：让 user unit 在用户未登录时也运行。无需 sudo 的 polkit 配置下可成功，否则 warn
      if command -v loginctl &>/dev/null; then
        if loginctl show-user "$USER" 2>/dev/null | grep -q "^Linger=yes"; then
          success "  systemd --user 已就绪，linger 已启用 / linger active"
        elif loginctl enable-linger "$USER" 2>/dev/null; then
          success "  systemd --user 已就绪，linger 已启用 / linger enabled"
        else
          warn "  linger 需要 root（polkit），user unit 仅登录后启动 / linger needs root, unit starts after login"
          warn "    管理员执行 / admin runs: sudo loginctl enable-linger $USER"
          warn "    在那之前，cron @reboot 会兜底（见下）/ cron @reboot will cover the gap"
        fi
      fi
    fi
  fi

  # Tier 2: cron @reboot（总是配置作为兜底，不依赖 linger）
  if command -v crontab &>/dev/null; then
    local line="@reboot $NEO4J_DIR/bin/neo4j start >> \"$NEO4J_DIR/logs/autostart.log\" 2>&1 $AUTOSTART_MARKER"
    local tmp; tmp=$(mktemp)
    (crontab -l 2>/dev/null | grep -v "$AUTOSTART_MARKER" || true) > "$tmp"
    echo "$line" >> "$tmp"
    if crontab "$tmp" 2>/dev/null; then
      AUTOSTART_METHODS+=("cron @reboot")
    fi
    rm -f "$tmp"
  fi

  # Tier 3: shell rc hook（仅在前两者都失败时降级）
  if [[ ${#AUTOSTART_METHODS[@]} -eq 0 ]]; then
    local rc_target=""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      [[ -f "$rc" ]] && rc_target="$rc" && break
    done
    [[ -z "$rc_target" ]] && rc_target="$HOME/.bashrc"
    if ! grep -q "$AUTOSTART_MARKER" "$rc_target" 2>/dev/null; then
      cat >> "$rc_target" <<HOOK

$AUTOSTART_MARKER
if ! pgrep -f "$NEO4J_DIR" >/dev/null 2>&1; then
  nohup "$NEO4J_DIR/bin/neo4j" start >> "$NEO4J_DIR/logs/autostart.log" 2>&1 &
fi
HOOK
      AUTOSTART_METHODS+=("shell rc ($rc_target)")
    else
      AUTOSTART_METHODS+=("shell rc ($rc_target, 已存在)")
    fi
    warn "  systemd/cron 均不可用，降级到 $rc_target（登录时拉起）/ degraded to shell rc hook"
  fi

  if [[ ${#AUTOSTART_METHODS[@]} -gt 0 ]]; then
    success "开机自启已配置 / Autostart configured: ${AUTOSTART_METHODS[*]}"
  else
    warn "未能配置开机自启，请手动启动 / Manual start required: $NEO4J_DIR/bin/neo4j start"
  fi
}

remove_autostart() {
  $DRY_RUN && { dry "remove_autostart (systemd --user + cron + shell rc)"; return 0; }
  local cleaned=()

  if command -v systemctl &>/dev/null && [[ -f "$SYSTEMD_UNIT_FILE" ]]; then
    systemctl --user disable --now "$SYSTEMD_UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$SYSTEMD_UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    cleaned+=("systemd --user unit")
  fi

  if command -v crontab &>/dev/null; then
    local tmp; tmp=$(mktemp)
    (crontab -l 2>/dev/null | grep -v "$AUTOSTART_MARKER" || true) > "$tmp"
    if crontab "$tmp" 2>/dev/null; then
      cleaned+=("cron @reboot entry")
    fi
    rm -f "$tmp"
  fi

  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]] && grep -q "$AUTOSTART_MARKER" "$rc"; then
      local backup="${rc}.bak.$(date +%Y%m%d_%H%M%S)"
      cp "$rc" "$backup"
      sed -i "/$AUTOSTART_MARKER/,/^fi\$/d; /^$/N;/^\n$/D" "$rc"
      cleaned+=("$rc hook (备份 $backup)")
    fi
  done

  if [[ ${#cleaned[@]} -gt 0 ]]; then
    info "自启动已清理 / Autostart removed: ${cleaned[*]}"
  fi
}

# ============================================================
#  卸载流程
# ============================================================
if $UNINSTALL; then
  info "进入卸载模式 / Uninstall mode..."

  if $DRY_RUN; then
    remove_autostart
    [[ -f "$OPENCLAW_JSON" ]] && dry "restore latest openclaw.json backup or remove graph-memory-pro fields"
    [[ -x "$NEO4J_DIR/bin/neo4j" ]] && dry "$NEO4J_DIR/bin/neo4j stop"
    dry "preserve $GMP_HOME unless deletion is explicitly confirmed in a real uninstall"
    success "卸载预览完成，未修改任何文件或服务 / Uninstall preview complete; no files or services changed"
    exit 0
  fi

  # 先清理自启动条目（避免停 Neo4j 后又被自启拉起）
  remove_autostart

  # 还原 openclaw.json
  if [[ -f "$OPENCLAW_JSON" ]]; then
    LATEST=$(ls -t "$OPENCLAW_JSON".backup.* 2>/dev/null | head -1 || true)
    if [[ -n "$LATEST" ]]; then
      echo "  最新备份 / Latest backup: $LATEST"
      if $INTERACTIVE; then
        read -rp "  还原该备份？/ Restore? (y/n) [y]: " R; R="${R:-y}"
      else R="n"; fi
      if [[ "$R" =~ ^[yY]$ ]]; then
        cp "$OPENCLAW_JSON" "$OPENCLAW_JSON.before-uninstall.$(date +%Y%m%d_%H%M%S)"
        cp "$LATEST" "$OPENCLAW_JSON"; success "openclaw.json 已还原 / restored"
      fi
    else
      # 精确删除本插件相关字段
      if command -v jq &>/dev/null; then
        jq 'del(.plugins.slots.contextEngine) | del(.plugins.entries["graph-memory-pro"])' \
          "$OPENCLAW_JSON" > "$OPENCLAW_JSON.tmp" && mv "$OPENCLAW_JSON.tmp" "$OPENCLAW_JSON"
        success "已从配置精确移除 graph-memory-pro 字段 / removed plugin fields"
      else
        warn "无 jq 也无备份，请手动编辑 $OPENCLAW_JSON"
      fi
    fi
  fi

  # 停止自建 Neo4j
  if [[ -x "$NEO4J_DIR/bin/neo4j" ]]; then
    info "停止 Neo4j / Stopping Neo4j..."
    $DRY_RUN && dry "$NEO4J_DIR/bin/neo4j stop"
    "$NEO4J_DIR/bin/neo4j" stop >/dev/null 2>&1 || true
    if $INTERACTIVE; then
      read -rp "  删除 Neo4j 数据目录 $GMP_HOME？/ Delete $GMP_HOME? (y/n) [n]: " D; D="${D:-n}"
    else D="n"; fi
    [[ "$D" =~ ^[yY]$ ]] && { rm -rf "$GMP_HOME"; success "已删除 $GMP_HOME"; }
  fi

  echo ""
  success "卸载完成 / Uninstall complete。重启 gateway 生效：openclaw gateway restart"
  exit 0
fi

# ============================================================
#  安装流程
# ============================================================

# ── Step 1: 环境检查 ──
info "第 1 步：环境检查 / Environment check..."

if $ASSUME_DEPS; then
  warn "--assume-deps：跳过 curl/tar/jq/java 依赖检查 / skip dep checks（自负责保证已安装 / ensure they exist）"
else
  command -v curl &>/dev/null || fail "缺少 curl / curl not found"
  command -v tar  &>/dev/null || fail "缺少 tar / tar not found"
  if ! command -v jq &>/dev/null; then
    warn "缺少 jq / jq missing —— 配置写入需要它 / config writes require jq"
    echo "    安装（任选其一 / pick one）:"
    echo "      sudo apt install jq             # Debian/Ubuntu"
    echo "      sudo dnf install jq             # Fedora/RHEL"
    echo "      brew install jq                 # Homebrew (Linuxbrew)"
    echo "      # 无 sudo 替代 / no-sudo: 下载静态二进制到 ~/.local/bin"
    echo "      mkdir -p ~/.local/bin && curl -fL https://github.com/jqlang/jq/releases/latest/download/jq-linux64 -o ~/.local/bin/jq && chmod +x ~/.local/bin/jq"
    $INTERACTIVE || fail "非交互模式下 jq 必需 / jq required in --non-interactive"
    read -rp "    继续？/ Continue without jq? (y/n) [n]: " C; [[ "$C" =~ ^[yY]$ ]] || exit 0
  fi
fi

# OS / arch
OS="$(uname -s)"; ARCH="$(uname -m)"
[[ "$OS" == "Linux" ]] || warn "本脚本面向 Linux，当前=$OS / script targets Linux, running on $OS"
case "$ARCH" in
  x86_64)  ARCH_TAG="linux-x64" ;;
  aarch64|arm64) ARCH_TAG="linux-arm64" ;;
  *) warn "未测试的架构 / Untested arch: $ARCH（继续 / continuing）" ;;
esac
success "OS=$OS ARCH=$ARCH_TAG"

# Java 17（Neo4j 5.x 依赖）— 仅自建 Neo4j 时需要
if ! $SKIP_NEO4J; then
  if $ASSUME_DEPS; then
    info "--assume-deps：跳过 Java 检查 / skip Java check（启动失败时再排查 / troubleshoot on startup failure）"
  elif command -v java &>/dev/null; then
    JAVA_MAJOR=$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+)\..*/\1/')
    [[ "$JAVA_MAJOR" == "1" ]] && JAVA_MAJOR=$(java -version 2>&1 | head -1 | sed -E 's/"1\.([0-9]+)\..*/\1/')
    if (( JAVA_MAJOR < 17 )); then
      fail "Java 版本过低 ($JAVA_MAJOR)，Neo4j 5.x 需要 JDK 17+ / Neo4j 5.x requires JDK 17+
    安装（任选其一 / pick one）:
      sudo apt install -y openjdk-17-jdk        # Debian/Ubuntu
      sudo dnf install -y java-17-openjdk        # Fedora/RHEL
      # 无 sudo 替代 / no-sudo: sdkman! 或下载 JDK 解压
      curl -s \"https://get.sdkman.io\" | bash && source \"\$HOME/.sdkman/bin/sdkman-init.sh\" && sdk install java 17.0.13-tem"
    fi
    success "Java $JAVA_MAJOR"
  else
    fail "未找到 java / java not found。Neo4j 5.x 需要 JDK 17：
    sudo apt install -y openjdk-17-jdk | sudo dnf install -y java-17-openjdk
    无 sudo / no-sudo: curl -s https://get.sdkman.io | bash && source \$HOME/.sdkman/bin/sdkman-init.sh && sdk install java 17.0.13-tem"
  fi
fi

# ── Step 2: 探测 OpenClaw / workspace / openclaw.json ──
echo ""
info "第 2 步：探测 OpenClaw / Detecting OpenClaw..."

HAS_OPENCLAW=false
command -v openclaw &>/dev/null && HAS_OPENCLAW=true
command -v pnpm &>/dev/null || warn "未找到 pnpm（若用 pnpm 安装插件会降级为手动注册）/ pnpm not found"

if $DRY_RUN; then
  [[ -d "$HOME/.openclaw" ]] || dry "mkdir -p $HOME/.openclaw"
  if [[ ! -f "$OPENCLAW_JSON" ]]; then
    dry "initialize $OPENCLAW_JSON"
  elif ! jq -e 'type == "object"' "$OPENCLAW_JSON" >/dev/null 2>&1; then
    dry "replace invalid $OPENCLAW_JSON with an empty JSON object"
  fi
else
  mkdir -p "$HOME/.openclaw"
  if [[ ! -f "$OPENCLAW_JSON" ]]; then
    if $HAS_OPENCLAW; then
      info "初始化 openclaw.json / Seeding config via CLI..."
      openclaw config init >/dev/null 2>&1 || echo '{}' > "$OPENCLAW_JSON"
    else
      warn "未找到 openclaw CLI，创建空配置 / No openclaw CLI, creating empty config"
      echo '{}' > "$OPENCLAW_JSON"
    fi
  fi
  jq -e 'type == "object"' "$OPENCLAW_JSON" >/dev/null 2>&1 || echo '{}' > "$OPENCLAW_JSON"
fi
success "配置文件: $OPENCLAW_JSON"

# 探测插件源目录（含 openclaw.plugin.json 的目录，默认 = 脚本所在目录）
PLUGIN_SRC="$SCRIPT_DIR"
[[ -f "$PLUGIN_SRC/openclaw.plugin.json" ]] || PLUGIN_SRC=""
if [[ -z "$PLUGIN_SRC" ]]; then
  if $INTERACTIVE; then
    read -rp "  未在脚本目录找到插件源，请输入 graph-memory-pro 源码路径 / Plugin source path: " PLUGIN_SRC
    [[ -f "$PLUGIN_SRC/openclaw.plugin.json" ]] || fail "未找到 $PLUGIN_SRC/openclaw.plugin.json"
  else
    fail "未找到插件源（需含 openclaw.plugin.json）/ plugin source not found"
  fi
fi
success "插件源: $PLUGIN_SRC"

# ── Step 3: Neo4j ──
NEO4J_BOLT_PORT=7687
if $SKIP_NEO4J; then
  echo ""
  info "第 3 步：跳过 Neo4j 安装（--skip-neo4j）/ Skip Neo4j setup"
  [[ -z "$NEO4J_URI" ]] && NEO4J_URI="bolt://localhost:7687"
  [[ -z "$NEO4J_PASSWORD" ]] && {
    if $INTERACTIVE; then read -rp "  Neo4j 密码 / Neo4j password: " NEO4J_PASSWORD
    else fail "--skip-neo4j + --non-interactive 需配合 --neo4j-password"; fi; }
else
  echo ""
  info "第 3 步：安装便携式 Neo4j / Install portable Neo4j ${NEO4J_VERSION}..."

  # 生成密码
  if [[ -z "$NEO4J_PASSWORD" ]]; then
    NEO4J_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
    [[ -n "$NEO4J_PASSWORD" ]] || NEO4J_PASSWORD="neo4j-pass-$(date +%s)"
    info "已生成随机密码 / Generated password: $NEO4J_PASSWORD  （请妥善保存 / save it）"
  fi
  NEO4J_URI="bolt://localhost:${NEO4J_BOLT_PORT}"

  if $DRY_RUN; then
    [[ -d "$GMP_HOME" ]] || dry "mkdir -p $GMP_HOME"
  else
    mkdir -p "$GMP_HOME"
  fi
  TGZ="$GMP_HOME/neo4j.tar.gz"
  NEO4J_URL="$NEO4J_URL_BASE/neo4j-community-${NEO4J_VERSION}-unix.tar.gz"
  dl "$NEO4J_URL" "$TGZ"

  if ! $DRY_RUN; then
    info "解压 / Extracting..."
    rm -rf "$GMP_HOME/neo4j-community-"*
    tar xzf "$TGZ" -C "$GMP_HOME"
    EXTRACTED="$(ls -d "$GMP_HOME/neo4j-community-"* 2>/dev/null | head -1)"
    [[ -n "$EXTRACTED" ]] || fail "解压后未找到 neo4j 目录 / extracted dir not found"

    UPGRADE_BACKUP=""
    if [[ -d "$NEO4J_DIR" ]]; then
      info "检测到现有 Neo4j，停止服务并保留 data/ / Existing Neo4j found; preserving data/"
      [[ -x "$NEO4J_DIR/bin/neo4j" ]] && "$NEO4J_DIR/bin/neo4j" stop >/dev/null 2>&1 || true
      UPGRADE_BACKUP="$GMP_HOME/neo4j.upgrade-backup.$(date +%Y%m%d_%H%M%S)"
      [[ ! -e "$UPGRADE_BACKUP" ]] || fail "升级备份目录已存在 / upgrade backup already exists: $UPGRADE_BACKUP"
      mv "$NEO4J_DIR" "$UPGRADE_BACKUP"
    fi

    if ! mv "$EXTRACTED" "$NEO4J_DIR"; then
      [[ -n "$UPGRADE_BACKUP" ]] && mv "$UPGRADE_BACKUP" "$NEO4J_DIR"
      fail "安装新 Neo4j 目录失败，已恢复旧版本 / failed to install new Neo4j; previous version restored"
    fi

    if [[ -n "$UPGRADE_BACKUP" && -d "$UPGRADE_BACKUP/data" ]]; then
      rm -rf "$NEO4J_DIR/data"
      if ! mv "$UPGRADE_BACKUP/data" "$NEO4J_DIR/data"; then
        rm -rf "$NEO4J_DIR"
        mv "$UPGRADE_BACKUP" "$NEO4J_DIR"
        fail "恢复 Neo4j 数据失败，已回滚旧版本 / failed to restore Neo4j data; previous version restored"
      fi
      rm -rf "$UPGRADE_BACKUP"
      success "Neo4j data/ 已保留 / existing Neo4j data preserved"
    fi

    rm -f "$TGZ"
    success "Neo4j 解压到 / extracted to $NEO4J_DIR"
  else
    dry "tar xzf $TGZ -C $GMP_HOME && mv ... $NEO4J_DIR"
  fi

  # ── 插件：APOC（必需）+ GDS（可选）──
  APOC_JAR="$NEO4J_DIR/plugins/apoc-${APOC_VERSION}-core.jar"
  dl "$APOC_URL_BASE/${APOC_VERSION}/apoc-${APOC_VERSION}-core.jar" "$APOC_JAR"
  if ! $SKIP_GDS; then
    GDS_JAR="$NEO4J_DIR/plugins/neo4j-graph-data-science-${GDS_VERSION}.jar"
    dl "$GDS_URL_BASE/${GDS_VERSION}/neo4j-graph-data-science-${GDS_VERSION}.jar" "$GDS_JAR"
  else
    warn "已跳过 GDS（--skip-gds）：PageRank/PPR 将降级为均匀分布 / PageRank degrades to uniform"
  fi

  # ── neo4j.conf（5.x 配置键）──
  if ! $DRY_RUN; then
    CONF="$NEO4J_DIR/conf/neo4j.conf"
    mkdir -p "$NEO4J_DIR/plugins"
    # 去掉同键旧注释行后追加我们的设置（幂等）
    for k in server.default_listen_address server.bolt.listen_address \
             server.http.listen_address dbms.memory.heap.initial_size \
             dbms.security.procedures.unrestricted dbms.security.procedures.allowlist; do
      sed -i "/^#\?$k\s*=/d; /^$k\s*=/d" "$CONF"
    done
    {
      echo "# ── graph-memory-pro ──"
      echo "server.default_listen_address=127.0.0.1"
      echo "server.bolt.listen_address=127.0.0.1:${NEO4J_BOLT_PORT}"
      echo "server.http.listen_address=127.0.0.1:7474"
      echo "dbms.memory.heap.initial_size=512m"
      echo "dbms.security.procedures.unrestricted=apoc.*,gds.*"
      echo "dbms.security.procedures.allowlist=apoc.*,gds.*"
    } >> "$CONF"
    # apoc.conf
    echo "apoc.trigger.enabled=true" > "$NEO4J_DIR/conf/apoc.conf"
    success "neo4j.conf 已配置 / configured"
  else
    dry "edit $NEO4J_DIR/conf/neo4j.conf + conf/apoc.conf"
  fi

  # ── 设初始密码（必须在首次启动前）──
  if ! $DRY_RUN; then
    info "设置 Neo4j 初始密码 / Setting initial password..."
    # 若数据已存在则跳过（neo4j-admin 会报错）
    if "$NEO4J_DIR/bin/neo4j-admin" dbms set-initial-password "$NEO4J_PASSWORD" 2>/dev/null; then
      success "初始密码已设置 / initial password set"
    else
      warn "设置初始密码失败（数据库可能已初始化）/ may already be initialized"
      info "如忘记密码可重建数据目录：rm -rf $NEO4J_DIR/data"
    fi
  else
    dry "$NEO4J_DIR/bin/neo4j-admin dbms set-initial-password ***"
  fi

  # ── 启动 Neo4j ──
  if ! $DRY_RUN; then
    info "启动 Neo4j / Starting Neo4j..."
    "$NEO4J_DIR/bin/neo4j" start >/dev/null 2>&1 || true
    info "等待 Bolt 端口 ${NEO4J_BOLT_PORT} / Waiting for Bolt..."
    if wait_port 127.0.0.1 "$NEO4J_BOLT_PORT" 90; then
      success "Neo4j Bolt 已就绪 / Bolt ready"
    else
      warn "Bolt 90s 内未就绪，查看日志 / Bolt not ready, check: $NEO4J_DIR/logs/neo4j.log"
    fi
  else
    dry "$NEO4J_DIR/bin/neo4j start"; dry "wait_port 127.0.0.1 $NEO4J_BOLT_PORT 90"
  fi

  # ── 校验 APOC / GDS 加载 ──
  if ! $DRY_RUN && [[ -x "$NEO4J_DIR/bin/cypher-shell" ]]; then
    if APOC_VER=$("$NEO4J_DIR/bin/cypher-shell" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" --format plain "RETURN apoc.version() AS v" 2>/dev/null | tail -1); then
      success "APOC 已加载 / loaded: $APOC_VER"
    else
      warn "APOC 校验失败 —— 插件创建关系会出错 / APOC check failed (edge creation needs APOC)"
    fi
    if ! $SKIP_GDS; then
      if GDS_VER=$("$NEO4J_DIR/bin/cypher-shell" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" --format plain "CALL gds.version() YIELD version RETURN version" 2>/dev/null | tail -1); then
        success "GDS 已加载 / loaded: $GDS_VER"
      else
        warn "GDS 校验失败 —— PageRank 将降级 / GDS check failed (PageRank will degrade)"
      fi
    fi
  fi
fi

success "Neo4j: $NEO4J_URI  (user=$NEO4J_USER)"

# ── Step 3.5: 配置 Neo4j 开机自启（无 sudo 三级降级）──
# 仅自建 Neo4j 路径下配置；--skip-neo4j 跳过（复用外部 Neo4j 应由其自身管理）
echo ""
if $SKIP_NEO4J; then
  info "第 3.5 步：跳过开机自启（--skip-neo4j，外部 Neo4j 自管）/ Skip autostart (external Neo4j)"
elif $SKIP_AUTOSTART; then
  info "第 3.5 步：跳过开机自启（--skip-autostart）/ Skip autostart config"
  warn "  Neo4j 重启后需手动启动 / Manual start after reboot: $NEO4J_DIR/bin/neo4j start"
else
  info "第 3.5 步：配置 Neo4j 开机自启 / Configure autostart（无 sudo / no sudo）..."
  configure_autostart
fi

# ── Step 4: 安装插件 ──
echo ""
info "第 4 步：安装 graph-memory-pro 插件 / Install plugin..."

INSTALLED=false
if $HAS_OPENCLAW && command -v pnpm &>/dev/null && ! $DRY_RUN; then
  if pnpm openclaw plugins install "$PLUGIN_SRC" 2>/dev/null; then
    success "已通过 openclaw CLI 安装 / installed via CLI"; INSTALLED=true
  fi
fi
if ! $INSTALLED; then
  # 降级：手动注册 plugins.load.paths
  info "降级为手动注册 plugins.load.paths / Falling back to manual registration"
  if ! $DRY_RUN; then
    if command -v jq &>/dev/null; then
      # 幂等加入路径
      jq --arg p "$PLUGIN_SRC" \
         '.plugins.load=(.plugins.load // {}) | .plugins.load.paths=((.plugins.load.paths // []) + [$p] | unique)' \
         "$OPENCLAW_JSON" > "$OPENCLAW_JSON.tmp" && mv "$OPENCLAW_JSON.tmp" "$OPENCLAW_JSON"
      # 安装依赖
      if [[ -f "$PLUGIN_SRC/package.json" ]]; then
        (cd "$PLUGIN_SRC" && npm install --omit=dev --loglevel=error 2>&1 | tail -2) || warn "npm install 失败，请手动运行 / npm install failed, run manually"
      fi
      success "已注册插件路径 / registered path: $PLUGIN_SRC"
    else
      warn "无 jq：请手动在 $OPENCLAW_JSON 的 plugins.load.paths 加入 $PLUGIN_SRC"
    fi
  else
    dry "jq add plugins.load.paths += $PLUGIN_SRC"; dry "cd $PLUGIN_SRC && npm install"
  fi
fi

# ── Step 5: 收集 LLM / Embedding 配置 ──
echo ""
info "第 5 步：配置 LLM / Embedding（回车跳过则写占位符）/ API config"

LLM_API_KEY=""; LLM_BASE=""; LLM_MODEL=""
EMB_API_KEY=""; EMB_BASE=""; EMB_MODEL=""; EMB_DIM=""

if $INTERACTIVE; then
  echo -e "  ${BOLD}LLM 提供方 / LLM provider${NC}（用于知识提取，建议便宜快速的模型）"
  read -rp "    LLM API Key (回车跳过 / Enter to skip): " LLM_API_KEY
  if [[ -n "$LLM_API_KEY" ]]; then
    read -rp "    LLM Base URL [https://api.openai.com/v1]: " LLM_BASE; LLM_BASE="${LLM_BASE:-https://api.openai.com/v1}"
    read -rp "    LLM Model [gpt-4o-mini]: " LLM_MODEL; LLM_MODEL="${LLM_MODEL:-gpt-4o-mini}"
  fi

  echo ""
  echo -e "  ${BOLD}Embedding 提供方 / Embedding provider${NC}（语义召回+去重，不配则退化为关键词搜索）"
  echo "    1) OpenAI      2) DashScope   3) SiliconFlow"
  echo "    4) Jina        5) Ollama(本地) 6) MiniMax CodePlan"
  echo "    7) 其他自定义 / custom"
  read -rp "  选择 / Choose (1-7) [1]: " PC; PC="${PC:-1}"
  case "$PC" in
    1) EMB_BASE="https://api.openai.com/v1";          EMB_MODEL="text-embedding-3-small"; EMB_DIM=512 ;;
    2) EMB_BASE="https://dashscope.aliyuncs.com/compatible-mode/v1"; EMB_MODEL="text-embedding-v4"; EMB_DIM=1024 ;;
    3) EMB_BASE="https://api.siliconflow.cn/v1";       EMB_MODEL="BAAI/bge-large-zh-v1.5"; EMB_DIM=1024 ;;
    4) EMB_BASE="https://api.jina.ai/v1";              EMB_MODEL="jina-embeddings-v3"; EMB_DIM=1024 ;;
    5) EMB_BASE="http://localhost:11434/v1";           EMB_MODEL="nomic-embed-text"; EMB_DIM=768 ;;
    6) EMB_BASE="https://api.minimaxi.com/v1";         EMB_MODEL="embo-01"; EMB_DIM=1536 ;;
    7) read -rp "    Base URL: " EMB_BASE; read -rp "    Model: " EMB_MODEL; read -rp "    Dimensions [1024]: " EMB_DIM; EMB_DIM="${EMB_DIM:-1024}" ;;
    *) warn "无效选择，使用 OpenAI 默认 / invalid, defaulting to OpenAI"
       EMB_BASE="https://api.openai.com/v1"; EMB_MODEL="text-embedding-3-small"; EMB_DIM=512 ;;
  esac
  read -rp "    Embedding API Key (Ollama 回车跳过 / Enter to skip for local): " EMB_API_KEY
  [[ -z "$EMB_API_KEY" && "$PC" != "5" ]] && warn "未填 Key，将写入占位符 / placeholder saved"
else
  warn "非交互模式：跳过 API 配置（稍后手动编辑 openclaw.json）/ non-interactive: edit config manually later"
fi

# ── Step 6: 写入 openclaw.json（备份 + jq 安全合并）──
echo ""
info "第 6 步：写入配置 / Writing openclaw.json（备份 / backup first）..."

if ! $DRY_RUN; then
  [[ -f "$OPENCLAW_JSON" ]] && cp "$OPENCLAW_JSON" "$OPENCLAW_JSON.backup.$(date +%Y%m%d_%H%M%S)"

  # 检测是否已注册其它 contextEngine
  EXISTING_CE=$(jq -r '.plugins.slots.contextEngine // empty' "$OPENCLAW_JSON")
  if [[ -n "$EXISTING_CE" && "$EXISTING_CE" != "$PLUGIN_ID" ]]; then
    warn "已存在 contextEngine=$EXISTING_CE，将被覆盖为 $PLUGIN_ID / will override"
    if $INTERACTIVE; then
      read -rp "  继续？/ Continue? (y/n) [n]: " C; [[ "$C" =~ ^[yY]$ ]] || fail "用户取消 / aborted"
    fi
  fi

  # 激活 contextEngine slot
  jq --arg id "$PLUGIN_ID" '.plugins.slots.contextEngine=$id' "$OPENCLAW_JSON" > "$OPENCLAW_JSON.tmp" \
    && mv "$OPENCLAW_JSON.tmp" "$OPENCLAW_JSON"

  # 构造 config 对象（用 --arg 注入，防注入）
  CFG_FILTER='
    .plugins.entries=(.plugins.entries // {})
    | .plugins.entries["'"$PLUGIN_ID"'"]=({
      enabled: true,
      config: ({
        neo4j: { uri: $uri, user: $user, password: $pw },
        compactTurnCount: 6, recallMaxNodes: 6, recallMaxDepth: 2,
        dedupThreshold: 0.90, pagerankDamping: 0.85, pagerankIterations: 20
      }
      | if ($lkey | length) > 0 then .llm={apiKey:$lkey, baseURL:$lbase, model:$lmodel} else . end
      | if ($ekey | length) > 0 or $elocal=="1" then .embedding={apiKey:$ekey, baseURL:$ebase, model:$emodel, dimensions:($edim|tonumber)} else . end
      )
    })'
  jq_safe_write \
    --arg uri "$NEO4J_URI" --arg user "$NEO4J_USER" --arg pw "$NEO4J_PASSWORD" \
    --arg lkey "${LLM_API_KEY:-}" --arg lbase "${LLM_BASE:-}" --arg lmodel "${LLM_MODEL:-}" \
    --arg ekey "${EMB_API_KEY:-}" --arg ebase "${EMB_BASE:-}" --arg emodel "${EMB_MODEL:-}" \
    --arg edim "${EMB_DIM:-1024}" --arg elocal "$([[ "$PC" == "5" ]] && echo 1 || echo 0)" \
    "$CFG_FILTER" "$OPENCLAW_JSON" \
    || fail "写入配置失败 / failed to write config"

  # 校验
  jq -e ".plugins.slots.contextEngine==\"$PLUGIN_ID\" and .plugins.entries[\"$PLUGIN_ID\"].config.neo4j.uri==\"$NEO4J_URI\"" \
    "$OPENCLAW_JSON" >/dev/null || fail "配置校验失败 / config verification failed"
  success "配置已写入并校验 / config written & verified"
else
  dry "backup + jq write: slots.contextEngine=$PLUGIN_ID, entries.$PLUGIN_ID.config.neo4j={uri:$NEO4J_URI,user:$NEO4J_USER}"
fi

# ── Step 7: 重启 gateway ──
echo ""
info "第 7 步：重启 gateway / Restart gateway..."
if $NO_RESTART; then
  warn "--no-restart：请手动重启 / restart manually: openclaw gateway restart"
elif $HAS_OPENCLAW && ! $DRY_RUN; then
  openclaw gateway restart 2>&1 | tail -3 || warn "重启失败，请手动 / restart failed, run: openclaw gateway restart"
  success "gateway 已重启 / restarted"
else
  warn "无 openclaw CLI 或 dry-run：请手动重启 / restart manually: openclaw gateway restart"
fi

# ── 完成 ──
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✅ graph-memory-pro 安装完成${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "  Neo4j Bolt : ${BOLD}$NEO4J_URI${NC}"
echo -e "  Neo4j 用户 : $NEO4J_USER"
[[ -n "$NEO4J_PASSWORD" ]] && echo -e "  Neo4j 密码 : ${YELLOW}$NEO4J_PASSWORD${NC}  （已写入 openclaw.json）"
echo -e "  插件路径   : $PLUGIN_SRC"
echo -e "  配置文件   : $OPENCLAW_JSON"
if ! $SKIP_NEO4J && ! $SKIP_AUTOSTART && [[ ${#AUTOSTART_METHODS[@]} -gt 0 ]]; then
  echo -e "  ${BOLD}开机自启 / Autostart:${NC} ${AUTOSTART_METHODS[*]}"
  echo    "    管理命令 / manage: systemctl --user {status|stop|start} $SYSTEMD_UNIT_NAME  (systemd 路径)"
  echo    "                 crontab -l | grep $AUTOSTART_MARKER  (查看 cron 条目)"
fi
echo ""
echo -e "  ${BOLD}验证 / Verify:${NC}"
echo    "    openclaw gateway --verbose   # 启动日志应见 [graph-memory-pro] ready"
echo    "    curl -s 127.0.0.1:7474       # Neo4j HTTP"
echo -e "  ${BOLD}Agent 工具:${NC} gm_search · gm_record · gm_stats · gm_maintain"
echo ""
