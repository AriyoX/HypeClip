"""Materialize a bounded, viewer-downloadable KICK clip from its public HLS playlist."""
import argparse
import re
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from .job import atomic_json, sha256
from .video import probe, run_tool


def read_url(url, limit):
    with urllib.request.urlopen(url, timeout=25) as response:
        if urlsplit(response.geturl()).hostname != "clips.kick.com":
            raise ValueError("Unexpected KICK clip media host")
        data = response.read(limit + 1)
        if len(data) > limit or response.headers.get("Content-Range"):
            raise ValueError("Incomplete or oversized KICK clip object")
        return data


def acquire(page, playlist, output):
    url = urlsplit(playlist)
    clip = urlsplit(page).path.rstrip("/").split("/")[-1]
    if (url.scheme != "https" or url.netloc != "clips.kick.com" or url.query
            or not re.fullmatch(r"clip_[A-Za-z0-9]+", clip)
            or not re.fullmatch(r"/clips/[A-Za-z0-9]+/" + clip + r"/playlist\.m3u8", url.path)):
        raise ValueError("The public playlist must match the selected KICK clip")
    data = read_url(playlist, 128000).decode().splitlines()
    duration = sum(float(line.split(":")[1].split(",")[0]) for line in data if line.startswith("#EXTINF:"))
    if "#EXT-X-ENDLIST" not in data or not 0 < duration <= 185 or any(line.startswith("#EXT-X-KEY") for line in data):
        raise ValueError("Expected a finite unencrypted KICK clip of up to 180 seconds plus keyframe padding")
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt = output.with_suffix(".source.json")
    if output.exists():
        import json
        record = json.loads(receipt.read_text(encoding="utf-8"))
        if record["playlist"] == playlist and record["sha256"] == sha256(output):
            return
        raise ValueError("Existing media differs from its source receipt")
    base = playlist.rsplit("/", 1)[0] + "/"
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        root = Path(temporary)
        previous, raw, span, written = None, b"", None, 0
        with (root / "excerpt.ts").open("wb") as dest:
            for line in data:
                if line.startswith("#EXT-X-BYTERANGE:"):
                    count, offset = line.partition(":")[2].split("@")
                    span = int(offset), int(count)
                elif line and not line.startswith("#"):
                    if not re.fullmatch(r"[\w.-]+\.ts", line):
                        raise ValueError("Expected a clip-local MPEG-TS object")
                    # Some CDNs serve the entire object for successive HTTP range requests.
                    # Read the public object once and enforce every declared byte range locally.
                    if previous != line:
                        raw = read_url(base + line, 32 * 1024 * 1024)
                        previous = line
                    start, size = span or (0, len(raw))
                    if start < 0 or size < 1 or start + size > len(raw):
                        raise ValueError("KICK clip byte range exceeds its media object")
                    written += size
                    if written > 400 * 1024 * 1024:
                        raise ValueError("Clip exceeds local acquisition budget")
                    dest.write(raw[start:start + size])
                    span = None
        temp = root / "source.mp4"
        run_tool("ffmpeg", ["-nostdin","-v","error","-xerror","-i",str(root / "excerpt.ts"),
                            "-map","0:v:0","-map","0:a:0?","-c","copy",str(temp)], "REMUX_FAILED")
        info = probe(temp, "ARCHIVE_INVALID")
        if abs(info.duration_ms - duration * 1000) > 350:
            raise ValueError("Downloaded clip duration differs from its playlist")
        utc = next((line.partition(":")[2] for line in data if line.startswith("#EXT-X-PROGRAM-DATE-TIME:")), None)
        atomic_json(receipt, {"url": page, "playlist": playlist, "mediaStart": utc, "durationMs": info.duration_ms,
                              "sha256":sha256(temp)})
        temp.replace(output)


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("page")
    p.add_argument("playlist")
    p.add_argument("output", type=Path)
    args=p.parse_args()
    acquire(args.page,args.playlist,args.output)
