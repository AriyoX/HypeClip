# HypeClip

Pair a finished recording with timestamped audience chat. HypeClip selects reaction spikes, renders captioned 1080×1920 MP4s, and evaluates them locally with Ollama. Clips go to review by default. An explicitly enabled session can send accepted clips to one Buffer TikTok channel.

## Set up the Victus

Run from the repository root in PowerShell. The tested stack is Windows 11 x64, Node 22.15, pnpm 10.14, Python 3.13 and FFmpeg with libx264, libass and drawtext. For a fresh Windows machine, install `OpenJS.NodeJS.LTS`, `Python.Python.3.13`, `Ollama.Ollama` and `Gyan.FFmpeg` with `winget install --id <package> --exact`. Reopen PowerShell. A side-by-side FFmpeg installation also works. [Worker setup and pinned dependencies](workers/README.md)

```powershell
npm install --global pnpm@10.14.0
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
py -3.13 -m venv .venv
$python = (Resolve-Path .venv/Scripts/python.exe).Path
& $python -m pip install -r workers/requirements.txt
& $python -m pip check
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,TotalVisibleMemorySize,FreePhysicalMemory
Get-PSDrive C | Select-Object Free
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv
ollama list
pnpm hypeclip setup-ollama
Invoke-RestMethod http://localhost:11434/api/tags | Select-Object -ExpandProperty models | Select-Object name,size
& $python -c "from huggingface_hub import try_to_load_from_cache as cached; from media.speech import MODEL_ID,MODEL_REVISION; print(cached(MODEL_ID,'model.bin',revision=MODEL_REVISION))"
```

`setup-ollama` checks RAM, disk, GPU and local service health. It tests installed instruction models against structured JSON and pulls `qwen3:4b` if necessary. The equivalent manual download is `ollama pull qwen3:4b`. The verified endpoint and tag live in `~/.config/hypeclip/ollama.json`. For Whisper, the following setup call reuses the pinned snapshot or downloads missing files. The worker then runs offline on CPU/int8 with VAD and word timestamps.

```powershell
Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
$env:HF_HUB_DISABLE_XET = '1'
& $python -c "from faster_whisper import download_model; from media.speech import MODEL_ID,MODEL_REVISION; print(download_model(MODEL_ID,revision=MODEL_REVISION))"
$env:HF_HUB_OFFLINE = '1'
pnpm hypeclip demo
pnpm hypeclip status
pnpm verify:local
```

`demo` renders and evaluates a local fixture. `verify:local` exercises the normal CLI with genuine speech, a real Ollama decision, an endpoint outage and retry. It writes exact commands, JSON results, decoded frames and audio under the printed directory. Optional FFmpeg/Python paths and provider variables are in [.env.example](.env.example). The worker accepts `python -m workers.media --request <json-file> --result <json-file>`. [V1 contracts and examples](contracts/README.md)

On Linux/WSL2, use Node 22.15+, pnpm 10.14, Python 3.13 with venv and FFmpeg on PATH. Use `python3.13 -m venv .venv`, `.venv/bin/python -m pip install -r workers/requirements.txt` and substitute `.venv/bin/python` for `& $python` above. WSL setup tries loopback and the Windows host gateway before starting another service. To check the Windows cache from WSL, set `HF_HOME=/mnt/c/Users/HP/.cache/huggingface` for this laptop. Share one database across publishing processes. Windows defaults to `%LOCALAPPDATA%\HypeClip` and Linux to `$XDG_STATE_HOME/HypeClip` or `~/.local/state/HypeClip`. `HYPECLIP_HOME` overrides the location.

## From an authorized recording to a clip

