import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { detect, readChat, Timing } from "./detector.ts";
import { processSession } from "./pipeline.ts";
import type { Session } from "./pipeline.ts";
import { stateDir } from "./local.ts";

export function closedSegments(csv: string) {
  return csv
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = /^(segment-\d{8}\.mkv),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(
        line,
      );
      if (!m) throw Error("Invalid FFmpeg segment index");
      return {
        name: m[1],
        startMs: Math.round(Number(m[2]) * 1000),
        endMs: Math.round(Number(m[3]) * 1000),
      };
    });
}
export async function capture(
  db: DatabaseSync,
  s: Omit<Session, "source">,
  port: number,
  once: boolean,
  signal: AbortSignal,
  report: (v: unknown) => void,
) {
  if (!s.rights) throw Error("Confirm recording rights with --rights");
  z.number().int().min(1024).max(65535).parse(port);
  Timing.parse({ ...s, durationMs: 1 });
  const chat = resolve(s.chat);
  if (db.prepare("SELECT 1 FROM sessions WHERE id=?").get(s.session))
    throw Error("Choose a new session ID for this live input");
  const parent = join(stateDir(), "captures");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "stream-"));
  const ff = process.env.HYPECLIP_FFMPEG || process.env.FFMPEG || "ffmpeg";
  const source = join(dir, "recording.mkv"),
    index = join(dir, "completed.csv");
  const child = fork(
    new URL("./capture-child.mjs", import.meta.url),
    [
      ff,
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      "udp://127.0.0.1:" +
        port +
        "?localaddr=127.0.0.1&fifo_size=65536&overrun_nonfatal=1",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-f",
      "segment",
      "-segment_time",
      "5",
      "-reset_timestamps",
      "1",
      "-segment_list",
      "completed.csv",
      "-segment_list_type",
      "csv",
      "segment-%08d.mkv",
    ],
    { cwd: dir, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
  );
  let failure = "",
    finished = false;
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (s) => {
    failure = (failure + s).slice(-1000);
  });
  const done = new Promise<void>((resolve) => {
    child.once("error", (e) => {
      failure = e.message;
      finished = true;
      resolve();
    });
    child.once("close", () => {
      finished = true;
      resolve();
    });
  });
  report({
    state: "listening",
    loopbackPort: port,
    closedSegmentsDirectory: dir,
  });
  const processed: { startMs: number; endMs: number }[] = [];
  let lastCheck = "";
  try {
    while (!signal.aborted && !finished) {
      await sleep(1000);
      if (!existsSync(index) || !existsSync(chat)) continue;
      const csv = readFileSync(index, "utf8");
      if (!csv.trim()) continue;
      const segments = closedSegments(csv.slice(0, csv.lastIndexOf("\n") + 1));
      if (!segments.length) continue;
      const key = segments.length + "-" + statSync(chat).size;
      if (key === lastCheck) continue;
      lastCheck = key;
      const messages = readChat(chat, true);
      const timing = {
        ...s,
        durationMs: segments.at(-1)!.endMs - segments[0].startMs,
        live: true,
      };
      const ready = detect(messages, timing).filter(
        (spike) =>
          spike.ready &&
          !processed.some(
            (p) => p.startMs < spike.endMs && spike.startMs < p.endMs,
          ),
      );
      if (!ready.length) continue;
      // Remux only finalized segments. The worker sees an ordinary, stable source timeline.
      writeFileSync(
        join(dir, "closed.ffconcat"),
        segments.map((x) => "file " + x.name).join("\n") + "\n",
      );
      const tmp = join(dir, "snapshot.mkv");
      await promisify(execFile)(
        ff,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "concat",
          "-safe",
          "1",
          "-i",
          "closed.ffconcat",
          "-map",
          "0",
          "-c",
          "copy",
          tmp,
        ],
        { cwd: dir, windowsHide: true, timeout: 120000 },
      );
      renameSync(tmp, source);
      const jobs = await processSession(db, { ...s, source, chat, live: true });
      if (jobs.length) processed.push(...ready);
      report({
        state: "processed",
        inputStillRunning: !finished,
        availableMs: timing.durationMs,
        source,
        jobs,
      });
      if (once && jobs.length) {
        if (!jobs.some((j) => !!j.result))
          throw Error(
            String(jobs[0].reason || "Live candidate failed to render"),
          );
        return;
      }
    }
    if (finished && !signal.aborted)
      throw Error("FFmpeg input stopped: " + failure);
  } finally {
    if (!finished && child.connected) child.disconnect();
    await done;
  }
}
