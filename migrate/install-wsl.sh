#!/usr/bin/env bash
# graph-memory-pro v2.0 WSL 安装 + 迁移 runbook
#
# 前置（唯一需要 sudo 的步骤）：
#   sudo apt update && sudo apt install -y openjdk-17-jre-headless
#
# 用法（在 WSL Ubuntu 内）：
#   cd /mnt/d/TEMP/graph-memory
#   bash migrate/install-wsl.sh
#
# 环境变量（可选）：
#   NEO4J_PASS       Neo4j 密码（默认 graphmemory）
#   SKIP_MIGRATE=1   跳过迁移（只装 v2.0 + Neo4j）
set -euo pipefail

NEO4J_PASS="${NEO4J_PASS:-graphmemory}"
SRC="/mnt/d/TEMP/graph-memory"
DEST="$HOME/graph-memory-pro"
GMP_HOME="$HOME/.graph-memory-pro"

green(){ printf "\033[32m%s\033[0m\n" "$1"; }
red(){ printf "\033[31m%s\033[0m\n" "$1"; }
info(){ printf "\033[36m%s\033[0m\n" "$1"; }

# ── 1. Java 检查 ──────────────────────────────────────────────
if ! command -v java >/dev/null 2>&1; then
  red "Java 未安装。请先运行："
  red "  sudo apt update && sudo apt install -y openjdk-17-jre-headless"
  exit 1
fi
green "Java OK: $(java -version 2>&1 | head -1)"

# ── 2. 同步源码到 WSL 原生路径（每次都 rsync，保证 setup 补丁更新）──
info "同步源码 → $DEST ..."
mkdir -p "$DEST"
rsync -a --exclude node_modules --exclude .codegraph \
  "$SRC/" "$DEST/"
cd "$DEST"
if [[ ! -d node_modules ]]; then
  info "npm install ..."; npm install --omit=dev 2>/dev/null || npm install
fi
green "源码就绪: $DEST"

# ── 3. 暂存已下载的制品（绕过代理下载大文件失败）─────────────
mkdir -p "$GMP_HOME/staging"
STAGING_SRC="$SRC/migrate/staging"
has_neo4j=0; has_apoc=0; has_gds=0
if [[ -f "$STAGING_SRC/neo4j.tar.gz" && -s "$STAGING_SRC/neo4j.tar.gz" ]]; then
  cp "$STAGING_SRC/neo4j.tar.gz" "$GMP_HOME/staging/neo4j.tar.gz"; has_neo4j=1
  green "暂存 Neo4j tarball"
fi
if [[ -f "$STAGING_SRC/apoc-5.24.2-core.jar" && -s "$STAGING_SRC/apoc-5.24.2-core.jar" ]]; then
  cp "$STAGING_SRC/apoc-5.24.2-core.jar" "$GMP_HOME/staging/apoc-5.24.2-core.jar"; has_apoc=1
  green "暂存 APOC jar"
fi
if [[ -f "$STAGING_SRC/neo4j-graph-data-science-2.12.0.jar" && -s "$STAGING_SRC/neo4j-graph-data-science-2.12.0.jar" ]]; then
  cp "$STAGING_SRC/neo4j-graph-data-science-2.12.0.jar" "$GMP_HOME/staging/neo4j-graph-data-science-2.12.0.jar"; has_gds=1
  green "暂存 GDS jar"
fi

# ── 4. 运行官方 setup 脚本 ────────────────────────────────────
SETUP_FLAGS=(--non-interactive --neo4j-password "$NEO4J_PASS" --no-restart)
if [[ $has_gds -eq 0 ]]; then
  info "GDS 未暂存 → 用 --skip-gds（PageRank 降级为均匀分；已迁移的 pagerank 值不受影响）"
  SETUP_FLAGS+=(--skip-gds)
