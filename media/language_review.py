"""Transcribe short, separated samples and save the matching frame for speaker attribution."""
import argparse
from pathlib import Path
import tempfile

from .job import atomic_json
from .speech import load_model, speech_samples
from .video import probe, run_tool


def sample(model, source, start, duration, dest):
    dest.mkdir(parents=True, exist_ok=True)
    prefix = dest / str(start)
    with tempfile.TemporaryDirectory(dir=dest) as directory:
        wav = Path(directory) / "sample.wav"
        run_tool("ffmpeg", ["-nostdin", "-v","error","-ss",str(start/1000),"-i",str(source),"-t",str(duration/1000),
                            "-map","0:a:0","-ar","16000","-ac","1","-c:a","pcm_s16le",str(wav)], "SAMPLE_AUDIO")
        run_tool("ffmpeg", ["-nostdin","-v","error","-ss",str((start+duration/2)/1000),"-i",str(source),
                            "-frames:v","1","-vf","scale=480:-2","-y",str(prefix.with_suffix(".jpg"))], "SAMPLE_FRAME")
        samples = speech_samples(wav)
        segments, language, probability = [], None, None
        if samples is not None:
            speech, info = model.transcribe(samples, vad_filter=True, beam_size=2)
            segments = [s.text.strip() for s in speech]
            language, probability = info.language, info.language_probability
        return {"source":str(source),"startMs":start,"durationMs":duration,"language":language,
                "probability":probability,"draft":segments,"frame":str(prefix.with_suffix(".jpg")),
                "attribution":"requires speaker review"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--at-ms", type=int, nargs="+")
    args = parser.parse_args()
    duration = probe(args.source, "SOURCE_INVALID").duration_ms
    width = min(12000,duration)
    times = args.at_ms or [int((duration-width)*fraction) for fraction in (.08,.48,.86)]
    if any(t<0 or t>=duration for t in times):
        raise ValueError("Sample outside recording")
    model = load_model()
    rows = [sample(model,args.source,t,min(width,duration-t),args.destination) for t in times]
    atomic_json(args.destination/"samples.json", {"samples":rows})
