import argparse
import json
import sys
from pathlib import Path

from media.errors import WorkerError
from media.job import atomic_json, process

CONTRACT = Path(__file__).resolve().parents[1] / "contracts" / "v1"


def read_request(path: Path) -> dict:
    try:
        from jsonschema import Draft202012Validator
    except ImportError as exc:
        raise WorkerError("MISSING_DEPENDENCY", "Install the Python dependencies in workers/requirements.txt.") from exc
    try:
        request = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise WorkerError("INVALID_REQUEST", f"Could not read request JSON: {exc}") from exc

    schema = json.loads((CONTRACT / "request.schema.json").read_text(encoding="utf-8"))
    error = next(Draft202012Validator(schema).iter_errors(request), None)
    if error is not None:
        location = ".".join(map(str, error.absolute_path)) or "request"
        raise WorkerError("INVALID_REQUEST", f"{location}: {error.message[:300]}")
    candidate, output = request["candidate"], request["output"]
    if candidate["startMs"] >= candidate["endMs"]:
        raise WorkerError("INVALID_REQUEST", "candidate.endMs must be greater than candidate.startMs.")
    for field in ("sourcePath", "outputDir"):
        if "\0" in candidate[field] or not Path(candidate[field]).is_absolute():
            raise WorkerError("INVALID_REQUEST", f"candidate.{field} must be an absolute local path.")
    if output["width"] % 2 or output["height"] % 2:
        raise WorkerError("UNSUPPORTED_DIMENSIONS", "H.264 yuv420p requires even width and height.")
    return request


def failure(code: str, message: str, retryable: bool = False) -> dict:
    return {"version": 1, "ok": False, "error": {
        "code": code, "message": message, "retryable": retryable,
    }}


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a HypeClip media contract v1 request")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    if args.result.resolve() == args.request.resolve():
        print("The result path must differ from the request path.", file=sys.stderr)
        return 1

    try:
        request = read_request(args.request)
        if args.result.resolve() == Path(request["candidate"]["sourcePath"]).resolve():
            print("The result path must differ from the source path.", file=sys.stderr)
            return 1
        result = process(request)
    except WorkerError as exc:
        result = failure(exc.code, str(exc), exc.retryable)
    except KeyboardInterrupt:
        result = failure("INTERRUPTED", "The media worker was interrupted.", True)
    except OSError as exc:
        result = failure("FILE_ERROR", f"Media worker file operation failed: {exc}", True)
    except Exception as exc:
        result = failure("WORKER_FAILED", f"{type(exc).__name__}: {exc}")

    try:
        atomic_json(args.result, result)
    except OSError as exc:
        print(f"Could not write worker result: {exc}", file=sys.stderr)
        return 1
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
