import { sameBroadcastConfig } from "./live-store.ts";
import { ChannelEdit } from "./editorial.ts";
import { captureLimit, claimCaptureSlot } from "./capture-slots.ts";
import { fallbackSpike, audioPeak, audioRise } from "./media-only.ts";
import { fork } from "node:child_process";
import {
  openSync,
  closeSync,
  readSync,
  existsSync,
  readFileSync,
  statSync,
  statfsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Chat, detect, timestamp } from "./detector.ts";
import { closedSegments } from "./capture.ts";
import {
  addSegments,
  binding,
  endSource,
  materialize,
  prune,
  reserve,
  ringDir,
  type Broadcast,
  type Window,
} from "./live-store.ts";
import { MachineStageBudget, StageBudget, type Stage } from "./stages.ts";
import { processJob, runtime } from "./pipeline.ts";

import {
  fixturePath,
  safeMessage,
  stateDir,
  writeJson,
  jsonFile,
} from "./local.ts";

export const manifest = z
  .object({
    sources: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,64}$/),
            file: z.string().optional(),
            feedEnv: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]*$/)
              .optional(),
            editorial: z
              .object({
                source: z.string(),
                channel: z.string(),
                settings: ChannelEdit,
                chatMode: z.string(),
                watchlist: z.boolean().optional(),
              })
              .optional(),
            port: z.number().int().min(1024).max(65535).optional(),
            mediaStart: timestamp.optional(),
            chat: z.string(),
            reactionMs: z.number().int().min(0).max(30000).default(4000),
            destination: z.string().min(1),
            rights: z.literal(true),
            fixture: z.boolean().default(false),
          })
          .refine(
            (s) =>
              [s.file, s.port, s.feedEnv].filter(Boolean).length === 1 &&
              (!s.feedEnv || !!s.editorial),
            "Choose a replay file or loopback UDP port",
          ),
      )
      .min(1)
      .max(8).refine(rows => rows.length <= captureLimit(), "Capture limit exceeded"),
    retentionMs: z.number().int().min(40000).default(65000),
    queueLimit: z.number().int().min(2).max(100).default(12),
    diskMiB: z.number().int().min(256).default(4096),
  })
  .refine(
    (m) =>
      new Set(m.sources.map((s) => s.id.toLowerCase())).size ===
        m.sources.length &&
      new Set(m.sources.map((s) => resolve(s.chat))).size ===
        m.sources.length &&
      new Set(m.sources.map((s) => s.port ?? s.file ?? s.feedEnv)).size ===
        m.sources.length,
    "Duplicate source or input",
  );
type Config = z.output<typeof manifest>;
export type SourceHooks = {
  captureKey?: (s: Broadcast) => string;
  startChat?: (s: Broadcast) => void;
  sharedBudget?: StageBudget;
  draining?: () => boolean;
  feed?: (s: Broadcast) => Promise<string>;
  chatMode?: (s: Broadcast) => string | undefined;
};
type Report = (e: Record<string, unknown>) => void;

export class ChatTail {
  private position = 0;
  private partial = Buffer.alloc(0);
  private recent: Chat[] = [];
  private lookAhead = 0;
  read(path: string, anchor: number, clock: number) {
    // Read chronological archive exports one chunk ahead of playback. Future rows must
    // not evict the current audience baseline in a large, fast chat.
    if (this.lookAhead <= anchor + clock + 5000 && existsSync(path)) {
      const size = statSync(path).size;
      if (size < this.position) throw Error("Live chat log was truncated");
      const length = Math.min(size - this.position, 256 * 1024);
      if (length) {
        const fd = openSync(path, "r");
        try {
          const data = Buffer.alloc(length);
          const n = readSync(fd, data, 0, length, this.position);
          this.position += n;
          const bytes = Buffer.concat([this.partial, data.subarray(0, n)]);
          const end = bytes.lastIndexOf(10) + 1;
          this.partial = Buffer.from(bytes.subarray(end));
          if (this.partial.length > 256 * 1024)
            throw Error("Oversize live chat line");
          for (const line of bytes
            .subarray(0, end)
            .toString("utf8")
            .split(/\r?\n/)) {
            if (line.trim()) {
              const m = Chat.parse(JSON.parse(line.replace(/^\uFEFF/, "")));
              this.recent.push(m);
              this.lookAhead = Math.max(this.lookAhead, Date.parse(m.eventAt));
            }
          }
        } finally {
          closeSync(fd);
        }
      }
    }
    this.recent = this.recent
      .filter((m) => Date.parse(m.eventAt) >= anchor + clock - 100000)
      .slice(-20000);
    return this.recent;
  }
}

