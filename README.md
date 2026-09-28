# Higgsfield Video Studio

Type a sentence and get an AI video back. This is a small app that runs on your own computer.
It uses **Seedance 2.0** through the [Higgsfield](https://higgsfield.ai) API.

You bring your own Higgsfield API key. You paste it into the app once, and the app keeps it
safe and uses it for every video after that.

---

## 🚀 Easiest setup: let an AI assistant do it

Open Claude Code, Cursor, Codex, or any AI coding assistant, and paste this:

> Set up and run this project for me: https://github.com/rishabh2023/higgsfield-apis
> Follow the instructions in AGENTS.md. When it's running, give me the link to open.

That's all. The assistant installs everything and starts the app. Then go to **[Step 3](#step-3--use-it)**.

---

## 🛠 Set it up yourself (about 2 minutes)

### Step 1 — Install two free tools (one time only)

| Tool | What it's for | How to install |
|---|---|---|
| **Node.js** (v20+) | Runs the website part | Download the **LTS** version from [nodejs.org](https://nodejs.org) and click through the installer |
| **uv** | Runs the server part (and installs Python for you) | **Mac/Linux:** open Terminal and paste `curl -LsSf https://astral.sh/uv/install.sh \| sh` <br> **Windows:** open PowerShell and paste `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` |

After installing, **close and reopen** your Terminal.

### Step 2 — Download and start

**Mac / Linux**

```bash
git clone https://github.com/rishabh2023/higgsfield-apis.git
cd higgsfield-apis
./start.sh
```

The first run takes about a minute. After that it starts in seconds. When it's ready you'll see:

```
✔ Video Studio is running →  http://localhost:5173
```

**Windows:** follow [Windows setup](docs/TROUBLESHOOTING.md#windows) (two terminal windows, one command each).

### Step 3 — Use it

1. Open **http://localhost:5173** in your browser.
2. Get an API key: log in to the [Higgsfield Console](https://console.higgsfield.ai) and create one.
   It has two parts, a **Key ID** and a **Secret**.
3. Paste both into the **Higgsfield API key** box and click **Verify & save**. You only do this once.
4. Describe your video, pick a length and shape, and click **Generate video**.
5. Wait a few minutes. The video shows up and plays on its own.

To stop the app, press **Ctrl + C** in the Terminal. To start it again later, run `./start.sh`.

---

## 📚 More help

- **[User guide](docs/USER_GUIDE.md)**: every option and what each status means
- **[Troubleshooting](docs/TROUBLESHOOTING.md)**: common problems, Windows setup, ports already in use
- **[How it works](docs/ARCHITECTURE.md)**: for developers

## 🔒 Is my API key safe?

- It stays on **your computer**. It's stored encrypted in `backend/data/` and never uploaded anywhere
  except to Higgsfield itself.
- The app never shows the full key again. You'll only see the last 4 characters.
- Never paste your key into a chat with an AI assistant. Enter it only in the app's page.
- Each video uses credits from **your** Higgsfield account.
