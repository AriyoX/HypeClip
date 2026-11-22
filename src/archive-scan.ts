import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { detect, highlightId, readChat, type Spike } from "./detector.ts";
import { sameBroadcastConfig, type Broadcast } from "./live-store.ts";
import { fallbackSpike, audioRise } from "./media-only.ts";
import { fixturePath, stateDir, writeJson } from "./local.ts";
import { probe } from "./probe.ts";
import { MachineStageBudget, StageBudget, type Stage } from "./stages.ts";
import { processJob, runtime } from "./pipeline.ts";

async function archiveAudio(path: string, duration: number, preRoll: number) {
  const rate = 2000,
    bucket = 2000,
    samples = (rate * bucket) / 1000;
  const { stdout } = await promisify(execFile)(
    process.env.HYPECLIP_FFMPEG || "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0?",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: Math.ceil(duration / 1000 + 2) * rate * 2,
    },
  );
  const history: number[] = [],
    candidates: Spike[] = [];
  for (let i = 0; i + samples * 2 <= stdout.length; i += samples * 2) {
    let energy = 0;
    for (let j = i; j < i + samples * 2; j += 2)
      energy += (stdout.readInt16LE(j) / 32768) ** 2;
    const rise = audioRise(
      history,
      10 * Math.log10(Math.max(1e-10, energy / samples)),
    );
    const event = (i * 1000) / (2 * rate);
    if (rise && event + 1000 < duration) {
      const spike = fallbackSpike(
        "audio",
        Math.max(0, event - preRoll),
        event,
        Math.min(duration, event + bucket + 12000),
      );
      spike.audioRise = { ...rise, segmentEndMs: event + bucket };
      candidates.push(spike);
    }
  }
  return candidates;
}
export function strongestWindows(candidates: Spike[], limit: number) {
  const weight = (s: Spike) =>
    s.audioRise ? s.audioRise.levelDb - s.audioRise.baselineDb : s.score;
  const selected: Spike[] = [];
  for (const spike of [...candidates].sort(
    (a, b) =>
      weight(b) - weight(a) ||
      b.distinctUsers - a.distinctUsers ||
      a.eventMs - b.eventMs,
  )) {
    if (
      !selected.some((s) => spike.startMs < s.endMs && spike.endMs > s.startMs)
    )
      selected.push(spike);
    if (selected.length === limit) break;
  }
  return selected;
}
export async function scanArchive(
  db: DatabaseSync,
  s: Broadcast,
  limit: number,
  signal: AbortSignal,
  report: (e: Record<string, unknown>) => void,
) {
  const file = s.file!,
    info = s.editorial!,
    { durationMs } = await probe(file);
  const anchor = s.mediaStart ?? "1970-01-01T00:00:00.000Z";
  const config = JSON.stringify(s);
  db.prepare(
    "INSERT OR IGNORE INTO live_sources(id,config,anchor,head,ended) VALUES(?,?,?,?,?)",
  ).run(s.id, config, anchor, durationMs, "Archive scan");
  const existing = db
    .prepare("SELECT config FROM live_sources WHERE id=?")
    .get(s.id);
  if (!existing || !sameBroadcastConfig(String(existing.config), s))
    throw Error(
      "Use a fresh scan state for a changed source or editorial policy",
    );
  const candidates = info.chatMode.startsWith("media only")
    ? await archiveAudio(file, durationMs, info.settings.preRollMs)
    : detect(
        readChat(s.chat),
        { ...info.settings, mediaStart: anchor, durationMs },
        false,
      );
  const selected = strongestWindows(candidates, limit);
  writeJson(join(stateDir(), "sources", s.id, "shortlist.json"), {
    durationMs,
    limit,
    candidates: candidates.map(({ chat, ...s }) => s),
    selected: selected.map((s) => s.eventMs),
  });
  report({
    event: "shortlist",
    source: s.id,
    candidates: candidates.length,
    selected: selected.map((s) => s.eventMs),
  });
  for (const spike of selected) {
    if (signal.aborted) break;
    const id = highlightId(s.id, spike),
      candidate = {
        sessionId: s.id,
        candidateId: id,
        sourcePath: file,
        startMs: spike.startMs,
        endMs: spike.endMs,
        outputDir: join(stateDir(), "clips", id),
      };
    const details = {
      editorial: info,
      spike,
      rights: s.rights,
      fixture: s.fixture || fixturePath(file),
      request: {
        version: 1,
        candidate,
        output: { width: 1080, height: 1920, layout: "fit-pad" },
      },
    };
    db.prepare(
      "INSERT OR IGNORE INTO jobs(id,session,source,state,details,destination) VALUES(?,?,?,'queued',?,'local-review')",
    ).run(id, s.id, file, JSON.stringify(details));
    const budget = new MachineStageBudget();
    let rendering = false;
    const acquire = async (stage: Stage) => {
      const free = await budget.acquire(stage);
      const { lastInsertRowid } = db
        .prepare("INSERT INTO live_stages(job,stage,start) VALUES(?,?,?)")
        .run(id, stage, Date.now());
      report({
        event: "stage-start",
        id,
        stage,
        phase: rendering ? "Rendering" : undefined,
        source: s.id,
      });
      return () => {
        db.prepare("UPDATE live_stages SET end=? WHERE rowid=?").run(
          Date.now(),
          lastInsertRowid,
        );
        free();
      };
    };
    const job = await processJob(
      db,
      id,
      {
        ...runtime,
        render: (r) => {
          rendering = true;
          return runtime.render(r, acquire, signal);
        },
      },
      false,
      acquire,
      signal,
    );
    report({
      event: "decision",
      source: s.id,
      id,
      state: job.state,
      reason: job.reason,
    });
    if (!job.result) throw Error("Archive render incomplete: " + job.reason);
  }
}
