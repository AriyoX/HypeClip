import { execFileSync } from "node:child_process";
import { monitor } from "../src/monitor.ts";
import { expect, it, vi, afterEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelEdit,
  calibratedSettings,
  Overrides,
  selectCut,
  applyPayoffLine,
  endingEvidence,
  approvedSlot,
  renderNarration,
  prepareEdit,
} from "../src/editorial.ts";
import { traceClaims } from "../src/evidence.ts";
import { questionEnding } from "../src/question-ending.ts";
import { detect, reactions, type Chat } from "../src/detector.ts";
import { fallbackSpike } from "../src/media-only.ts";
import {
  identify,
  kickEvent,
  youtubeEvent,
  resolveFeed,
} from "../src/platforms.ts";
import * as worker from "../src/worker.ts";
import { youtubeChat } from "../src/platforms.ts";

const origin = "2026-11-18T00:00:00Z",
  base = Date.parse(origin);
const airportQuestion = {
  startMs: 38600,
  endMs: 40240,
  text: "Can you go inside the airport?",
};
const airportReply = { startMs: 42820, endMs: 43780, text: "You can't." };
const airportEnding = (
  next: worker.Transcript["segments"],
  available = 55000,
) => questionEnding([airportQuestion, ...next], 22340, 40490, available, 45000);
it("includes the recorded airport reply and only the available pause", () => {
  expect(airportEnding([airportReply])).toMatchObject({
    question: airportQuestion,
    reply: airportReply,
    pauseMs: 450,
    end: 44230,
  });
  expect(
    airportEnding([
      airportReply,
      { startMs: 43880, endMs: 44400, text: "Next." },
    ])?.end,
  ).toBe(43830);
  expect(airportEnding([airportReply], 43780)?.end).toBe(43780);
  expect(airportEnding([airportReply], 43500)?.end).toBe(40490);
});
it("keeps the proposed cut for an unanswered question, including a reply too late to connect", () => {
  expect(airportEnding([])).toMatchObject({ reply: null, end: 40490 });
  expect(
    airportEnding([{ ...airportReply, startMs: 47000, endMs: 48000 }])?.reply,
  ).toBeNull();
});
it("stops at unrelated speech even when a later cue sounds like an answer", () => {
  expect(
    airportEnding([
      { startMs: 40800, endMs: 41850, text: "Yeah, my controller is dead." },
      airportReply,
    ]),
  ).toMatchObject({ reply: null, end: 40490 });
  expect(
    airportEnding([{ startMs: 40800, endMs: 41000, text: "Um." }, airportReply])
      ?.reply,
  ).toEqual(airportReply);
  expect(
    airportEnding([{ ...airportReply, text: "You can't park on my lawn." }])
      ?.reply,
  ).toBeNull();
  expect(
    questionEnding(
      [airportQuestion, airportReply],
      22340,
      40490,
      55000,
      45000,
      [{ ...airportReply, probability: 0.3 }],
    )?.reply,
  ).toBeNull();
});
it("traces every model citation and catches unsupported claims alongside genuine evidence", () => {
  const rows = [
    { id: "S1", kind: "speech" as const, ...airportQuestion },
    {
      id: "C1",
      kind: "chat" as const,
      startMs: 40230,
      text: "arrivals",
      eventAt: origin,
    },
  ];
  const opinion = {
    decision: "accept" as const,
    reason: airportQuestion.text,
    evidence: ["S1", "C1"],
  };
  expect(traceClaims(opinion, rows)).toEqual({
    resolved: rows,
    missing: [],
    issues: [],
  });
  expect(
    traceClaims({ ...opinion, evidence: ["S1", "C8"] }, rows).issues.length,
  ).toBe(1);
  expect(
    traceClaims({ ...opinion, reason: "The HUD shows an aircraft." }, rows)
      .issues.length,
  ).toBe(1);
});
it.each([
  ["Where are we going?", "To the airport.", true],
  ["Where are we going?", "At least we tried.", false],
  ["When is the race?", "Tomorrow.", true],
  ["How many laps?", "Three.", true],
])("checks the form of a short answer to %s", (question, answer, direct) => {
  const result = questionEnding(
    [
      { ...airportQuestion, text: question },
      { ...airportReply, text: answer },
    ],
    22340,
    40490,
    55000,
    45000,
  );
  expect(Boolean(result?.reply)).toBe(direct);
});
function crowd(time: number, texts: string[], one = false): Chat[] {
  return texts.map((text, i) => ({
    eventId: time + "-" + i,
    eventAt: new Date(base + time + i).toISOString(),
    receivedAt: origin,
    userId: one ? "one" : String(i),
    text,
    emotes: [],
    fixture: false,
  }));
}
const laugh = Array(8).fill("LOL"),
  clock = { mediaStart: origin, durationMs: 120000 };
