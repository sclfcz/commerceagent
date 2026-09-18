#!/bin/bash
set -e

# Default to owner-only creation. Rootless mode switches to 0007 after its
# owner-root/group-node bridge is ready; no mode grants access to "other".
umask 0077

# This root-owned helper accepts no runtime-configurable path.
# shellcheck source=session-permissions.sh
source /app/session-permissions.sh
commerceagent_configure_node_identity

# Prepare only explicit writable roots. Direct mode touches roots and performs
# a separate one-time legacy migration below; rootless defers to its verified
# bridge; host-root/Desktop preserve owner-only modes.
commerceagent_prepare_mounted_paths
commerceagent_migrate_direct_managed_paths

# Mark mounted directories as safe for git (CVE-2022-24765 ownership check).
# Host uid may differ from container node user, causing git to refuse operations.
# 使用通配符 '*' 因为挂载路径动态（extra mounts、customCwd），无法枚举具体目录。
runuser -u node -- env HOME=/home/node /usr/bin/git \
  config --global --add safe.directory '*'

# Source ordinary runtime variables while locally shadowing every root-control
# variable, including stale values persisted before the host-side denylist.
commerceagent_source_runtime_env

# Prepend agent-runner 的本地 node_modules/.bin 到 PATH。
# agent-runner/package.json 声明了 @anthropic-ai/claude-code 依赖，npm install
# 会在 /app/node_modules/.bin/claude 生成 shim。但若不把该目录加入 PATH，
# agent-runner 内 `which claude` 找不到 CLI，SDK 会 fallback 到空的 native
# binary optionalDependency（@anthropic-ai/claude-agent-sdk-linux-x64 等）
# 导致 "Native CLI binary for linux-x64 not found" 启动失败。
export PATH="/app/node_modules/.bin:${PATH}"

# CLAUDE_CONFIG_DIR: CLI 默认用 $HOME/.claude.json 作为身份文件，但该文件被
# readonly 挂载（避免容器篡改宿主机配置）。CLI 启动时尝试写入（更新 numStartups
# 等计数器），readonly 导致静默失败 → query() 返回 0 messages。
# 显式设 CLAUDE_CONFIG_DIR 让 CLI 改读写 /home/node/.claude/.claude.json（session
# 目录，可写），与宿主机模式的 hostEnv['CLAUDE_CONFIG_DIR'] 保持一致。
export CLAUDE_CONFIG_DIR=/home/node/.claude

# IS_SANDBOX: Claude Code 2.1.114+ 要求 IS_SANDBOX=1 才允许 --dangerously-skip-permissions。
# 与宿主机模式的 hostEnv['IS_SANDBOX'] = '1' 保持一致。
export IS_SANDBOX=1

# Persist Agent's `npm install -g <pkg>` to per-user mounted extra dir.
# 容器是 docker run --rm 模式，每次结束销毁。如果 Agent 在容器里跑
# `npm install -g lark-cli`、`@fanfanv5/feishu-cli`、各类 MCP server 包等，
# 默认会装到镜像内层 /usr/local/lib/node_modules，下次新容器又得重装。
# 把 npm prefix 指向已挂载的 /workspace/extra/.npm-global（host 端
# data/extra/{folder}/.npm-global/，per-user 隔离）即可让全局包持久化。
NPM_GLOBAL_DIR=/workspace/extra/.npm-global
/usr/local/bin/node /app/session-generated-paths.mjs --ensure-npm-global
commerceagent_prepare_generated_path npm-global
# 写到 node user 的 ~/.npmrc 让 npm 全局命令默认走该 prefix。
# 镜像每次启动重置 /home/node，所以 entrypoint 每次都重写一遍是稳妥做法。
cat > /home/node/.npmrc <<EOF
prefix=$NPM_GLOBAL_DIR
EOF
chown node:node /home/node/.npmrc 2>/dev/null || true
# 注意：append 而非 prepend，避免持久化的 npm shim 屏蔽 /app/node_modules/.bin 中 SDK 自带的 claude CLI（见上方第 28-33 行注释）
export PATH="$PATH:$NPM_GLOBAL_DIR/bin"

