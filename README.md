# HypeClip

HypeClip pairs Twitch chat with a finished OBS recording, detects reaction spikes, renders portrait clips through a local Python worker and evaluates shortlisted clips with Ollama. The default destination is local review. Publishing targets one configured Buffer TikTok channel through a dedicated public R2 bucket.

## Run locally

Use Node 22.15+ with built-in SQLite and pnpm 10. Install the Python dependencies, FFmpeg and local transcription model using the [worker setup instructions](workers/README.md). Commands below run from the repository root. The CLI reads an optional local `.env` and includes a platform-specific ffprobe binary. Set `HYPECLIP_FFPROBE` or `FFPROBE` to select another executable.

```powershell
pnpm install --frozen-lockfile
pnpm hypeclip setup-ollama
pnpm hypeclip demo
pnpm hypeclip status
pnpm typecheck
pnpm test
```

`demo` replays eight fixture messages, invokes the Python worker on a 95-second synthetic recording with a spoken line, validates its artifacts and calls the real local evaluator. `demo --prerendered` uses saved worker artifacts for an independent CLI check. Both runs stay local. `status` reads SQLite and lists jobs, detector scores, evaluations, intent IDs, remote outcomes, enabled sessions and rate-limit deadlines.

On Windows, the database and clip directories live under `%LOCALAPPDATA%\HypeClip`. On Linux, they use `$XDG_STATE_HOME/HypeClip` or `~/.local/state/HypeClip`. Worktrees on one laptop share that state. Set `HYPECLIP_HOME` to select a different state directory. All live workers for a destination must use the same database.

## Evaluator

`setup-ollama` checks memory, disk and GPU information where available. It tries the configured Ollama endpoint, including the Windows host gateway on WSL, then tries starting a local service. It inventories installed models, checks structured output, and pulls `qwen3:4b` if needed. Install Ollama on the laptop if the executable and service are both missing. Verified settings are saved in `~/.config/hypeclip/ollama.json` for all worktrees. `OLLAMA_BASE_URL` defaults to `http://localhost:11434`. To verify another tag, set `OLLAMA_MODEL` and run setup again.

On the target laptop, the installed `mistral:7b` returned the wrong requested decision. `ollama pull qwen3:4b` downloaded the 2.5 GB model. It passed the structured check and evaluated the demo locally. Windows 11 reported 15.6 GiB usable RAM, the RTX 4050 reported 6,141 MiB VRAM and the initial disk check found 350 GiB free.

Each evaluation records its model, decision, reason, score, proposed caption and review flags. The evaluator receives bounded transcript text, nearby chat text and detection signals as untrusted data. Missing models, unavailable service, invalid output and timeouts leave the clip available for review. Use `pnpm hypeclip evaluate <clip-id>` to retry on the saved artifacts. Only a verified model can authorize auto-publishing. The heuristic score remains available for sorting.

## Collect Twitch chat and process an OBS recording

Set `TWITCH_USER_TOKEN` to a user access token with `user:read:chat`, and `TWITCH_BROADCASTER_ID` to the authorized channel's numeric ID. The collector validates the token and gets the client and reader IDs from Twitch. It subscribes to `channel.chat.message` over EventSub WebSocket. It deduplicates delivery IDs across restarts, retains the original EventSub timestamp and records a separate local receipt time. A server-directed reconnect keeps the old connection until the replacement welcomes the reader. Unexpected disconnects can leave a gap in the log.

Start collection during a stream you have permission to record. Supply the UTC or offset timestamp of the **first recorded frame**, including any delay between stream start and OBS recording start. Stop OBS and let it finalize the file, then press Ctrl+C in the collector. The following command continues directly into local processing.

```powershell
pnpm hypeclip collect --session stream-01 --chat C:\Recordings\stream-01.jsonl --source C:\Recordings\stream-01.mkv --media-start 2026-01-01T18:00:00Z --rights
```

For separate collection and processing, omit `--source` and `--media-start` on `collect`, then run the following command once the recording is complete.

```powershell
pnpm hypeclip process --session stream-01 --chat C:\Recordings\stream-01.jsonl --source C:\Recordings\stream-01.mkv --media-start 2026-01-01T18:00:00Z --rights
```

This workflow renders **after recording**. `--layout center-crop` fills the portrait frame. The default `fit-pad` preserves the full source frame. A session ID binds the source path, time mapping and fixture provenance. Reuse the same ID and recording when resuming.

## Clip during a stream

