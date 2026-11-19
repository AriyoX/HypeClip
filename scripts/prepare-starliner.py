"""Prepare a local editorial excerpt with its original audience chat (no provider keys)."""
import argparse
import hashlib
import json
import os
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ITEM = "nasas-boeing-starliner-crew-flight-test-launch-june-5-2024-official-nasa-broadcast"
# The archived broadcast shows L-00:03:36 at 14,800 s. NASA's flight
# timeline gives 14:52:15 UTC for L+0. The anchor has one-second precision.
LAUNCH = datetime(2024, 6, 5, 14, 52, 15, tzinfo=timezone.utc)
START = 14800 + 216 - 45
ANCHOR = LAUNCH - timedelta(seconds=45)
DURATION = 130

def get_json(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return json.load(response)

def prepare(directory, ffmpeg):
    directory.mkdir(parents=True, exist_ok=True)
    metadata = get_json("https://archive.org/metadata/" + ITEM)
    movie = next(f for f in metadata["files"] if f["name"].endswith("[HneVxAmYcaA].mp4"))
    base = "https://archive.org/download/" + ITEM + "/"
    url = base + urllib.parse.quote(movie["name"], safe="")
    source = directory / "starliner.mp4"
    temporary = directory / "starliner.partial.mp4"
    subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-y", "-rw_timeout", "60000000",
                    "-ss", str(START), "-i", url, "-t", str(DURATION), "-map", "0:v:0",
                    "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                    "-c:a", "aac", "-movflags", "+faststart", str(temporary)], check=True)
    temporary.replace(source)
    received = datetime.now(timezone.utc).isoformat()
    messages = get_json(base + "chat.json")
    chat = directory / "chat.jsonl"
    with chat.open("w", encoding="utf-8", newline="\n") as output:
        for item in messages:
            author_id = item.get("author", {}).get("id")
            if item.get("message_type") != "text_message" or not author_id:
                continue
            at = datetime.fromtimestamp(item["timestamp"] / 1_000_000, timezone.utc)
            if not 0 <= (at - ANCHOR).total_seconds() < DURATION:
                continue
            # Stable anonymous IDs preserve the distinct-chatter and spam signals.
            user = hashlib.sha256(author_id.encode()).hexdigest()[:16]
            chat_event = {
                "eventId": item["message_id"],
                "eventAt": at.isoformat(),
                "receivedAt": received,
                "userId": user,
                "text": item.get("message", ""),
                "emotes": [e["name"] for e in item.get("emotes", []) if e.get("name")],
            }
            output.write(json.dumps(chat_event) + "\n")
    provenance = dict(sourcePath=str(source.resolve()), chatPath=str(chat.resolve()),
        mediaStart=ANCHOR.isoformat(), archiveOffsetSeconds=START, durationSeconds=DURATION,
        clockCalibration="L-00:03:36 at archive 14800s; L+0 at 14:52:15 UTC (one-second precision)",
        receiptTime="Local archive import time. Live receipt timestamps were unavailable.",
        credit="Footage: NASA. Excerpt of the June 5, 2024 Boeing Starliner Crew Flight Test broadcast.",
        recording="https://www.youtube.com/watch?v=HneVxAmYcaA", archive=base,
        usage="https://www.nasa.gov/nasa-brand-center/images-and-media/",
        timeline="https://www.nasa.gov/wp-content/uploads/2024/06/cft-rendezvous-summary-timeline-gmt-157-launch-june-5.pdf")
    (directory / "source.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps(provenance, indent=2))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--ffmpeg", default=os.getenv("HYPECLIP_FFMPEG") or "ffmpeg")
    args = parser.parse_args()
    prepare(args.directory.resolve(), args.ffmpeg)
