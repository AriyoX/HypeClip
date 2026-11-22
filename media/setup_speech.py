"""Check the installed worker and provision its pinned speech model."""
import argparse
import os

from .errors import WorkerError
from .speech import MODEL_ID, MODEL_REVISION, load_model, model_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    if args.download:
        os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    # Import native dependencies to catch a broken venv or missing runtime DLL.
    import av
    import faster_whisper
    import jsonschema
    import numpy
    import onnxruntime

    try:
        model_path()
    except WorkerError as exc:
        if exc.code != "MISSING_SPEECH_MODEL":
            raise
        if not args.download:
            print("missing")
            return
        if os.environ.get("HYPECLIP_WHISPER_MODEL_PATH"):
            raise
        faster_whisper.download_model(MODEL_ID, revision=MODEL_REVISION)
    if args.download:
        load_model()
    print("ready")


if __name__ == "__main__":
    main()
