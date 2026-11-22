import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireInterval } from "./kick-interval.ts";
import { claimCaptureSlot } from "./capture-slots.ts";
import { monitor, monitorWatchlist } from "./monitor.ts";
import { exportJob } from "./review-export.ts";
import { resolveFeed } from "./platforms.ts";
import { jsonFile, stateDir, writeJson, safeMessage } from "./local.ts";
import { inspectSource, type CheckedSource } from "./dashboard-sources.ts";
import { openDb } from "./db.ts";

const ctrl = new AbortController();
process.on("message", (message) => {
  if (message === "stop") ctrl.abort();
});
process.once("disconnect", () => ctrl.abort());
const send = (event: Record<string, unknown>) => {
  if (process.connected) process.send?.(event);
};
async function work() {
  const task = jsonFile(process.argv[2]) as {
    source: CheckedSource;
    rights: string;
    exports: string;
  };
  const folder = stateDir(),
    file = join(folder, "monitor.json");
  let pending = Promise.resolve();
  const report = (ev: Record<string, unknown>) => {
    send(ev);
    if (ev.event === "decision" && typeof ev.id === "string") {
      const id = ev.id;
      pending = pending
        .then(async () => {
          if (!existsSync(join(task.exports, id, "results.json")))
            await exportJob(id, task.exports, id);
          send({ event: "exported", id });
        })
        .catch((e) => send({ event: "export-error", reason: safeMessage(e) }));
    }
  };
  const s = task.source;
  try {
    if (s.form.kind === "watchlist") {
      await monitorWatchlist(
        { watchlist: "docs/watchlist.json", rights: task.rights },
        ctrl.signal,
        report,
      );
    } else {
      let src = s;
      if (s.form.kind === "url" && !s.archive) {
        src = await inspectSource(s.form);
        if (!src.available || !src.eligible)
          throw Error(src.reason || "Broadcast unavailable");
      }
      const form = src.form,
        input: Record<string, unknown> = {
          url: src.url,
          channel: src.name,
          broadcastId: src.broadcastId,
          status: src.archive ? "archive" : "live",
          localReviewRights: task.rights,
          settings: form.settings,
        };
      if (form.file)
        Object.assign(input, {
          file: form.file,
          chat: form.chat || undefined,
          mediaStart: form.mediaStart || undefined,
          chatProvenance: form.chat
            ? "Original timestamped local JSONL"
            : undefined,
        });
      if (src.archive && src.platform !== "local") {
        const dir = join(folder, "archive"),
          startMs = Math.round(form.startMinute * 60000),
          endMs = startMs + Math.round(form.minutes * 60000);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "interval.mp4");
        send({ event: "acquiring" });
        if (src.platform === "kick") {
          const spec = join(dir, "selection.json");
          writeJson(spec, { url: src.url, startMs, endMs });
          const a = await acquireInterval(spec, dir, task.rights);
          Object.assign(input, {
            file: path,
            archiveOffsetMs: startMs,
            mediaStart: a.mediaStart,
            chat: a.chat?.messages ? join(dir, "chat.jsonl") : undefined,
            chatProvenance: a.chat?.messages
              ? "Original synchronized Kick replay"
              : undefined,
          });
        } else {
          const release = claimCaptureSlot(
            undefined,
            src.platform + ":" + src.broadcastId,
          );
          try {
            const feed = await resolveFeed(src.url);
            try {
              await promisify(execFile)(
                process.env.HYPECLIP_FFMPEG || "ffmpeg",
                [
                  "-v",
                  "error",
                  "-nostdin",
                  "-ss",
                  String(startMs / 1000),
                  "-i",
                  feed,
                  "-t",
                  String((endMs - startMs) / 1000),
                  "-map",
                  "0:v:0",
                  "-map",
                  "0:a:0?",
                  "-c:v",
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-c:a",
                  "aac",
                  "-y",
                  path,
                ],
                { windowsHide: true, signal: ctrl.signal },
              );
            } catch {
              throw Error(
                "Archive download failed. Choose a retained recording or a shorter accessible interval.",
              );
            }
            Object.assign(input, { file: path, archiveOffsetMs: startMs });
          } finally {
            release();
          }
        }
      }
      if (ctrl.signal.aborted) return;
      writeJson(file, { sources: [input] });
      await monitor(
        [],
        { config: file, ...(src.archive ? { scan: 1 } : {}) },
        ctrl.signal,
        report,
      );
    }
  } finally {
    await pending;
    // Recover a completed decision if the server or a child exited between render and library registration.
    const db = openDb(true);
    try {
      for (const r of db
        ?.prepare("SELECT id FROM jobs WHERE result IS NOT NULL")
        .all() ?? []) {
        if (!existsSync(join(task.exports, String(r.id), "results.json")))
          await exportJob(String(r.id), task.exports, String(r.id));
      }
    } finally {
      db?.close();
    }
  }
}
try {
  await work();
  send({ event: ctrl.signal.aborted ? "stopped" : "complete" });
} catch (e) {
  send({ event: "failed", reason: safeMessage(e) });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
