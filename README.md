# HypeClip

HypeClip is a local Windows studio for monitoring English-speaking GTA VI streams and reviewing vertical clips. It can follow a creator watchlist, scan an archive, or process a local recording. Chat activity and audio identify candidates. Whisper supplies timed speech, Ollama evaluates the evidence, and FFmpeg renders the MP4 with the original audio.

## Start monitoring on this PC

Start the dashboard from PowerShell. Keep this terminal open and the PC awake while it monitors. You can close Codex and the browser tab. [Open the local dashboard](http://127.0.0.1:4177)

```powershell
pnpm --dir "C:\Users\HP\OneDrive\Documents\Desktop\Ariyo\clip-it" hypeclip dashboard
```

1. Choose **Choose a stream** on **Monitor**. Pick a channel or the entire **Watchlist**, paste a supported link, or select a **Local recording**.
2. Select **Check source**, confirm your capture and editing permission, then choose **Monitor once**. A live link can produce several clips and can retry if capture fails. It stops when capture finishes normally or you press **Stop**. The full watchlist keeps looking for eligible streams until stopped. Recordings and archive intervals are scanned once for up to one clip.
3. Use **Monitor** to follow capture, chat and clip progress or stop a source. The CLI and dashboard share two capture slots by default. Use **Technical details** to inspect errors and processing events.
4. Open **Clips** to play and download finished MP4s. Choose **Needs review** to work through the queue. **Compare cuts** opens two exports of the same moment at the same source time. **Presentation** previews a new layout or caption treatment using cached media and speech. Saving creates a separate export.

Local studio work needs no publishing account. Dashboard exports go in your Windows Videos folder under `HypeClip\Studio`. Use **Open folder** to locate an MP4. **Publishing** shows the Buffer connection, TikTok destination and separate CLI automatic-posting setting.

**Starting at Windows sign-in is optional.** For a dedicated monitoring PC, create a Task Scheduler task for your Windows account with an **At log on** trigger. For **Program/script**, use the path printed by `(Get-Command pnpm.cmd).Source`. For **Add arguments**, enter `--dir "C:\Users\HP\OneDrive\Documents\Desktop\Ariyo\clip-it" hypeclip dashboard`. Set **If the task is already running** to **Do not start a new instance**. Start and test the watchlist in the dashboard first. At the next sign-in, open **Monitor** and check the source state. Capture requires the PC to remain awake.

### Which connections do I need?

| What you want to do | What to set up |
| --- | --- |
| Review a local recording or accessible public Kick archive | The local tools below. Kick replay chat is fetched when available. |
| Monitor a live channel | A playable feed and the applicable media adapter. Use **Check source** on the channel you want to follow. For Streamlink, install its Windows build and put it on PATH, or set `HYPECLIP_STREAMLINK` in `.env`. |
| Read Twitch or YouTube audience chat | Configure the corresponding reader in `.env`. Twitch uses a user token. YouTube uses a Data API key or access token. |
| Use TikTok LIVE | A playable live room or a creator-provided recording. Supply a timestamped chat export for chat detection. Native TikTok chat collection is unavailable. |
| Publish through Buffer later | Configure Buffer and R2 only when you decide to publish. The dashboard never authorizes posting. |

**Sources → Stream chat** explains optional reader credentials. Run `pnpm hypeclip providers --check` to inspect this installation. [Provider setup guide](docs/monitor.md)

### How endings and review work

The editor examines nearby Whisper segments inside the reserved footage. When the proposed ending lands on a question, it looks for a supported direct reply before a topic change. It can include the reply and a short pause bounded by the next speech cue and the available footage. An unanswered question or unrelated turn keeps the proposed end. The decision record includes the question, reply, source times and pause. Qwen cites timestamped speech or chat rows. Unsupported claims go to review, where the original MP4 is available for playback.

## Monitor stream URLs

Run `pnpm hypeclip watchlist` for the ranked GTA VI roster and its source evidence. `pnpm hypeclip providers --check` shows local provider readiness. Use `pnpm hypeclip monitor --watchlist docs/watchlist.json` for the two-slot local monitor. Supply the scope of authorized capture with `--rights` or on individual channels. [Provider setup, archive scans and editable exports](docs/monitor.md)

Use `pnpm hypeclip monitor` for concurrent Twitch, YouTube Live, Kick and TikTok LIVE sources. The local workflow preserves original audio, captions speech and supports operator timestamps when chat is unavailable. Run the two real GTA VI edits with `pnpm hypeclip monitor --config .\docs\gta6-kick.json --once`. [Mixed URL setup, source capabilities, exports and voice previews](docs/monitor.md)

## Install on a new Windows PC

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

The recording commands process one candidate at a time. It validates the worker artifacts, stores the transcript and SRT separately from the proposed post text, and records the Ollama tag, decision, reason and flags. Retry an unavailable evaluator with `pnpm hypeclip evaluate <clip-id>`. A verified accept, clean quality flags, confirmed source rights and an enabled destination are required for automatic publication. Fixtures stay local.

## Concurrent local broadcasts

On the configured Victus, run the complete two-source acceptance demo from this checkout in PowerShell.

```powershell
python .\scripts\gta6-demo.py
```

The runner uses Windows desktop speech synthesis, Pillow, NumPy and psutil in the system Python. The existing worker venv supplies offline Whisper small. FFmpeg receives two original 240-second discussion fixtures at real-time pace. Each feed stops after its first completed decision. The runner ignores repository credentials, replaces the publishers with local doubles, and writes a new state directory under `%LOCALAPPDATA%\HypeClip\gta6-runs`. It verifies copies in a timestamped subdirectory of the Windows Videos known folder under `HypeClip\GTA6-Demo`. Allow several minutes for rendering, model checks and the timed recovery test.

For an existing local feed manifest, the entry point is `pnpm hypeclip live-multi --manifest PATH`. Add `--once` to stop each source after its first decision. The generated `fixtures/manifest.json` is a working example. Each of the one or two entries in `sources` requires a distinct broadcast `id`, its own chat JSONL path, an authorized replay `file` or loopback UDP `port`, a `destination` and `rights: true`. Use `fixture: true` for synthetic inputs. An explicit `mediaStart` maps archived chat to the first frame. Otherwise chat uses the current capture anchor. Set `reactionMs` per source. New broadcasts need new IDs.

FFmpeg stream-copies the input into keyframe-aligned segments. Supply regular keyframes, ideally every two seconds. Each broadcast has a 65-second rolling buffer, a separate detection baseline and a cooldown covering its reserved window. Candidates reserve 30 seconds before and 25 seconds after the estimated event. Gaps or early endings that cut through a reservation remain visible in SQLite as incomplete. A ready window transfers to a durable local file before it enters the worker queue. Restart with the same state directory and manifest to resume. Replays seek to the finalized media position. A loopback reconnect opens a fresh capture directory and records a gap.

The coordinator admits at most 12 pending windows by default, advances two jobs and alternates ready sources. There is one slot each for heavy FFmpeg, Whisper and Ollama, with two active heavy stages in total. Capture and stream-copy remuxing run independently. Manifest settings `retentionMs`, `queueLimit` and `diskMiB` control capacity. The default disk high-water mark is 4096 MiB across the state directory, sampled once per second. Reaching it stops intake and active encoders. Completed review media stays on disk and counts against that budget.

Jobs retain their destination and delivery mode. Automatic sends also require the matching enabled policy at send time. Active sessions sharing a destination use the smallest configured cap as their combined budget against automatic intents in this database. The existing unique claims, rate-limit cooldown and ambiguous-response reconciliation still apply. Explicitly authorized EventSub channels sharing one identity can use `collect-multi --manifest PATH`, with an array of `{broadcaster, session, path}` entries. The local demo uses synthetic chat.

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
