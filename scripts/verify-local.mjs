// Local model acceptance test. Run from the repository root after both models are installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { stateDir, writeJson, hashFile } from "../src/local.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const root = join(stateDir(), "verification");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "acceptance-"));
const commands = [];
const callLog = join(dir, "publisher-calls.txt");
writeFileSync(callLog, "");
const env = {
  ...process.env,
  HYPECLIP_HOME: dir,
  HYPECLIP_CALL_LOG: callLog,
  HF_HUB_OFFLINE: "1",
};
const ff = env.HYPECLIP_FFMPEG || "ffmpeg",
  probe = env.HYPECLIP_FFPROBE || "ffprobe";
const python =
  env.HYPECLIP_PYTHON ||
  resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
function run(bin, args, overrides = {}) {
  commands.push({
    bin,
    args,
    ...(Object.keys(overrides).length ? { env: overrides } : {}),
  });
  writeJson(join(dir, "commands.json"), commands);
  return execFileSync(bin, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...env, ...overrides },
  });
}
function cli(args, overrides) {
  return JSON.parse(
    run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./tests/support/observe-publisher.mjs",
        "cli.ts",
        ...args,
      ],
      overrides,
    ),
  );
}
console.log("Verification directory " + dir);
const media = join(dir, "media fixture");
run(python, ["-m", "workers.tests.fixtures", "--output-dir", media]);
const source = join(media, "speech source.mp4"),
  anchor = "2026-01-01T00:00:00Z";
const genuine = readFileSync("tests/fixtures/chat.jsonl", "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
const iso = (ms) => new Date(Date.parse(anchor) + ms).toISOString();
const baseline = Array.from({ length: 12 }, (_, i) => ({
  ...genuine[i % genuine.length],
  eventId: "base-" + i,
  eventAt: iso(5000 * i),
  receivedAt: iso(5000 * i + 10),
  text: "hello",
  emotes: [],
}));
const spam = Array.from({ length: 60 }, (_, i) => ({
  ...genuine[0],
  eventId: "spam-" + i,
  userId: "one",
}));
const cases = {
  baseline,
  spam: [...baseline, ...spam],
  genuine: [...baseline, ...genuine],
  overlap: [
    ...baseline,
    ...genuine,
    ...genuine.map((m) => ({
      ...m,
      eventId: m.eventId + "b",
      eventAt: iso(70000),
      receivedAt: iso(70010),
    })),
  ],
};
const counts = {};
for (const [name, lines] of Object.entries(cases)) {
  const path = join(dir, name + ".jsonl");
  writeFileSync(path, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const events = cli([
    "replay",
    "--chat",
    path,
    "--media-start",
    anchor,
    "--duration-ms",
    "95000",
  ]);
  counts[name] = events.length;
  if (name === "genuine")
    assert.deepEqual(
      [events[0].eventMs, events[0].startMs, events[0].endMs],
      [56000, 26000, 81000],
    );
}
assert.deepEqual(counts, { baseline: 0, spam: 0, genuine: 1, overlap: 1 });
const processArgs = (name) => [
  "process",
  "--session",
  name,
  "--source",
  source,
  "--chat",
  join(dir, "genuine.jsonl"),
  "--media-start",
  anchor,
  "--rights",
];
const [online] = cli(processArgs("healthy"));
assert.ok(online.result?.ok, online.reason);
assert.ok(online.evaluation?.verified, online.reason);
assert.ok(online.evaluation.decision, JSON.stringify(online.evaluation));
function artifacts(job) {
  return ["originalPath", "verticalPath", "transcriptPath", "subtitlePath"].map(
    (key) => [job.result[key], statSync(job.result[key]).mtimeMs],
  );
}
const before = artifacts(online);
const [repeat] = cli(processArgs("healthy"));
assert.deepEqual(repeat, online);
assert.deepEqual(artifacts(repeat), before);
const socket = createServer();
await new Promise((resolve, reject) =>
  socket.once("error", reject).listen(0, "127.0.0.1", resolve),
);
const unusedPort = socket.address().port;
await new Promise((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve())),
);
const [offline] = cli(processArgs("outage"), {
  OLLAMA_BASE_URL: "http://127.0.0.1:" + unusedPort,
});
assert.equal(offline.state, "review");
assert.ok(offline.evaluation.error);
assert.ok(offline.result?.ok, offline.reason);
assert.ok(statSync(offline.result.subtitlePath).size > 0);
const saved = artifacts(offline);
const digest = await hashFile(offline.result.verticalPath);
const retry = cli(["evaluate", offline.id]);
assert.ok(retry.evaluation.verified);
assert.ok(retry.evaluation.decision);
assert.deepEqual(saved, artifacts(retry));
assert.equal(await hashFile(retry.result.verticalPath), digest);
const status = cli(["status"]);
assert.equal(status.jobs.length, 2);
assert.equal(status.intents.length, 0);
assert.equal(readFileSync(callLog, "utf8"), "");
const properties = JSON.parse(
  run(probe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,avg_frame_rate:format=duration",
    "-of",
    "json",
    online.result.verticalPath,
  ]),
);
const voice = JSON.parse(readFileSync(online.result.transcriptPath, "utf8"))
  .segments.map((x) => x.text)
  .join(" ");
assert.match(voice, /last train/i);
assert.match(voice, /blue lantern/i);
const srt = readFileSync(online.result.subtitlePath, "utf8");
const cue = srt.match(/(\d+):(\d+):(\d+),(\d+) -->/);
const t =
  Number(cue[1]) * 3600 +
  Number(cue[2]) * 60 +
  Number(cue[3]) +
  Number(cue[4]) / 1000 +
  0.35;
for (const [at, name] of [
  [0, "first"],
  [t, "captioned"],
  [54.8, "last"],
]) {
  run(ff, [
    "-v",
    "error",
    "-nostdin",
    "-ss",
    String(at),
    "-i",
    online.result.verticalPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=540:960",
    "-y",
    join(dir, name + ".jpg"),
  ]);
}
run(ff, [
  "-v",
  "error",
  "-nostdin",
  "-ss",
  String(Math.max(0, t - 1)),
  "-i",
  online.result.verticalPath,
  "-t",
  "6",
  "-vn",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-y",
  join(dir, "speech.wav"),
]);
const report = {
  dir,
  counts,
  properties,
  online,
  offline,
  retry,
  repeatedSessionSameJob: true,
  reusedMedia: true,
  uploadCalls: 0,
  publishCalls: 0,
  transcript: voice,
};
writeJson(join(dir, "verification.json"), report);
console.log(
  JSON.stringify(
    {
      dir,
      counts,
      clip: online.result.verticalPath,
      decision: online.evaluation.decision,
      reusedMedia: true,
      uploadCalls: 0,
      publishCalls: 0,
    },
    null,
    2,
  ),
);
