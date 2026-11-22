import os
import textwrap
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

from .errors import WorkerError

MODEL_ID = "Systran/faster-whisper-small"
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "preprocessor_config.json")
SUBTITLE_LITERAL = str.maketrans("{}\\<>&", "｛｝＼＜＞＆")


def model_signature() -> list:
    configured = os.environ.get("HYPECLIP_WHISPER_MODEL_PATH")
    if not configured:
        return [MODEL_ID, MODEL_REVISION]
    model = Path(configured).resolve()
    signature = [str(model)]
    for name in MODEL_FILES:
        file = model / name
        if file.is_file():
            signature.append([name, file.stat().st_size, file.stat().st_mtime_ns])
    return signature


def speech_samples(path: Path):
    try:
        import numpy as np
    except ImportError as exc:
        raise WorkerError("MISSING_SPEECH_DEPENDENCY", "NumPy could not be loaded.") from exc
    with wave.open(str(path), "rb") as wav:
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    if not pcm.size or (pcm.max() < 32 and pcm.min() > -32):
        return None
    return pcm.astype(np.float32) / 32768


def load_model():
    os.environ["HF_HUB_OFFLINE"] = "1"
    try:
        from faster_whisper import WhisperModel
        from huggingface_hub import try_to_load_from_cache
    except (ImportError, OSError) as exc:
        raise WorkerError("MISSING_SPEECH_DEPENDENCY", f"faster-whisper could not load: {exc}") from exc

    configured = os.environ.get("HYPECLIP_WHISPER_MODEL_PATH")
    if configured:
        path = Path(configured).resolve()
    else:
        cached_model = try_to_load_from_cache(MODEL_ID, "model.bin", revision=MODEL_REVISION)
        if not isinstance(cached_model, str):
            raise WorkerError(
                "MISSING_SPEECH_MODEL", "The Whisper small snapshot is absent from the local cache. See workers/README.md.",
            )
        path = Path(cached_model).parent
    if any(not (path / name).is_file() for name in MODEL_FILES[:3]):
        raise WorkerError("MISSING_SPEECH_MODEL", f"Incomplete local Whisper model at {path}.")
    try:
        return WhisperModel(str(path), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
    except Exception as exc:
        raise WorkerError("SPEECH_MODEL_FAILED", f"Could not initialize the local Whisper model: {exc}") from exc


@dataclass(frozen=True)
class Cue:
    startMs: int
    endMs: int
    text: str


def cue(start: float, end: float, text: str, limit: int) -> Cue | None:
    start_ms = max(0, round(start * 1000))
    end_ms = min(limit, round(end * 1000))
    text = " ".join(text.split())
    return Cue(start_ms, end_ms, text) if start_ms < end_ms and text else None


def caption_cues(words: list[Cue], fallback: Cue, line_width: int) -> list[Cue]:
    if not words:
        return [fallback]
    captions = []
    group = [words[0]]
    text = words[0].text
    for word in words[1:]:
        combined = f"{text} {word.text}"
        if (len(combined) > line_width * 2 or word.endMs - group[0].startMs > 3500
                or word.startMs - group[-1].endMs > 700):
            captions.append(Cue(group[0].startMs, group[-1].endMs, text))
            group = []
            combined = word.text
        group.append(word)
        text = combined
    captions.append(Cue(group[0].startMs, group[-1].endMs, text))
    return captions


def transcribe(samples, limit: int, line_width: int, timed_words=None) -> tuple[list[Cue], list[Cue]]:
    model = load_model()
    transcript, captions = [], []
    try:
        segments, info = model.transcribe(samples, vad_filter=True, word_timestamps=True)
        if not info.duration_after_vad:
            return transcript, captions
        # The segment generator also performs inference and can raise during iteration.
        for segment in segments:
            segment_cue = cue(segment.start, segment.end, segment.text, limit)
            if segment_cue is None:
                continue
            transcript.append(segment_cue)
            words = []
            for word in segment.words or []:
                word_cue = cue(word.start, word.end, word.word, limit)
                if word_cue is not None:
                    words.append(word_cue)
                    if timed_words is not None:
                        timed_words.append((word_cue, float(word.probability)))
            captions.extend(caption_cues(words, segment_cue, line_width))
    except Exception as exc:
        raise WorkerError("TRANSCRIPTION_FAILED", f"Local transcription failed: {exc}") from exc
    return transcript, captions


def timestamp(ms: int) -> str:
    whole, fraction = divmod(ms, 1000)
    minutes, seconds = divmod(whole, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{fraction:03d}"


def srt(captions: list[Cue], line_width: int) -> str:
    blocks = []
    for i, caption in enumerate(captions, 1):
        literal = caption.text.translate(SUBTITLE_LITERAL)
        lines = textwrap.fill(literal, width=line_width, break_on_hyphens=False)
        timing = f"{timestamp(caption.startMs)} --> {timestamp(caption.endMs)}"
        blocks.append(f"{i}\n{timing}\n{lines}\n")
    return "\n".join(blocks)


def transcript_json(segments: list[Cue]) -> dict:
    return {"segments": [asdict(segment) for segment in segments]}
