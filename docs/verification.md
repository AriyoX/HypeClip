# Victus integration verification

## Local end-to-end

Windows 11 Home build 26200, 15.6 GiB usable RAM, RTX 4050 Laptop GPU with 6,141 MiB VRAM. The final setup check reported 2,784 MiB free VRAM, 1.95 GiB free RAM and 349 GiB free disk. Node 22.15.0, pnpm 10.14.0, CPython 3.13.3 and FFmpeg/ffprobe 9.0.2 ran in the merged worktree.

| Component | Installation and result |
| --- | --- |
| Ollama | The existing Windows service at `http://localhost:11434` already had `mistral:7b`. It failed the original instruction check. Setup downloaded `qwen3:4b` (2.5 GB). The integration run reused it and `setup-ollama` returned `downloaded: false`. Both tags remain installed. The verified tag is in `%USERPROFILE%\.config\hypeclip\ollama.json`. |
| Evaluator | `POST /api/chat` with JSON schema, `stream=false`, `think=false`, temperature 0 and context 4096. Its setup response passed the exact `review` / `42` check. [Model inventory](https://docs.ollama.com/api/tags) and [structured outputs](https://docs.ollama.com/capabilities/structured-outputs) |
| Whisper | Sol's setup downloaded the multilingual `Systran/faster-whisper-small` snapshot. Integration reused it offline with faster-whisper 1.2.1, CTranslate2 4.9.0, four CPU threads, int8, VAD and word timestamps. The snapshot is `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-small\snapshots\536b0662742c02347bc0e980a01041f333bce120`. |

Run after the Windows setup in the root README. For the Victus side-by-side binaries, these environment settings also make FFmpeg available to the standalone Python tests.

```powershell
$python = (Resolve-Path .venv/Scripts/python.exe).Path
$bin = "$env:LOCALAPPDATA\HypeClip\tools\ffmpeg-9.0.2-essentials_build\bin"
$env:HYPECLIP_FFMPEG = Join-Path $bin ffmpeg.exe
$env:HYPECLIP_FFPROBE = Join-Path $bin ffprobe.exe
$env:HF_HUB_OFFLINE = '1'
pnpm install --frozen-lockfile
& $python -m pip install -r workers/requirements.txt
& $python -m pip check
pnpm typecheck
pnpm test
& $python -m unittest discover -s workers/tests -v
pnpm verify:local
```

TypeScript typecheck and `pip check` passed. Vitest passed 47 tests across eight files. The Python suite passed seven tests using real binaries, including speech, silence, missing audio, nonzero container timestamp, captioned frames and interrupted artifacts. Sol's worker is `f3da9ce`, merged by `07748a3`. The shared request/result boundary is `2749392`.

**Clock fixture.** `pnpm verify:local` generated 95 s of media and ran the actual `replay`, `process`, `evaluate` and `status` CLI commands. The quiet baseline and single spammer produced zero candidates each. The genuine spike and overlapping-spike cases produced one each. A spike at 60 s minus a 4 s reaction delay gave an estimated event at 56 s and a cut from 26 to 81 s. FFprobe reported 55.000000 s, H.264, 1080×1920, 30/1 fps, yuv420p and AAC. The SHA-256 was `a04123b388dbc150dff19a0e01ca170291bcea371b00dcc6f715d0cabf0baa12`.

I inspected the decoded frames. The opening clock read `00:00:26.000`, the captioned frame read `00:00:37.100` and the near-final frame read `00:01:20.800`. Both colored landmarks and the full source picture were visible. The first subtitle was readable in the lower safe margin. The two clip-relative SRT intervals were 10.800–13.760 s and 40.080–42.160 s. A separate offline Whisper pass on audio decoded from the **finished MP4** recovered both spoken lines. Audio input was unavailable to the reviewing agent. Human listening for volume and intelligibility remains open.

Qwen returned `accept`, score 92. Its proposed caption says the speaker caught the last train with one second to spare and mentions the blue lantern. Both details occur in the speech. The picture itself shows a clock and colored markers. The source remained a local fixture. A repeat of the same session reused the job and all four files. A fresh candidate sent only to an unused loopback port (`127.0.0.1:53483`) reached `review` with `fetch failed`. Its MP4 and SRT remained present. Retrying `evaluate` against the restored endpoint returned a verified accept, with identical artifact paths, modification times and video digest. Across this run the publisher observer logged zero calls and SQLite contained zero intents.

```powershell
$v = "$env:LOCALAPPDATA\HypeClip\verification\acceptance-myRGL5"
$r = Get-Content "$v\verification.json" -Raw | ConvertFrom-Json
& $env:HYPECLIP_FFPROBE -v error -show_entries 'stream=codec_name,width,height,pix_fmt,avg_frame_rate:format=duration' -of json $r.online.result.verticalPath
Get-FileHash -Algorithm SHA256 -LiteralPath $r.online.result.verticalPath
& $env:HYPECLIP_FFMPEG -v error -i $r.online.result.verticalPath -vn -ar 16000 -ac 1 -c:a pcm_s16le -y "$v\final-audio.wav"
& $python -c "import sys; from pathlib import Path; from media.speech import load_model,speech_samples; segments,_=load_model().transcribe(speech_samples(Path(sys.argv[1])),vad_filter=True,word_timestamps=True); print(' '.join(s.text.strip() for s in segments))" "$v\final-audio.wav"
# Inspect the decoded artifacts and exact per-subprocess arguments
Get-Item "$v\first.jpg","$v\captioned.jpg","$v\last.jpg","$v\speech.wav","$v\commands.json"
```

## Real broadcast and recorded chat

The source is the June 5, 2024 NASA Starliner launch broadcast. The public archive includes the original audience chat. The preparation script wrote a 130 s excerpt and 1,334 real messages with hashed chatter IDs. `eventAt` is the archived timestamp, and `receivedAt` is local import time. The calibration frame read L−00:03:36 at archive time 14,800 s. Using NASA's 14:52:15 UTC launch time gives a first-frame anchor of approximately 14:51:30 UTC. The permitted use considered here was factual editorial reporting with credit to NASA. For other uses, review NASA's third-party and endorsement terms. [Broadcast and chat archive](https://archive.org/details/nasas-boeing-starliner-crew-flight-test-launch-june-5-2024-official-nasa-broadcast) · [NASA timeline](https://www.nasa.gov/wp-content/uploads/2024/06/cft-rendezvous-summary-timeline-gmt-157-launch-june-5.pdf) · [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)

```powershell
$d = "$env:LOCALAPPDATA\HypeClip\acceptance\starliner"
& $python scripts/prepare-starliner.py $d --ffmpeg $env:HYPECLIP_FFMPEG
$env:HYPECLIP_HOME = "$env:LOCALAPPDATA\HypeClip\acceptance\nasa-state"
pnpm hypeclip replay --chat "$d\chat.jsonl" --media-start 2024-06-05T14:51:30Z --duration-ms 130000
pnpm hypeclip process --session nasa-cft-20240605 --source "$d\starliner.mp4" --chat "$d\chat.jsonl" --media-start 2024-06-05T14:51:30Z --rights
pnpm hypeclip status
node --experimental-strip-types scripts/verify-broadcast.mjs $d
```

The production pipeline ran after recording, with publishing disabled, and selected one window, `[37.746,92.746)`. The score of 70 comprised 20 velocity, 30 distinct-chatter and 20 reaction points. The decoded picture showed liftoff, a NASA LIVE mark and burned-in speech captions. The 55 s worker video has SHA-256 `e612beb588f95a3d789dec28cbcf95078baae8101d32d629dd301921cd6fc4c8`. The real model accepted it at 70, and SQLite retained it for local review. Repeating the exact session returned the same job and output.

Whisper transcribed Butch Wilmore as “Butch Wilmer.” Ollama carried that error into its caption and implied mission success beyond the clip. The editorial bundle uses the first 25 s, including countdown and liftoff, and a separately edited factual post caption. It excludes the later speech with misheard names. The full original worker result and evaluation remain available in `run.json`. The final bundle probes at 25.007891 s, H.264, 1080×1920, 30/1 fps, yuv420p and AAC. Its SHA-256 is `2829fdd7b63c3d32cbf560183915028c1acc271c72a61b8ef6d3e4491faad802`. [NASA launch report](https://www.nasa.gov/news-release/liftoff-nasa-astronauts-pilot-first-starliner-crewed-test-to-station/)

## Mocked integration

`verify-broadcast.mjs` runs the same recording through the normal CLI with real local models, a fresh SQLite database, an enabled source, `--mode shareNow` and a one-clip cap. It records R2 and Buffer operations to a file-backed double. Two passes produced one upload, one creation and one status read. The mock returned `post-1` and `sent`. Its ID, time and example URL are test data. Its results are in `%LOCALAPPDATA%\HypeClip\acceptance\starliner\verification-7JpdFQ\verification.json` and `provider.jsonl`. The script prints a new export directory on each invocation.

Vitest also killed a child process immediately after its fake provider persisted an accepted post and before SQLite recorded the ID. After the claim expired, two database connections reconciled the one remote record without a second creation. Other cases covered a lost response with no unique match, a missing/invalid Buffer token, runtime 429s on create and status reads, remote failure, scheduled/draft/notification/approval states, disabled publishing, an Ollama 404, invalid model JSON/score, rejected candidates and invalid worker output. Each affected case checked its local state or transport calls.

## Live verification and handoff

**Public post blocked.** No Buffer token, selected TikTok channel or R2 credentials were configured. The production dry run returned `dry_run`, `channel=unconfigured` and `verified=false`. The production verification database held zero publish intents. There is no real Buffer ID, `sentAt`, external link or TikTok visibility result. The preserved bundle includes the final MP4, UTF-8 caption, cue-aligned transcript, SRT, preview, source provenance and dry-run receipt.

```powershell
$b = "$env:LOCALAPPDATA\HypeClip\ready\nasa-cft-20240605"
pnpm hypeclip publish --file "$b\vertical.mp4" --caption-file "$b\caption.txt" --highlight 2a90fe221f4d69744d7c8e6f-liftoff25 --mode shareNow --dry-run
```

Once the operator selects the clip and destination, the explicit send form is in the root README. Keep that highlight ID for this editorial cut. Live Twitch account access, public R2 retrieval, Buffer delivery and a TikTok profile check remain pending.

A separate earlier loopback test produced a clip **before** the synthetic sender ended. With fixture chat, the receiver reported 90,046 ms of finalized media and `inputStillRunning: true`. To repeat it, run the receiver first and the sender in another PowerShell window with the same local FFmpeg path. Use a fresh session ID.

```powershell
pnpm hypeclip live --session loopback-new --port 24762 --chat tests/fixtures/chat.jsonl --media-start 2026-01-01T00:00:00Z --rights --once
# Sender terminal
& $env:HYPECLIP_FFMPEG -hide_banner -loglevel error -readrate 4 -stream_loop -1 -i tests/fixtures/recording.mp4 -t 240 -r 12 -g 24 -bf 0 -c:v libx264 -c:a aac -muxdelay 0 -f mpegts 'udp://127.0.0.1:24762?pkt_size=1316'
```


## Two concurrent GTA 6 discussion fixtures on the Victus

On November 19, 2026, two 240-second original illustrated broadcasts with Windows TTS and simulated chat were ingested at 1x through `live-multi`. Both clips covered media seconds 12?67 and finished while their own captures were running. The shared destination snapshot was `local-gta6-review`. Local FFmpeg, CPU/int8 Whisper small and Ollama qwen3:4b processed both. Publisher adapters were local doubles.

| Simulated source | Chat delay | Trigger UTC | Finalized post-roll UTC | Validated render UTC | Decision UTC | Model |
| --- | ---: | --- | --- | --- | --- | --- |
| Frame Desk | 2.3 s | 16:21:34.730 | 16:21:57.991 | 16:22:59.574 | 16:23:10.511 | Review |
| Forecast Club | 6.0 s | 16:21:38.342 | 16:21:58.098 | 16:23:39.666 | 16:23:44.457 | Reject |

Forecast Club transcription overlapped Frame Desk encoding by 29.276 seconds and its evaluation by 10.917 seconds. Finalized media advanced to 140 and 174 seconds respectively. No segment gaps were observed. The sampled CLI process tree peaked at 1,487 MiB working set, system CPU at 100%, and system GPU memory at 3,135 MiB. The state directory peaked at 18.8 MiB. The delivered H.264/AAC files decoded in full at 1080?1920. Both matched their worker SHA-256. The original and exported audio envelopes aligned within 30 ms. Normalized subtitle words matched the original scripts.

The fault run killed one FFmpeg receiver with an outstanding reservation, verified its peer continued, then killed the coordinator. Restart recovered the surviving reservation. A separate SQLite owner held the job beyond 40-second media retention. At release, after 40.283 seconds, the original segments for the window had all been evicted. The real worker rendered from the reserved extract and a forced loopback Ollama outage left the media in review. Cross-process claims, duplicate mocked sends, shared destination cap and ambiguous-create reconciliation were tested locally.

Run `python .\scripts\gta6-demo.py` from the checkout for a fresh Videos export and isolated verification state. The export includes independently authored captions, SRT, decoded stills, metadata, file digests and `results.txt`. The November 19 run's machine-readable receipts, source streams, captured segments and test logs are in `%LOCALAPPDATA%\HypeClip\gta6-runs\run-rhm3tl17`.

## Genuine GTA VI gameplay and mixed-platform monitoring

On November 20, 2026 (Nairobi), the normal monitor acquired two public, viewer-downloadable Kick clips from GrooTR6's broadcast 01a1ee1c-bc18-7a03-b966-e60e561dfaeb. Source frames showed an interactive sink repair with original dialogue and a driving pursuit with the HUD and facecam. Operator timestamps selected local footage at 2.600 to 18.200 s and 11.200 to 22.100 s respectively. Both exports fully decoded at 1080 x 1920 with stereo AAC. Audio envelope correlations to the source were 0.9994 and 0.9975 with 0 ms estimated shift at 10 ms resolution. Both auto decisions used zero generated narration. Four original speech cues accompany the repair. The driving cut keeps a brief Tamil comment on its original audio track and withholds inconsistent Whisper wording. Standalone af_heart and am_michael audition files are separate from the edits. [Reproducible source list](gta6-kick.json) / [Monitor and export commands](monitor.md)

During one mixed-source run, two Kick captures and the NASA YouTube archive capture began within 28 ms. Their inputs overlapped for more than 31 s. The shared worker produced attributed outputs for both platforms. NASA used synchronized archived chat. Kick's original structured chat was unavailable. Its operator cuts establish media-only editing. Streamlink inspected real live Twitch (Swagg), YouTube (official launch) and Kick (GrooTR6) variants. TikTok @rockstargames/live returned no playable stream. A simultaneous live-media and live-chat run remains unverified. Twitch EventSub and YouTube pagination/retry were covered with mocks. Kick's signed webhook events were checked locally. TikTok's media-only trigger ran against a local regression replay.

The final test run passed typecheck, 71 Vitest cases, nine Python worker tests and the legacy local integration exercise. The GTA VI run databases contained zero posting intents and zero enabled publication policies. The Windows Videos known folder contains HypeClip/GTA6-Real/grootr6-20261120-000848, with the MP4s, editable assets, auditions, a results file and PowerShell commands. Acquisition receipts, stage timings and mixed-source logs are in %LOCALAPPDATA%/HypeClip/real-runs/grootr6-20261120-000848.
# GTA VI watchlist acceptance, 20–21 November 2026

The working branch was `main` at `9ab05084c52a1f469da7a86896d8adb410363c03`. Existing working-tree edits and previous exports were retained. The Windows Videos known folder resolved to `C:\Users\HP\Videos`. The run is in `HypeClip\GTA6-Watchlist\20261120-133924754` beneath it. Raw media, model decisions and SQLite state are under `%LOCALAPPDATA%\HypeClip\watchlist-20261120`.

| Source and archive interval | First-pass selection | Editorial outcome |
| --- | --- | --- |
| xQc, 07:00:00–07:30:00 | 4,281 original Kick replay messages. The detector scored 34 candidates and shortlisted three. | The vape and health-bar moment scored 81 with 30 distinct chatters. Qwen requested review. The editor kept the original start and extended the ending by 6.733 seconds to include the HP remark. |
| Adin Ross, 01:00:00–01:30:00 | 37 audio rises, three first-pass edits. Kick returned HTTP 429 during chat retrieval. | All three showed a casino intermission. None was promoted. |
| Adin Ross, 03:00:00–03:30:00 | Media-only by selection. Eight audio rises, three independent shortlisted windows. | The store moment rose 15.23 dB over its baseline. Qwen requested review. The editor shortened the opening and extended the ending through the lockbox and cash. |
| SHNAGGYHOSE, 02:00:00–02:30:00 | 91 audio rises, three first-pass edits. Kick returned HTTP 429 before a complete replay was available. | Kept all three for review. Frames exposed a different facecam position in this broadcast. The source crop was corrected for future clips. |

The selections were written before inspection. The run retains all twelve original MP4s and independent decisions under `first-pass`. The two deliverables are distinct Kick archive discoveries. The earlier Adin basketball excerpt is labeled separately in `reference-edits`.

Both finished MP4s decoded to 1080×1920 with one stereo AAC track. The original-to-export audio-envelope correlations were 0.999963 for xQc and 0.999973 for Adin. Both had a measured offset of 0 ms at 10 ms resolution. The panels share one decoded input. Beginning, action, ending, current-word cues and scene-on/scene-off frames were inspected. Saved edit settings reproduced both MP4 hashes without re-running transcription. An independent full rescan from the retained 30-minute recordings also reproduced both finished MP4 hashes after applying the documented edits.

Twenty distinct creators met the watchlist sample rule. The November 21 snapshot contains timestamped provider evidence and unknown counts as null. HypeClip resolved Kai Cenat on Twitch and IShowSpeed on YouTube and decoded concurrent live samples on November 20. On November 21 the watchlist coordinator recorded overlapping GTA VI streams from SHNAGGYHOSE and schlump with real player-chat events. The first smoke test exposed a misleading GTA VI title on a channel categorized as Just Sleeping. The category now takes precedence, and a focused regression covers it. Twitch and YouTube credentialed chat were exercised by tests. Kick signature verification was local. No real webhook delivery was observed. TikTok's verified IShowSpeed creator embed returned stable ID 6865486669187171334. Its LIVE URL and the other tested rooms returned no playable variants.

The complete suite passed with FFmpeg enabled: 78 TypeScript tests and 11 Python tests, including a decoded native portrait regression. Type checking passed. The legacy local acceptance run found one genuine-pattern fixture burst, suppressed baseline and spam and recorded zero upload and publishing calls. Fixture MP4s are confined to regression state. Run-local publication policies and posting intents are recorded in `evidence/publication-check.json`.

From the checkout, run `pnpm hypeclip providers --check` and `pnpm hypeclip watchlist`. In the run folder, `reproduce.ps1` rescans the retained recordings in fresh state; `reproduce.ps1 -RenderOnly` repeats the exports using saved model work. The source URLs, exact timecodes, language reviews, original decisions, overrides and audio measurements are in the two deliverables' `results.json` files.


## November 22 dashboard acceptance

The unattended Adin Ross test used an unseen six-minute Kick recording and 1,565 synchronized replay messages. The detector selected a 79/100 reaction from 31 distinct chatters. Local `qwen3:4b` recommended accept at 85/100. The validator retained the untouched 18.15-second cut in review because the quoted evidence could not be confirmed. The later answer to the airport question falls outside that first pass. The original stereo audio measured 0 ms offset at 10 ms resolution.

[Open the acceptance clip](http://127.0.0.1:4177/#clips/f1e840de727320ad44b64175) or read the local handoff at `C:\Users\HP\Videos\HypeClip\Dashboard\acceptance-20261122-093255207\RUN.md`. The handoff includes the fixed-input reproduction command, original model response, clip hashes, decoded examples, browser screenshots and the earlier blind runs.

The TypeScript suite passed 80 tests and Python passed 17. Two concurrent CLI captures occupied both slots while the dashboard recording waited. Browser refreshes and a second client produced no duplicate worker. Chrome played, sought and downloaded the export. A cached re-render preserved the original MP4 and speech cache. The disconnected-model test retained both MP4 and SRT for review. Publishing stayed disabled.

## November 22 question-ending regression

The original Adin airport MP4 still has SHA-256 `edd5dd0f559c04ba8d0c59514576d231b446533aecf50b87014f5bf87999ba44`. Both airport cuts start at 03:40:25.979. The original ends at 03:40:44.129. The revised automatic cut includes “You can’t” at 03:40:46.459–03:40:47.419 and ends at 03:40:47.869. The available gap supported a 450 ms pause. Unanswered questions and unrelated following speech kept their original endings. Tests also cover reservation limits, intervening filler, unreliable recognition and timestamped citations.

Chrome cued both players to 14.15 seconds. Each player has its own controls, and the pair fits on a 393 px viewport. The raw decisions, integrity checks and preselected intervals are recorded in `C:\Users\HP\Videos\HypeClip\Dashboard\endings-20261122-144323250\RUN.md`. [Compare the airport cuts in the local studio](http://127.0.0.1:4177/#clips/f1e840de727320ad44b64175/6e876aa5abd9159db2f07da3)
