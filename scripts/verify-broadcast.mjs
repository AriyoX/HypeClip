// Run after prepare-starliner.py. The child CLI can reach Ollama, but uses file-backed
// R2/Buffer doubles and a fresh SQLite database. All paths in the report are local.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { jsonFile, writeJson, hashFile } from "../src/local.ts";

if (!process.argv[2])
  throw Error("Pass the directory created by scripts/prepare-starliner.py");
if (existsSync(".env")) process.loadEnvFile(".env");
const sourceDir = resolve(process.argv[2]);
const source = jsonFile(join(sourceDir, "source.json"));
const dir = mkdtempSync(join(sourceDir, "verification-"));
const bundle = join(dir, "bundle");
mkdirSync(bundle);
const ledger = join(dir, "provider.jsonl");
writeFileSync(ledger, "");
const env = {
  ...process.env,
  HYPECLIP_HOME: dir,
  HF_HUB_OFFLINE: "1",
  BUFFER_CHANNEL_ID: "test",
  BUFFER_ACCESS_TOKEN: "",
  HYPECLIP_R2_ACCESS_KEY_ID: "",
  HYPECLIP_R2_SECRET_ACCESS_KEY: "",
  HYPECLIP_CHANNEL_REQUIREMENTS: "",
};
const commands = [];
function run(bin, args) {
  commands.push({ bin, args });
  writeJson(join(dir, "commands.json"), commands);
  return execFileSync(bin, args, {
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}
function cli(args) {
  return JSON.parse(
    run(process.execPath, [
      "--experimental-strip-types",
      "--import",
      "./tests/support/fixture-publisher.mjs",
      "cli.ts",
      ...args,
    ]),
  );
}
console.log("Broadcast verification directory " + dir);
const session = "nasa-cft-20240605";
const input = ["--session", session, "--source", source.sourcePath];
const processArgs = [
  "process",
  ...input,
  "--chat",
  source.chatPath,
  "--media-start",
  source.mediaStart,
  "--rights",
];
cli([
  "auto-enable",
  ...input,
  "--channel",
  "test",
  "--cap",
  "1",
  "--mode",
  "shareNow",
  "--rights",
]);
const [job] = cli(processArgs);
assert.ok(job.result?.ok, job.reason);
assert.deepEqual(cli(processArgs), [job]);
cli(["auto-off", "--session", session]);
const status = cli(["status"]);
writeJson(join(dir, "mock-status.json"), status);
const calls = readFileSync(ledger, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((x) => JSON.parse(x));
if (
  job.evaluation?.decision?.decision === "accept" &&
  !job.evaluation.decision.reviewFlags.length &&
  !job.result.qualityFlags.length
) {
  assert.equal(job.state, "published", job.reason);
  assert.equal(
    calls.filter((x) => x.operation === "mock-create" && x.mode === "shareNow")
      .length,
    1,
  );
  assert.equal(calls.filter((x) => x.operation === "mock-upload").length, 1);
} else {
  assert.equal(calls.length, 0);
}
// Prepare a separately identified editorial cut of the countdown and launch.
// The unedited 55 s worker result, subtitles and original model caption remain in SQLite.
const startMs = status.jobs[0].startMs;
assert.ok(
  startMs < 45000 && startMs + 25000 > 55000,
  "The chosen clip must contain the countdown and liftoff",
);
const vertical = join(bundle, "vertical.mp4"),
  caption = join(bundle, "caption.txt");
run(env.HYPECLIP_FFMPEG || "ffmpeg", [
  "-nostdin",
  "-loglevel",
  "error",
  "-i",
  job.result.verticalPath,
  "-t",
  "25",
  "-map",
  "0:v:0",
  "-map",
  "0:a:0",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "copy",
  "-movflags",
  "+faststart",
  vertical,
]);
const stamp = (s) =>
  s
    .split(/[:,]/)
    .reduce(
      (v, n, i) => (i === 3 ? v * 1000 + Number(n) : v * 60 + Number(n)),
      0,
    );
const cues = readFileSync(job.result.subtitlePath, "utf8")
  .trim()
  .split(/\r?\n\s*\r?\n/)
  .map((block) => {
    const [, timing, ...lines] = block.split(/\r?\n/);
    const [start, end] = timing.split(" --> ").map(stamp);
    return { startMs: start, endMs: end, text: lines.join(" "), block };
  });
assert.ok(
  cues.every((c) => c.endMs <= 25000 || c.startMs >= 25000),
  "Choose an editorial boundary between subtitle cues",
);
const kept = cues.filter((c) => c.endMs <= 25000);
assert.ok(kept.length);
writeFileSync(
  join(bundle, "subtitles.srt"),
  kept.map((c) => c.block).join("\n\n") + "\n",
);
writeJson(join(bundle, "transcript.json"), {
  segments: kept.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
});
writeFileSync(
  caption,
  "June 5, 2024: Starliner lifts off on its first crewed flight aboard an Atlas V rocket. Footage: NASA.\n",
);
copyFileSync(join(sourceDir, "source.json"), join(bundle, "source.json"));
const highlight = job.id + "-liftoff25";
const dryRun = cli([
  "publish",
  "--file",
  vertical,
  "--caption-file",
  caption,
  "--highlight",
  highlight,
  "--dry-run",
]);
assert.equal(dryRun.state, "dry_run");
assert.equal(
  readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).length,
  calls.length,
);
const probe = JSON.parse(
  run(env.HYPECLIP_FFPROBE || "ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,avg_frame_rate:format=duration",
    "-of",
    "json",
    vertical,
  ]),
);
const report = {
  transport: "fixture",
  job,
  sourceStartMs: startMs,
  sourceEndMs: status.jobs[0].endMs,
  calls,
  bundle,
  highlight,
  probe,
  sha256: await hashFile(vertical),
  dryRun,
};
writeJson(join(dir, "verification.json"), report);
console.log(
  JSON.stringify(
    {
      dir,
      bundle,
      highlight,
      workerDecision: job.evaluation,
      transport: "fixture",
      mockCreates: calls.filter((c) => c.operation === "mock-create").length,
    },
    null,
    2,
  ),
);
