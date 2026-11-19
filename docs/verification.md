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