const speech = {
  segments: [],
  captions: [],
  hasAudio: true,
  quiet: [[0, 5000]],
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("distinguishes one spammer, bots, raids and a laughing crowd deterministically", () => {
  expect(detect(crowd(45000, laugh, true), clock)).toEqual([]);
  expect(
    detect(crowd(45000, laugh), {
      ...clock,
      bots: Array.from({ length: 8 }, (_, i) => String(i)),
    }),
  ).toEqual([]);
  expect(detect(crowd(45000, Array(16).fill("W RAID")), clock)).toEqual([]);
  expect(detect(crowd(45000, laugh), clock)[0]).toMatchObject({
    distinctUsers: 8,
    contributions: { reactions: 20 },
  });
});
it("preserves unknown emote activity, scoped glossary and sarcastic counterexamples", () => {
  const rows = crowd(45000, [...laugh, "yeah right /s", "great save"]).map(
    (m) => ({ ...m, emotes: ["123", "Blink"] }),
  );
  const spike = detect(rows, clock)[0];
  const one = reactions(spike, { "123": "laughter" }),
    two = reactions(spike, {});
  expect(one.sample[0].emotes.map((e) => e.meaning)).toEqual([
    "laughter",
    "unknown",
  ]);
  expect(two.counterexamples[0].text).toBe("yeah right /s");
  expect(two.sample).toHaveLength(2);
  expect(two.sample[0].emotes[0].meaning).toBe("unknown");
});
it("keeps calibrated clock, stream latency and human delay separate and reserves near the start", () => {
  const rows = crowd(45000, laugh);
  const a = detect(rows, {
    ...clock,
    offsetMs: 1500,
    latencyMs: 15000,
    reactionMs: 1600,
    preRollMs: 40000,
  })[0];
  const b = detect(rows, { ...clock, latencyMs: 500, reactionMs: 400 })[0];
  expect(a.eventMs).toBe(a.peakMs - 16600);
  expect(a.startMs).toBe(0);
  expect(b.eventMs).toBe(b.peakMs - 900);
  const first = detect(crowd(5100, laugh), { ...clock, reactionMs: 7000 })[0];
  expect(first).toMatchObject({ startMs: 0, eventMs: 0 });
  expect(selectCut(first, ChannelEdit.parse({}), speech)[0]).toBe(0);
});
it("retains the reaction tail and ends at an original speech boundary inside the limit", () => {
  const merged = detect(
    [...crowd(45000, laugh), ...crowd(60000, laugh)],
    clock,
  )[0];
  expect(merged.lastReactionMs).toBeGreaterThan(60000);
  const settings = ChannelEdit.parse({ setupMs: 5000, tailMs: 2500 });
  const boundary = merged.lastReactionMs! - merged.startMs + 2500;
  const [start, end] = selectCut(merged, settings, {
    ...speech,
    segments: [
      { startMs: boundary - 400, endMs: boundary + 800, text: "Done." },
    ],
  });
  expect(end).toBe(boundary + 1050);
  expect(end - start).toBeLessThan(settings.maxClipMs);
  expect(Overrides.parse({ markers: [] })).toEqual({ markers: [] });
});
it("allows exactly an evidenced line in quiet time, runs off without TTS and falls back on failure", async () => {
  const fact = "The timer resets each lap.",
    source = "Reviewed race briefing at 00:12",
    readingConflict =
      "The viewer must track the map and checkpoint timer at the same time.";
  const settings = ChannelEdit.parse({
    narration: "auto",
    context: { fact, source, readingConflict },
  });
  const proposed = {
    line: fact,
    missingContext: fact,
    evidence: source,
    whyTextFails: readingConflict,
    slotStartMs: 500,
    slotEndMs: 3800,
  };
  const slot = approvedSlot(proposed, settings, speech, 5500, "");
  expect(slot).toBeDefined();
  expect(
    approvedSlot(
      { ...proposed, evidence: "chat said so" },
      settings,
      speech,
      5500,
      "",
    ),
  ).toBeUndefined();
  expect(
    approvedSlot(
      proposed,
      settings,
      { ...speech, segments: [{ startMs: 1600, endMs: 2100, text: "Wait!" }] },
      5500,
      "",
    ),
  ).toBeUndefined();
  expect(approvedSlot(proposed, settings, speech, 3000, "")).toBeUndefined();
  const generate = vi.fn(async () => ({ path: "voice.wav", length: 2200 }));
  await renderNarration("off", slot, generate);
  await renderNarration("auto", undefined, generate);
  expect(generate).not.toHaveBeenCalled();
  expect((await renderNarration("auto", slot, generate)).voice).toEqual({
    path: "voice.wav",
    startMs: 500,
  });
  expect(
    (
      await renderNarration("auto", slot, async () => {
        throw Error("missing");
      })
    ).reason,
  ).toContain("unavailable");
  expect(
    (
      await renderNarration("auto", slot, async () => ({
        path: "v",
        length: 5000,
      }))
    ).voice,
  ).toBeUndefined();
});
it.each([
  ["https://twitch.tv/swagg", "twitch"],
  ["https://youtu.be/KY4DWumZffg", "youtube"],
  ["https://kick.com/grootr6", "kick"],
  ["https://www.tiktok.com/@artist/live", "tiktok"],
])("detects %s", (url, p) => expect(identify(url).platform).toBe(p));
it("requires the actual YouTube chat ID and preserves the original publication time", () => {
  const row = {
    id: "m",
    snippet: {
      liveChatId: "youtube-a",
      type: "textMessageEvent",
      publishedAt: origin,
      authorChannelId: "u",
      displayMessage: "hi",
    },
  };
  expect(youtubeEvent(row, "youtube-a", origin)?.eventAt).toBe(origin);
  expect(youtubeEvent(row, "youtube-b", origin)).toBeUndefined();
});
it("authenticates and isolates Kick webhook events and retains emote IDs", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = publicKey.export({ format: "pem", type: "spki" }).toString();
  const body = Buffer.from(
    JSON.stringify({
      message_id: "m",
      broadcaster: { channel_slug: "alice" },
      sender: { user_id: 42 },
      content: "[emote:12:Blink]",
      created_at: origin,
    }),
  );
  const headers = {
    "kick-event-type": "chat.message.sent",
    "kick-event-version": "1",
    "kick-event-message-id": "d",
    "kick-event-message-timestamp": origin,
    "kick-event-signature": sign(
      "sha256",
      Buffer.concat([Buffer.from("d." + origin + "."), body]),
      privateKey,
    ).toString("base64"),
  };
  expect(kickEvent(body, headers, key, "alice", origin)).toMatchObject({
    eventId: "m",
    emotes: ["12", "Blink"],
    eventAt: origin,
  });
  expect(() => kickEvent(body, headers, key, "other", origin)).toThrow();
  expect(() =>
    kickEvent(
      Buffer.concat([body, Buffer.from(" ")]),
      headers,
      key,
      "alice",
      origin,
    ),
  ).toThrow();
});
it("identifies the exact missing authorized feed variable", async () => {
  vi.stubEnv("HC_TEST_URL", "https://example.test/live.m3u8");
  expect(
    await resolveFeed("https://kick.com/example", "HC_TEST_URL"),
  ).toContain("example.test");
  await expect(
    resolveFeed("https://kick.com/example", "HC_TEST_MISSING"),
  ).rejects.toThrow("HC_TEST_MISSING");
});

