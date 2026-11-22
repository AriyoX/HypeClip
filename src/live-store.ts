import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ChannelEdit } from "./editorial.ts";
import { atomic } from "./db.ts";
import { highlightId, type Spike } from "./detector.ts";
import { stateDir, safeMessage } from "./local.ts";

export type Segment = { path: string; start: number; end: number };
export type Window = {
  id: string;
  source: string;
  start: number;
  end: number;
  destination: string;
  mode: string | null;
  spike: string;
  state: string;
};
export type Broadcast = {
  editorial?: import("./editorial.ts").Editorial;
  feedEnv?: string;
  id: string;
  destination: string;
  chat: string;
  file?: string;
  port?: number;
  mediaStart?: string;
  reactionMs: number;
  fixture: boolean;
  rights: boolean;
};
export function sameBroadcastConfig(saved: string, current: Broadcast) {
  const previous = JSON.parse(saved) as Broadcast;
  if (previous.editorial) previous.editorial.settings = ChannelEdit.parse(previous.editorial.settings);
  return isDeepStrictEqual(previous, JSON.parse(JSON.stringify(current)));
}
export const binding = (s: Broadcast) =>
  s.file || (s.feedEnv ? s.editorial!.source : "udp://127.0.0.1:" + s.port);
export const ringDir = (id: string) => join(stateDir(), "rolling", id);

export function reserve(
  db: DatabaseSync,
  s: Broadcast,
  spike: Spike,
  limit: number,
) {
  return atomic(db, () => {
    const overlap = db
      .prepare(
        "SELECT * FROM live_windows WHERE source=? AND start<? AND end>? ORDER BY start LIMIT 1",
      )
      .get(s.id, spike.endMs, spike.startMs);
    if (overlap) {
      if (s.editorial && overlap.state === "waiting" && !spike.mode) {
        const previous = JSON.parse(String(overlap.spike)) as Spike;
        if (
          spike.peakMs >= previous.peakMs &&
          spike.lastReactionMs! > (previous.lastReactionMs ?? 0)
        ) {
          const end = Math.min(
            Number(overlap.start) + 110000,
            Math.max(Number(overlap.end), spike.endMs),
          );
          const combined = {
            ...(spike.score > previous.score ? spike : previous),
            startMs: Number(overlap.start),
            endMs: end,
            lastReactionMs: spike.lastReactionMs,
            chat: [
              ...new Map(
                [...previous.chat, ...spike.chat].map((m) => [m.eventId, m]),
              ).values(),
            ].slice(-80),
          };
          db.prepare("UPDATE live_windows SET end=?,spike=? WHERE id=?").run(
            end,
            JSON.stringify(combined),
            overlap.id,
          );
        }
      }
      return;
    }
    const n = db
      .prepare(
        "SELECT count(*) n FROM live_windows WHERE state IN ('waiting','queued')",
      )
      .get()!;
    if (Number(n.n) >= limit) return;
    if (
      Number(n.n) === limit - 1 &&
      db
        .prepare("SELECT 1 FROM live_sources WHERE id<>? AND ended IS NULL")
        .get(s.id) &&
      !db
        .prepare(
          "SELECT 1 FROM live_windows WHERE source<>? AND state IN ('waiting','queued')",
        )
        .get(s.id)
    )
      return;

    const policy = db
      .prepare(
        "SELECT mode FROM policy WHERE session=? AND source=? AND channel=?",
      )
      .get(s.id, binding(s), s.destination);
    const id = highlightId(s.id, spike);
    db.prepare(
      "INSERT INTO live_windows(id,source,start,end,spike,destination,mode,state,triggerAt) VALUES(?,?,?,?,?,?,?,'waiting',?)",
    ).run(
      id,
      s.id,
      spike.startMs,
      spike.endMs,
      JSON.stringify(spike),
      s.destination,
      s.editorial ? null : (policy?.mode ?? null),
      Date.now(),
    );
    return id;
  });
}
export function addSegments(
  db: DatabaseSync,
  source: string,
  segments: Segment[],
) {
  atomic(db, () => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO live_segments VALUES(?,?,?,?)",
    );
    for (const seg of segments)
      insert.run(source, seg.path, seg.start, seg.end);
    if (segments.length)
      db.prepare("UPDATE live_sources SET head=max(head,?) WHERE id=?").run(
        segments.at(-1)!.end,
        source,
      );
  });
}
export function prune(db: DatabaseSync, source: string, cutoff: number) {
  const expired = db
    .prepare(
      `SELECT path FROM live_segments s WHERE source=? AND end<=? AND NOT EXISTS
    (SELECT 1 FROM live_windows w WHERE w.source=s.source AND w.state='waiting' AND w.start<s.end AND w.end>s.start)`,
    )
    .all(source, cutoff);
  for (const { path } of expired) {
    rmSync(String(path), { force: true });
    db.prepare("DELETE FROM live_segments WHERE path=?").run(path);
  }
}
export function endSource(db: DatabaseSync, source: string, reason: string) {
  atomic(db, () => {
    db.prepare("UPDATE live_sources SET ended=? WHERE id=?").run(
      reason,
      source,
    );
    db.prepare(
      "UPDATE live_windows SET state='incomplete',reason=? WHERE state='waiting' AND source=?",
    ).run(reason, source);
  });
}

