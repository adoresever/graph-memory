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
#    bash setup-graph-memory-pro.sh --uninstall           # 还原配置 + 停止 Neo4j
#    bash setup-graph-memory-pro.sh --skip-neo4j          # 复用已存在的 Neo4j（只装插件+写配置）
#    bash setup-graph-memory-pro.sh --skip-gds            # 不装 GDS（PageRank 会降级为均匀分）
#    bash setup-graph-memory-pro.sh --neo4j-password XXX  # 指定 Neo4j 密码（非交互）
#    bash setup-graph-memory-pro.sh --neo4j-version 5.26.0 --apoc-version 5.26.0
#    bash setup-graph-memory-pro.sh --no-restart          # 装完不重启 gateway
#
#  安全机制 / Safety：
#    - 改 openclaw.json 前自动备份
#    - 用 jq --arg 注入 API Key / 密码，杜绝命令注入
#    - Neo4j 只监听 127.0.0.1，不暴露公网
#    - 所有下载校验 HTTP 状态，失败即中止
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
NO_RESTART=false
NEO4J_PASSWORD=""
NEO4J_USER="neo4j"
NEO4J_URI=""                 # 留空 → 根据是否自建 Neo4j 自动决定
PLUGIN_REF=""
INTERACTIVE=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    --uninstall)      UNINSTALL=true ;;
    --skip-neo4j)     SKIP_NEO4J=true ;;
    --skip-gds)       SKIP_GDS=true ;;
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

# ============================================================
#  卸载流程
# ============================================================
if $UNINSTALL; then
  info "进入卸载模式 / Uninstall mode..."

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

command -v curl &>/dev/null || fail "缺少 curl / curl not found"
command -v tar  &>/dev/null || fail "缺少 tar / tar not found"
if ! command -v jq &>/dev/null; then
  warn "缺少 jq / jq missing —— 配置写入需要它 / config writes require jq"
  echo "    安装 / Install: sudo apt install jq   |   sudo dnf install jq   |   brew install jq"
  $INTERACTIVE || fail "非交互模式下 jq 必需 / jq required in --non-interactive"
  read -rp "    继续？/ Continue without jq? (y/n) [n]: " C; [[ "$C" =~ ^[yY]$ ]] || exit 0
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
  if command -v java &>/dev/null; then
    JAVA_MAJOR=$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+)\..*/\1/')
    # java 8 报 "1.8"
    [[ "$JAVA_MAJOR" == "1" ]] && JAVA_MAJOR=$(java -version 2>&1 | head -1 | sed -E 's/"1\.([0-9]+)\..*/\1/')
    if (( JAVA_MAJOR < 17 )); then
      fail "Java 版本过低 ($JAVA_MAJOR)，Neo4j 5.x 需要 JDK 17+ / Neo4j 5.x requires JDK 17+
    安装 / Install:
      sudo apt install -y openjdk-17-jdk
      sudo dnf install -y java-17-openjdk"
    fi
    success "Java $JAVA_MAJOR"
  else
    fail "未找到 java / java not found。Neo4j 5.x 需要 JDK 17：
    sudo apt install -y openjdk-17-jdk   |   sudo dnf install -y java-17-openjdk"
  fi
fi

# ── Step 2: 探测 OpenClaw / workspace / openclaw.json ──
echo ""
info "第 2 步：探测 OpenClaw / Detecting OpenClaw..."

HAS_OPENCLAW=false
command -v openclaw &>/dev/null && HAS_OPENCLAW=true
command -v pnpm &>/dev/null || warn "未找到 pnpm（若用 pnpm 安装插件会降级为手动注册）/ pnpm not found"

mkdir -p "$HOME/.openclaw"
if [[ ! -f "$OPENCLAW_JSON" ]]; then
  if $HAS_OPENCLAW; then
    info "初始化 openclaw.json / Seeding config via CLI..."
    $DRY_RUN && dry "openclaw config init"
    openclaw config init >/dev/null 2>&1 || echo '{}' > "$OPENCLAW_JSON"
  else
    warn "未找到 openclaw CLI，创建空配置 / No openclaw CLI, creating empty config"
    $DRY_RUN || echo '{}' > "$OPENCLAW_JSON"
  fi
fi
# 保证是合法 JSON 对象
jq -e 'type == "object"' "$OPENCLAW_JSON" >/dev/null 2>&1 || echo '{}' > "$OPENCLAW_JSON"
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

  mkdir -p "$GMP_HOME"
  TGZ="$GMP_HOME/neo4j.tar.gz"
  NEO4J_URL="$NEO4J_URL_BASE/neo4j-community-${NEO4J_VERSION}-unix.tar.gz"
  dl "$NEO4J_URL" "$TGZ"

  if ! $DRY_RUN; then
    info "解压 / Extracting..."
    rm -rf "$GMP_HOME/neo4j-community-"* "$NEO4J_DIR"
    tar xzf "$TGZ" -C "$GMP_HOME"
    EXTRACTED="$(ls -d "$GMP_HOME/neo4j-community-"* 2>/dev/null | head -1)"
    [[ -n "$EXTRACTED" ]] || fail "解压后未找到 neo4j 目录 / extracted dir not found"
    mv "$EXTRACTED" "$NEO4J_DIR"
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
  echo "    4) Jina        5) Ollama(本地) 6) 其他自定义 / custom"
  read -rp "  选择 / Choose (1-6) [1]: " PC; PC="${PC:-1}"
  case "$PC" in
    1) EMB_BASE="https://api.openai.com/v1";          EMB_MODEL="text-embedding-3-small"; EMB_DIM=512 ;;
    2) EMB_BASE="https://dashscope.aliyuncs.com/compatible-mode/v1"; EMB_MODEL="text-embedding-v4"; EMB_DIM=1024 ;;
    3) EMB_BASE="https://api.siliconflow.cn/v1";       EMB_MODEL="BAAI/bge-large-zh-v1.5"; EMB_DIM=1024 ;;
    4) EMB_BASE="https://api.jina.ai/v1";              EMB_MODEL="jina-embeddings-v3"; EMB_DIM=1024 ;;
    5) EMB_BASE="http://localhost:11434/v1";           EMB_MODEL="nomic-embed-text"; EMB_DIM=768 ;;
    6) read -rp "    Base URL: " EMB_BASE; read -rp "    Model: " EMB_MODEL; read -rp "    Dimensions [1024]: " EMB_DIM; EMB_DIM="${EMB_DIM:-1024}" ;;
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
echo ""
echo -e "  ${BOLD}验证 / Verify:${NC}"
echo    "    openclaw gateway --verbose   # 启动日志应见 [graph-memory-pro] ready"
echo    "    curl -s 127.0.0.1:7474       # Neo4j HTTP"
echo -e "  ${BOLD}Agent 工具:${NC} gm_search · gm_record · gm_stats · gm_maintain"
echo ""
