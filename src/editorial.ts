import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Decision, chatSchema, type Evaluation } from "./evaluator.ts";
import {
  jsonFile,
  writeJson,
  localModel,
  safeMessage,
  stateDir,
} from "./local.ts";
import {
  workerEnv,
  runWorkerModule,
  type Request,
  type Transcript,
} from "./worker.ts";
import type { Acquire } from "./stages.ts";
import { reactions, type Spike } from "./detector.ts";
import { questionEnding } from "./question-ending.ts";
import {
  assessments,
  evidenceRows,
  sameQuote,
  traceClaims,
} from "./evidence.ts";

const unit = z.number().min(0).max(1);
export const SceneCaption = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1)
      .max(62)
      .regex(/^[^\r\n]+$/),
    startMs: z.number().int().nonnegative().default(0),
    endMs: z.number().int().positive().default(2500),
    panelY: z.number().min(0.08).max(0.92).default(0.86),
  })
  .refine(
    (c) => c.endMs > c.startMs,
    "Scene caption must have positive duration",
  );
export const Crop = z
  .tuple([unit, unit, unit, unit])
  .refine(
    ([x, y, w, h]) => w > 0 && h > 0 && x + w <= 1.000001 && y + h <= 1.000001,
    "Crop must fit inside the displayed source frame",
  );
export const SplitScreen = z
  .strictObject({
    facecam: Crop.optional(),
    gameplay: Crop.optional(),
    hud: Crop.optional(),
    preserveDivider: z.boolean().optional(),
    fraction: z.number().min(0.2).max(0.8).default(0.53),
    captions: z.enum(["auto", "words", "clean"]).default("auto"),
    captionOffset: z.number().int().min(-480).max(480).default(0),
    fontSize: z.number().int().min(24).max(150).default(78),
    outline: z.number().int().min(1).max(16).default(7),
    highlightColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#873BFF"),
  })
  .refine(
    (v) => Boolean(v.facecam) === Boolean(v.gameplay),
    "Supply both panel crops",
  );
const Word = z.strictObject({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1).max(80),
});
export const Marker = z
  .object({
    startMs: z.number().int().nonnegative(),
    payoffMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    observation: z.string().trim().min(1).max(500),
    withholdSpeech: z.string().trim().min(4).max(300).optional(),
    overlay: z.string().trim().max(62).default(""),
    sceneCaption: SceneCaption.nullable().optional(),
    caption: z.string().trim().max(400).optional(),
    words: z.array(Word).max(500).optional(),
    splitScreen: SplitScreen.optional(),
  })
  .refine(
    (m) =>
      m.startMs <= m.payoffMs &&
      m.payoffMs < m.endMs &&
      m.endMs - m.startMs <= 90000,
    "Invalid operator cut",
  );