The optional `live` command accepts one MPEG-TS input over UDP on loopback. Start `collect` in one terminal and the receiver in another. Send your authorized OBS feed to `udp://127.0.0.1:24760` after the receiver starts. Use the first frame's timestamp for the anchor. Configure regular keyframes on the sender. Set `HYPECLIP_FFMPEG` to your FFmpeg executable if it is outside PATH.

```powershell
pnpm hypeclip live --session stream-02 --port 24760 --chat C:\Recordings\stream-02.jsonl --media-start 2026-01-01T18:00:00Z --rights
```

The receiver waits for complete post-roll, remuxes finalized segments into a local recording and invokes the same worker and evaluator while capture continues. It retains the segments and most recent snapshot under the reported capture directory. Ctrl+C ends capture. Use `--once` for a single candidate and a fresh session ID for a new input.

## Replay and timing

```powershell
pnpm hypeclip replay --chat tests/fixtures/chat.jsonl --media-start 2026-01-01T00:00:00Z --duration-ms 95000 --reaction-ms 4000
```

JSONL fields are `eventId`, `eventAt`, `receivedAt`, `userId`, `text` and optional `emotes` and `fixture`. The fixture's media-start timestamp is its first frame. Source time is event time minus media start plus signed `--offset-ms`. Reaction delay is subtracted from the spike's media time. In the example, the 60,000 ms spike estimates an event at 56,000 ms. Applying 30 seconds of pre-roll and 25 seconds of post-roll gives **[26,000, 81,000) ms**.

The detector uses five-second buckets, a rolling baseline of up to twelve preceding buckets, a two-message per-user cap per bucket, distinct chatters and reaction keywords/emotes. A score of at least 60 and at least three chatters shortlists the event. Contributions, capped messages and their mapped times accompany each candidate. Overlapping cuts merge. Finished recordings clamp at the source boundaries. `replay --live` reports `ready: false` until post-roll exists.

## TikTok publisher

Configure the following environment variables for live use. Scope the R2 credentials to the dedicated HypeClip bucket. Set its public HTTPS domain and retention so each object remains readable through publication. HypeClip leaves uploaded assets in place.

| Variable | Value |
| --- | --- |
| `BUFFER_ACCESS_TOKEN` | Buffer API bearer token |
| `BUFFER_CHANNEL_ID` | One connected TikTok channel ID |
| `HYPECLIP_R2_ACCOUNT_ID` | Cloudflare account ID |
| `HYPECLIP_R2_BUCKET` | Dedicated HypeClip bucket name |
| `HYPECLIP_R2_ACCESS_KEY_ID`, `HYPECLIP_R2_SECRET_ACCESS_KEY` | Bucket-scoped R2 credentials |
| `HYPECLIP_R2_PUBLIC_URL` | Stable public HTTPS bucket base URL |
| `HYPECLIP_CHANNEL_REQUIREMENTS` | Any known unsupported requirement, such as manual privacy selection, commercial disclosure, approval or notification publishing. Setting this leaves the clip for review. |

Edit the post text in a UTF-8 caption file. The SRT file remains a separate worker artifact. A dry run verifies the portrait MP4 and resolves the configured channel when credentials are present. Without credentials it reports the missing verification and still previews the file locally.

```powershell
pnpm hypeclip publish --file C:\Clips\final.mp4 --highlight stream-01-final --caption-file C:\Clips\caption.txt --dry-run
```

For an explicitly selected real clip and destination, the deadline test uses `shareNow`. This command uploads to public R2 and sends a real post. Regular posting uses `--mode addToQueue` (the default).

```powershell
pnpm hypeclip publish --file C:\Clips\final.mp4 --highlight stream-01-final --caption-file C:\Clips\caption.txt --channel $env:BUFFER_CHANNEL_ID --mode shareNow --live
```

The publisher snapshots the final MP4, conditionally writes `clips/<sha256>.mp4`, then performs an anonymous HTTPS GET and verifies the media type and full digest. It displays the resolved TikTok handle and ID. Buffer receives a variable-based `createPost` mutation with `assets: [{video: {url}}]`, `channelId`, `text`, `schedulingType: automatic` and the selected mode. Locked, disconnected, paused or permission-limited destinations go to review. Configure requirements that Buffer does not expose through its channel query.

## Auto-publish

Enable a specific authorized session, exact recording path and destination. The cap counts durable intents for that session and channel, including uncertain attempts. Re-enabling the same session preserves the count. Each passing clip goes directly to the regular Buffer queue as part of `process` or the combined `collect` workflow.

```powershell
pnpm hypeclip auto-enable --session stream-01 --source C:\Recordings\stream-01.mkv --channel $env:BUFFER_CHANNEL_ID --cap 2 --rights
pnpm hypeclip auto-off --session stream-01
pnpm hypeclip auto-off
```