# Materialize the canonical Skill manifest resolved by the host. Each selected
# Skill is mounted read-only below /workspace/effective-skills. Completely
# rebuilding the directory prevents a real Skill directory created by an
# earlier Agent run from surviving a container restart.
/usr/local/bin/node /app/session-generated-paths.mjs --reset-skills
if [ -d /workspace/effective-skills ]; then
  for skill in /workspace/effective-skills/*/; do
    if [ -f "${skill}SKILL.md" ]; then
      name=$(basename "$skill")
      /usr/local/bin/node /app/session-generated-paths.mjs \
        "--link-skill=$name"
    fi
  done
fi
commerceagent_prepare_generated_path skills

# Compile TypeScript (agent-runner source may be hot-mounted from host). The
# image build leaves /app/dist/.tsbuildinfo behind; disable incremental mode so
# changing only outDir cannot incorrectly reuse that cache and emit no files.
cd /app && npx tsc --outDir /tmp/dist --incremental false 2>&1 >&2
commerceagent_prepare_generated_path dist
ln -s /app/node_modules /tmp/dist/node_modules
/usr/local/bin/node /app/session-prompts-copy.mjs

# Fix permissions on exit: Claude Code creates some files with mode 0600
# (e.g. settings.json), which the host backend (agent user) cannot read.
# The trap runs as root after the node process exits. It also stops the managed
# Chromium process so no browser child survives a cancelled run.
CHROMIUM_PID=
cleanup() {
  local cleanup_status=0
  commerceagent_stop_session_permission_watcher || cleanup_status=$?
  if [ -n "$CHROMIUM_PID" ] && kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    kill "$CHROMIUM_PID" 2>/dev/null || true
    for ((attempt = 0; attempt < 20; attempt++)); do
      kill -0 "$CHROMIUM_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CHROMIUM_PID" 2>/dev/null; then
      kill -KILL "$CHROMIUM_PID" 2>/dev/null || true
    fi
    wait "$CHROMIUM_PID" 2>/dev/null || true
  fi
  return "$cleanup_status"
}
trap cleanup EXIT

# Rootless bind mounts require a live owner-root/group-node bridge for files
# that applications explicitly create as 0600. Other modes need no watcher.
commerceagent_start_session_permission_watcher
if [ "$COMMERCEAGENT_INTERNAL_IDENTITY_MODE" = rootless ]; then
  umask 0007
fi

# Start one deterministic browser for this task container. Binding to loopback
# keeps the raw Chrome DevTools Protocol private to the container; a future Web
# browser panel must proxy the authenticated agent-browser dashboard/stream,
# never publish this port directly.
COMMERCEAGENT_CHROMIUM_CDP_HOST="${COMMERCEAGENT_CHROMIUM_CDP_HOST:-127.0.0.1}"
COMMERCEAGENT_CHROMIUM_CDP_PORT="${COMMERCEAGENT_CHROMIUM_CDP_PORT:-9222}"
CHROMIUM_PROFILE_DIR=/tmp/commerceagent-chromium-profile
CHROMIUM_LOG=/tmp/commerceagent-chromium.log
mkdir -p "$CHROMIUM_PROFILE_DIR"
commerceagent_prepare_generated_path chromium

# agent-browser reads this value when its daemon starts, so it attaches to the
# managed browser instead of creating another Chromium with a random CDP port.
export AGENT_BROWSER_CDP="$COMMERCEAGENT_CHROMIUM_CDP_PORT"

HOME=/home/node setpriv --reuid=node --regid=node --init-groups -- \
  "${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/bin/chromium}" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address="$COMMERCEAGENT_CHROMIUM_CDP_HOST" \
  --remote-debugging-port="$COMMERCEAGENT_CHROMIUM_CDP_PORT" \
  --user-data-dir="$CHROMIUM_PROFILE_DIR" \
  about:blank >"$CHROMIUM_LOG" 2>&1 &
CHROMIUM_PID=$!

CHROMIUM_READY=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if curl --noproxy '*' -fsS \
    "http://127.0.0.1:${COMMERCEAGENT_CHROMIUM_CDP_PORT}/json/version" \
    >/dev/null 2>&1; then
    CHROMIUM_READY=true
    break
  fi
  if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [ "$CHROMIUM_READY" != true ]; then
  echo "Chromium failed to listen on container-local CDP port ${COMMERCEAGENT_CHROMIUM_CDP_PORT}" >&2
  cat "$CHROMIUM_LOG" >&2 2>/dev/null || true
  exit 1
fi

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Drop privileges and execute agent-runner as node user
runuser -u node -- node /tmp/dist/index.js < /tmp/input.json