export const LayoutMode = z.enum(["auto", "gameplay", "split"]);
export const Dialogue = z.enum(["auto", "clean", "words"]);
export const ChannelEdit = z.object({
  layoutMode: LayoutMode.default("auto"),
  dialogue: Dialogue.default("auto"),
  subtitleY: z.number().min(0.6).max(0.86).optional(),
  gameplayCrop: Crop.optional(),
  glossary: z.record(z.string(), z.string().max(80)).default({}),
  bots: z.array(z.string()).default([]),
  offsetMs: z.number().int().min(-120000).max(120000).default(0),
  latencyMs: z.number().int().min(0).max(60000).default(0),
  reactionMs: z.number().int().min(0).max(30000).default(4000),
  calibration: z.string().default("Unmeasured"),
  measurements: z
    .object({
      evidence: z.string().trim().min(1).max(400),
      offsetMs: z
        .array(z.number().int().min(-120000).max(120000))
        .min(1)
        .max(100)
        .optional(),
      latencyMs: z
        .array(z.number().int().min(0).max(60000))
        .min(1)
        .max(100)
        .optional(),
      reactionMs: z
        .array(z.number().int().min(0).max(30000))
        .min(1)
        .max(100)
        .optional(),
    })
    .optional(),
  preRollMs: z.number().int().min(20000).max(40000).default(30000),
  setupMs: z.number().int().min(2000).max(20000).default(7000),
  tailMs: z.number().int().min(1000).max(12000).default(3500),
  maxClipMs: z.number().int().min(10000).max(90000).default(45000),
  narration: z.enum(["off", "auto"]).default("off"),
  voice: z.string().default("am_michael"),
  splitScreen: SplitScreen.optional(),
  sceneDurationMs: z.number().int().min(500).max(6000).default(2500),
  reviews: z.array(Marker).max(200).default([]),
  pace: z.number().min(0.7).max(1.4).default(1),
  // Optional factual context reviewed by the operator. A voice line must match this evidence.
  context: z
    .object({
      fact: z.string().min(4).max(110),
      source: z.string().min(4).max(300),
      readingConflict: z.string().min(12).max(250),
    })
    .optional(),
  markers: z.array(Marker).max(200).default([]),
});
export type Settings = z.infer<typeof ChannelEdit>;
export function calibratedSettings(input: z.input<typeof ChannelEdit>) {
  const settings = ChannelEdit.parse(input),
    measured = settings.measurements;
  if (measured) {
    for (const field of ["offsetMs", "latencyMs", "reactionMs"] as const) {
      const values = measured[field]?.toSorted((a, b) => a - b);
      if (values) {
        const middle = Math.floor(values.length / 2);
        settings[field] = Math.round(
          (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2,
        );
      }
    }
    settings.calibration = measured.evidence;
  }
  return settings;
}
export const Overrides = z.record(z.string(), z.unknown()).transform((raw) => {
  const parsed = ChannelEdit.strict().partial().parse(raw);
  return Object.fromEntries(
    Object.keys(raw).map((k) => [k, parsed[k as keyof Settings]]),
  ) as Partial<Settings>;
});
export type Editorial = {
  watchlist?: boolean;
  source: string;
  channel: string;
  settings: Settings;
  chatMode: string;
};
type Speech = Transcript & {
  words?: (Transcript["segments"][number] & { probability: number })[];
  captions: Transcript["segments"];
  quiet: number[][];
  hasAudio: boolean;
};
const Proposal = z.strictObject({
  line: z.string().max(110),
  missingContext: z.string().max(160),
  evidence: z.string().max(300),
  whyTextFails: z.string().max(250),
  slotStartMs: z.number().int(),
  slotEndMs: z.number().int(),
});
const Opinion = Decision.extend({
  payoffLine: z.string().max(240).nullable().optional(),
  subtitleTreatment: z.enum(["words", "clean"]).optional(),
  evidence: z.array(z.string().max(180)).max(4),
  ambiguity: z.string().max(250),
  overlay: z.string().max(62),
  narration: Proposal.nullable(),
});
const version = "shortlist-v13.1-question-reply";
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function selectCut(spike: Spike, settings: Settings, speech: Speech) {
  const duration = spike.endMs - spike.startMs;
  if (spike.mode === "operator") return [0, duration];
  const event = spike.eventMs - spike.startMs;
  let start = Math.max(0, event - settings.setupMs);
  let end = Math.min(
    duration,
    Math.max(
      event + 2000,
      (spike.lastReactionMs ?? spike.peakMs) - spike.startMs,
    ) + settings.tailMs,
  );
  const opening = speech.segments.find(
    (c) => c.startMs <= start && c.endMs > start,
  );
  if (opening && start - opening.startMs <= 3500) start = opening.startMs;
  const closing = speech.segments.find((c) => c.startMs < end && c.endMs > end);
  if (closing && closing.endMs - end <= 12000)
    end = Math.min(duration, closing.endMs + 250);
  // Keep the estimated payoff in view even when setup exceeds the export budget.
  start = Math.max(start, Math.min(event, end - settings.maxClipMs));
  return [start, Math.min(end, start + settings.maxClipMs)];
}
// Times in this evidence are relative to the first reserved frame, including for live extracts.
export function endingEvidence(
  speech: Transcript,
  end: number,
  available: number,
) {
  return speech.segments
    .filter(
      (s) =>
        s.endMs >= end - 4000 &&
        s.startMs <= end + 6500 &&
        s.endMs <= Math.min(available, end + 12000),
    )
    .slice(0, 12);
}
export function applyPayoffLine(
  line: string | null | undefined,
  nearby: Transcript["segments"],
  start: number,
  end: number,
  available: number,
  maxClip: number,
) {
  const cue =
    line && nearby.find((s) => s.text.trim() === line.trim() && s.endMs > end);
  if (!cue || cue.endMs > start + maxClip || cue.endMs > available) return end;
  return Math.min(available, start + maxClip, cue.endMs + 250);
}
export async function chooseLayout(
  source: string,
  start: number,
  end: number,
  channel: string,
  mode: z.infer<typeof LayoutMode>,
  profile?: Settings["splitScreen"],
) {
  if (mode === "gameplay")
    return {
      reason: "Gameplay only selected",
      confidence: 1,
      split: undefined,
    };
  if (mode === "split") {
    if (!profile?.facecam)
      throw Error("Supply facecam and gameplay crops for the split layout");
    return {
      reason: "Source or clip crop selected",
      confidence: 1,
      split: profile,
    };
  }
  try {
    const { stdout } = await promisify(execFile)(
      process.env.HYPECLIP_PYTHON ||
        resolve(
          ".venv",
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        ),
      [
        "-m",
        "media.layout_check",
        source,
        String(start),
        String(end),
        channel,
        JSON.stringify(profile ?? {}),
      ],
      { windowsHide: true, env: workerEnv(), timeout: 35000 },
    );
    const found = JSON.parse(stdout);
    const split =
      found.facecam && found.gameplay
        ? SplitScreen.parse({
            ...profile,
            facecam: found.facecam,
            gameplay: found.gameplay,
            hud: found.hud ?? profile?.hud,
          })
        : undefined;
    return {
      reason: String(found.reason),
      confidence: found.confidence === "high" ? 1 : 0,
      subtitleY: z
        .number()
        .min(0.75)
        .max(0.8)
        .catch(0.77)
        .parse(found.subtitleY),
      split,
    };
  } catch {
    return {
      reason: "Frame check unavailable; full source retained",
      confidence: 0,
      split: undefined,
    };
  }
}
export function clipCues(
  cues: Transcript["segments"],
  start: number,
  end: number,
  words?: Transcript["segments"],
) {
  return cues
    .filter((c) => c.startMs < end && c.endMs > start)
    .map((c) => ({
      ...c,
      startMs: Math.max(0, c.startMs - start),
      endMs: Math.min(end, c.endMs) - start,
      text:
        (c.startMs < start || c.endMs > end) && words
          ? words
              .filter(
                (w) =>
                  w.startMs >= Math.max(start, c.startMs) &&
                  w.endMs <= Math.min(end, c.endMs),
              )
              .map((w) => w.text)
              .join(" ")
          : c.text,
    }))
    .filter((c) => c.text.trim());
}

// Only offer contexts the speaker explicitly stated in the setup. Selection is
// optional. No text-only inference about a frame, a motive, or the outcome.
export function sceneOptions(speech: Speech, start: number) {
  return speech.segments
    .filter((s) => s.endMs <= start && s.endMs >= start - 18000)
    .flatMap((s) => {
      const words = speech.words?.filter(
        (w) => w.startMs >= s.startMs && w.endMs <= s.endMs,
      );
      if (!words?.length || words.some((w) => w.probability < 0.85)) return [];
      const line = words
        .map((w) => w.text)
        .join(" ")
        .trim();
      const m =
        /^(?:okay,? |alright,? )?(?:I want to|I'm trying to|let me) (find|try|choose|buy|figure out|learn) ([\w' -]{2,38})[.!?]?$/i.exec(
          line,
        );
      if (!m) return [];
      // Speech is a mixed game/stream track, so avoid attributing the line to the streamer.
      const verbs: Record<string, string> = {
        find: "Looking for",
        try: "Trying",
        choose: "Choosing",
        buy: "Buying",
        "figure out": "Figuring out",
        learn: "Learning",
      };
      const text = verbs[m[1].toLowerCase()] + " " + m[2].trim();
      return text.length <= 62
        ? [{ text, source: "explicit spoken setup", evidence: line }]
        : [];
    })
    .slice(-3);
}
export function approvedSlot(
  proposal: z.infer<typeof Proposal> | null,
  settings: Settings,
  speech: Speech,
  payoff: number,
  overlay: string,
) {
  if (
    settings.narration !== "auto" ||
    !proposal ||
    !settings.context ||
    !speech.hasAudio
  )
    return;
  const { fact, source, readingConflict } = settings.context;
  const {
    line,
    missingContext,
    evidence,
    whyTextFails,
    slotStartMs: a,
    slotEndMs: b,
  } = proposal;
  if (
    line !== fact ||
    missingContext !== fact ||
    source !== evidence ||
    whyTextFails !== readingConflict ||
    line === overlay ||
    speech.segments.some(
      (c) =>
        c.text.toLowerCase().includes(line.toLowerCase()) ||
        (c.startMs < b + 300 && c.endMs > a - 300),
    )
  )
    return;
  // Only accept a documented concurrent reading task. A generic preference for voice is insufficient.
  if (
    !/\b(read|reading|watch|track|tracking|follow)\b/i.test(readingConflict) ||
    !/\b(map|timer|HUD|scoreboard|sign|prompt|gauge|checkpoint|subtitle)\b/i.test(
      readingConflict,
    )
  )
    return;
  if (
    a < 0 ||
    b - a < 1200 ||
    b - a > 6000 ||
    b > payoff - 750 ||
    !speech.quiet.some(([s, e]) => a >= s && b <= e)
  )
    return;
  return { line, startMs: a, endMs: b };
}
export async function audition(
  path: string,
  line: string,
  voice: string,
  pace: number,
) {
  const root =
    process.env.HYPECLIP_KOKORO_DIR ||
    join(process.env.LOCALAPPDATA || stateDir(), "HypeClip", "tools", "kokoro");
  const python =
    process.env.HYPECLIP_KOKORO_PYTHON ||
    join(
      root,
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  await promisify(execFile)(
    python,
    [
      "-m",
      "media.voice",
      "--line",
      line,
      "--output",
      resolve(path),
      "--voice",
      voice,
      "--pace",
      String(pace),
    ],
    { windowsHide: true, timeout: 90000 },
  );
}
type Slot = NonNullable<ReturnType<typeof approvedSlot>>;
export async function renderNarration(
  mode: Settings["narration"],
  slot: Slot | undefined,
  generate: (slot: Slot) => Promise<{ path: string; length: number }>,
) {
  if (mode === "off") return { reason: "off" };
  if (!slot)
    return { reason: "text only: no supported essential line and safe slot" };
  try {
    const { path, length } = await generate(slot);
    if (length > 0 && length <= slot.endMs - slot.startMs)
      return { reason: slot.line, voice: { path, startMs: slot.startMs } };
    return { reason: "text only: audition exceeded quiet slot" };
  } catch {
    return { reason: "text only: Kokoro unavailable" };
  }
}
export async function prepareEdit(
  request: Request,
  spike: Spike,
  info: Editorial,
  acquire?: Acquire,
  signal?: AbortSignal,
) {
  const dir = request.candidate.outputDir,
    settings = ChannelEdit.parse(info.settings);
  const stat = statSync(request.candidate.sourcePath);
  const analysis = join(
    dir,
    "speech-" +
      hash([
        request.candidate,
        stat.size,
        stat.mtimeMs,
        process.env.HYPECLIP_WHISPER_MODEL_PATH,
        "small-word-times-v2",
      ]) +
      ".json",
  );
  if (!existsSync(analysis)) {
    const input = join(dir, "analysis-request.json");
    writeJson(input, request);
    await runWorkerModule("media.analysis", [input, analysis], acquire, signal);
  }
  const speech = jsonFile(analysis) as Speech;
  const review = settings.reviews?.find(
    (m) => spike.mode !== "operator" && m.payoffMs === spike.eventMs,
  );
  if (review && (review.startMs < spike.startMs || review.endMs > spike.endMs))
    throw Error("Reviewed trim exceeds the detector reservation");
  const [start, proposedEnd] = review
    ? [review.startMs - spike.startMs, review.endMs - spike.startMs]
    : selectCut(spike, settings, speech);
  const marker =
    review ??
    settings.markers.find(
      (m) =>
        spike.mode === "operator" &&
        m.startMs === spike.startMs &&
        m.endMs === spike.endMs,
    );
  const layout = await chooseLayout(
    request.candidate.sourcePath,
    request.candidate.startMs + start,
    request.candidate.startMs + proposedEnd,
    info.channel,
    marker?.splitScreen?.facecam ? "split" : settings.layoutMode,
    marker?.splitScreen ?? settings.splitScreen,
  );
  const split = layout.split;
  const nearby = endingEvidence(
    speech,
    proposedEnd,
    spike.endMs - spike.startMs,
  );
  const originalSpeech = clipCues(
    speech.segments,
    start,
    proposedEnd,
    speech.words,
  );
  const timed = (speech.words ?? []).filter(
    (w) => w.startMs >= start && w.endMs <= proposedEnd,
  );
  const uncertain = !marker?.words && timed.some((w) => w.probability < 0.7);
  const withheld = marker?.withholdSpeech;
  const segments = withheld ? [] : originalSpeech;
  const payoff = spike.eventMs - spike.startMs - start;
  const quiet = speech.quiet
    .map(([a, b]) => [
      Math.max(0, a - start),
      Math.min(proposedEnd - start, b - start),
    ])
    .filter(([a, b]) => b > a);
  const contexts = sceneOptions(speech, start);
  const safeLine = segments.find((s) => {
    const matched = timed.filter(
      (w) => w.startMs - start >= s.startMs && w.endMs - start <= s.endMs,
    );
    return (
      !withheld &&
      s.text.length <= 110 &&
      matched.length >= 3 &&
      matched.every((w) => w.probability >= 0.85)
    );
  });
  const postOptions = [
    marker?.caption,
    marker?.observation,
    ...contexts.map((c) => c.text),
    safeLine
      ? "Heard on " + info.channel + "’s stream: “" + safeLine.text.trim() + "”"
      : undefined,
    !spike.mode && spike.distinctUsers > 0
      ? info.channel +
        "’s chat picked up here — " +
        spike.distinctUsers +
        " people in the reaction window."
      : undefined,
    info.channel + " stream highlight",
  ].filter((v): v is string => !!v);
  const reliableSegments = uncertain
    ? segments.filter(
        (s) =>
          !timed.some(
            (w) =>
              w.probability < 0.7 &&
              w.startMs - start < s.endMs &&
              w.endMs - start > s.startMs,
          ),
      )
    : segments;
  const audience = reactions(spike, settings.glossary);
  const rows = evidenceRows(reliableSegments, audience, spike.startMs + start);
  const data = {
    mode: spike.mode || "chat",
    transcript: reliableSegments
      .map((s) => s.text)
      .join(" ")
      .slice(0, 2800),
    evidenceRows: rows,
    reasonOptions: assessments,
    reactions: {
      sample: audience.sample.map(({ mediaMs, ...m }) => ({
        ...m,
        startMs: mediaMs - spike.startMs - start,
      })),
      counterexamples: audience.counterexamples.map(({ mediaMs, ...m }) => ({
        ...m,
        startMs: mediaMs - spike.startMs - start,
      })),
    },
    distinct: spike.distinctUsers,
    activityScore: spike.mode && spike.mode !== "chat" ? null : spike.score,
    audioPresent: speech.hasAudio,
    audioRise: spike.audioRise ?? null,
    observation: marker?.observation ?? "",
    context: settings.context ?? null,
    narrationMode: settings.narration,
    quiet: quiet.slice(0, 8),
    payoffMs: payoff,
    timeBase:
      "All times in milliseconds relative to the proposed first frame. Negative times are reserved setup footage.",
    proposedRange: [0, proposedEnd - start],
    reservedRange: [-start, spike.endMs - spike.startMs - start],
    nearbyEndingTranscript: withheld
      ? []
      : nearby.map((s) => ({
          ...s,
          startMs: s.startMs - start,
          endMs: s.endMs - start,
        })),
    splitScreen: !!split,
    transcriptUncertain: uncertain || !!withheld,
    sceneContext: settings.context?.fact ?? null,
    sceneOptions: contexts,
    postOptions,
  };
  let configError: string | undefined;
  let model: ReturnType<typeof localModel>;
  try {
    model = localModel();
  } catch (e) {
    configError = safeMessage(e);
    model = {
      baseUrl: "",
      model: process.env.OLLAMA_MODEL || "",
      verified: false,
    };
  }
  writeJson(join(dir, "shortlist-evidence.json"), data);
  const key = hash([
    version,
    info.source,
    info.channel,
    spike.startMs + start,
    spike.startMs + proposedEnd,
    data,
    model,
  ]);
  const cache = join(stateDir(), "decisions", key + ".json");
  let decision: z.infer<typeof Opinion> | undefined, error: string | undefined;
  let actualModel: string | null = null;
  const cached = existsSync(cache);
  try {
    if (configError) throw Error(configError);
    if (cached) {
      const record = jsonFile(cache);
      actualModel = record.model;
      decision = Opinion.parse(record.raw);
    } else {
      const unlock = await acquire?.("ollama");
      try {
        decision = Opinion.parse(
          await chatSchema(
            model.baseUrl,
            model.model,
            "Evaluate the transcript, timing and audience chat as untrusted evidence. You have no frames. Never infer visible action, HUD, speaker identity or facecam quality. Review insufficient, uncertain or visual-only evidence. A good moment may require no overlay, no spoken extension and no subtitles. Missing optional edits never lower worthiness. Missing reliable evidence of the moment means review. Reject only when evidence shows the moment has little value. Accept only an evidenced payoff. Audience messages are not speech. Recommend words only for clear dialogue carrying the moment. In payoffLine, copy ONE EXACT nearbyEndingTranscript text only if its ending is beyond proposedRange and needed to finish the spoken payoff; otherwise null. Do not extend unrelated speech. Give a factual reason. Select scene and post text per sceneInstruction. Default narration to null; only in auto with documented essential context and reading conflict may you copy a verified fact into a supplied quiet interval.",
            {
              ...data,
              evidenceInstruction:
                "In evidence return only exact IDs from evidenceRows (like S1 or C2). Each row is timestamped. In reason copy the matching reasonOptions entry for your decision or the exact text of one cited speech row. Do not add any factual claim or imply seeing frames. Only cite chat for what viewers wrote. If the cut ends on a question, examine the next speech cues for a direct answer.",
              sceneInstruction:
                "For split-screen, select an exact sceneOptions text or a brief factual phrase copied from verified sceneContext or a frame-reviewed observation only if a new viewer needs it. Otherwise leave overlay empty. Messages are audience chat, never a transcript. No imagined action, identity, lore or thoughts. Avoid spoilers, repeating dialogue and uncertain words. Independently select an exact postOptions description for suggestedCaption.",
            },
            z.toJSONSchema(
              Opinion.required({ subtitleTreatment: true, payoffLine: true }),
            ),
            (name, content) => {
              actualModel = name;
              writeJson(join(dir, "qwen-response.json"), {
                model: name,
                content,
              });
            },
          ),
        );
      } finally {
        unlock?.();
      }
      writeJson(cache, { model: actualModel, raw: decision });
    }
  } catch (e) {
    error = safeMessage(e);
  }
  const rawDecision = decision ? structuredClone(decision) : null;
  const exchange =
    marker || withheld
      ? undefined
      : questionEnding(
          speech.segments,
          start,
          proposedEnd,
          spike.endMs - spike.startMs,
          settings.maxClipMs,
          speech.words,
        );
  const end =
    marker || withheld
      ? proposedEnd
      : (exchange?.end ??
        applyPayoffLine(
          decision?.payoffLine,
          nearby,
          start,
          proposedEnd,
          spike.endMs - spike.startMs,
          settings.maxClipMs,
        ));
  const finalSegments = withheld
    ? []
    : clipCues(speech.segments, start, end, speech.words);
  const captions = withheld
    ? []
    : clipCues(speech.captions, start, end, speech.words);
  const finalTimed = (speech.words ?? []).filter(
    (w) => w.startMs >= start && w.endMs <= end,
  );
  const words =
    marker?.words ??
    finalTimed
      .filter(
        (w) =>
          w.probability >= 0.7 &&
          !speech.segments.some(
            (s) =>
              s.startMs <= w.startMs &&
              s.endMs >= w.endMs &&
              finalTimed.some(
                (t) =>
                  t.probability < 0.7 &&
                  t.startMs >= s.startMs &&
                  t.endMs <= s.endMs,
              ),
          ),
      )
      .map((w) => ({
        startMs: w.startMs - start,
        endMs: w.endMs - start,
        text: w.text,
      }));
  const trace = decision ? traceClaims(decision, rows) : undefined;
  const verifiedCaption =
    decision &&
    postOptions.find((option) => sameQuote(option, decision!.suggestedCaption));
  if (decision && trace) {
    if (
      decision.payoffLine &&
      !(exchange
        ? exchange.reply?.text.trim() === decision.payoffLine.trim()
        : nearby.some(
            (s) =>
              s.text.trim() === decision.payoffLine!.trim() &&
              s.endMs > proposedEnd &&
              s.endMs <=
                Math.min(
                  start + settings.maxClipMs,
                  spike.endMs - spike.startMs,
                ),
          ))
    )
      trace.issues.push("The proposed payoff has no supported later cue");
    if (
      decision.overlay &&
      !contexts.some((c) => c.text === decision!.overlay) &&
      !marker?.observation.includes(decision.overlay) &&
      !settings.context?.fact.includes(decision.overlay)
    )
      trace.issues.push("The proposed scene text lacks verified context");
    if (decision.suggestedCaption && !verifiedCaption)
      trace.issues.push(
        "The proposed description is outside the verified choices",
      );
    if (
      decision.narration &&
      decision.narration.line !== settings.context?.fact
    )
      trace.issues.push("The narration proposal lacks a verified source");
  }
  const evidence =
    trace && trace.issues.length === 0 && trace.resolved.length > 0;
  const sarcastic = data.reactions.counterexamples.some((r) =>
    /\/s\b|yeah[,]? right/i.test(r.text),
  );
  if (
    decision &&
    ((sarcastic && !marker) ||
      !evidence ||
      uncertain ||
      !finalSegments.length ||
      !!decision.reviewFlags.length ||
      (decision.ambiguity &&
        !/^(none|no ambiguity|clear)\.?$/i.test(decision.ambiguity)))
  ) {
    if (
      decision.decision === "accept" ||
      (!data.transcript.trim() && !data.observation.trim()) ||
      !evidence
    )
      decision.decision = "review";
  }
  const quote = decision?.overlay || "";
  const preference =
    settings.dialogue !== "auto"
      ? settings.dialogue
      : (split?.captions ?? "auto");
  const treatment =
    preference === "auto"
      ? (decision?.subtitleTreatment ?? "clean")
      : preference;
  const subtitleReview =
    withheld ||
    (treatment === "words" && uncertain
      ? "Low-confidence Whisper words. Review the draft against the original speech."
      : undefined);
  const proposedScene =
    evidence &&
    decision?.decision === "accept" &&
    quote &&
    (contexts.some((c) => c.text === quote) ||
      marker?.observation.includes(quote) ||
      settings.context?.fact.includes(quote)) &&
    !data.transcript.toLowerCase().includes(quote.toLowerCase())
      ? quote
      : "";
  const scene =
    marker?.sceneCaption === undefined
      ? proposedScene
        ? SceneCaption.parse({
            text: proposedScene,
            endMs: Math.max(
              settings.sceneDurationMs,
              Math.ceil((proposedScene.length / 18) * 1000),
            ),
            panelY: split ? 0.86 : 0.24,
          })
        : null
      : marker.sceneCaption;
  const sceneEnd = scene ? Math.min(scene.endMs, payoff - 200, end - start) : 0;
  const sceneCaption =
    scene && sceneEnd - scene.startMs >= 500
      ? { ...scene, endMs: sceneEnd }
      : null;
  const overlay = "";
  const cut: Request = {
    ...request,
    candidate: {
      ...request.candidate,
      startMs: request.candidate.startMs + start,
      endMs: request.candidate.startMs + end,
    },
    output: {
      ...request.output,
      presentation: {
        dialogue: treatment,
        subtitleY: settings.subtitleY ?? layout.subtitleY ?? 0.77,
        gameplayCrop: !split
          ? (settings.gameplayCrop ??
            (settings.layoutMode === "gameplay"
              ? settings.splitScreen?.gameplay
              : undefined))
          : undefined,
      },
      ...(split && treatment
        ? {
            layout: "split-screen" as const,
            splitScreen: {
              ...split,
              captions: treatment,
            },
          }
        : {}),
      overlay,
      ...(sceneCaption ? { sceneCaption } : {}),
      speech: {
        segments: finalSegments,
        captions,
        words: withheld ? [] : words,
        ...(subtitleReview ? { withheld: true } : {}),
      },
    },
  };
  const slot = approvedSlot(
    decision?.narration ?? null,
    settings,
    { ...speech, segments: originalSpeech, quiet },
    payoff,
    sceneCaption?.text ?? overlay,
  );
  const permitted =
    !error && model.verified && decision?.decision === "accept"
      ? slot
      : undefined;
  const narration = await renderNarration(
    settings.narration,
    permitted,
    async (selected) => {
      const unlock = await acquire?.("whisper");
      try {
        const path = join(dir, "narration.wav");
        await audition(path, selected.line, settings.voice, settings.pace);
        const { stdout } = await promisify(execFile)(
          process.env.HYPECLIP_FFPROBE || "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            path,
          ],
          { windowsHide: true },
        );
        return { path, length: Number(stdout) * 1000 };
      } finally {
        unlock?.();
      }
    },
  );
  if (narration.voice) cut.output.voice = narration.voice;
  const evaluation: Evaluation = {
    provider: "ollama",
    model: model.model,
    verified: model.verified && actualModel === model.model,
    decision,
    error,
  };
  // Captions used outside the model stay attributable to a reviewed observation or a verbatim quote.
  const caption =
    marker?.caption || marker?.observation || verifiedCaption || postOptions[0];
  return {
    cut,
    evaluation,
    edit: {
      source: info.source,
      mode: spike.mode || "chat",
      chat: info.chatMode,
      cacheKey: key,
      evidenceClock: data.timeBase,
      actualModel,
      rawDecision,
      modelResponse: error ? "unavailable" : cached ? "cached" : "ran",
      validatedDecision: decision?.decision ?? "review",
      evidenceTrace: trace,
      validationReason: !decision
        ? error
        : trace?.issues.length
          ? trace.issues.join(". ")
          : decision.decision !== rawDecision?.decision
            ? "Insufficient verified speech or ambiguous evidence"
            : decision.reason,
      override: marker
        ? review
          ? "operator review"
          : "operator marker"
        : settings.layoutMode !== "auto" ||
            settings.dialogue !== "auto" ||
            settings.gameplayCrop
          ? "Saved source presentation settings"
          : null,
      layout: {
        mode: settings.layoutMode,
        chosen: split ? "Facecam + gameplay" : "Gameplay only",
        reason: layout.reason,
        confidence: layout.confidence,
      },
      presentation: cut.output.presentation,
      boundary: {
        reserved: [spike.startMs, spike.endMs],
        proposed: [start + spike.startMs, proposedEnd + spike.startMs],
        nearbyTranscript: nearby.map((c) => ({
          ...c,
          startMs: c.startMs + spike.startMs,
          endMs: c.endMs + spike.startMs,
        })),
        timeBase:
          "All boundaries and nearby transcript times are measured from the first frame of the monitored source",
        recommendation: decision?.payoffLine ?? null,
        exchange: exchange && {
          question: {
            ...exchange.question,
            startMs: spike.startMs + exchange.question.startMs,
            endMs: spike.startMs + exchange.question.endMs,
          },
          reply: exchange.reply && {
            ...exchange.reply,
            startMs: spike.startMs + exchange.reply.startMs,
            endMs: spike.startMs + exchange.reply.endMs,
          },
          pauseMs: exchange.pauseMs,
        },
        applied: end !== proposedEnd,
        reason: exchange?.reply
          ? "Included the timestamped direct reply and the available pause"
          : exchange
            ? "The closing question had no supported direct reply within the available footage"
            : end !== proposedEnd
              ? "Extended to the end of the exact nearby spoken payoff"
              : marker
                ? "Operator cut"
                : "Detector setup and reaction tail, aligned to bounded speech",
        final: [start + spike.startMs, end + spike.startMs],
      },
      analysis,
      promptVersion: version,
      fromMs: spike.startMs + start,
      toMs: spike.startMs + end,
      payoffMs: spike.eventMs,
      selection: {
        peakMs: spike.peakMs,
        eventMs: spike.eventMs,
        reserved: [spike.startMs, spike.endMs],
        score: spike.score,
        contributions: spike.contributions,
        distinctUsers: spike.distinctUsers,
        acceptedMessages: spike.acceptedMessages,
        baseline: spike.baseline,
        audioRise: spike.audioRise,
        trim: review
          ? "operator reviewed detector candidate"
          : marker
            ? "operator marker"
            : "automatic",
      },
      splitScreen: cut.output.splitScreen,
      ...(info.watchlist
        ? {
            compositionReview: layout.reason,
            languageReview:
              "Creator samples are in the source record. Check shortlisted speech against the facecam to attribute the speaker; a silent payoff can qualify.",
          }
        : {}),
      sceneCaption,
      overlay,
      caption,
      narration: narration.reason,
      voiceSlot: narration.voice ? permitted : null,
      subtitleReview: subtitleReview
        ? { reason: subtitleReview, unverifiedDraft: originalSpeech }
        : undefined,
      rationale: marker?.observation || decision?.reason || error,
      calibration: settings.calibration,
      offsetMs: settings.offsetMs,
      latencyMs: settings.latencyMs,
      reactionMs:
        spike.mode === "operator" || spike.mode === "audio"
          ? null
          : settings.reactionMs,
    },
  };
}
