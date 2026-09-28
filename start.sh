#!/usr/bin/env bash
# One-command setup + start for Video Studio (macOS / Linux).
# Usage:  ./start.sh
# Installs dependencies on first run, then starts the backend and frontend together.
# Press Ctrl+C to stop both.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# A port counts as busy if anything listens on it (IPv4 or IPv6; Vite binds to ::1).
port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null
  fi
}
free_port() {
  local p=$1
  while port_busy "$p"; do p=$((p + 1)); done
  echo "$p"
}

# ---- prerequisites ---------------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
  fail "'uv' is not installed. Install it with:
    curl -LsSf https://astral.sh/uv/install.sh | sh
  then open a new terminal and run ./start.sh again."
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "Node.js (npm) is not installed. Install the LTS version from https://nodejs.org
  then open a new terminal and run ./start.sh again."
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "${NODE_MAJOR}" -ge 20 ] || fail "Node.js 20 or newer is required (found $(node -v)). Update from https://nodejs.org"

# ---- install (fast no-op after the first run) --------------------------------
say "Installing backend dependencies (uv downloads Python 3.12 automatically if needed)..."
(cd backend && uv sync --python 3.12 --quiet)

if [ ! -d frontend/node_modules ] || [ frontend/package-lock.json -nt frontend/node_modules/.package-lock.json ]; then
  say "Installing frontend dependencies..."
  (cd frontend && npm install --no-audit --no-fund --loglevel=error)
fi

# ---- start --------------------------------------------------------------------
export BACKEND_PORT="${BACKEND_PORT:-$(free_port 8010)}"
export FRONTEND_PORT="${FRONTEND_PORT:-$(free_port 5173)}"

say "Starting backend on port ${BACKEND_PORT}..."
(cd backend && exec uv run --python 3.12 uvicorn app.main:app --host 127.0.0.1 --port "${BACKEND_PORT}" --log-level warning --reload --reload-dir app) &
BACKEND_PID=$!
trap 'kill ${BACKEND_PID} 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1 && break
  kill -0 ${BACKEND_PID} 2>/dev/null || fail "Backend failed to start — see the error above."
  sleep 0.5
done

printf '\n\033[1;32m✔ Video Studio is running →  http://localhost:%s\033[0m\n' "${FRONTEND_PORT}"
printf '  Open that link, paste your Higgsfield API key, and generate. Press Ctrl+C to stop.\n\n'

cd frontend && npx vite --port "${FRONTEND_PORT}" --strictPort --logLevel warn