fi
info "运行 setup-graph-memory-pro.sh ${SETUP_FLAGS[*]} ..."
bash setup-graph-memory-pro.sh "${SETUP_FLAGS[@]}"
green "Neo4j 已 provision 到 $GMP_HOME/neo4j/"
green "插件已注册为 contextEngine（openclaw.json 已备份 + 合并）"

# ── 5. tmux console 模式启动 Neo4j（绕过 WSL 会话退出杀 daemon）───
info "启动 Neo4j（tmux console，防 WSL 退出导致立即 shutdown）..."
NEO4J_BIN="$GMP_HOME/neo4j/bin"
tmux kill-session -t neo4j 2>/dev/null || true
tmux new-session -d -s neo4j "$NEO4J_BIN/neo4j console > /tmp/neo4j.log 2>&1"
for i in $(seq 1 40); do
  if "$NEO4J_BIN/cypher-shell" -u neo4j -p "$NEO4J_PASS" "RETURN 1" >/dev/null 2>&1; then
    green "Bolt 就绪（~$((i*3))s）"; break
  fi
  sleep 3
  [[ $i -eq 40 ]] && { red "Bolt 未就绪，查 /tmp/neo4j.log"; tail -8 /tmp/neo4j.log; exit 1; }
done

# ── 6. 自动配置：复制 llm/embedding + 禁用旧插件 ─────────────
info "复制 llm/embedding 配置 + 禁用旧 graph-memory 插件..."
python3 "$DEST/migrate/patch_config.py" 2>/dev/null || warn "patch_config.py 失败，手动编辑 openclaw.json 填 llm/embedding"
python3 -c "
import json,shutil,datetime,os
p=os.path.expanduser('~/.openclaw/openclaw.json')
shutil.copy(p,p+'.pre-disable.'+datetime.datetime.now().strftime('%Y%m%d_%H%M%S'))
c=json.load(open(p))
old=c['plugins']['entries'].get('graph-memory')
if old: old['enabled']=False; json.dump(c,open(p,'w'),indent=2,ensure_ascii=False); print('old graph-memory disabled')
" 2>/dev/null || warn "禁用旧插件失败，手动设 graph-memory.enabled=false"
green "配置完成（neo4j/llm/embedding 已填，旧插件已禁用）"

# ── 7. 迁移 ──────────────────────────────────────────────────
if [[ "${SKIP_MIGRATE:-0}" == "1" ]]; then
  green "SKIP_MIGRATE=1，跳过迁移。"; exit 0
fi

BACKUP=$(ls -t "$HOME"/graph-memory.db.bak-????????-?????? 2>/dev/null | grep -v -E -- '-(shm|wal)$' | head -1 || true)
if [[ -z "$BACKUP" ]]; then
  red "未找到 SQLite 备份。先运行: python3 $DEST/migrate/backup.py"; exit 1
fi
info "准备迁移环境（uv，避开 PEP 668 externally-managed）..."
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
cd "$DEST"
uv venv --quiet
uv pip install --quiet neo4j
info "运行迁移（--reset 首次干净导入）: $BACKUP → localhost:7687 ..."
.venv/bin/python migrate/migrate.py "$BACKUP" bolt://localhost:7687 neo4j "$NEO4J_PASS" --reset

green ""
green "═══════════════════════════════════════════════════════════"
green " 完成！最后一步：重启 gateway"
green "   ~/.npm-global/bin/openclaw gateway restart"
green "   ~/.npm-global/bin/openclaw gateway --verbose | grep graph-memory-pro"
green "   （应见 [graph-memory-pro] ready | neo4j=bolt://localhost:7687）"
[[ $has_gds -eq 0 ]] && green "   注：GDS 未装，PageRank 降级；浏览器下载 gds jar 放 $GMP_HOME/neo4j/plugins/ 后重启 Neo4j"
green "   Neo4j 在 tmux 会话 neo4j 里跑；WSL 重启后需重开：tmux new-session -d -s neo4j '$NEO4J_BIN/neo4j console > /tmp/neo4j.log 2>&1'"
green "═══════════════════════════════════════════════════════════"
