import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../src/db.ts";
import { publish, reconcile } from "../src/publisher.ts";
import { jsonFile } from "../src/local.ts";
import { ProviderError, retryTime, sameAsset } from "../src/buffer.ts";
import type { Post, Provider } from "../src/buffer.ts";
const fixture = jsonFile("tests/fixtures/buffer.json");
const options = {
  path: resolve("tests/fixtures/portrait.mp4"),
  channel: "test",
  caption: "caption",
  highlight: "h1",
  live: true,
  mode: "shareNow" as const,
};
function adapter() {
  const post: Post = structuredClone(fixture.post);
  return {
    provider: {
      channel: vi.fn(async () => fixture.channel),
      create: vi.fn(async () => post.id),
      read: vi.fn(async () => post),
      matches: vi.fn<Provider["matches"]>(async () => [post]),
    },
    host: vi.fn(async () => {}),
    assetUrl: () => "https://example.invalid/asset.mp4",
    delay: async () => {},
    polls: 1,
    post,
  };
}
let db: NonNullable<ReturnType<typeof openDb>>, dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-pub-"));
  vi.stubEnv("HYPECLIP_HOME", dir);
  db = openDb()!;
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
it("dry run probes and resolves without uploading or posting", async () => {
  const a = adapter();
  const r = await publish(null, { ...options, live: false }, a);
  expect(r).toMatchObject({ state: "dry_run", width: 90, height: 160 });
  expect(a.host).not.toHaveBeenCalled();
  expect(a.provider.create).not.toHaveBeenCalled();
});
it("claims once for concurrent IDs with the same video", async () => {
  const a = adapter();
  const concurrent = openDb()!;
  try {
    await Promise.all([
      publish(db, options, a),
      publish(concurrent, { ...options, highlight: "alias" }, a),
    ]);
  } finally {
    concurrent.close();
  }
  expect(a.provider.create).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT count(*) n FROM highlights").get()?.n).toBe(2);
  expect(await publish(db, options, a)).toMatchObject({
    state: "published",
    sentAt: a.post.sentAt,
  });
});
it.each([
  ["scheduled", "automatic", "pending"],
  ["draft", "automatic", "review"],
  ["needs_approval", "automatic", "review"],
  ["sent", "notification", "review"],
  ["error", "automatic", "failed"],
])("maps %s %s", async (status, type, state) => {
  const a = adapter();
  a.post.status = status;
  a.post.schedulingType = type;
  expect(await publish(db, options, a)).toMatchObject({ state });
});
it("reconciles ambiguous create without repeating it", async () => {
  const a = adapter();
  a.provider.create.mockRejectedValueOnce(Error("timed out"));
  a.provider.matches.mockResolvedValueOnce([]);
  expect(await publish(db, options, a)).toMatchObject({
    state: "needs_reconciliation",
  });
  a.provider.matches.mockResolvedValueOnce([]);
  expect(await publish(db, options, a)).toMatchObject({
    state: "needs_reconciliation",
  });
  expect(await reconcile(db, 1, a)).toMatchObject({ state: "published" });
  expect(a.provider.create).toHaveBeenCalledTimes(1);
});
it("persists a status rate-limit deadline", async () => {
  const a = adapter();
  a.provider.read.mockRejectedValueOnce(
    new ProviderError("HTTP 429", Date.now() + 60000),
  );
  expect(await publish(db, options, a)).toMatchObject({
    state: "pending",
    remoteId: "post-1",
  });
  await reconcile(db, 1, a);
  expect(a.provider.read).toHaveBeenCalledTimes(1);
  expect(retryTime("10", 1000)).toBe(11000);
  expect(retryTime("Thu, 01 Jan 1970 00:01:00 GMT", 10)).toBe(60000);
});