For live Twitch chat, set `TWITCH_USER_TOKEN` to a user token with `user:read:chat` and `TWITCH_BROADCASTER_ID` to the authorized channel ID. Start collection during the stream. For a finished OBS file, supply the UTC time of its **first frame**. Stop OBS and finalize the file before pressing Ctrl+C in the collector. This example processes automatically after collection. [Twitch chat and EventSub](https://dev.twitch.tv/docs/chat/send-receive-messages/)

```powershell
$source = 'C:\Recordings\stream-01.mkv'
$chat = 'C:\Recordings\stream-01.jsonl'
$firstFrame = '2026-11-19T18:00:00Z'   # replace with the actual first-frame time
pnpm hypeclip collect --session stream-01 --chat $chat --source $source --media-start $firstFrame --rights
# For an existing chat log and finished recording:
pnpm hypeclip process --session stream-01 --chat $chat --source $source --media-start $firstFrame --rights
```

Chat JSONL retains `eventId`, `eventAt`, `receivedAt`, `userId`, `text` and optional `emotes`. Source time is event time minus the anchor plus signed `--offset-ms`. A 60 s spike with `--reaction-ms 4000` estimates a 56 s event. The 30 s pre-roll and 25 s post-roll produce `[26,81)` on a 95 s recording. Overlapping candidates merge. The optional `live` command waits for finalized post-roll on a loopback MPEG-TS input. [Replay, broadcast run and live-input verification](docs/verification.md)

The CLI processes one candidate at a time. It validates the worker artifacts, stores the transcript and SRT separately from the proposed post text, and records the Ollama tag, decision, reason and flags. Retry an unavailable evaluator with `pnpm hypeclip evaluate <clip-id>`. A verified accept, clean quality flags, confirmed source rights and an enabled destination are required for automatic publication. Fixtures stay local.

## Publish to TikTok

Connect the intended TikTok profile in Buffer. Set `BUFFER_ACCESS_TOKEN` and `BUFFER_CHANNEL_ID` in `.env`. Create a dedicated HypeClip R2 bucket, attach a public HTTPS domain, and supply the five `HYPECLIP_R2_*` values from the example. Use credentials scoped to this bucket. Keep its objects publicly readable through publication. Set `HYPECLIP_CHANNEL_REQUIREMENTS` if the account requires manual privacy selection, commercial disclosure, approval or notification posting. Such clips go to review. [Buffer media hosting](https://developers.buffer.com/guides/hosting-media.html)

Edit `caption.txt` for the post text. A dry run probes the final MP4 and displays the configured channel when available. It performs zero uploads and creates zero posts. For a live command, supply the exact channel ID shown in the preview.

```powershell
$video = 'C:\Clips\vertical.mp4'
$caption = 'C:\Clips\caption.txt'
$channel = 'replace-with-the-confirmed-buffer-channel-id'
pnpm hypeclip publish --file $video --highlight stream-01-final --caption-file $caption --dry-run
# Explicit public send of the selected clip
pnpm hypeclip publish --file $video --highlight stream-01-final --caption-file $caption --channel $channel --mode shareNow --live
```

For hands-off posting, enable the exact session and existing recording path **before** running `process`. Regular sessions default to `addToQueue`. For an authorized immediate-send test, add `--mode shareNow` and use a cap of one. Use the same highlight ID on retries.

```powershell
pnpm hypeclip auto-enable --session stream-01 --source $source --channel $channel --cap 1 --rights
pnpm hypeclip process --session stream-01 --source $source --chat $chat --media-start $firstFrame --rights
pnpm hypeclip auto-off --session stream-01
pnpm hypeclip status
pnpm hypeclip sync --watch
```

`auto-off` without a session disables all sessions. Publication uploads only the final MP4 as `clips/<sha256>.mp4` and verifies the full bytes via anonymous HTTPS before Buffer creation. SQLite reserves the channel/highlight and channel/video digest before sending. A published result requires a subsequent Buffer read with automatic `sent`, a valid `sentAt` and no notification status. Check the returned `externalLink` or TikTok profile for public visibility. [Buffer createPost](https://developers.buffer.com/examples/create-video-post.html) · [Buffer schema](https://developers.buffer.com/reference.html)

**Recovery.** `status` is read-only. `sync --watch` refreshes pending states and respects persisted Retry-After deadlines. For `needs_reconciliation`, run `pnpm hypeclip reconcile <intent-id>`. It searches Buffer for the exact destination, caption and asset URL. If the result stays ambiguous, inspect the Buffer queue and sent history, then run `pnpm hypeclip reconcile <intent-id> --post-id <verified-id>`. Use `--close-unposted` only after confirming no remote post exists. An ambiguous creation never triggers an automatic resubmission.
