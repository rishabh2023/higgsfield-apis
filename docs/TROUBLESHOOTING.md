# Troubleshooting

### "uv: command not found" or "npm: command not found"
Install the missing tool (see [README, Step 1](../README.md#step-1--install-two-free-tools-one-time-only)),
then **close and reopen** your Terminal so it can find it.

### "Permission denied" when running `./start.sh`
Run `chmod +x start.sh` once, then `./start.sh` again. You can also run `bash start.sh`.

### Something else is already using port 5173 or 8010
`start.sh` automatically moves to the next free port. Use the link it prints (for example
`http://localhost:5174`). To pick the ports yourself:
```bash
FRONTEND_PORT=3000 BACKEND_PORT=9000 ./start.sh
```

### "Higgsfield rejected these credentials (401)"
The Key ID or Secret is wrong. Copy them again from the [Higgsfield Console](https://console.higgsfield.ai).
Make sure you don't include any spaces.

### "Saved, but Higgsfield could not be reached"
Your internet connection or Higgsfield was down for a moment. The key is saved anyway. Try generating.

### "Insufficient Higgsfield credits" or "Maximum number of concurrent requests"
Add credits in the Higgsfield Console, or wait for your running videos to finish first.

### My saved key shows "Unreadable"
The encryption file `backend/data/secret.key` was deleted or changed. Click **Replace** and save your key again.

### The page loads but says "Request failed"
The server part isn't running. Stop everything (Ctrl + C) and run `./start.sh` again.

### "QuickTime .mov files aren't accepted"
Higgsfield only accepts MP4 video. Export or convert the clip to MP4 (for example with QuickTime:
File, Export As, then 1080p), then upload it again.

### "Couldn't prepare reference files"
The app couldn't send one of your chosen files to Higgsfield (the network dropped, or the file was removed).
Nothing was generated and you weren't charged. Just click **Generate** again.

### A video says "Couldn't save a local copy"
It still plays from Higgsfield. Click **Retry** on the card. After about 7 days Higgsfield deletes its copy,
so retry before then.

### I updated the app (git pull) and something looks broken
Stop it with Ctrl + C and run `./start.sh` again. The server part doesn't reload by itself.
Your projects and videos are kept.

### The Speak button is missing or says "Microphone access was blocked"
- Use **Chrome, Edge or Safari**. Firefox has no built-in speech recognition, so the button is hidden there.
- Click the 🔒 or 🎤 icon in the address bar, allow the microphone, and click **Speak** again.
- Dictation needs an internet connection, because the browser sends the audio to its speech service.

### The app says the database was damaged / "rebuilt database from ledger"
That's the safety net working. The broken file was moved aside (`app.db.corrupt-…`, never deleted) and
everything was rebuilt from `backend/data/ledger.jsonl`. To run the rebuild by hand (stop the app first):
```bash
cd backend && uv run python -m app.recover --check   # see what the ledger holds
cd backend && uv run python -m app.recover           # rebuild (the current DB is kept aside)
```
Daily copies of the database are also kept in `backend/data/backups/` (the last 7 days).

### Back up everything / move to another computer
Copy the whole `backend/data` folder. It holds your videos, reference files, ledger, backups and the key
that unlocks your saved API key.

### Start over completely
Stop the app, delete the `backend/data` folder (this removes the saved key, projects and **all saved videos**), and run `./start.sh`.

---

## Windows

`start.sh` is for Mac and Linux. On Windows, open **two** PowerShell windows in the project folder.

**Window 1 (server):**
```powershell
cd backend
uv sync --python 3.12
uv run --python 3.12 uvicorn app.main:app --host 127.0.0.1 --port 8010
```

**Window 2 (website):**
```powershell
cd frontend
npm install
npm run dev
```

Then open **http://localhost:5173**. Keep both windows open while you use the app.
(Or just ask an AI assistant to set it up. It follows `AGENTS.md`.)