it("recovers remote acceptance after the sending process dies before saving the ID", async () => {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "tests/support/crash-after-accept.mjs"],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(86);
  expect(db.prepare("SELECT state,remoteId FROM intents").get()).toMatchObject({
    state: "needs_reconciliation",
    remoteId: null,
  });
  const posts = () =>
    readFileSync(join(dir, "remote.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Post);
  const a = adapter();
  a.provider.matches.mockImplementation(async (_channel, input) =>
    posts().filter((post) => sameAsset(post, input)),
  );
  expect(await publish(db, options, a)).toMatchObject({
    state: "needs_reconciliation",
  });
  db.prepare("UPDATE intents SET inFlightUntil=0").run();
  const other = openDb()!;
  try {
    await Promise.all([publish(db, options, a), publish(other, options, a)]);
  } finally {
    other.close();
  }
  expect(db.prepare("SELECT state,remoteId FROM intents").get()).toMatchObject({
    state: "published",
    remoteId: "post-1",
  });
  expect(posts()).toHaveLength(1);
  expect(a.provider.create).not.toHaveBeenCalled();
});

it("resumes a definitively rate-limited creation only after its cooldown", async () => {
  const a = adapter(),
    now = Date.now();
  a.provider.create.mockRejectedValueOnce(
    new ProviderError("Buffer HTTP 429", now + 60000, true),
  );
  expect(await publish(db, options, a)).toMatchObject({
    state: "ready",
    remoteId: null,
  });
  await expect(publish(db, options, a)).rejects.toThrow("Retry-After");
  expect(a.provider.create).toHaveBeenCalledTimes(1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60001);
  try {
    expect(await publish(db, options, a)).toMatchObject({
      state: "published",
      remoteId: "post-1",
    });
  } finally {
    clock.mockRestore();
  }
  expect(a.provider.create).toHaveBeenCalledTimes(2);
});

it("persists claims across restart and never recreates an ambiguous post", async () => {
  const a = adapter();
  a.provider.create.mockRejectedValueOnce(Error("connection lost"));
  a.provider.matches.mockResolvedValue([]);
  const first = await publish(db, options, a);
  expect(first.state).toBe("needs_reconciliation");
  db.close();
  db = openDb()!;
  await publish(db, options, a);
  expect(a.provider.create).toHaveBeenCalledOnce();
  a.post.assets = [{ source: a.assetUrl() }];
  expect(await reconcile(db, 1, a, "post-1")).toMatchObject({
    state: "published",
    remoteId: "post-1",
  });
});
it("reserves the cap atomically and checks auto-off before creation", async () => {
  db.prepare("INSERT INTO policy(session,source,channel,cap) VALUES(?,?,?,?)").run(
    "stream",
    "source",
    "test",
    1,
  );
  const a = adapter();
  const auto = { session: "stream", source: "source" };
  await publish(db, { ...options, auto }, a);
  await expect(
    publish(
      db,
      {
        ...options,
        path: "tests/fixtures/cut-vertical.mp4",
        highlight: "second",
        auto,
      },
      a,
    ),
  ).rejects.toThrow("cap");
  expect(a.provider.create).toHaveBeenCalledOnce();
  db.prepare("UPDATE policy SET cap=2").run();
  a.host.mockImplementationOnce(async () => {
    db.exec("DELETE FROM policy");
  });
  expect(
    await publish(
      db,
      {
        ...options,
        path: "tests/fixtures/cut-vertical.mp4",
        highlight: "second",
        auto,
      },
      a,
    ),
  ).toMatchObject({ state: "ready" });
  expect(a.provider.create).toHaveBeenCalledOnce();
});
it("keeps fixtures and invalid video input away from live transport", async () => {
  await expect(publish(db, options)).rejects.toThrow("Fixture assets");
  const a = adapter();
  await expect(
    publish(db, { ...options, path: "tests/fixtures/recording.mp4" }, a),
  ).rejects.toThrow("portrait");
  expect(a.provider.channel).not.toHaveBeenCalled();
});
