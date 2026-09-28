# User guide

The app has two pages in the left sidebar: **Projects** (where you make videos) and **Settings**
(your API key, storage info, and the list of models).

## 1. Connect Higgsfield (once)

1. Go to the [Higgsfield Console](https://console.higgsfield.ai), log in, and create an API key.
   You get a **Key ID** and a **Secret**.
2. Open **Settings** in the app, paste both, and click **Verify & save**.

The key is checked with a free lookup (it doesn't make a video) and stored encrypted on your computer.
The dot at the bottom-left of the sidebar turns green when the key is ready.

## 2. Projects

A project is a folder for one idea or campaign. It has three tabs:

| Tab | What's there |
|---|---|
| **Create** | The form for making a new video, with your 4 most recent videos beside it |
| **Videos** | Every video in the project, with its status |
| **References** | Your uploaded images, MP4 clips and WAV audio, plus any generated videos you've saved as references |

Rename or delete a project with the **⋯** button at the top right. Deleting it removes its files from your computer.

## 3. The five ways to make a video

| Mode | You give it | Models |
|---|---|---|
| **Text** | A prompt | Seedance 2.0 (up to 15s, up to 4K), Seedance 2.5 (up to 30s, 720p) |
| **Image** | A start image, an optional end image, and an optional prompt | Seedance 2.0 |
| **References** | Reference images, videos and/or audio, plus a prompt describing how to use them | Seedance 2.0, Seedance 2.5 |
| **Edit** | A video plus a prompt describing the change ("make it snow") | Seedance 2.5 Edit, Kling O3 Edit (3–15.5s source) |
| **Extend** | A video plus a prompt describing what happens next | Seedance 2.5 Extend (4–30s more) |

The form changes to match the model you pick. It only shows options that model supports and tells you its
limits. The **↗** icon next to the model opens its official documentation.

### Adding files to a generation
Click **Choose image / video / audio** in the form. You can pick from the project's References or its
generated videos, or drop a new file right there.

Accepted files: **JPG, PNG, WEBP, GIF** images (≤30 MB), **MP4** video (≤200 MB), **WAV** audio (≤50 MB).
Higgsfield doesn't accept `.mov`, so export as MP4 first.

## 4. Editing a video you made

Every finished video has these buttons:

- **Edit**: opens Create in Edit mode with this video already filled in. Write what should change.
- **Extend**: opens Create in Extend mode to continue the video.
- **⋯ → Use as reference**: starts a References-to-video generation that uses this clip.
- **⋯ → Add to references**: saves the clip to the project's References tab for later.
- **⋯ → Download**: saves the MP4.

## 5. What the statuses mean

| Status | Meaning | What to do |
|---|---|---|
| **Submitting / Queued** | Sent to Higgsfield and waiting its turn | Wait. You can **Cancel** while it's queued |
| **Generating** | Higgsfield is making the video | Wait, usually a few minutes |
| **Completed** | Done 🎉 | Play it, edit it, extend it or download it |
| **Failed** | Higgsfield couldn't make it | Try again. You are not charged |
| **Moderated** | Blocked by the content filter | Change the prompt or files. You are not charged |
| **Rejected** | Refused before starting (for example not enough credits, too many videos running at once, or a file couldn't be sent) | Read the message on the card |
| **Outcome unknown** | The connection dropped while sending, so we can't tell whether Higgsfield received it | Check the [Higgsfield Console](https://console.higgsfield.ai) before trying again. The app **never** resends on its own, so you won't be charged twice |
| **Timed out** | Waited 45 minutes with no answer | Click **Check again** |
| **Stalled** | Status checks stopped (the key was changed or removed) | Save a working key in Settings, then click **Check again** |

"Saving a copy to this computer…" under a video means it's still downloading. Until that finishes, it plays
from Higgsfield.

## Good to know

- **Your videos are kept.** Higgsfield deletes outputs after about 7 days, so the app downloads every finished
  video to `backend/data/media/`. When an old video or reference is used again, the app re-uploads it for you.
- **Costs:** each generation uses credits from your Higgsfield account. The price depends on the model,
  length and resolution.
- Your projects, key and files belong to **this browser**. Another browser, or a private window, starts fresh.
