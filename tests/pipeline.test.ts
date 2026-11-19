import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enable,
  processSession,
  processJob,
  runtime,
} from "../src/pipeline.ts";
import type { Session } from "../src/pipeline.ts";
import { openDb } from "../src/db.ts";
import { fixtureResult } from "../src/demo.ts";
import type { Evaluation } from "../src/evaluator.ts";
import { jsonFile } from "../src/local.ts";
import { buffer } from "../src/buffer.ts";
const fixture = jsonFile("tests/fixtures/buffer.json");
const accept: Evaluation = {
  provider: "ollama",
  model: "fixture",
  verified: true,
  decision: {
    decision: "accept",
    score: 91,
    reason: "Clear story",
    suggestedCaption: "Last train",
    reviewFlags: [],
  },
};
let db: NonNullable<ReturnType<typeof openDb>>, dir: string, s: Session;
function adapters() {
  return {
    ...runtime,
    render: vi.fn(fixtureResult),
    evaluate: vi.fn(async () => structuredClone(accept)),
    publisher: {
      ...runtime.publisher,
      assetUrl: () => "https://example.invalid/video",
      host: vi.fn(async () => {}),
      polls: 1,
      provider: {
        channel: async () => fixture.channel,
        create: vi.fn(async () => fixture.post.id),
        read: async () => fixture.post,
        matches: async () => [],
      },
    },
  };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-session-"));
  vi.stubEnv("HYPECLIP_HOME", dir);
  vi.stubEnv("BUFFER_CHANNEL_ID", "test");
  db = openDb()!;
  const source = join(dir, "obs.mp4"),
    chat = join(dir, "chat.jsonl");
  copyFileSync("tests/fixtures/recording.mp4", source);
  writeFileSync(
    chat,
    readFileSync("tests/fixtures/chat.jsonl", "utf8").replaceAll(
      '"fixture":true',
      '"fixture":false',
    ),
  );
  s = {
    session: "stream",
    source,
    chat,
    mediaStart: "2026-01-01T00:00:00Z",
    offsetMs: 0,
    reactionMs: 4000,
    rights: true,
    layout: "fit-pad",
  };
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { force: true, recursive: true });
});
it("flows from an authorized recording into the publisher exactly once", async () => {
  enable(db, s.session, s.source, "test", 1, true);
  const a = adapters();
  expect((await processSession(db, s, a))[0].state).toBe("published");
  await processSession(db, s, a);
  expect(a.publisher.provider.create).toHaveBeenCalledTimes(1);
  expect(a.render).toHaveBeenCalledTimes(1);
});
it.each([
  "quality",
  "rights",
  "fixture",
  "disabled",
  "uncertain",
  "reject",
  "invalid",
])("routes %s locally", async (kind) => {
  const a = adapters();
  if (kind !== "disabled" && kind !== "rights")
    enable(db, s.session, s.source, "test", 1, true);
  s.rights = kind !== "rights";
  s.fixture = kind === "fixture";
  if (kind === "quality" || kind === "invalid")
    a.render.mockImplementation(async (r) => ({
      ...(await fixtureResult(r)),
      qualityFlags: kind === "quality" ? ["low_audio"] : [],
      ...(kind === "invalid" ? { sha256: "0".repeat(64) } : {}),
    }));
  if (kind === "uncertain" || kind === "reject")
    a.evaluate.mockResolvedValue({
      ...accept,
      decision: {
        ...accept.decision!,
        decision: kind === "reject" ? "reject" : "review",
      },
    });
  const [j] = await processSession(db, s, a);
  expect(j.state).toBe(
    kind === "invalid"
      ? "invalid_output"
      : kind === "reject"
        ? "rejected"
        : "review",
  );
  expect(a.publisher.host).not.toHaveBeenCalled();
  expect(a.publisher.provider.create).not.toHaveBeenCalled();
});
it.each([
  "missing token",
  "invalid token",
  "missing model",
  "invalid model output",
])(
  "preserves media and blocks upload with %s in an enabled session",
  async (kind) => {
    enable(db, s.session, s.source, "test", 1, true);
    const a = adapters();
    const fetchMock = vi.fn(async () =>
      kind === "invalid model output"
        ? Response.json({
            done: true,
            message: { content: '{"decision":"accept","score":110}' },
          })
        : new Response(null, { status: kind === "missing model" ? 404 : 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    if (kind.endsWith("token")) {
      vi.stubEnv(
        "BUFFER_ACCESS_TOKEN",
        kind === "missing token" ? "" : "example-token",
      );
      a.publisher.provider.channel = () => buffer.channel("test");
    } else {
      vi.stubEnv("OLLAMA_MODEL", "controlled-test:local");
      vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    }
    const [job] = await processSession(
      db,
      s,
      kind.endsWith("token") ? a : { ...a, evaluate: runtime.evaluate },
    );
    expect(job.state).toBe("review");
    expect(job.reason).toBeTruthy();
    const result = JSON.parse(String(job.result));
    expect(readFileSync(result.verticalPath).length).toBeGreaterThan(0);
    expect(readFileSync(result.subtitlePath).length).toBeGreaterThan(0);
    expect(a.publisher.host).not.toHaveBeenCalled();
    expect(a.publisher.provider.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(kind === "missing token" ? 0 : 1);
  },
);
it("retries evaluation from saved artifacts after local provider failure", async () => {
  const a = adapters();
  a.evaluate.mockResolvedValueOnce({
    provider: "ollama",
    model: "offline",
    error: "unreachable",
  });
  const [j] = await processSession(db, s, a);
  expect(j.state).toBe("review");
  expect(j.result).toBeTruthy();
  enable(db, s.session, s.source, "test", 1, true);
  expect((await processJob(db, String(j.id), a, true)).state).toBe("published");
  expect(a.render).toHaveBeenCalledTimes(1);
});
