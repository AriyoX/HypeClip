# Local media worker

Run the v1 worker from the worktree root with Python 3.13 and FFmpeg 5.1 or later. FFmpeg needs `libx264` and `libass`. The fixture generator also needs `drawtext`. The setup below uses the Windows x64 build from [FFmpeg’s Windows download list](https://ffmpeg.org/download.html#build-windows).

## Setup on Windows

```powershell
$mediaTools = Join-Path $env:LOCALAPPDATA 'HypeClip\tools'
New-Item -ItemType Directory -Path $mediaTools -Force | Out-Null
$mediaArchive = Join-Path $mediaTools 'ffmpeg-release-essentials.zip'
curl.exe --fail --location --output $mediaArchive https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
tar.exe -xf $mediaArchive -C $mediaTools
$mediaBin = Get-ChildItem $mediaTools -Directory -Filter 'ffmpeg-*-essentials_build' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$env:HYPECLIP_FFMPEG = Join-Path $mediaBin.FullName 'bin\ffmpeg.exe'
$env:HYPECLIP_FFPROBE = Join-Path $mediaBin.FullName 'bin\ffprobe.exe'
$env:FFPROBE = $env:HYPECLIP_FFPROBE

python -m venv .venv
$python = (Resolve-Path '.venv\Scripts\python.exe').Path
& $python -m pip install -r workers/requirements.txt

Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
$env:HF_HUB_DISABLE_XET = '1'
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
& $python -c 'from faster_whisper import download_model; from media.speech import MODEL_ID, MODEL_REVISION; print(download_model(MODEL_ID, revision=MODEL_REVISION))'
$env:HF_HUB_OFFLINE = '1'
```

With FFmpeg already installed, `ffmpeg` and `ffprobe` on `PATH` also work. The model download is a one-time setup step. The worker loads `Systran/faster-whisper-small` revision `536b0662742c02347bc0e980a01041f333bce120` offline on CPU with int8, VAD and word timestamps. The default Victus snapshot is `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-small\snapshots\536b0662742c02347bc0e980a01041f333bce120`. Worktrees share that cache. `HF_HOME` can relocate it. `HYPECLIP_WHISPER_MODEL_PATH` can point directly to a local CTranslate2 model with `model.bin`, `config.json` and `tokenizer.json`.

## Run and verify

```powershell
& $python -m workers.tests.fixtures --output-dir '.hypeclip\media fixture'
& $python -m workers.media --request '.hypeclip\media fixture\speech request.json' --result '.hypeclip\media fixture\speech result.json'
& $python -m workers.media --request '.hypeclip\media fixture\silent request.json' --result '.hypeclip\media fixture\silent result.json'
& $python -m unittest discover -s workers/tests -v

$result = Get-Content '.hypeclip\media fixture\speech result.json' -Raw | ConvertFrom-Json
& $env:HYPECLIP_FFPROBE -v error -show_entries 'stream=codec_name,width,height,pix_fmt,avg_frame_rate:format=duration' -of json $result.verticalPath
Get-FileHash -Algorithm SHA256 -LiteralPath $result.verticalPath
```

The generator makes 95-second recordings with a visible source clock, colored landmarks, and a shifted container timestamp. The speech fixture uses two short Windows SAPI recordings from `workers/tests/fixtures/`, at source times 37 and 66 seconds. The requests cut `[26s,81s]` into a 55-second clip. The test suite uses the real model and binaries.

For the TypeScript adapter, set `HYPECLIP_PYTHON` to the absolute `.venv` Python path. When the adapter and worker are in separate worktrees, also set `HYPECLIP_WORKER_ROOT` to the media worktree root in adapters that support this variable. Pass absolute source and output paths in the request and use the artifact paths returned in the result.

## Output

`fit-pad` keeps the full landscape picture over a blurred background. `center-crop` fills the canvas. The request supplies even output dimensions. Examples use 540×960 and the renderer also handles 1080×1920. The source-aspect extract preserves the first audio track when present. The vertical MP4 uses H.264, yuv420p, 30 fps, faststart and AAC for clips with audio. Transcript segments and SRT cues use the extracted clip timeline.

Review flags include `silence` for near-zero audio, `missing_audio` for a video-only extract, and `no_speech` when audio is audible but yields no transcript. Each produces empty transcript segments and SRT. An audible clip whose model is unavailable produces `MISSING_SPEECH_MODEL` and a nonzero exit.

Completed artifacts live in a generation directory under `outputDir/.media-work`. Retry reuse checks all four artifact digests and regenerates damaged or incomplete output. A new generation leaves prior results readable. Remove the candidate output directory when its results are no longer needed.
