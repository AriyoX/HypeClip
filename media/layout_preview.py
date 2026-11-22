"""Render a composition preview from cached footage with the export filter graph."""
import json
import sys
from pathlib import Path

from .video import render_filter, run_tool


def main():
    source, destination, ms, config = sys.argv[1:]
    settings = json.loads(config)
    split = settings.get("split")
    graph = render_filter(432, 768, "split-screen" if split else "fit-pad", False, 100,
                          split_screen=split, presentation=settings.get("presentation"))
    run_tool("ffmpeg", ["-v", "error", "-nostdin", "-ss", str(int(ms) / 1000),
                        "-protocol_whitelist", "file", "-i", str(Path(source).resolve()),
                        "-filter_complex_threads", "2", "-filter_complex", graph, "-map", "[out]",
                        "-frames:v", "1", "-q:v", "2", destination], "PREVIEW_FAILED")


if __name__ == "__main__":
    main()