it("uses page tokens after a transient YouTube failure and ignores other chats", async () => {
  const ctrl = new AbortController(),
    dir = mkdtempSync(join(tmpdir(), "hc-pages-")),
    file = join(dir, "chat.jsonl");
  const item = {
    id: "m",
    snippet: {
      type: "textMessageEvent",
      displayMessage: "LOL",
      publishedAt: origin,
      liveChatId: "chat",
      authorChannelId: "u",
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        items: [{ liveStreamingDetails: { activeLiveChatId: "chat" } }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [item],
        nextPageToken: "page-2",
        pollingIntervalMillis: 1000,
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementationOnce(async () => {
      ctrl.abort();
      return Response.json({ items: [], nextPageToken: "page-3" });
    });
  vi.stubGlobal("fetch", fetcher);
  try {
    const task = youtubeChat("KY4DWumZffg", file, ctrl.signal);
    await task;
    expect(
      fetcher.mock.calls
        .slice(-2)
        .map(([url]) => url.searchParams.get("pageToken")),
    ).toEqual(["page-2", "page-2"]);
  } finally {
    ctrl.abort();
    rmSync(dir, { force: true, recursive: true });
  }
}, 12000);
it("caches bounded decisions by source, window and evidence; sarcastic praise stays in review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-shortlist-")),
    path = join(dir, "reserved.mkv");
  writeFileSync(path, "local analysis fixture");
  vi.stubEnv("HYPECLIP_HOME", dir);
  vi.stubEnv("OLLAMA_MODEL", "test:local");
  vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
  const analyse = vi
    .spyOn(worker, "runWorkerModule")
    .mockImplementation(async (_module, args) => {
      writeFileSync(
        args[1],
        JSON.stringify({
          ...speech,
          segments: [
            { startMs: 30000, endMs: 31200, text: "We finished the lap." },
          ],
          captions: [],
        }),
      );
    });
  const mocked = vi.fn(async () =>
    Response.json({
      done: true,
      message: {
        content: JSON.stringify({
          decision: "accept",
          score: 70,
          reason: "The lap finished.",
          ambiguity: "none",
          evidence: ["We finished the lap."],
          overlay: "The car went airborne",
          suggestedCaption: "Lap complete",
          reviewFlags: [],
          narration: null,
        }),
      },
    }),
  );
  vi.stubGlobal("fetch", mocked);
  const spike = detect(crowd(45000, ["yeah right /s", ...laugh]), clock)[0],
    settings = ChannelEdit.parse({ layoutMode: "gameplay" });
  const info = {
    source: "https://kick.com/a",
    channel: "a",
    settings,
    chatMode: "chat",
  };
  const request: worker.Request = {
    version: 1,
    candidate: {
      candidateId: "one",
      sessionId: "source",
      outputDir: dir,
      sourcePath: path,
      startMs: 0,
      endMs: spike.endMs - spike.startMs,
    },
    output: { width: 1080, height: 1920, layout: "fit-pad" },
  };
  try {
    const result = await prepareEdit(request, spike, info);
    expect(result.evaluation.decision?.decision).toBe("review");
    expect(result.edit.overlay).toBe("");
    await prepareEdit(request, spike, info);
    expect(mocked).toHaveBeenCalledTimes(1);
    await prepareEdit(request, spike, {
      ...info,
      source: "https://kick.com/b",
    });
    expect(mocked).toHaveBeenCalledTimes(2);
    await prepareEdit(request, { ...spike, chat: [] }, info);
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(analyse).toHaveBeenCalledTimes(1);
  } finally {
    analyse.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("prefers each channel's independent measurements over estimates", () => {
  const left = calibratedSettings({
    latencyMs: 15000,
    measurements: {
      evidence: "Clock slate and two viewer samples",
      offsetMs: [-800, -600],
      latencyMs: [2000, 2500, 20000],
      reactionMs: [1200],
    },
  });
  const right = calibratedSettings({
    measurements: {
      evidence: "Second encoder",
      latencyMs: [14000],
      reactionMs: [3200],
    },
  });
  const event = (s: typeof left) =>
    detect(crowd(45000, laugh), { ...clock, ...s })[0].eventMs;
  expect(left).toMatchObject({
    offsetMs: -700,
    latencyMs: 2500,
    reactionMs: 1200,
  });
  expect(event(left) - event(right)).toBe(12800);
});

it.skipIf(!process.env.HYPECLIP_FFMPEG)(
  "shortlists real audio energy through monitor when optional archive chat is absent",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-level-")),
      file = join(dir, "level.mp4"),
      cfg = join(dir, "sources.json");
    vi.stubEnv("HYPECLIP_HOME", join(dir, "state"));
    vi.stubEnv("LOCALAPPDATA", dir);
    const signal = new AbortController(),
      events: Record<string, unknown>[] = [];
    try {
      execFileSync(
        process.env.HYPECLIP_FFMPEG!,
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=size=160x90:rate=10:duration=20",
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=(0.001+0.35*gte(t\\,10))*sin(2*PI*440*t):s=16000:d=20",
          "-g",
          "20",
          "-bf",
          "0",
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          file,
        ],
        { windowsHide: true },
      );
      writeFileSync(
        cfg,
        JSON.stringify({
          sources: [
            {
              url: "https://www.tiktok.com/@fixture/live",
              broadcastId: "audio-fixture",
              channel: "fixture",
              status: "archive",
              file,
              chat: join(dir, "missing.jsonl"),
              localReviewRights: "Original regression fixture",
            },
          ],
        }),
      );
      await monitor([], { config: cfg }, signal.signal, (e) => {
        events.push(e);
        if (e.event === "trigger") signal.abort();
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          platform: "tiktok",
          chat: expect.stringContaining("media only"),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event: "trigger", mode: "audio" }),
      );
      expect(events.some((e) => e.event === "stage-start")).toBe(false);
    } finally {
      signal.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  35000,
);

it("finishes the retained xQc HP remark without delaying silent or unrelated endings", () => {
  // Actual first-pass reservation, initial end and Whisper cue in the saved xQc analysis.
  const spike = {
    ...fallbackSpike("audio", 427917, 457917, 482917),
    mode: "chat" as const,
    lastReactionMs: 469217,
  };
  const cue = {
    startMs: 42480,
    endMs: 51030,
    text: "Oh my god, my HP is tanking though",
  };
  const settings = ChannelEdit.parse({});
  const [, silent] = selectCut(spike, settings, speech);
  expect(silent).toBe(44800);
  const [start, end] = selectCut(spike, settings, {
    ...speech,
    segments: [cue],
  });
  expect(end).toBe(51280);
  // A genuinely separate spoken payoff can also extend a cut, only on an exact grounded recommendation.
  const next = { ...cue, startMs: silent + 1600 };
  const nearby = endingEvidence({ segments: [next] }, silent, 55000);
  expect(applyPayoffLine(null, nearby, start, silent, 55000, 45000)).toBe(
    silent,
  );
  expect(
    applyPayoffLine("another line", nearby, start, silent, 55000, 45000),
  ).toBe(silent);
  expect(applyPayoffLine(next.text, nearby, start, silent, 55000, 45000)).toBe(
    next.endMs + 250,
  );
  expect(endingEvidence({ segments: [next] }, silent, 50000)).toEqual([]);
});