// Reservation and rolling eviction use the same interval predicate. Transfer ownership
// to an immutable file before inserting a claimable worker job.
export async function materialize(db: DatabaseSync, s: Broadcast, w: Window) {
  const segments = db
    .prepare(
      "SELECT path,start,end FROM live_segments WHERE source=? AND start<? AND end>? ORDER BY start",
    )
    .all(s.id, w.end, w.start) as unknown as Segment[];
  const head = Number(
    db.prepare("SELECT head FROM live_sources WHERE id=?").get(s.id)?.head,
  );
  if (head < w.end) return;
  try {
    if (!segments.length || segments.at(-1)!.end < w.end)
      throw Error("Post-roll crosses a media gap");
    let cursor = w.start;
    for (const seg of segments) {
      if (seg.start > cursor + 2 || !existsSync(seg.path))
        throw Error("Missing reserved footage or media gap");
      cursor = seg.end;
    }
    const base = join(stateDir(), "clips", w.id);
    mkdirSync(base, { recursive: true });
    const durable = join(base, "reserved.mkv");
    const offset = w.start - segments[0].start;
    if (!existsSync(durable)) {
      const list = join(base, "reserved.ffconcat");
      // Paths originate in our capture directory; ffconcat uses shell-like single quoting.
      writeFileSync(
        list,
        segments
          .map(
            (seg) =>
              "file '" +
              seg.path.replaceAll("\\", "/").replaceAll("'", "'\\''") +
              "'\nduration " +
              ((seg.end - seg.start) / 1000).toFixed(3),
          )
          .join("\n") + "\n",
      );
      const temp = join(base, "pending.mkv");
      await promisify(execFile)(
        process.env.HYPECLIP_FFMPEG || "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-protocol_whitelist",
          "file",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-map",
          "0",
          "-c",
          "copy",
          temp,
        ],
        { windowsHide: true, timeout: 90000 },
      );
      renameSync(temp, durable);
    }
    const request = {
      version: 1,
      candidate: {
        sessionId: s.id,
        candidateId: w.id,
        sourcePath: durable,
        startMs: offset,
        endMs: offset + w.end - w.start,
        outputDir: base,
      },
      output: { width: 1080, height: 1920, layout: "fit-pad" },
    };
    const spike = JSON.parse(w.spike) as Spike;
    const details = {
      request,
      spike,
      fixture: s.fixture || spike.chat.some((m) => m.fixture),
      rights: s.rights,
      editorial: s.editorial,
    };
    atomic(db, () => {
      db.prepare(
        "INSERT OR IGNORE INTO jobs(id,session,source,details,state,destination,destinationMode) VALUES(?,?,?,?,'queued',?,?)",
      ).run(
        w.id,
        s.id,
        binding(s),
        JSON.stringify(details),
        w.destination,
        w.mode,
      );
      db.prepare("UPDATE live_windows SET state='queued' WHERE id=?").run(w.id);
    });
  } catch (error) {
    db.prepare(
      "UPDATE live_windows SET state='incomplete',reason=? WHERE id=?",
    ).run(safeMessage(error), w.id);
  }
}
