# HypeClip

HypeClip is a local Windows studio for monitoring English-speaking GTA VI streams and reviewing vertical clips. It can follow a creator watchlist, scan an archive, or process a local recording. Chat activity and audio identify candidates. Whisper supplies timed speech, Ollama evaluates the evidence, and FFmpeg renders the MP4 with the original audio.

## Install on Windows

1. Open the **HypeClip Setup** installer and follow the prompts. Use **HypeClip** in the Windows Start menu to open it again. With the ZIP version, choose **Extract All**, then double-click **Start HypeClip.cmd** inside the extracted **HypeClip** folder.
2. If prompted, accept the Node.js install. In the browser, choose **Setup → Install tools and models**. Allow time for several GB of downloads on the first run. [Windows Package Manager](https://learn.microsoft.com/en-us/windows/package-manager/winget/)
3. Choose **Continue to Monitor** to try a local recording. Use **Quick start** in Setup for the first-clip walkthrough. [Quick start](Start%20Here.html)

Use a Windows x64 PC with internet access for the first setup. If Windows blocks the unsigned installer, use the ZIP version. If setup reports a WinGet error, install or update **App Installer** in the Microsoft Store, then run HypeClip again. Keep the HypeClip window open and the PC awake when monitoring.

## Monitor and review clips

1. Choose **Choose a stream** on **Monitor**. Pick a channel or the entire **Watchlist**, paste a supported link, or select a **Local recording**.
2. Select **Check source**, confirm your capture and editing permission, then choose **Monitor once**. A live link can produce several clips and can retry if capture fails. It stops when capture finishes normally or you press **Stop**. The full watchlist keeps looking for eligible streams until stopped. Recordings and archive intervals are scanned once for up to one clip.
3. Use **Monitor** to follow capture, chat and clip progress or stop a source. The CLI and dashboard share two capture slots by default. Use **Technical details** to inspect errors and processing events.
4. Open **Clips** to play and download finished MP4s. Choose **Needs review** to work through the queue. **Compare cuts** opens two exports of the same moment at the same source time. **Presentation** previews a new layout or caption treatment using cached media and speech. Saving creates a separate export.

Dashboard exports go to `Videos\HypeClip\Studio` by default. Choose **Settings → Clips folder** to pick a location for new runs and saved versions. Use **Open folder** on a clip to find its MP4. Upload that file in TikTok for manual posting. Making, saving, and manually uploading clips requires no R2 setup.

To start at Windows sign-in, finish Setup first. In Task Scheduler, create a task for your Windows account with an **At log on** trigger. Use `powershell.exe` as the program and enter `-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\HypeClip\scripts\start-windows.ps1" -NoBrowser` as the arguments, using your actual path. Set **If the task is already running** to **Do not start a new instance**. At the next sign-in, open **Monitor** and check the source state.

### Which connections do I need?

| What you want to do | What to set up |
| --- | --- |
| Review a local recording or accessible public Kick archive | Tools and models from **Setup**. Kick replay chat is fetched when available. |
| Monitor a live channel | Install Streamlink in **Setup**. Use **Check source** on the channel you want to follow. |
| Read Twitch or YouTube audience chat | Save the corresponding reader in **Setup**. Twitch uses a user token. YouTube uses a Data API key or access token. |
| Use TikTok LIVE | A playable live room or a creator-provided recording. Supply a timestamped chat export for chat detection. Native TikTok chat collection is unavailable. |
| Schedule TikTok posts through Buffer | Configure Buffer and R2 in **Setup**. The separate CLI workflow controls posting authorization. |

**Sources → Stream chat** explains optional reader credentials. Run `pnpm hypeclip providers --check` to inspect this installation. [Provider setup guide](docs/monitor.md)

### How endings and review work

The editor examines nearby Whisper segments inside the reserved footage. When the proposed ending lands on a question, it looks for a supported direct reply before a topic change. It can include the reply and a short pause bounded by the next speech cue and the available footage. An unanswered question or unrelated turn keeps the proposed end. The decision record includes the question, reply, source times and pause. Qwen cites timestamped speech or chat rows. Unsupported claims go to review, where the original MP4 is available for playback.

## Monitor stream URLs

Run `pnpm hypeclip watchlist` for the ranked GTA VI roster and its source evidence. `pnpm hypeclip providers --check` shows local provider readiness. Use `pnpm hypeclip monitor --watchlist docs/watchlist.json` for the two-slot local monitor. Supply the scope of authorized capture with `--rights` or on individual channels. [Provider setup, archive scans and editable exports](docs/monitor.md)

Use `pnpm hypeclip monitor` for concurrent Twitch, YouTube Live, Kick and TikTok LIVE sources. The local workflow preserves original audio, captions speech and supports operator timestamps when chat is unavailable. Run the two real GTA VI edits with `pnpm hypeclip monitor --config .\docs\gta6-kick.json --once`. [Mixed URL setup, source capabilities, exports and voice previews](docs/monitor.md)

## Command-line setup

Run from the repository root with Node 22.15+ and pnpm 10.14. On Linux or WSL2, install Python 3.13 with venv, FFmpeg with libx264, libass and drawtext, and Ollama using your system package manager before running setup. [Python worker requirements](workers/README.md)

```sh
pnpm install --frozen-lockfile
pnpm hypeclip setup
pnpm hypeclip dashboard
```

Run `pnpm hypeclip setup --check` to see readiness without installing anything. `pnpm hypeclip setup-ollama` verifies Ollama alone, reuses a compatible local model, and pulls `qwen3:4b` when needed. The verified model and endpoint are stored in `~/.config/hypeclip/ollama.json`. Ollama setup under WSL tries the Windows host gateway when loopback is unavailable. Whisper resumes using its local cache after setup.

Setup saves the optional connection values in `connections.json` under your HypeClip state directory. The default is `%LOCALAPPDATA%\HypeClip` on Windows and `$XDG_STATE_HOME/HypeClip` or `~/.local/state/HypeClip` on Linux. `HYPECLIP_HOME` overrides the path. The file contains plaintext credentials, so share the HypeClip download and keep this file private. Shell variables take precedence, followed by values saved or removed in Setup, then the checkout’s optional `.env`. New monitoring runs use saved values immediately. [Advanced environment options](.env.example)

`pnpm hypeclip demo` renders and evaluates a local fixture. `pnpm verify:local` exercises speech, a real Ollama decision, an endpoint outage, and retry. The worker accepts `python -m workers.media --request <json-file> --result <json-file>`. [V1 contracts and examples](contracts/README.md)

To build the Windows installer and ZIP from the current commit, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1`. The build verifies the portable NSIS compiler and writes both files under `.hypeclip\releases`. [NSIS releases](https://nsis.sourceforge.io/Download)

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

For manual posting, open **Clips**, choose **Download MP4**, and upload the file in TikTok. To schedule through HypeClip, use the Buffer setup below. The Buffer API needs a direct public HTTPS link that stays available until the post publishes. [Buffer media hosting](https://developers.buffer.com/guides/hosting-media.html)

Connect the intended TikTok profile in Buffer. Save the Buffer API key in **Setup**, then use **Publishing → Find TikTok channels** to select it. Create a dedicated HypeClip R2 bucket, attach a public HTTPS domain, and save the bucket and scoped credentials under **Setup → Cloudflare R2**. Keep its objects publicly readable through publication. Enter **Manual posting requirements** if the account needs manual privacy selection, commercial disclosure, approval or notification posting. Such clips go to review. [Buffer media hosting](https://developers.buffer.com/guides/hosting-media.html)

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