export async function directoryBytes(dir: string): Promise<number> {
  let bytes = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    try {
      if (e.isDirectory()) bytes += await directoryBytes(path);
      else if (e.isFile()) bytes += (await stat(path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return bytes;
}

export function claimCoordinator() {
  // Hold a separate SQLite file lock for the coordinator lifetime. The OS
  // releases it on process death, independently of PID reuse or wall clocks.
  const lock = new DatabaseSync(join(stateDir(), "live.lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5)
      throw Error("A live coordinator already owns this database");
    throw error;
  }
  return () => lock.close();
}

function finalized(dir: string, base: number, after: number, replay: boolean) {
  const csv = join(dir, "closed.csv");
  if (!existsSync(csv)) return [];
  const body = readFileSync(csv, "utf8");
  return closedSegments(body.slice(0, body.lastIndexOf("\n") + 1))
    .map((seg) => ({
      path: join(dir, seg.name),
      start: replay ? Math.max(base, seg.startMs) : base + seg.startMs,
      end: replay ? seg.endMs : base + seg.endMs,
    }))
    .filter((seg) => seg.end > after);
}

async function captureSource(
  db: DatabaseSync,
  s: Broadcast,
  c: Config,
  signal: AbortSignal,
  report: Report,
  once: boolean,
  feeds: SourceHooks,
) {
  const config = JSON.stringify(s);
  const saved = db.prepare("SELECT * FROM live_sources WHERE id=?").get(s.id);
  if (saved?.ended) {
    if (!feeds.draining || s.file) return;
    db.prepare("UPDATE live_sources SET ended=NULL WHERE id=?").run(s.id);
  }
  async function remoteFeed() {
    for (let attempt = 0; ; attempt++) {
      try {
        return feeds.feed
          ? await feeds.feed(s)
          : new URL(process.env[s.feedEnv!]!).href;
      } catch (e) {
        if (signal.aborted || attempt >= 2) throw e;
        report({ event: "resolve-retry", source: s.id, attempt: attempt + 1 });
        await sleep(1000 * (attempt + 1), undefined, { signal });
      }
    }
  }
  // Opening the platform resolver can take seconds. Exclude it from the first-frame estimate.
  let remote = s.feedEnv ? await remoteFeed() : undefined;
  const anchor = String(
    saved?.anchor ?? s.mediaStart ?? new Date().toISOString(),
  );
  db.prepare(
    "INSERT OR IGNORE INTO live_sources(id,config,anchor) VALUES(?,?,?)",
  ).run(s.id, config, anchor);
  const root = ringDir(s.id);
  mkdirSync(root, { recursive: true });
  let base = Number(saved?.head ?? 0);
  if (saved) {
    // Import a close that FFmpeg flushed just before the previous process died.
    // Ignore the unfinished final file, which has no CSV record.
    const epochs = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const dir = join(root, entry.name),
        metadata = join(dir, "epoch.json");
      if (entry.isDirectory() && existsSync(metadata))
        epochs.push({ dir, base: Number(jsonFile(metadata).base) });
    }
    for (const epoch of epochs.sort((a, b) => a.base - b.base)) {
      const closed = finalized(epoch.dir, epoch.base, base, !!s.file).filter(
        (seg) => existsSync(seg.path),
      );
      if (closed.length) {
        addSegments(db, s.id, closed);
        base = closed.at(-1)!.end;
      }
    }
  }
  const chat = new ChatTail();
  const levels: number[] = [];
  let lastBucket = -1;
  const settings = s.editorial?.settings;
  const mediaOnly = () =>
    (feeds.chatMode?.(s) ?? s.editorial?.chatMode)?.startsWith("media only");
  // Use a new directory on reconnect so an orphaned producer cannot overwrite reservations.
  for (let attempt = 0; !signal.aborted; attempt++) {
    if (s.feedEnv && attempt) remote = await remoteFeed();
    if (!s.file && (saved || attempt)) {
      base = Math.max(base, Date.now() - Date.parse(anchor));
      db.prepare(
        "UPDATE live_windows SET state='incomplete',reason='Reconnect gap in reserved footage' WHERE source=? AND state='waiting' AND end>?",
      ).run(
        s.id,
        Number(
          db.prepare("SELECT head FROM live_sources WHERE id=?").get(s.id)!
            .head,
        ),
      );
      report({ event: "gap", source: s.id, toMs: base });
    }
    const dir = mkdtempSync(join(root, "capture-"));
    writeJson(join(dir, "epoch.json"), { base });
    const input = s.file
      ? [
          "-copyts",
          "-start_at_zero",
          "-re",
          "-readrate_initial_burst",
          "0",
          ...(base ? ["-ss", String(base / 1000)] : []),
          "-i",
          s.file,
        ]
      : s.feedEnv
        ? [
            "-rw_timeout",
            "12000000",
            "-protocol_whitelist",
            "https,http,tls,tcp,crypto",
            "-i",
            remote!,
          ]
        : [
            "-i",
            "udp://127.0.0.1:" +
              s.port +
              "?localaddr=127.0.0.1&fifo_size=16384&overrun_nonfatal=1&timeout=12000000",
          ];
    const ff = fork(
      fileURLToPath(new URL("./capture-child.mjs", import.meta.url)),
      [
        process.env.HYPECLIP_FFMPEG || "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        ...input,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-f",
        "segment",
        ...(s.file ? ["-avoid_negative_ts", "disabled"] : []),
        "-segment_time",
        "2",
        "-segment_list_size",
        "64",
        "-segment_list_type",
        "csv",
        "-segment_list",
        "closed.csv",
        "-reset_timestamps",
        "1",
        "segment-%08d.mkv",
      ],
      { cwd: dir, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
    );
    let error = "",
      ended = false,
      code: number | null = null;
    ff.stderr!.on("data", (data) => (error = (error + data).slice(-1000)));
    ff.once("error", (e) => {
      error = e.message;
    });
    const done = new Promise<void>((resolve) => {
      ff.once("error", () => {
        ended = true;
        resolve();
      });
      ff.once("exit", (v) => {
        code = v;
        ended = true;
        resolve();
      });
    });
    const started = Date.now();
    ff.once("message", (pid) =>
      report({ event: "capture-start", source: s.id, anchor, base, pid }),
    );
    let cursor = base,
      lastAdvance = Date.now(),
      stalled = false;
    try {
      while (!signal.aborted) {
        const rows = finalized(dir, base, cursor, !!s.file);
        if (rows.length) {
          if (rows[0].start > cursor + 100)
            report({
              event: "gap",
              source: s.id,
              fromMs: cursor,
              toMs: rows[0].start,
            });
          addSegments(db, s.id, rows);
          cursor = rows.at(-1)!.end;
          lastAdvance = Date.now();
        }
        const archiveEnd = !!s.file && ended && code === 0;
        const mediaNow = archiveEnd
          ? cursor
          : Math.max(1, Math.min(cursor + 5000, Date.now() - started + base));
        const draining = feeds.draining?.();
        if (!draining && settings && mediaOnly()) {
          for (const m of settings.markers) {
            if (
              m.startMs < base ||
              m.startMs > cursor ||
              m.endMs < cursor - 10000
            )
              continue;
            const spike = fallbackSpike(
              "operator",
              m.startMs,
              m.payoffMs,
              m.endMs,
            );
            const id = reserve(db, s, spike, c.queueLimit);
            if (id)
              report({
                event: "trigger",
                source: s.id,
                id,
                mode: "operator",
                startMs: m.startMs,
                endMs: m.endMs,
              });
          }
          if (!settings.markers.length)
            for (const seg of rows) {
              const level = await audioPeak(seg.path);
              if (level !== null) {
                const rise = audioRise(levels, level);
                if (rise) {
                  const spike = fallbackSpike(
                    "audio",
                    Math.max(0, seg.start - settings.preRollMs),
                    seg.start,
                    seg.end + 12000,
                  );
                  spike.audioRise = {
                    ...rise,
                    segmentEndMs: seg.end,
                  };
                  const id = reserve(db, s, spike, c.queueLimit);
                  if (id)
                    report({
                      event: "trigger",
                      source: s.id,
                      id,
                      mode: "audio",
                      eventMs: spike.eventMs,
                      ...spike.audioRise,
                    });
                }
              }
            }
        }
        const messages = mediaOnly()
          ? []
          : chat.read(
              s.chat,
              Date.parse(anchor),
              mediaNow - (settings?.offsetMs ?? 0),
            );
        const completeBucket = archiveEnd
          ? Math.ceil(mediaNow / 5000)
          : Math.floor(mediaNow / 5000);
        const shortlist = settings
          ? completeBucket === lastBucket
            ? []
            : messages.filter(
                (m) =>
                  Date.parse(m.eventAt) -
                    Date.parse(anchor) +
                    settings.offsetMs <
                  completeBucket * 5000,
              )
          : messages;
        lastBucket = completeBucket;
        for (const spike of detect(
          draining ? [] : shortlist,
          {
            ...settings,
            mediaStart: anchor,
            durationMs: mediaNow,
            reactionMs: s.reactionMs,
            live: true,
          },
          false,
        )) {
          if (
            spike.peakMs < base ||
            spike.peakMs <
              mediaNow - 15000 + Math.min(0, settings?.offsetMs ?? 0)
          )
            continue;
          if (settings)
            spike.endMs = Math.min(
              spike.startMs + 110000,
              Math.max(
                spike.eventMs + 6000,
                (spike.lastReactionMs ?? spike.peakMs) + settings.tailMs + 12000,
              ),
            );
          const id = reserve(db, s, spike, c.queueLimit);
          if (id)
            report({
              event: "trigger",
              source: s.id,
              id,
              peakMs: spike.peakMs,
              startMs: spike.startMs,
              endMs: spike.endMs,
            });
        }
        // A finite archive can end during reserved post-roll. Keep the completed
        // reaction if at least one second follows the detected event.
        if (archiveEnd && settings) {
          const pending = db
            .prepare(
              "SELECT id,spike FROM live_windows WHERE source=? AND state='waiting' AND end>?",
            )
            .all(s.id, cursor);
          for (const row of pending) {
            const spike = JSON.parse(String(row.spike));
            if (spike.mode !== "operator" && cursor >= spike.eventMs + 1000) {
              spike.endMs = cursor;
              db.prepare(
                "UPDATE live_windows SET end=?,spike=? WHERE id=?",
              ).run(cursor, JSON.stringify(spike), row.id);
            }
          }
        }
        const ready = db
          .prepare(
            "SELECT * FROM live_windows WHERE source=? AND state='waiting' AND end<=? ORDER BY start",
          )
          .all(s.id, cursor) as unknown as Window[];
        for (const w of ready) {
          db.prepare(
            "UPDATE live_windows SET readyAt=coalesce(readyAt,?) WHERE id=?",
          ).run(Date.now(), w.id);
          report({
            event: "post-roll-ready",
            source: s.id,
            id: w.id,
            head: cursor,
          });
          await materialize(
            db,
            s.editorial
              ? {
                  ...s,
                  editorial: {
                    ...s.editorial,
                    chatMode: feeds.chatMode?.(s) ?? s.editorial.chatMode,
                  },
                }
              : s,
            w,
          );
        }
        prune(
          db,
          s.id,
          cursor -
            Math.max(
              c.retentionMs,
              (settings?.preRollMs ?? 0) +
                (settings?.latencyMs ?? 0) +
                (settings?.reactionMs ?? 0) +
                Math.max(0, -(settings?.offsetMs ?? 0)) +
                10000,
            ),
        );
        if (
          once &&
          db
            .prepare(
              "SELECT 1 FROM live_windows WHERE source=? AND decisionAt IS NOT NULL",
            )
            .get(s.id)
        ) {
          report({
            event: "clip-finished",
            source: s.id,
            inputRunning: !ended,
            head: cursor,
          });
          endSource(db, s.id, "Stopped after local decision");
          return;
        }
        if (
          draining &&
          !db
            .prepare(
              "SELECT 1 FROM live_windows WHERE source=? AND state='waiting'",
            )
            .get(s.id)
        )
          return;
        if (ended) break;
        if (Date.now() - lastAdvance > 18000) {
          stalled = true;
          break;
        }
        await sleep(200);
      }
    } finally {
      if (ff.connected) ff.disconnect();
      await done;
    }
    if (signal.aborted) return; // preserve complete ranges and replay position for resume
    if (!s.file && attempt < 2) {
      report({
        event: "disconnect",
        source: s.id,
        head: cursor,
        error: s.feedEnv ? "Authorized media feed interrupted" : error,
      });
      base = cursor;
      continue;
    }
    const reason = stalled
      ? "No finalized keyframe segment for 18 seconds"
      : code === 0
        ? "End of input"
        : "Capture stopped (exit " +
          String(code) +
          ")" +
          (!s.feedEnv && error ? ": " + error : "");
    endSource(db, s.id, reason);
    report({ event: "input-ended", source: s.id, reason, head: cursor });
    return;
  }
}

export async function runLive(
  db: DatabaseSync,
  c: Config,
  signal: AbortSignal,
  report: Report,
  once = false,
  feeds: SourceHooks = {},
) {
  for (const s of c.sources) {
    if (s.file) s.file = realpathSync(s.file);
    s.chat = resolve(s.chat);
    s.fixture ||= fixturePath(s.chat) || !!(s.file && fixturePath(s.file));
  }
  for (const s of c.sources) {
    const saved = db
      .prepare("SELECT config FROM live_sources WHERE id=?")
      .get(s.id);
    if (saved && !sameBroadcastConfig(String(saved.config),s))
      throw Error(
        "Broadcast ID already bound to a different input or destination",
      );
    if (db.prepare("SELECT id FROM sessions WHERE id=?").get(s.id))
      throw Error("This ID belongs to a single-source session");
  }
  const releaseCoordinator = feeds.sharedBudget ? () => {} : claimCoordinator();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop);
  if (signal.aborted) stop();
  const diskStop = new AbortController();
  const budget = feeds.sharedBudget ?? new MachineStageBudget();
  let finished = false,
    last = "",
    fatal = "";
  const tasks = new Map<string, Promise<void>>();
  async function work(id: string, source: string) {
    let rendering = false;
    const acquire = async (stage: Stage) => {
      const unlock = await budget.acquire(stage);
      const { lastInsertRowid } = db
        .prepare("INSERT INTO live_stages(job,stage,start) VALUES(?,?,?)")
        .run(id, stage, Date.now());
      report({ event: "stage-start", source, id, stage, phase: rendering && stage === "ffmpeg" ? "Rendering" : undefined });
      return () => {
        db.prepare("UPDATE live_stages SET end=? WHERE rowid=?").run(
          Date.now(),
          lastInsertRowid,
        );
        unlock();
      };
    };
    const job = await processJob(
      db,
      id,
      {
        ...runtime,
        render: (r) => { rendering = true; return runtime.render(r, acquire, diskStop.signal); },
        evaluate: async (t, spike, fixture) => {
          db.prepare(
            "UPDATE live_windows SET renderAt=coalesce(renderAt,?) WHERE id=?",
          ).run(Date.now(), id);
          const unlock = await acquire("ollama");
          try {
            return await runtime.evaluate(t, spike, fixture);
          } finally {
            unlock();
          }
        },
      },
      false,
      acquire,
      diskStop.signal,
    );
    if (job.result)
      db.prepare(
        "UPDATE live_windows SET renderAt=coalesce(renderAt,?) WHERE id=?",
      ).run(Date.now(), id);
    if (diskStop.signal.aborted && !job.result) return; // Retry this reserved extract on resume.
    if (db.prepare("SELECT owner FROM jobs WHERE id=?").get(id)?.owner) return;
    db.prepare(
      "UPDATE live_windows SET state=?,decisionAt=?,reason=? WHERE id=?",
    ).run(job.state, Date.now(), job.reason, id);
    report({
      event: "decision",
      source,
      id,
      state: job.state,
      reason: job.reason,
    });
  }
  async function schedule() {
    while (true) {
      const queue = db
        .prepare(
          "SELECT id,source FROM live_windows WHERE state='queued' ORDER BY readyAt,triggerAt",
        )
        .all()
        .filter(
          (w) =>
            !tasks.has(String(w.id)) &&
            c.sources.some((s) => s.id === w.source),
        );
      while (queue.length && tasks.size < 2 && !controller.signal.aborted) {
        const i = queue.findIndex((w) => w.source !== last);
        const w = queue.splice(Math.max(0, i), 1)[0];
        last = String(w.source);
        const id = String(w.id);
        tasks.set(
          id,
          work(id, last)
            .catch((e) => {
              fatal = safeMessage(e);
              stop();
            })
            .finally(() => tasks.delete(id)),
        );
      }
      if (
        !tasks.size &&
        (controller.signal.aborted || (finished && !queue.length))
      )
        break;
      await sleep(100);
    }
  }
  async function monitor() {
    let high = 0,
      free = Infinity;
    while ((!finished || tasks.size) && !controller.signal.aborted) {
      const bytes = await directoryBytes(stateDir());
      high = Math.max(high, bytes);
      const disk = statfsSync(stateDir());
      free = Math.min(free, disk.bavail * disk.bsize);
      if (
        bytes >= c.diskMiB * 1048576 ||
        disk.bavail * disk.bsize < 256 * 1048576
      ) {
        fatal = "Live storage budget exhausted";
        diskStop.abort();
        stop();
      }
      await sleep(1000);
    }
    report({
      event: "storage",
      peakSampledBytes: high,
      minFreeDiskBytes: free,
    });
  }
  const scheduler = schedule(),
    storage = monitor().catch((e) => {
      fatal = safeMessage(e);
      stop();
    });
  try {
    await Promise.all(
      c.sources.map(async (s) => {
        let releaseSlot;
        try {
          releaseSlot = claimCaptureSlot(undefined, feeds.captureKey?.(s) ?? (s.port ? "udp:" + s.port : s.file ?? s.id));
          feeds.startChat?.(s);
          await captureSource(db, s, c, controller.signal, report, once, feeds);
        } catch (error) {
          const reason = safeMessage(error);
          endSource(db, s.id, reason);
          report({ event: "input-error", source: s.id, reason });
          fatal = reason;
        } finally {
          releaseSlot?.();
        }
      }),
    );
  } finally {
    finished = true;
    await Promise.all([scheduler, storage]);
    releaseCoordinator();
    signal.removeEventListener("abort", stop);
  }
  if (fatal) throw Error(fatal);
}
