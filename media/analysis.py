"""Analyze only a reserved media window. All times are relative to its first frame."""
import json
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

from .job import atomic_json
from .speech import speech_samples, transcribe
from .stages import stage
from .video import probe, run_tool, seconds


def analyze(candidate):
    source = Path(candidate["sourcePath"])
    start, end = candidate["startMs"], candidate["endMs"]
    duration = end - start
    if not 0 < duration <= 120000:
        raise ValueError("Analysis windows must be within 120 seconds")
    segments, captions, quiet, words = [], [], [], []
    info = probe(source, "SOURCE_INVALID")
    if info.audio:
        with tempfile.TemporaryDirectory(dir=candidate["outputDir"]) as directory:
            wav = Path(directory) / "audio.wav"
            with stage("ffmpeg"):
                run_tool("ffmpeg", ["-nostdin", "-v", "error", "-ss", seconds(start + info.video_offset_ms),
                         "-protocol_whitelist", "file", "-i", str(source), "-t", seconds(duration),
                         "-map", "0:a:0", "-vn", "-af", "aresample=16000:async=1:first_pts=0",
                         "-ac", "1", "-c:a", "pcm_s16le", str(wav)], "AUDIO_EXTRACT_FAILED")
            samples = speech_samples(wav)
            if samples is not None:
                with stage("whisper"):
                    segments, captions = transcribe(samples, duration, 28, words)
                # A continuous low peak level is a conservative candidate voice slot.
                for i in range(0, len(samples) - 3999, 4000):
                    if abs(samples[i:i + 4000]).max() <= 0.012:
                        ms = i // 16
                        if quiet and quiet[-1][1] == ms:
                            quiet[-1][1] += 250
                        else:
                            quiet.append([ms, ms + 250])
            else:
                quiet = [[0, duration]]
    return {"segments": list(map(asdict, segments)), "captions": list(map(asdict, captions)),
            "words": [{**asdict(word), "probability": probability} for word, probability in words],
            "quiet": [r for r in quiet if r[1] - r[0] >= 500], "hasAudio": bool(info.audio)}


if __name__ == "__main__":
    request, output = map(Path, sys.argv[1:])
    atomic_json(output, analyze(json.loads(request.read_text(encoding="utf-8"))["candidate"]))
