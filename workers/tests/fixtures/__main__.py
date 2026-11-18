import argparse
from pathlib import Path

from media.job import atomic_json
from media.video import run_tool

FIXTURES = Path(__file__).resolve().parent
CLOCK = (
    r"drawtext=font=Arial:fontsize=26:fontcolor=white:box=1:boxcolor=black:"
    r"text='%{pts\:hms}':x=(w-tw)/2:y=(h-th)/2"
)
VIDEO = (
    "color=c=0x182540:s=320x180:r=10:d=95,"
    "drawbox=x=8:y=36:w=34:h=28:color=red:t=fill,"
    "drawbox=x=278:y=36:w=34:h=28:color=lime:t=fill,"
    + CLOCK
)


def generate(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    for kind in ("speech", "silent"):
        inputs = ["-f", "lavfi", "-i", VIDEO]
        if kind == "speech":
            inputs += ["-i", str(FIXTURES / "last-train.flac"), "-i", str(FIXTURES / "blue-lantern.flac")]
            inputs += [
                "-filter_complex",
                "[1:a]adelay=37000[a];[2:a]adelay=66000[b];"
                "[a][b]amix=inputs=2,apad[audio]",
                "-map", "0:v", "-map", "[audio]",
            ]
        else:
            inputs += ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-map", "0:v", "-map", "1:a"]
        source = output / f"{kind} source.mp4"
        run_tool("ffmpeg", [
            "-hide_banner", "-nostdin", "-v", "error", "-y", *inputs,
            "-t", "95", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "16000", "-b:a", "48k", "-output_ts_offset", "7",
            str(source),
        ], "FIXTURE_FAILED")
        write_request(output, kind, source)


def write_request(output: Path, kind: str, source: Path, *, start: int = 26000, end: int = 81000,
                  layout: str = "fit-pad") -> Path:
    request = output / f"{kind} request.json"
    atomic_json(request, {
        "version": 1,
        "candidate": {
            "sessionId": "media-tests", "candidateId": kind, "sourcePath": str(source),
            "startMs": start, "endMs": end, "outputDir": str(output / f"{kind} artifacts"),
        },
        "output": {"width": 540, "height": 960, "layout": layout},
    })
    return request


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate HypeClip's local media fixtures")
    parser.add_argument("--output-dir", type=Path, required=True)
    generate(parser.parse_args().output_dir.resolve())


if __name__ == "__main__":
    main()
