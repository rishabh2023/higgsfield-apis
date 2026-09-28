# Higgsfield Video Studio

Make AI videos from text, images or reference clips, then **edit** or **extend** them. It all
runs on your own computer, using Seedance 2.0 / 2.5 and Kling O3 through the [Higgsfield](https://higgsfield.ai) API.

- 📁 **Projects** keep each campaign's videos and reference files together
- 🖼 **References library**: upload images, MP4 clips or WAV audio and reuse them in any generation
- ✂️ **Edit / Extend** any video you made, or use it as a reference for the next one
- 💾 **Every video is saved to your computer**, because Higgsfield deletes outputs after about 7 days. Download with one click
- 🎤 **Speak your prompt** with free built-in browser speech recognition
- 🛡 **No lost work, no double charges**: a plain-text ledger and daily backups let the app rebuild itself, and it asks before re-paying for an identical video

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
2. Go to **Settings**. Paste your Higgsfield **Key ID** and **Secret** (create them in the
   [Higgsfield Console](https://console.higgsfield.ai)) and click **Verify & save**. You only do this once.
3. Go to **Projects**, then **New project**.
4. In the **Create** tab, pick a mode (Text, Image, References, Edit or Extend), write a prompt, and click **Generate**.
5. Wait a few minutes. The video appears and plays on its own. Click **Edit** or **Extend** on it to keep going.

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
