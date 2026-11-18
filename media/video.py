import json
import os
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from .errors import WorkerError


def binary(name: str) -> str:
    key = name.upper()
    return os.environ.get(f"HYPECLIP_{key}") or os.environ.get(key) or name


def run_tool(name: str, args: list[str], code: str, cwd: Path | None = None) -> str:
    try:
        completed = subprocess.run(
            [binary(name), *args], cwd=cwd, capture_output=True,
            encoding="utf-8", errors="replace", check=False,
        )
    except FileNotFoundError as exc:
        raise WorkerError("MISSING_BINARY", f"{name} executable was not found.") from exc
    except OSError as exc:
        raise WorkerError("BINARY_START_FAILED", f"Could not start {name}: {exc}") from exc
    if completed.returncode:
        details = completed.stderr.strip()[-2000:] or f"exit status {completed.returncode}"
        raise WorkerError(code, f"{name}: {details}")
    return completed.stdout


def milliseconds(value) -> int | None:
    try:
        return round(Fraction(value) * 1000)
    except (ValueError, TypeError, ZeroDivisionError):
        return None


def seconds(ms: int) -> str:
    return f"{ms // 1000}.{ms % 1000:03d}"


@dataclass(frozen=True)
class Media:
    video: dict
    audio: dict | None
    format: dict

    @property
    def duration_ms(self) -> int:
        return milliseconds(self.format.get("duration")) or 0

    @property
    def video_duration_ms(self) -> int | None:
        return milliseconds(self.video.get("duration"))

    @property
    def video_offset_ms(self) -> int:
        format_start = milliseconds(self.format.get("start_time")) or 0
        video_start = milliseconds(self.video.get("start_time"))
        return 0 if video_start is None else max(0, video_start - format_start)

    @property
    def frame_ms(self) -> int:
        try:
            return max(1, round(1000 / Fraction(self.video["avg_frame_rate"])))
        except (KeyError, ValueError, ZeroDivisionError):
            return 50


def probe(path: Path, code: str) -> Media:
    raw = run_tool("ffprobe", [
        "-v", "error", "-protocol_whitelist", "file", "-show_format", "-show_streams",
        "-of", "json", "-i", str(path),
    ], code)
    try:
        report = json.loads(raw)
        streams = report["streams"]
        video = next(stream for stream in streams if stream["codec_type"] == "video"
                     and not stream.get("disposition", {}).get("attached_pic"))
        audio = next((stream for stream in streams if stream["codec_type"] == "audio"), None)
        return Media(video, audio, report["format"])
    except (ValueError, KeyError, StopIteration) as exc:
        raise WorkerError(code, f"No usable video stream in {path.name}.") from exc


def extract(source: Path, target: Path, info: Media, start_ms: int, end_ms: int) -> Media:
    duration = end_ms - start_ms
    source_duration = info.video_duration_ms
    if source_duration is not None and end_ms > source_duration + 1:
        raise WorkerError("WINDOW_OUT_OF_RANGE", "The requested window extends past the source video.")

    run_tool("ffmpeg", [
        "-hide_banner", "-nostdin", "-v", "error", "-xerror",
        "-ss", seconds(info.video_offset_ms + start_ms),
        "-protocol_whitelist", "file", "-i", str(source), "-t", seconds(duration),
        "-map", f"0:{info.video['index']}", "-map", "0:a:0?",
        "-vf", "scale=ceil(iw/2)*2:ceil(ih/2)*2",
        "-fps_mode", "vfr", "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target),
    ], "EXTRACT_FAILED")
    trimmed = probe(target, "EXTRACT_INVALID")
    video_duration = trimmed.video_duration_ms or trimmed.duration_ms
    if abs(video_duration - duration) > max(info.frame_ms * 2, 70):
        raise WorkerError("EXTRACT_INVALID", "The extracted video duration differs from the requested window.")
    return trimmed


def extract_speech_audio(source: Path, target: Path) -> None:
    run_tool("ffmpeg", [
        "-hide_banner", "-nostdin", "-v", "error", "-xerror",
        "-protocol_whitelist", "file", "-i", str(source),
        "-map", "0:a:0", "-vn", "-af", "aresample=16000:async=1:first_pts=0",
        "-ac", "1", "-c:a", "pcm_s16le", str(target),
    ], "AUDIO_EXTRACT_FAILED")


def cover(width: int, height: int) -> str:
    return (
        f"scale='ceil(max({width},{height}*iw/ih)/2)*2':"
        f"'ceil(max({height},{width}*ih/iw)/2)*2',crop={width}:{height},setsar=1"
    )


def render_filter(width: int, height: int, layout: str, captioned: bool, duration: int) -> str:
    # Normalize display aspect, then cover any sub-frame gap from the accurate cut.
    base = (
        "scale='max(2,round(iw*sar/2)*2)':ih,setsar=1,"
        f"tpad=stop_mode=clone:stop_duration={seconds(duration)},fps=30:start_time=0"
    )
    if layout == "center-crop":
        graph = f"{base},{cover(width, height)}"
    else:
        blur_w, blur_h = max(2, width // 12 * 2), max(2, height // 12 * 2)
        foreground = (
            f"scale='max(2,trunc(min({width},{height}*iw/ih)/2)*2)':"
            f"'max(2,trunc(min({height},{width}*ih/iw)/2)*2)',setsar=1"
        )
        graph = (
            f"{base},split=2[background][foreground];"
            f"[background]{cover(blur_w, blur_h)},boxblur=min(w\\,h)/8:2,"
            f"scale={width}:{height},setsar=1[canvas];"
            f"[foreground]{foreground}[picture];"
            "[canvas][picture]overlay=(W-w)/2:(H-h)/2:shortest=1"
        )
    if captioned:
        # The process runs beside the SRT, so its name needs no filter or drive-letter escaping.
        graph += (
            ",subtitles=filename=subtitles.srt:force_style='FontName=Arial,FontSize=16,"
            "Alignment=2,MarginL=24,MarginR=24,MarginV=24,Outline=2,Shadow=0'"
        )
    return graph + "[out]"


def render(source: Path, target: Path, width: int, height: int, layout: str,
           duration: int, captioned: bool, has_audio: bool) -> Media:
    run_tool("ffmpeg", [
        "-hide_banner", "-nostdin", "-v", "error", "-xerror",
        "-protocol_whitelist", "file", "-i", str(source),
        "-filter_complex_threads", "2",
        "-filter_complex", render_filter(width, height, layout, captioned, duration),
        "-map", "[out]", "-map", "0:a:0?", "-t", seconds(duration),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target),
    ], "RENDER_FAILED", cwd=target.parent)
    final = probe(target, "RENDER_INVALID")
    actual_audio = final.audio["codec_name"] if final.audio else None
    video = final.video
    if (
        (video["width"], video["height"], video["codec_name"], video["pix_fmt"],
         video["avg_frame_rate"]) != (width, height, "h264", "yuv420p", "30/1")
        or actual_audio != ("aac" if has_audio else None)
        or final.duration_ms <= 0
        or abs(final.duration_ms - duration) > 40
    ):
        raise WorkerError("RENDER_INVALID", "Rendered MP4 does not match the requested video or audio format.")
    return final
