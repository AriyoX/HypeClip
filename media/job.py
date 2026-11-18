import hashlib
import json
import os
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

from .errors import WorkerError
from .speech import model_signature, speech_samples, srt, transcribe, transcript_json
from .video import extract, extract_speech_audio, probe, render

ARTIFACTS = {
    "originalPath": "original.mp4",
    "verticalPath": "vertical.mp4",
    "transcriptPath": "transcript.json",
    "subtitlePath": "subtitles.srt",
}
# Bump when a change affects artifact contents or reuse.
RECIPE_VERSION = 1


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", dir=path.parent,
        prefix=".media-", suffix=".tmp", delete=False,
    ) as file:
        temporary = Path(file.name)
        try:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.close()
            temporary.replace(path)
        finally:
            file.close()
            temporary.unlink(missing_ok=True)


def sha256(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def source_signature(path: Path) -> list:
    stat = path.stat()
    return [str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino]


def success(directory: Path, receipt: dict) -> dict:
    return {
        "version": 1, "ok": True,
        **{field: str(directory / name) for field, name in ARTIFACTS.items()},
        "durationMs": receipt["durationMs"],
        "sha256": receipt["digests"]["vertical.mp4"],
        "qualityFlags": receipt["qualityFlags"],
    }


def reuse(cache: Path, index: Path) -> dict | None:
    try:
        receipt = json.loads(index.read_text(encoding="utf-8"))
        directory = cache / UUID(receipt["generation"]).hex
        if all(sha256(directory / name) == receipt["digests"][name] for name in ARTIFACTS.values()):
            return success(directory, receipt)
    except (OSError, TypeError, ValueError, KeyError, AttributeError):
        # Incomplete or damaged artifacts are rebuilt in a fresh directory.
        pass
    return None


def process(request: dict) -> dict:
    candidate = request["candidate"]
    output = request["output"]
    source = Path(candidate["sourcePath"]).resolve()
    if not source.is_file():
        raise WorkerError("SOURCE_NOT_FOUND", f"Local source file does not exist: {source}")
    start, end = int(candidate["startMs"]), int(candidate["endMs"])
    width, height = int(output["width"]), int(output["height"])
    layout = output["layout"]
    duration = end - start
    cache = Path(candidate["outputDir"]).resolve() / ".media-work"
    cache.mkdir(parents=True, exist_ok=True)
    source_id = source_signature(source)
    model_id = model_signature()
    recipe = [RECIPE_VERSION, source_id, start, end, width, height, layout, model_id]
    key = hashlib.sha256(json.dumps(recipe).encode("utf-8")).hexdigest()
    index = cache / f"{key}.json"
    previous = reuse(cache, index)
    if previous is not None:
        return previous

    with tempfile.TemporaryDirectory(prefix=".staging-", dir=cache) as temporary:
        staging = Path(temporary)
        files = staging / "artifacts"
        files.mkdir()
        original = files / ARTIFACTS["originalPath"]
        vertical = files / ARTIFACTS["verticalPath"]
        extracted = extract(source, original, probe(source, "SOURCE_INVALID"), start, end)
        segments, captions, flags = [], [], []
        line_width = max(12, min(32, round(50 * width / height)))
        if extracted.audio is None:
            flags.append("missing_audio")
        else:
            audio = staging / "speech.wav"
            extract_speech_audio(original, audio)
            samples = speech_samples(audio)
            if samples is None:
                flags.append("silence")
            else:
                segments, captions = transcribe(samples, duration, line_width)
                if not segments:
                    flags.append("no_speech")

        subtitle = files / ARTIFACTS["subtitlePath"]
        subtitle.write_text(srt(captions, line_width), encoding="utf-8", newline="\n")
        atomic_json(files / ARTIFACTS["transcriptPath"], transcript_json(segments))
        final = render(original, vertical, width, height, layout, duration, bool(captions),
                       extracted.audio is not None)
        if any(item.endMs > final.duration_ms for item in [*segments, *captions]):
            raise WorkerError("RENDER_INVALID", "Caption timing exceeds the rendered MP4 duration.")
        if source_signature(source) != source_id or model_signature() != model_id:
            raise WorkerError("INPUT_CHANGED", "The source or configured model changed during rendering.",
                              retryable=True)
        published = cache / uuid4().hex
        receipt = {
            "generation": published.name, "durationMs": final.duration_ms, "qualityFlags": flags,
            "digests": {name: sha256(files / name) for name in ARTIFACTS.values()},
        }
        # Concurrent writers publish independent, complete generations. Each result stays valid.
        files.rename(published)
        atomic_json(index, receipt)
    return success(published, receipt)
