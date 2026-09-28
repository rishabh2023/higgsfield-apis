# AGENTS.md — setup instructions for AI assistants

You are setting up **Higgsfield Video Studio** for a user who may not be technical.
Goal: get the app running and give them a link to open. Keep your messages short and plain.

## Stack

- `backend/`: FastAPI (Python 3.12, managed by **uv**) with the official `higgsfield-client` SDK and SQLite
- `frontend/`: React + Vite + Tailwind + shadcn/ui. The Vite dev server proxies `/api` to the backend
- There is no Docker, no database server, and no `.env` file to fill in. It works out of the box

## Setup steps (follow in order)

1. **Check the prerequisites.** Run `uv --version` and `node --version` (Node must be ≥ 20).
   - If `uv` is missing: macOS/Linux `curl -LsSf https://astral.sh/uv/install.sh | sh`,
     Windows `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`.
     Then make sure `uv` is on PATH (open a new shell or `source $HOME/.local/bin/env`).
   - If Node is missing or too old: ask the user to install the LTS version from https://nodejs.org,
     or use their package manager (`brew install node`, `winget install OpenJS.NodeJS.LTS`).
   - You do not need to install Python. `uv` downloads 3.12 by itself.
2. **Start the app.**
   - **macOS/Linux:** run `./start.sh` from the repo root as a **long-running/background** process.
     It installs dependencies, picks free ports (default 8010 backend, 5173 frontend), and prints
     `✔ Video Studio is running →  http://localhost:<port>`.
   - **Windows (or if `start.sh` can't be used):** run two long-running processes:
     ```bash
     cd backend && uv sync --python 3.12 && uv run --python 3.12 uvicorn app.main:app --host 127.0.0.1 --port 8010
     ```
     ```bash
     cd frontend && npm install && npm run dev
     ```
     If you change the backend port, set the `BACKEND_PORT` environment variable for the frontend
     process as well, because the Vite proxy reads it.
3. **Verify.** Run `curl -s http://localhost:5173/api/health`. It must return `{"ok":true}`.
   A `200` from `http://localhost:5173/` means the UI is being served.
4. **Hand off.** Tell the user:
   > It's running. Open http://localhost:5173, paste your Higgsfield **Key ID** and **Secret**
   > (from https://console.higgsfield.ai) into the API key box, click *Verify & save*, then generate.

## Rules

- **Never ask the user to paste their API key or secret into the chat.** They enter it only in the web
  UI, which stores it encrypted server-side. No env var is needed for the key.
- Don't generate test videos on the user's behalf. Each generation costs their credits.
- Don't commit `backend/data/` (it holds the encrypted DB and `secret.key`), `.env`, `.venv`, or `node_modules`.
- If a port is busy, `start.sh` picks the next free one automatically. Report the URL it prints.

## Checks (for code changes)

```bash
cd backend && uv run --python 3.12 pytest -q    # 29 mocked tests, no network needed
```

```bash
cd frontend && npm run build                     # typecheck + production build
```

More detail: `docs/ARCHITECTURE.md` (design) and `docs/TROUBLESHOOTING.md` (common failures).