The recording must exist when enabling a session. For a future recording, start collection separately, enable once the recording path exists, then process after OBS finishes. The final command disables all sessions. A clip requires confirmed rights, valid artifacts, a verified local accept, a caption, and clear quality and review flags. Missing evidence and visual-only events go to local review. Rejections and invalid worker outputs have separate states. Demo and fixture clips stay local.

## Publication status and recovery

`published` requires a subsequent Buffer read with `status: sent`, automatic scheduling, a valid `sentAt` and no notification status. The remote ID is recorded immediately after creation. Status includes `sentAt`, `externalLink` when available and failure reasons. Scheduled or sending posts remain pending. Drafts, approval and notification posts go to review.

```powershell
pnpm hypeclip status
pnpm hypeclip sync --watch
pnpm hypeclip reconcile 17
pnpm hypeclip reconcile 17 --post-id VERIFIED_BUFFER_POST_ID
```

SQLite enforces a unique channel/highlight and channel/video digest. A durable claim precedes creation. A timeout or crash can leave `needs_reconciliation`. Reconciliation uses paginated remote posts matching the destination, exact caption and immutable asset URL. A unique match supplies the ID. Zero or multiple matches require operator review in Buffer. Supply a verified post ID, or, after confirming no post exists remotely, retire the intent with `reconcile 17 --close-unposted`. An ambiguous creation is never automatically submitted again. Rate-limit deadlines survive restarts. `sync` refreshes pending IDs once; `--watch` continues polling until they settle.

## Worker handoff and verification

Set `HYPECLIP_WORKER_ROOT` when running the Python worker from a separate checkout. The launcher detects the worker checkout's `.venv`.

Sol owns `media/`, `workers/`, their fixtures and tests. The shared boundary was committed at `274939201eb904a6c26b07bd793a1f61c178b058`. The root CLI invokes `python -m workers.media --request <json-file> --result <json-file>` with a provider-credential-free environment. Set `HYPECLIP_PYTHON` to the worker virtual environment's Python executable. The schemas, example request, example result and timing rules are in [contracts](contracts/README.md). Successful results are checked against the schema, output directory, media dimensions, clip duration, digest, transcript and SRT timeline before evaluation.

Use `pnpm hypeclip demo --worker` to select the real worker explicitly. Tests use a fixture-based Buffer adapter and mocked provider responses. Live publication verification requires configured credentials, an operator-selected real clip and a confirmed destination.

### Laptop verification

Sol's worker commit `f3da9ce` was merged at `07748a3`. From the merged checkout, the TypeScript typecheck passed, Vitest passed 40 tests and the Python worker passed 7 tests. A fresh `pnpm hypeclip demo` rendered a 720×1280 H.264 video lasting 55 seconds. Its SHA-256 matched the result file. Local Whisper placed the spoken line at 28.270–31.290 seconds on the clip timeline. Local Ollama returned `accept` with score 92. The fixture stayed in review.

For the before-stream-end check, two PowerShell terminals ran the receiver and sender below. The sender replayed the synthetic fixture at four times real time. Configure the FFmpeg path from the worker setup first and use a fresh session ID on subsequent runs.

```powershell
pnpm hypeclip live --session loopback-speech-check --port 24762 --chat tests/fixtures/chat.jsonl --media-start 2026-01-01T00:00:00Z --rights --once
```

```powershell
& $env:HYPECLIP_FFMPEG -hide_banner -loglevel error -readrate 4 -stream_loop -1 -i tests/fixtures/recording.mp4 -t 240 -r 12 -g 24 -bf 0 -c:v libx264 -c:a aac -muxdelay 0 -f mpegts 'udp://127.0.0.1:24762?pkt_size=1316'
```

The receiver reported 90,046 ms of finalized media and `inputStillRunning: true` when it returned the transcribed clip. A separate video-only run produced `missing_audio` and went to review. Both used replayed chat. Live Twitch collection, public R2 delivery and Buffer publication still require verification with a configured account. The local status check showed zero publish intents and zero enabled auto-publish sessions.

Provider specifications used for implementation include [Buffer video posts](https://developers.buffer.com/examples/create-video-post.html), [media hosting](https://developers.buffer.com/guides/hosting-media.html), the [Buffer schema](https://developers.buffer.com/reference.html), [Twitch chat](https://dev.twitch.tv/docs/chat/send-receive-messages/), [EventSub reconnects](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/), [Ollama model inventory](https://docs.ollama.com/api/tags) and [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
