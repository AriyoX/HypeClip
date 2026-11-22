import hashlib
import json
import os
import tempfile
import textwrap
from dataclasses import asdict
from pathlib import Path
from uuid import UUID, uuid4

from .errors import WorkerError
from .speech import Cue, model_signature, speech_samples, srt, transcribe, transcript_json
from .stages import stage
from .split_screen import scene_subtitles, seam_subtitles, studio_subtitles
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
        names = [*ARTIFACTS.values(), *(["subtitles.ass"] if "subtitles.ass" in receipt["digests"] else [])]
        if all(sha256(directory / name) == receipt["digests"][name] for name in names):
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
    split = output.get("splitScreen")
    scene = output.get("sceneCaption")
    presentation = output.get("presentation")
    if presentation:
        recipe.append(["studio-v2", presentation])
    if scene:
        if not (split or presentation):
            raise WorkerError("INVALID_REQUEST", "A scene caption needs the upper panel.")
        recipe.append(["scene-v1", scene])
    if split is not None:
        recipe.append(["split-screen-v2", split])
    if any(field in output for field in ("overlay", "speech", "voice")):
        voice = output.get("voice")
        voice_id = source_signature(Path(voice["path"])) + [voice["startMs"]] if voice else None
        recipe.extend([output.get("overlay"), output.get("speech"), voice_id])
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
        # The live coordinator owns this job exclusively. Reuse a completed
        # speech pass when interrupted between transcription and final encoding.
        checkpoint = cache / f"{key}.speech.json"
        cut = cache / f"{key}.cut.mp4"
        saved = None
        controlled = bool(os.environ.get("HYPECLIP_STAGE_CONTROL"))
        if controlled and checkpoint.exists() and cut.exists():
            try:
                record = json.loads(checkpoint.read_text(encoding="utf-8"))
                if sha256(cut) == record["cutHash"]:
                    saved = record
            except (ValueError, KeyError, OSError):
                pass
        line_width = max(12, min(32, round(50 * width / height)))
        words = []
        if saved:
            os.link(cut, original)
            extracted = probe(original, "EXTRACT_INVALID")
            segments = [Cue(**item) for item in saved["segments"]]
            captions = [Cue(**item) for item in saved["captions"]]
            flags = saved["flags"]
            words = [Cue(**item) for item in saved.get("words", [])]
        else:
            with stage("ffmpeg"):
                extracted = extract(source, original, probe(source, "SOURCE_INVALID"), start, end)
            segments, captions, flags = [], [], []
            if extracted.audio is None:
                flags.append("missing_audio")
            elif "speech" in output:
                segments, captions = ([Cue(**item) for item in output["speech"][field]]
                                      for field in ("segments", "captions"))
                words = [Cue(**item) for item in output["speech"].get("words", [])]
                if output["speech"].get("withheld"):
                    flags.append("speech_under_review")
                elif not segments:
                    flags.append("no_speech")
            else:
                audio = staging / "speech.wav"
                with stage("ffmpeg"):
                    extract_speech_audio(original, audio)
                samples = speech_samples(audio)
                if samples is None:
                    flags.append("silence")
                else:
                    timed_words = []
                    with stage("whisper"):
                        segments, captions = transcribe(samples, duration, line_width, timed_words)
                    if all(p >= 0.7 for _, p in timed_words):
                        words = [word for word, _ in timed_words]
                    elif split is not None:
                        flags.append("speech_under_review")
                    if not segments:
                        flags.append("no_speech")
            if controlled:
                link = staging / "complete-cut.mp4"
                os.link(original, link)
                link.replace(cut)
                atomic_json(checkpoint, {"cutHash": sha256(cut), "flags": flags,
                                         "segments": [asdict(item) for item in segments],
                                         "words": [asdict(item) for item in words],
                                         "captions": [asdict(item) for item in captions]})

        subtitle = files / ARTIFACTS["subtitlePath"]
        if scene and not presentation:
            scene_subtitles(files / "scene.ass", scene, width, height, split, duration)
        if presentation:
            if scene and not 0 <= scene["startMs"] < scene["endMs"] <= duration:
                raise WorkerError("INVALID_REQUEST", "Scene caption must fit within the clip.")
            captions = studio_subtitles(files / "subtitles.ass", words if presentation["dialogue"] == "words" else [],
                                        scene, width, height, split, presentation)
        elif split is not None:
            if "facecam" not in split and extracted.video["width"] >= extracted.video["height"]:
                raise WorkerError("INVALID_CROP", "Landscape split-screen needs facecam and gameplay crops.")
            if any(w.startMs >= w.endMs or w.endMs > duration for w in words) or any(
                a.endMs > b.startMs for a, b in zip(words, words[1:])
            ):
                raise WorkerError("INVALID_REQUEST", "Caption words must be ordered within the clip.")
            captions = seam_subtitles(files / "subtitles.ass", words if split["captions"] != "clean" else [],
                                      width, height, split)
        subtitle.write_text(srt(captions or ([Cue(**item) for item in output.get("speech", {}).get("captions", [])] if presentation else []), line_width), encoding="utf-8", newline="\n")
        atomic_json(files / ARTIFACTS["transcriptPath"], transcript_json(segments))
        (files / "overlay.txt").write_text(textwrap.fill(output.get("overlay", ""), width=32, break_long_words=True), encoding="utf-8")
        with stage("ffmpeg"):
            final = render(original, vertical, width, height, layout, duration, bool(captions),
                           extracted.audio is not None, bool(output.get("overlay")), output.get("voice"), split, bool(scene), presentation)

        if any(item.endMs > final.duration_ms for item in [*segments, *captions]):
            raise WorkerError("RENDER_INVALID", "Caption timing exceeds the rendered MP4 duration.")
        if source_signature(source) != source_id or model_signature() != model_id:
            raise WorkerError("INPUT_CHANGED", "The source or configured model changed during rendering.",
                              retryable=True)
        published = cache / uuid4().hex
        receipt = {
            "generation": published.name, "durationMs": final.duration_ms, "qualityFlags": flags,
            "digests": {name: sha256(files / name) for name in
                        [*ARTIFACTS.values(), *(["subtitles.ass"] if split is not None or presentation else [])]},
        }
        # Concurrent writers publish independent, complete generations. Each result stays valid.
        files.rename(published)
        atomic_json(index, receipt)
        checkpoint.unlink(missing_ok=True)
        cut.unlink(missing_ok=True)
    return success(published, receipt)
