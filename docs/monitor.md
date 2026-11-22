# Local stream monitoring

## Dashboard

On Windows, open **Start HypeClip.cmd** from the extracted folder. With pnpm installed, you can also start from the checkout in PowerShell. Keep the terminal open while monitoring. [Windows setup](../README.md#install-on-windows)

```powershell
pnpm hypeclip dashboard --open
```

Overview shows active work and the local clip library. Sources opens with no initial selections. A saved source starts only when enabled. Use **Check source** before monitoring a URL or local recording. With synchronized JSONL, provide the UTC time of the first recorded frame. Public Kick VODs support a bounded archive interval and original replay chat when available. For another known archive, select the archive option if its URL also serves live broadcasts. Sources share the machine-wide capture budget with the CLI. Explicitly selected sources can resume on a server restart.

In **Clips → Presentation**, the phone preview runs the FFmpeg export recipe on retained media and saved speech. Save the preview as an independent version. **Decision** retains the detector evidence, source times, Qwen response, validated outcome and later operator review. Settings shows server-side connection readiness. Publishing stays off in the dashboard. Stop monitoring using the source's Stop control or close the server with Ctrl+C.

## GTA VI watchlist

`docs/watchlist.json` stores one creator key, one or more verified channel identities, recent activity evidence, and timecoded commentary samples per creator. `pins`, `additions` and `exclusions` accept creator keys. Exclusions apply to every linked identity. Copy this JSON for personal changes and pass its path to both commands. Refresh writes its cache under `HYPECLIP_HOME/watchlist`; it never rewrites your roster. Stable IDs are platform-specific. Kick entries use the numeric **channel** ID. Its webhook subscriptions use the **broadcaster user** ID.

```powershell
pnpm hypeclip providers --check
pnpm hypeclip watchlist --config .\docs\watchlist.json
pnpm hypeclip monitor --watchlist .\docs\watchlist.json --inspect
# Set this only for sources you can capture and edit locally.
$basis = Read-Host 'Local capture and editing permission basis'
pnpm hypeclip monitor --watchlist .\docs\watchlist.json --rights $basis
```

The supplied roster contains 31 creator profiles. On November 21, 2026 the ranking selected 20 creators with English-commentary evidence, including the two pins, Kai Cenat and IShowSpeed. The other 11 remained in review. The watchlist caps membership at 20. Pins and manual additions retain membership when offline. The public Kick GTA VI directory contributes discovery candidates. With a validated Twitch reader, Helix also checks the GTA VI category for up to 50 English-tagged live streams every five minutes. Category tags alone cannot qualify a creator. Known Twitch, YouTube, Kick and TikTok identities are checked individually. The monitor ranks current game evidence and reported concurrent audiences, with a seven-day fallback for verified past activity. A hidden or absent count stays null. A VOD view total is never a live viewer count. Three separately timecoded streamer-English samples qualify a creator. Mixed-language, silent-only and unattributed samples remain in review. The editable samples describe who spoke and what distinguishes that voice from game characters. A new broadcast needs current GTA VI evidence. An explicit current category takes precedence over its title. The capture rechecks the available category immediately before opening a live feed. Silent highlights from a reviewed English-speaking stream can qualify. Inspect shortlisted audio and frames before export.

The coordinator rechecks its cache every 15 seconds. Live metadata has a 90-second TTL, offline channels and category listings five minutes. Failed lookups back off exponentially up to one hour. Per-channel checks run three at a time. The YouTube adapter uses a known live handle and video ID without `search.list`. The default is two live capture slots shared across clients and state directories for the Windows user. The shared registry reads HYPECLIP_CAPTURE_LIMIT on first initialization. The dashboard then saves the machine setting, from one to eight. Changing an individual process environment cannot raise an existing shared limit. Opening or refreshing a dashboard tab uses no slot. Explicitly previewing a remote source may briefly reserve a slot to fetch six seconds of footage. A second coordinator using the same state directory also encounters an exclusive database lock. A live, eligible pin gets first choice. Among other candidates, a reviewed composition and available chat improve priority. A source being replaced stops reserving new windows, finishes collecting existing post-roll and drains its render queue. Share one state directory when monitoring the same PC. Ctrl+C closes the coordinator. Use `--duration-seconds 90` for a bounded run.

## Provider setup on this checkout

| Input | Discovery | Live media | Live chat | Archive media | Replay chat |
| --- | --- | --- | --- | --- | --- |
| Twitch | GTA VI directory through Helix with a reader token. Known-channel lookup also uses the public IVR mirror. | Streamlink Twitch plugin. Live playback observed for Kai Cenat. | EventSub WebSocket, one subscription per broadcaster. Mocked delivery tested. Reader token missing on this PC. | Supply an authorized bounded local recording. Streamlink supports accessible Twitch VODs. | Import original timestamped JSONL. Native replay download unavailable. |
| YouTube Live | Known handle or video. Watchlist checks channel ID against the public page or `videos.list`. | Streamlink YouTube plugin. Live playback observed for IShowSpeed. | Active chat ID from `videos.list`, then `liveChatMessages.list`. Mocked delivery tested. Reader credentials missing on this PC. | Local recording or creator download. | Supply original JSONL. The active-chat API ends with the broadcast. |
| Kick | Public GTA VI category listing and channel lookup. | Streamlink Kick plugin. Concurrent live captures observed. | Sampled public player polling observed. Optional signed webhook receiver tested locally. Internet delivery unverified. | `archive-interval` acquires up to one hour of accessible VOD media. `clipPlaylist` supports bounded public clips. | Cursor-paginated VOD replay aligned with HLS program-date-time. HTTP 429 can interrupt retrieval. Import original JSONL or use media-only detection. |
| TikTok LIVE | Known creator embed verifies numeric ID. Category-directory discovery unavailable. | Streamlink TikTok plugin accepts known `@handle/live` rooms. The tested rooms returned no playable stream. | Native live collector unavailable. Accepts supplied timestamped JSONL. | Creator-provided recording. | Creator-provided JSONL. Native replay download unavailable. |

These results describe the November 20–21 checks on this checkout. A Streamlink version confirms an installed adapter. To test a particular broadcast, run `pnpm hypeclip monitor --inspect <url>` for media availability and verify the channel's latest timestamped chat after monitoring starts. Kick's public player poll samples about every three seconds and can skip messages. The earlier YouTube archive example uses an Internet Archive recording and its supplied chat in `scripts/prepare-starliner.py`. [Streamlink supported plugins](https://streamlink.github.io/plugins.html)

**Twitch reader.** Create a Twitch application in the developer console. For a manually supplied user token, register `http://localhost:3000` and open the following authorize URL in your browser, replacing only `YOUR_CLIENT_ID`. After consent, copy the token from the redirect's URL fragment into the local `.env` as `TWITCH_USER_TOKEN`. The local page itself may be unavailable. HypeClip has no callback server. Repeat consent on expiry. When starting its chat collector and hourly while connected, HypeClip validates the token, reads its matching `client_id` and `user_id`, resolves each login with Helix Users and checks any configured `broadcasterId`. Each EventSub `channel.chat.message` v1 subscription uses its broadcaster ID, the reader's user ID and the current WebSocket session ID. `TWITCH_BROADCASTER_ID` is needed only by standalone `collect`. Use the numeric account ID from Helix Users for the target broadcaster. The monitor resolves the login itself. Verify the token with `providers --check`, then confirm delivery from new timestamped events. [Register an application](https://dev.twitch.tv/console/apps) · [Twitch OAuth](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/) · [EventSub chat](https://dev.twitch.tv/docs/chat/send-receive-messages/)

```text
https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A3000&response_type=token&scope=user%3Aread%3Achat
```

**YouTube reader.** Enable YouTube Data API v3 in a Google Cloud project. Create a key restricted to that API and set `YOUTUBE_API_KEY` for public reads. Alternatively supply an existing OAuth bearer token with `https://www.googleapis.com/auth/youtube.readonly` in `YOUTUBE_ACCESS_TOKEN`. Its issuer handles renewal. This checkout implements no Google redirect or refresh grant. The public watch-page fallback needs neither. Verify delivery on a current video with chat enabled using timestamped rows under `sources/<id>/chat.jsonl`. A 403 or an absent `activeLiveChatId` leaves capture in media-only mode. [Google Cloud credentials](https://console.cloud.google.com/apis/credentials) · [YouTube live chat list](https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/list)

**Optional Kick webhook.** Public player polling and archive replay need no Kick credentials. For signed push delivery, configure the app's public HTTPS Webhook URL in Kick Settings → Developer → Edit → Enable Webhooks. Set it to `https://YOUR-PUBLIC-HOST/events` and forward the unchanged raw body and headers to `http://127.0.0.1:17481/events`. Set `webhookPort: 17481` on each receiving channel. Channels on this port share a receiver. Register `chat.message.sent` v1 using an app access token and the broadcaster's numeric **user_id**, obtained from the channel lookup. With an external authorized app token in a temporary PowerShell variable, the registration body is shown below. To obtain the app token, use Kick's client credentials endpoint with your developer app ID and secret. This flow has no redirect URI. Reissue the app token if it expires. No Kick token or client secret is read by the local monitor. This run created no public callback or subscription. Signature tests exercise only the local receiver. Verify actual webhook delivery using new channel-matched JSONL entries while configured for webhook mode. [Events setup](https://github.com/KickEngineering/KickDevDocs/blob/main/events/introduction.md) · [Signing key and headers](https://github.com/KickEngineering/KickDevDocs/blob/main/events/webhook-security.md)

```powershell
# Optional external registration for your existing public callback.
$token = Invoke-RestMethod 'https://id.kick.com/oauth/token' -Method Post -ContentType 'application/x-www-form-urlencoded' -Body @{grant_type='client_credentials'; client_id=$kickClientId; client_secret=$kickClientSecret}
$body = @{broadcaster_user_id=[int64]$broadcasterUserId; method='webhook'; events=@(@{name='chat.message.sent'; version=1})} | ConvertTo-Json -Depth 4
Invoke-RestMethod 'https://api.kick.com/public/v1/events/subscriptions' -Method Post -Headers @{Authorization="Bearer $($token.access_token)"} -ContentType 'application/json' -Body $body | Select-Object -ExpandProperty data
```

### Local configuration

Run commands from the checkout. Use **Setup** in the dashboard to save optional reader credentials and publishing settings. New monitoring runs use these values immediately. Launch environment variables take precedence, followed by Setup values, then the working directory's optional `.env`. Restart the dashboard after editing `.env` or its launch environment. Keep custom private feed URLs in the environment or the ignored `.env`. A local recording and optional chat export can run with all provider credentials blank.

| Setting | Source, usage and check |
| --- | --- |
| `HYPECLIP_DASHBOARD_PORT` | Local listening port. Default 4177. Open the loopback URL printed by the dashboard command. |
| `HYPECLIP_CAPTURE_LIMIT` | Default capture-slot setting, two when unset. Use the dashboard capture setting to manage the shared limit. Check slot occupancy on Overview. |
| `HYPECLIP_HOME` | Writable directory for the run's SQLite database, clips, decisions and rolling captures. In a normal Windows CLI session the fallback is `%LOCALAPPDATA%\HypeClip`. Use a fresh directory to preserve blind scans. Inspect state with `pnpm hypeclip status`. On other systems `XDG_STATE_HOME` supplies the base when `LOCALAPPDATA` is absent, followed by `~/.local/state`. |
| `HYPECLIP_FFMPEG`, `HYPECLIP_FFPROBE` | Set absolute paths to the two executables in the installed FFmpeg build. Run each with `-version`. The Python worker also accepts `FFMPEG` and `FFPROBE`, and the legacy capture/probe adapters accept the corresponding alias. Use the `HYPECLIP_` names for all monitor paths. |
| `HYPECLIP_STREAMLINK` | Optional executable for live discovery/playback. On Windows the adapter first checks `%LOCALAPPDATA%\HypeClip\tools\streamlink\Scripts\streamlink.exe`, then PATH. Check with `pnpm hypeclip providers --check`. |
| `HYPECLIP_PYTHON`, `HYPECLIP_WORKER_ROOT` | Interpreter and optional separate checkout containing `media` and `workers`. Default analysis interpreter on Windows is the checkout's `.venv\Scripts\python.exe`. Run it with `-m workers.media --help`. [Worker setup](../workers/README.md) |
| `HYPECLIP_WHISPER_MODEL_PATH`, `HF_HOME`, `XDG_CACHE_HOME`, `HF_HUB_OFFLINE` | Optional CTranslate2 snapshot path or Hugging Face cache location. The default is pinned to `Systran/faster-whisper-small` revision `536b0662742c02347bc0e980a01041f333bce120`. Acquisition is a one-time setup step. Speech analysis forces offline loading. Check a non-silent clip with `pnpm hypeclip language-samples <recording> --to <new-directory>`. [Model installation](../workers/README.md) |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Local Ollama endpoint and preferred model tag. Setup verifies the explicit tag or chooses a compatible installed model when the tag is unset. It downloads `qwen3:4b` if no compatible model is available. The verified endpoint and tag are saved in `~/.config/hypeclip/ollama.json`. A later override must match that receipt to count as verified. |
| `HYPECLIP_KOKORO_DIR`, `HYPECLIP_KOKORO_PYTHON`, `OMP_NUM_THREADS` | Optional narration only. The directory contains `kokoro-v1.0.int8.onnx` and `voices-v1.0.bin`. Default interpreter is the `venv` under that directory. The standalone voice process defaults the thread setting to 2. Check with the `voice-preview` command below. |
| Source `feedEnv` | Set this field to the **name** of your environment variable containing an authorized HTTP(S) stream URL. Supply the current broadcast ID separately. Check `monitor --inspect --config <sources.json>` for a resolved feed. |
| `HYPECLIP_ISOLATED` | Local test sessions can set this in the calling shell before launch. A nonempty value skips checkout `.env` loading and disables the EventSub collector. Other adapters retain their individual behavior. |
| Worker lifecycle fields | `HYPECLIP_STAGE_CONTROL`, `HYPECLIP_STAGE_PARENT` and `HYPECLIP_STAGE_CANCEL` come from the coordinator when it controls a child worker. The stage budget and cancellation protocol assign them automatically. |

### Optional TikTok publishing connection

TikTok LIVE input uses the room adapter above. The separate publishing path uses TikTok connected **inside Buffer** and an R2 URL for the finished video. Local capture, preview and MP4 export use the filesystem. Adding credentials supplies connection details. Publishing requires a separate explicit publishing action or a separately enabled source policy.

| Setting | Source, usage and read-only verification |
| --- | --- |
| `BUFFER_ACCESS_TOKEN` | Personal API key from Buffer's API settings, supplied as a bearer token. Check the account with a read-only `account` query. This integration uses no redirect URI. [Buffer authentication](https://developers.buffer.com/guides/authentication.html) |
| `BUFFER_CHANNEL_ID`, `HYPECLIP_CHANNEL_REQUIREMENTS` | Connect TikTok in Buffer, list the organization's channels and copy the intended ID. Check the channel's `id`, `name`, `service` and `isDisconnected` with a read-only channel query. The service must be `tiktok`. The requirements field is optional free text for channel-specific manual disclosures or privacy requirements. [Buffer channel queries](https://developers.buffer.com/reference.html) |
| `HYPECLIP_R2_ACCOUNT_ID`, `HYPECLIP_R2_BUCKET` | Account ID and exact bucket name from Cloudflare's R2 dashboard. The SDK targets the default-jurisdiction S3 endpoint. Check both against the account and bucket shown there. [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/) |
| `HYPECLIP_R2_ACCESS_KEY_ID`, `HYPECLIP_R2_SECRET_ACCESS_KEY` | Two S3 credentials generated by an R2 API token scoped for object read/write on that bucket. Verify the token's scope and active status in R2. [R2 token setup](https://developers.cloudflare.com/r2/api/tokens/) |
| `HYPECLIP_R2_PUBLIC_URL` | Permanent public HTTPS base for this bucket. Verify an existing object's URL supports anonymous reads. The publishing path checks video retrieval before sending a post. |

On November 21 the Twitch reader, YouTube reader, Buffer destination and R2 hosting were unconfigured. Kick polling works without a developer connection. External Kick webhook delivery, TikTok LIVE playback and credentialed Twitch/YouTube chat still need an end-to-end broadcast check. No publishing connection is required for the dashboard.

## Blind scans and editable caption layers

Record the source URL and fixed `startMs` / `endMs` in a selection JSON before opening the interval. For Kick, run `archive-interval <selection.json> --to <new-directory> --rights <basis>`. The acquisition receipt identifies the media hash, stream title, language tag, UTC anchor and replay-message count or retrieval error. Create an archive source config using `interval.mp4`, the original broadcast ID, UTC anchor and archive offset. Add `chat` and `chatProvenance` only when the original replay is available. Replay acquisition caches complete one-minute slices, limits each invocation to 480 page lookups plus transient retries and records a retrieval error on failure. Use `--media-only` to skip chat requests.

`monitor --config <source.json> --scan 3` scores the entire finite interval. It selects the three highest-ranked non-overlapping reservations, or fewer when the detector finds fewer. A chatless recording uses the segment-energy detector and Whisper for shortlisted windows. The shortlist and SQLite jobs keep all candidate scores and chosen timecodes. Existing channel crops and reaction timing carry through. Blind scans reject operator markers and reviews. No first-pass decision depends on manual timestamps. The result of a text-only model is an editorial suggestion; review speech, action, framing and the identity of the speaker on the exported MP4.

The scene caption and dialogue subtitles are independent. The scene caption is a temporary, centered white card with dark text and rounded corners. It sits near the lower edge of the facecam panel, or in the upper third of a gameplay-only frame. Its times are relative to the trimmed clip. `sceneDurationMs` defaults to 2500 ms. Keep its factual context readable and clear it before the payoff. Dialogue uses smaller white phrases with a dark outline, below the divider in split-screen. Keep the post description in its own field. For a native portrait source that already has captions, select the clean dialogue treatment.

`export <id> --to <directory> --name <name>` writes an editable `edit-settings.json`. Change the scene text or duration, set `sceneCaption` to null to remove it, edit the post description or change the split crops and dialogue treatment. Then use `export <id> --edit <edited-settings.json> --to <directory> --name <new-name>` in the same state directory. This reuses saved speech and word timings without detection, Whisper or Ollama. An editable `trim` contains millisecond `fromMs` and `toMs` in the monitored source timeline. For a complete archived recording, a reviewed cut may extend beyond the original reservation. For live extracts, the reservation bounds apply. The selected event must remain inside the cut. Speech outside saved analysis needs reviewed word timings or stays uncaptioned. A saved original-picture edit can also be given a reviewed `splitScreen` profile. The original generation stays in place. Scene-on exports include frames decoded during and after the overlay, plus opening, payoff and ending stills.


Start one coordinator for a list of Twitch, YouTube Live, Kick and TikTok LIVE URLs. Capture and editing permissions belong to the selected sources. `--inspect` does read-only discovery and prints the media, chat and reconnect capabilities of each source.

```powershell
$urls = @('https://www.twitch.tv/swagg', 'https://www.youtube.com/live/KY4DWumZffg', 'https://kick.com/grootr6', 'https://www.tiktok.com/@rockstargames/live')
pnpm hypeclip monitor --inspect @urls
# For channels with recorded permission and inputs in your config:
pnpm hypeclip monitor --config .\sources.json @($urls[0], $urls[1])
```

The default profile is `~/.config/hypeclip/sources.json`. You can also run `monitor --rights "your actual permission basis" @urls` for live URLs covered by the same permission. Streamlink supplies live variant discovery and playable URLs via the installed platform plugins. A creator feed can use `feedEnv` pointing to an environment variable holding its HTTP(S) playback URL, or `port` for a loopback MPEG-TS feed. Configure its public channel URL and broadcast ID alongside either input. The coordinator opens sources separately, renews resolved URLs on reconnect, records gaps and pins each candidate before the render queue. A new live broadcast needs its own ID. Ctrl+C stops the run. Media and decisions stay in local state. [Streamlink plugins](https://streamlink.github.io/plugins.html)

| Platform | Original audience chat | Reconnect |
| --- | --- | --- |
| Twitch | EventSub WebSocket with `TWITCH_USER_TOKEN` and `user:read:chat`. Helix binds the login to its broadcaster ID. | EventSub handoff or resubscription. Gaps can lose messages. |
| YouTube Live | `videos.list` resolves the active chat. `liveChatMessages.list` receives publication timestamps with `YOUTUBE_API_KEY` or `YOUTUBE_ACCESS_TOKEN`. For archives supply the original export. | Retains the page token across transient failures and honors the server's polling interval. |
| Kick | Default public player polling needs no credentials. For signed delivery configure `webhookPort` for an existing subscription and HTTPS forwarder. Forward the original signed `chat.message.sent` body and headers to `127.0.0.1:<port>/events`. The receiver checks the signature, event version and channel. | Provider webhook redelivery. Event IDs are deduplicated during detection. |
| TikTok LIVE | Creator-provided timestamped JSONL when available. The public developer products reviewed did not expose general LIVE audience chat. | Media reopen and local JSONL resume. |

Provider references cover [Twitch EventSub](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/), [YouTube live chat](https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages), [Kick webhook security](https://docs.kick.com/events/webhook-security) and [TikTok developer products](https://developers.tiktok.com/products/).

## Inputs and time

Define a `sources` array and optional `channels` settings keyed by `platform:lowercase-channel`. Each source carries a public `url`, `localReviewRights`, and live or archive `status`. For a bounded archive provide `file`, `broadcastId`, `channel` and the source-relative `archiveOffsetMs`. With original chat, include `chat` (the normalized JSONL), `chatProvenance` and `mediaStart` (the UTC time of the excerpt's first frame). A public viewer-downloadable Kick clip can use its matching finite `clipPlaylist` and embedded first-frame UTC. A complete two-highlight example is in [gta6-kick.json](gta6-kick.json).

```powershell
pnpm hypeclip monitor --config .\docs\gta6-kick.json --once
$delivery = Join-Path ([Environment]::GetFolderPath('MyVideos')) ('HypeClip/GTA6-Real/' + (Get-Date -Format yyyyMMdd-HHmmss))
pnpm hypeclip export 3db502d02f72f14a5494cec1 --name right-turn --to $delivery
pnpm hypeclip export 10d5cb16d5a0fd1f6343c23d --name snapmatic --to $delivery
```

The chat clock in milliseconds is `event UTC − first-frame UTC + offsetMs`. The estimated event is `mapped chat time − latencyMs − reactionMs`. Stream latency is the difference between the capture timeline and the audience's presentation timeline. Use zero differential latency when both observe the same delayed player. Reaction time is the additional delay between seeing the event and sending the message. The receiver-open estimate on live capture is approximate. Per-channel `measurements` can supply separate arrays of measured `offsetMs`, `latencyMs` and `reactionMs` with an `evidence` note. Each measured median supersedes the corresponding estimate. The inherited 4 s reaction estimate is uncalibrated until measured. A single undifferentiated lag observation belongs in only one correction.

`preRollMs` reserves 20–40 s by channel (30 s default). `setupMs`, `tailMs` and `maxClipMs` determine the edit inside that reservation. Overlapping bursts update the waiting reservation. Speech boundaries refine the cut before the final encode. `glossary` maps original emote IDs, names and phrases to channel-specific meanings. `bots` lists chatter IDs to exclude. Capped, distinct reactions and counterexamples reach Qwen only after the shared detector admits the window. The decision cache includes source, time range, evidence, prompt version and local model. The coordinator permits one FFmpeg, one Whisper and one Ollama stage, with at most two heavy stages active at once.

Without timestamped chat the report shows **media only**. Operator `markers` specify `startMs`, `payoffMs`, `endMs`, a frame-reviewed `observation`, and optional short `overlay` and post `caption`. All three times are relative to the excerpt or capture. Otherwise rises in the segment audio envelope shortlist a window for transcription and review. For a reviewed operator cut with unreliable Whisper wording, set `withholdSpeech` to the reason. The export keeps the original voice and saves the uncertain draft for review. Audio and operator cuts apply zero chat delay. These modes do not verify chat detection.

## Text and voice

### Facecam and gameplay

Auto chooses one layout for a clip. A usable streamer camera belongs above the synchronized gameplay. Gameplay only preserves the full source if a tight crop would sacrifice context. Choose a layout and inspect the MP4 at phone size before saving a new version. A known source profile can supply normalized rectangles in the order left, top, width, height.

```json
{
  "splitScreen": {
    "facecam": [0.027, 0, 0.145, 0.217],
    "gameplay": [0.219, 0, 0.673, 1],
    "fraction": 0.53,
    "captions": "auto"
  }
}
```

The red divider follows the panel fraction. Native portrait footage can keep the original frame. Qwen can recommend dialogue or clean presentation based on speech evidence. An operator can use `words` or `clean` to change that treatment. Play the preview to check the facecam, HUD and subtitle position. The renderer uses the same source clock for both panels and maps the original audio once.

For an existing automatic candidate, add an entry to `settings.reviews` using the detector's exact `payoffMs`, an observed action and a `startMs` and `endMs` inside the reservation. These times are measured from the first frame of the monitored excerpt. The review can supply its own complete `splitScreen` profile and an optional `words` array of reviewed `{startMs,endMs,text}` timings **relative to the trimmed clip**. A review is applied only when the detector independently finds that event. A manual `markers` entry uses the same edit fields for a media-only operator cut. Use a fresh state directory to rerun a completed broadcast with different settings.

For a split-screen job, `export <id> --to <directory> --name <name> --preview-ms <time>` writes a named MP4, a full-resolution JPEG from that clip time, subtitles, crop settings, selection evidence and source timecodes. The exporter checks the decoded audio envelope against the capture. The preview time is in milliseconds from the start of the finished clip.

### Original audio and optional voice

Narration defaults to `off`. Use `--narration auto` or a channel setting for the optional exception. A channel's optional `context` must identify a verified `fact`, its `source` and the specific `readingConflict` that makes a short overlay insufficient. Qwen must return a matching factual line and a measured quiet interval before the payoff. Overlapping speech, weak evidence, an overlong take or an unavailable engine leaves the original audio alone. Configure `voice` and `pace` per channel. A standalone preview uses the optional local Kokoro v1.0 82M ONNX model, independent of capture.

```powershell
pnpm hypeclip voice-preview --voice af_heart --pace 1 --line "Listen for the change in the engine." --output .\heart.wav
pnpm hypeclip voice-preview --voice am_michael --pace 1 --line "Listen for the change in the engine." --output .\michael.wav
```

On this Victus, Streamlink is installed under `%LOCALAPPDATA%\HypeClip\tools\streamlink` and Kokoro under `tools\kokoro`, in separate venvs. The Kokoro directory contains `kokoro-v1.0.int8.onnx` and `voices-v1.0.bin`. Other installations can set `HYPECLIP_STREAMLINK`, `HYPECLIP_KOKORO_DIR` and `HYPECLIP_KOKORO_PYTHON`. [Kokoro ONNX release assets](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
