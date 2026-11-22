import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  copyFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../src/db.ts";
import { StageBudget, type Stage } from "../src/stages.ts";
import {
  addSegments,
  prune,
  reserve,
  endSource,
  materialize,
  type Broadcast,
  type Window,
} from "../src/live-store.ts";
import { claimCoordinator, runLive, manifest } from "../src/live.ts";
import { probe } from "../src/probe.ts";
import type { Spike } from "../src/detector.ts";

let dir: string, db: NonNullable<ReturnType<typeof openDb>>;
const source: Broadcast = {
  id: "left",
  chat: "chat",
  file: "file",
  rights: true,
  fixture: true,
  reactionMs: 4000,
  destination: "review",
};
const spike: Spike = {
  startMs: 1000,
  endMs: 50000,
  peakMs: 29000,
  eventMs: 25000,
  ready: false,
  score: 80,
  contributions: { velocity: 40, distinct: 30, reactions: 10 },
  baseline: 1,
  distinctUsers: 8,
  acceptedMessages: 8,
  chat: [],
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-concurrent-"));
  vi.stubEnv("HYPECLIP_HOME", dir);
  vi.stubEnv("LOCALAPPDATA", dir);
  db = openDb()!;
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function register(id: string) {
  db.prepare(
    "INSERT INTO live_sources(id,config,anchor) VALUES(?,'{}','now')",
  ).run(id);
}
it("excludes simultaneous coordinators and releases the database on shutdown", () => {
  const release = claimCoordinator();
  try {
    expect(() => claimCoordinator()).toThrow("already owns");
  } finally {
    release();
  }
  claimCoordinator()();
});
it("caps heavy work and runs independent FIFO stages concurrently", async () => {
  const budget = new StageBudget(),
    order: Stage[] = [];
  const releases = await Promise.all([
    budget.acquire("ffmpeg"),
    budget.acquire("whisper"),
  ]);
  const next = (s: Stage) =>
    budget.acquire(s).then((unlock) => {
      order.push(s);
      return unlock;
    });
  const secondRender = next("ffmpeg"),
    evaluation = next("ollama"),
    thirdRender = next("ffmpeg");
  releases[1]();
  (await evaluation)();
  expect(order).toEqual(["ollama"]);
  releases[0]();
  (await secondRender)();
  (await thirdRender)();
  expect(order).toEqual(["ollama", "ffmpeg", "ffmpeg"]);
});
it("scopes overlapping windows to their source and bounds admission", () => {
  register("left");
  register("right");
  const id = reserve(db, source, spike, 2);
  expect(reserve(db, source, spike, 2)).toBeUndefined();
  const id2 = reserve(db, { ...source, id: "right" }, spike, 2);
  expect(id2).toBeTruthy();
  expect(id2).not.toBe(id);
  expect(
    reserve(db, source, { ...spike, startMs: 70000, endMs: 125000 }, 2),
  ).toBeUndefined();
  endSource(db, "left", "Early stream ending");
  expect(
    db.prepare("SELECT state FROM live_windows WHERE id=?").get(id!)?.state,
  ).toBe("incomplete");
  expect(
    db.prepare("SELECT state FROM live_windows WHERE id=?").get(id2!)?.state,
  ).toBe("waiting");
});
it("marks a missing post-roll interval incomplete when the source clock has advanced across a gap", async () => {
  register(source.id);
  const id = reserve(db, source, spike, 2)!;
  db.prepare("UPDATE live_sources SET head=80000 WHERE id=?").run(source.id);
  const w = db
    .prepare("SELECT * FROM live_windows WHERE id=?")
    .get(id) as unknown as Window;
  await materialize(db, source, w);
  expect(
    db.prepare("SELECT state,reason FROM live_windows WHERE id=?").get(id),
  ).toMatchObject({
    state: "incomplete",
    reason: "Post-roll crosses a media gap",
  });
  expect(db.prepare("SELECT 1 FROM jobs WHERE id=?").get(id)).toBeUndefined();
});
it.skipIf(!process.env.HYPECLIP_FFMPEG)(
  "recovers pinned footage after restart and a queue delay longer than retention",
  async () => {
    register("left");
    const path = join(dir, "segment.mkv");
    copyFileSync("tests/fixtures/recording.mp4", path);
    const id = reserve(db, source, spike, 2)!;
    addSegments(db, source.id, [{ path, start: 0, end: 95000 }]);
    prune(db, source.id, 150000);
    expect(existsSync(path)).toBe(true);
    db.close();
    db = openDb()!;
    const w = db
      .prepare("SELECT * FROM live_windows WHERE id=?")
      .get(id) as unknown as Window;
    await materialize(db, { ...source, destination: "different-now" }, w);
    prune(db, source.id, 200000);
    const j = db.prepare("SELECT * FROM jobs WHERE id=?").get(id)!;
    expect(j.destination).toBe("review");
    expect(existsSync(path)).toBe(false);
    expect(
      (await probe(JSON.parse(String(j.details)).request.candidate.sourcePath))
        .durationMs,
    ).toBeGreaterThan(50000);
  },
);
it.skipIf(!process.env.HYPECLIP_FFMPEG)(
  "keeps recording the peer after a capture process drops and resumes its finalized media clock",
  async () => {
    const input = join(dir, "left.mp4");
    // The detector test recording has only one keyframe. Produce a short-GOP live input.
    execFileSync(
      process.env.HYPECLIP_FFMPEG!,
      [
        "-v",
        "error",
        "-i",
        resolve("tests/fixtures/recording.mp4"),
        "-t",
        "14",
        "-r",
        "12",
        "-g",
        "24",
        "-bf",
        "0",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        input,
      ],
      { windowsHide: true },
    );
    const otherInput = join(dir, "right.mp4");
    copyFileSync(input, otherInput);
    const chat = join(dir, "chat.jsonl");
    writeFileSync(chat, "");
    const config = manifest.parse({
      sources: ["left", "right"].map((id, i) => ({
        ...source,
        id,
        chat: i ? chat + ".b" : chat,
        file: i ? otherInput : input,
      })),
    });
    const controller = new AbortController();
    let killed = false;
    const start = runLive(db, config, controller.signal, (e) => {
      if (e.event === "capture-start" && e.source === "left") {
        setTimeout(() => {
          process.kill(Number(e.pid));
          killed = true;
        }, 500);
      }
    });
    try {
      await vi.waitFor(
        () => {
          expect(killed).toBe(true);
          expect(
            db.prepare("SELECT ended FROM live_sources WHERE id='left'").get()
              ?.ended,
          ).toBeTruthy();
          expect(
            Number(
              db.prepare("SELECT head FROM live_sources WHERE id='right'").get()
                ?.head,
            ),
          ).toBeGreaterThan(0);
        },
        { timeout: 30000, interval: 250 },
      );
    } finally {
      controller.abort();
      await start;
    }
    const head = db
      .prepare("SELECT head FROM live_sources WHERE id='right'")
      .get()!.head;
    db.close();
    db = openDb()!;
    const resume = new AbortController();
    let recovered: unknown;
    await runLive(db, config, resume.signal, (e) => {
      if (e.event === "capture-start") {
        recovered = e.base;
        resume.abort();
      }
    });
    expect(recovered).toBe(head);
  },
  45000,
);
