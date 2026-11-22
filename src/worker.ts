import { Ajv2020 } from "ajv/dist/2020.js";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { dirname, relative, isAbsolute, sep, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { jsonFile, writeJson, hashFile } from "./local.ts";
import { probe } from "./probe.ts";
import { controlledWorker, type Acquire } from "./stages.ts";
import type { Settings } from "./editorial.ts";
const ajv = new Ajv2020();
const schema = (name: string) =>
  ajv.compile(
    jsonFile(
      fileURLToPath(
        new URL("../contracts/v1/" + name + ".schema.json", import.meta.url),
      ),
    ),
  );
const request = schema("request"),
  result = schema("result"),
  transcript = schema("transcript");
export interface Request {
  version: 1;
  candidate: {
    sessionId: string;
    candidateId: string;
    sourcePath: string;
    startMs: number;
    endMs: number;
    outputDir: string;
  };
  output: {
    width: number;
    height: number;
    layout: "fit-pad" | "center-crop" | "split-screen";
    presentation?: { dialogue: "clean" | "words"; subtitleY: number; gameplayCrop?: number[] };
    splitScreen?: Settings["splitScreen"];
    overlay?: string;
    sceneCaption?: {text:string;startMs:number;endMs:number;panelY:number};
    speech?: {
      withheld?: boolean;
      segments: Transcript["segments"];
      captions: Transcript["segments"];
      words?: Transcript["segments"];
    };
    voice?: { path: string; startMs: number };
  };
}
export interface Result {
  version: 1;
  ok: true;
  originalPath: string;
  verticalPath: string;
  transcriptPath: string;
  subtitlePath: string;
  durationMs: number;
  sha256: string;
  qualityFlags: string[];
}
export interface Transcript {
  segments: { startMs: number; endMs: number; text: string }[];
}
export function checkRequest(r: Request) {
  if (!request(r) || r.candidate.startMs >= r.candidate.endMs)
    throw Error("Invalid worker request: " + ajv.errorsText(request.errors));
}
const repo = fileURLToPath(new URL("../", import.meta.url));
export class InvalidWorkerOutput extends Error {}
export function workerLocation() {
  const cwd = resolve(process.env.HYPECLIP_WORKER_ROOT || repo);
  const venv = join(cwd, ".venv");
  const interpreter = join(
    venv,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  return {
    cwd,
    venv,
    interpreter,
    python: process.env.HYPECLIP_PYTHON || interpreter,
  };
}
export function workerEnv() {
  // Allowlist only environment needed by Python, multimedia tools and local models.
  const allow =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES.*|LANG|LC_ALL|VIRTUAL_ENV|CUDA_PATH.*|HF_HOME|HF_HUB_OFFLINE|XDG_CACHE_HOME|FFMPEG|FFPROBE|HYPECLIP_(?:FFMPEG|FFPROBE|WHISPER_[A-Z_]+))$/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => allow.test(k)),
  );
}
export async function runWorkerModule(
  module: string,
  args: string[],
  acquire?: Acquire,
  cancel?: AbortSignal,
) {
  const { cwd, python } = workerLocation();
  const env = workerEnv();
  if (acquire)
    return controlledWorker(
      python,
      ["-m", module, ...args],
      cwd,
      env,
      acquire,
      cancel,
    );
  await promisify(execFile)(python, ["-m", module, ...args], {
    cwd,
    env,
    windowsHide: true,
    timeout: 3600000,
  });
}
export async function render(
  r: Request,
  acquire?: Acquire,
  cancel?: AbortSignal,
): Promise<Result> {
  checkRequest(r);
  const dir = r.candidate.outputDir;
  mkdirSync(dir, { recursive: true });
  const input = join(dir, "request.json"),
    output = join(dir, "result.json");
  writeJson(input, r);
  const env = workerEnv();
  const worker = workerLocation();
  const cwd = worker.cwd;
  const python = process.env.HYPECLIP_PYTHON ||
    (existsSync(worker.interpreter) ? worker.interpreter : "python");
  let failed = false;
  try {
    if (acquire)
      await controlledWorker(
        python,
        ["-m", "workers.media", "--request", input, "--result", output],
        cwd,
        env,
        acquire,
        cancel,
      );
    else
      await promisify(execFile)(
        python,
        ["-m", "workers.media", "--request", input, "--result", output],
        {
          cwd,
          env,
          windowsHide: true,
          timeout: 60 * 60 * 1000,
          maxBuffer: 1024 * 1024,
        },
      );
  } catch {
    failed = true;
  }
  let body;
  try {
    body = jsonFile(output);
  } catch {
    throw Error(
      "Media worker did not write a result. Check python -m workers.media and the worker dependencies.",
    );
  }
  if (!result(body))
    throw new InvalidWorkerOutput(
      "Invalid worker result: " + ajv.errorsText(result.errors),
    );
  if ((body as Result).ok !== true) {
    const err = (body as { error: unknown }).error as {
      code: string;
      message: string;
    };
    throw Error(
      (failed ? "" : "Worker exit mismatch. ") + err.code + ": " + err.message,
    );
  }
  if (failed)
    throw new InvalidWorkerOutput(
      "Worker reported success with a failing exit code",
    );
  return body as unknown as Result;
}
export async function validateOutput(
  r: Request,
  b: Result,
): Promise<Transcript> {
  if (!result(b) || !b.ok) throw Error("Invalid worker result");
  const root = realpathSync(r.candidate.outputDir);
  const paths = [
    b.originalPath,
    b.verticalPath,
    b.transcriptPath,
    b.subtitlePath,
  ].map((p) => realpathSync(p));
  for (const p of paths) {
    const rel = relative(root, p);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(".." + sep) ||
      isAbsolute(rel) ||
      !statSync(p).isFile()
    )
      throw Error("Worker output outside candidate directory");
  }
  if (new Set(paths).size !== 4)
    throw Error("Expected four distinct worker artifacts");
  const [media, original, hash] = await Promise.all([
    probe(b.verticalPath, true),
    probe(b.originalPath),
    hashFile(b.verticalPath),
  ]);
  if (
    hash !== b.sha256 ||
    Math.abs(media.durationMs - b.durationMs) > 250 ||
    Math.abs(original.durationMs - b.durationMs) > 1000 ||
    Math.abs(b.durationMs - (r.candidate.endMs - r.candidate.startMs)) > 1000 ||
    media.width !== r.output.width ||
    media.height !== r.output.height
  )
    throw Error("Worker media dimensions, duration or SHA-256 mismatch");
  const doc = jsonFile(b.transcriptPath);
  if (!transcript(doc)) throw Error("Invalid transcript");
  const data = doc as unknown as Transcript;
  if (data.segments.some((s) => s.endMs <= s.startMs || s.endMs > b.durationMs))
    throw Error("Transcript exceeds clip timeline");
  const srt = readFileSync(b.subtitlePath, "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
  const expectsSubtitles =
    r.output.layout === "split-screen"
      ? r.output.splitScreen?.captions !== "clean" &&
        !!r.output.speech?.words?.length
      : data.segments.length > 0;
  if (expectsSubtitles && !srt) throw Error("Missing subtitle cues");
  for (const block of srt ? srt.split(/\r?\n\s*\r?\n/) : []) {
    const lines = block.split(/\r?\n/);
    const match = lines[1]?.match(
      /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/,
    );
    if (!match || !/^\d+$/.test(lines[0]) || !lines.slice(2).join("").trim())
      throw Error("Invalid SRT cue");
    const [h, m, s, ms, H, M, S, MS] = match.slice(1).map(Number);
    const start = ((h * 60 + m) * 60 + s) * 1000 + ms,
      end = ((H * 60 + M) * 60 + S) * 1000 + MS;
    if (end <= start || end > b.durationMs)
      throw Error("Subtitle exceeds clip timeline");
  }
  return data;
}
