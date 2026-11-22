import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureStatus,
  setCaptureLimit,
  claimCaptureSlot,
} from "../src/capture-slots.ts";
import { gtaBroadcast, preferredCaptures, roster } from "../src/watchlist.ts";
import { manifest } from "../src/live.ts";
import { providerStatus } from "../src/providers.ts";
import { SceneCaption, sceneOptions, clipCues } from "../src/editorial.ts";
const now = Date.now(),
  at = new Date(now).toISOString();
function person(key: string, viewers: number | null, platform = "kick") {
  const url =
    platform === "twitch"
      ? "https://www.twitch.tv/" + key
      : "https://kick.com/" + key;
  return {
    key,
    name: key,
    channels: [{ url, id: key }],
    evidence: { source: url, at, title: "GTA VI", viewers },
    samples: [1, 2, 3].map((t) => ({
      url,
      atMs: t * 12000,
      note: "Reviewer heard commentary",
      speaker: "streamer-en",
    })),
  };
}
afterEach(() => vi.unstubAllEnvs());
it("shares the two OS-backed capture slots across independent coordinators and releases on close", () => {
  const directory = mkdtempSync(join(tmpdir(), "hypeclip-slots-"));
  const first = claimCaptureSlot(directory),
    second = claimCaptureSlot(directory);
  try {
    expect(() => claimCaptureSlot(directory)).toThrow("occupied");
    first();
    const next = claimCaptureSlot(directory);
    try {
      expect(() => claimCaptureSlot(directory)).toThrow("occupied");
    } finally {
      next();
    }
  } finally {
    second();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("uses the actual game category ahead of a title announcing later GTA gameplay", () => {
  expect(gtaBroadcast("Finishing GTA 6 later", ["Just Sleeping"])).toBe(false);
  expect(gtaBroadcast("Day three", ["Grand Theft Auto VI (GTA)"])).toBe(true);
  expect(gtaBroadcast("GTA 6 playthrough")).toBe(true);
});
it("deduplicates simulcasts and stable-ID aliases; exclusions apply across aliases", () => {
  const a = person("first", null),
    b = person("second", 20),
    alias = {
      ...a,
      key: "alias",
      channels: [...a.channels, { id: "88", url: "https://www.twitch.tv/one" }],
    };
  const raw = {
    creators: [a, b, alias],
    pins: ["alias"],
    additions: ["second"],
  };
  const saved = JSON.stringify(raw);
  const r = roster(raw, {}, now);
  expect(r.watch.map((c) => c.key)).toEqual(["first", "second"]);
  expect(r.watch[0].channels).toHaveLength(2);
  expect(r.watch[0].evidence?.viewers).toBeNull();
  expect(
    roster({ ...raw, exclusions: ["first"] }, {}, now).watch.map((c) => c.key),
  ).toEqual(["second"]);
  expect(JSON.stringify(raw)).toBe(saved);
});
it("keeps only audible words within a new trim and grounds optional scene text in earlier speech", () => {
  const words = [
    { text: "Let me", startMs: 0, endMs: 220, probability: 0.98 },
    { text: "find", startMs: 240, endMs: 400, probability: 0.96 },
    { text: "the keys.", startMs: 460, endMs: 760, probability: 0.99 },
  ];
  const segments = [{ startMs: 0, endMs: 760, text: "Let me find the keys." }];
  const speech = {
    segments,
    words,
    quiet: [],
    captions: segments,
    hasAudio: true,
  };
  expect(sceneOptions(speech, 900)[0].text).toBe("Looking for the keys");
  expect(sceneOptions(speech, 450)).toEqual([]);
  expect(
    sceneOptions(
      { ...speech, words: words.map((w) => ({ ...w, probability: 0.6 })) },
      900,
    ),
  ).toEqual([]);
  expect(clipCues(segments, 220, 800, words)[0].text).toBe("find the keys.");
});
it("selects two globally, gives an eligible live pin priority and keeps game-only language for review", () => {
  const creators = [
    person("a", 2),
    person("b", 20, "twitch"),
    person("c", 200),
    person("d", 800),
  ];
  creators[3].samples.forEach((s) => (s.speaker = "game"));
  const cache = Object.fromEntries(
    creators.map((c) => [
      (c.channels[0].url.includes("twitch") ? "twitch" : "kick") + ":" + c.key,
      {
        next: now + 90000,
        failures: 0,
        value: { ...c.evidence, live: true, gta: true, broadcastId: c.key },
      },
    ]),
  );
  const raw = { creators, pins: ["a", "d"] };
  const { watch } = roster(raw, cache, now);
  expect(preferredCaptures(watch, "review").map((c) => c.creator)).toEqual([
    "a",
    "c",
  ]);
  cache["kick:a"].value.gta = false;
  expect(
    preferredCaptures(roster(raw, cache, now).watch, "review").map(
      (c) => c.creator,
    ),
  ).toEqual(["c", "b"]);
  expect(preferredCaptures(watch)).toEqual([]);
  expect(
    manifest.safeParse({
      sources: [1, 2, 3].map((i) => ({
        id: String(i),
        port: 2200 + i,
        chat: i + ".jsonl",
        rights: true,
        destination: "local-review",
      })),
    }).success,
  ).toBe(false);
});
it("continues reporting providers with secrets absent and keeps credentials out of status", async () => {
  for (const k of [
    "TWITCH_USER_TOKEN",
    "YOUTUBE_ACCESS_TOKEN",
    "YOUTUBE_API_KEY",
  ])
    vi.stubEnv(k, "");
  vi.stubEnv("BUFFER_ACCESS_TOKEN", "private-value");
  const rows = await providerStatus();
  expect(rows).toHaveLength(4);
  expect(rows[0].liveChat).toContain("missing");
  expect(rows[2].liveChat).toContain("Public player");
  expect(rows[3].liveChat).toContain("unsupported");
  expect(JSON.stringify(rows)).not.toContain("private-value");
});
it("bounds the independent upper caption interval and position", () => {
  expect(SceneCaption.parse({ text: "At the hoop" })).toEqual({
    text: "At the hoop",
    startMs: 0,
    endMs: 2500,
    panelY: 0.86,
  });
  expect(SceneCaption.safeParse({ text: "two\nlines" }).success).toBe(false);
  expect(
    SceneCaption.safeParse({ text: "Here", startMs: 2000, endMs: 1000 })
      .success,
  ).toBe(false);
});

it("enforces shared broadcast ownership and a configurable machine limit in a second process", async () => {
  const { execFileSync } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "hc-second-client-"));
  const held = claimCaptureSlot(directory, "kick:session");
  try {
    setCaptureLimit(1, directory);
    expect(() => setCaptureLimit(0, directory)).toThrow();
    const script = `import {claimCaptureSlot} from "./src/capture-slots.ts";
      for(const key of ["kick:session","twitch:other"]){try{const free=claimCaptureSlot(process.argv[1],key);free();console.log("unexpected")}catch(e){console.log(e.message)}}`;
    const output = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
        directory,
      ],
      { encoding: "utf8" },
    );
    expect(output).toContain("already being captured");
    expect(output).toContain("occupied");
    expect(captureStatus(directory).active).toHaveLength(1);
  } finally {
    held();
    rmSync(directory, { recursive: true, force: true });
  }
});
