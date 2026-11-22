"""Offline Kokoro v1.0 (82M) inference for an audition or a single approved line."""
import argparse
import os
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--line", required=True)
    p.add_argument("--voice", default="am_michael")
    p.add_argument("--pace", type=float, default=1.0)
    a = p.parse_args()
    if not 0.7 <= a.pace <= 1.4 or not 0 < len(a.line.strip()) <= 180:
        p.error("Choose pace 0.7–1.4 and a line of up to 180 characters")
    from kokoro_onnx import Kokoro
    import soundfile
    root = Path(os.environ.get("HYPECLIP_KOKORO_DIR") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "HypeClip/tools/kokoro")
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    engine = Kokoro(str(root / "kokoro-v1.0.int8.onnx"), str(root / "voices-v1.0.bin"))
    audio, rate = engine.create(a.line, voice=a.voice, speed=a.pace, lang="en-gb" if a.voice.startswith("b") else "en-us")
    a.output.parent.mkdir(parents=True, exist_ok=True)
    soundfile.write(a.output, audio, rate, subtype="PCM_16")


if __name__ == "__main__":
    main()
