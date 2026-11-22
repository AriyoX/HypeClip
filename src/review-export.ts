import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MachineStageBudget } from "./stages.ts";
import { registerExport } from "./library.ts";
import { openDb } from "./db.ts";
import { jsonFile, writeJson, hashFile, stateDir } from "./local.ts";
import { probe } from "./probe.ts";
import {
  LayoutMode,
  Dialogue,
  Crop,
  chooseLayout,
  SceneCaption,
  SplitScreen,
  clipCues,
} from "./editorial.ts";
import { render, validateOutput, type Request } from "./worker.ts";
import { z } from "zod";

export const EditSettings = z.strictObject({
  layoutMode: LayoutMode.optional(),
  dialogue: Dialogue.optional(),
  subtitleY: z.number().min(0.6).max(0.86).optional(),
  gameplayCrop: Crop.nullable().optional(),
  narration: z.enum(["off", "auto"]).optional(),
  sceneCaption: SceneCaption.nullable().optional(),
  splitScreen: SplitScreen.optional(),
  postCaption: z.string().trim().min(1).max(400).optional(),
  note: z.string().max(800).optional(),
  languageReview: z.string().trim().min(5).max(1600).optional(),
  trim: z
    .strictObject({
      fromMs: z.number().int().nonnegative(),
      toMs: z.number().int().positive(),
    })
    .optional(),
  words: z
    .array(
      z.strictObject({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        text: z.string().trim().min(1).max(80),
      }),
    )
    .max(500)
    .optional(),
});

async function audioSamples(
  ff: string,
  path: string,
  startMs: number,
  durationMs: number,
) {
  const { stdout } = await promisify(execFile)(
    ff,
    [
      "-v",
      "error",
      "-ss",
      (startMs / 1000).toFixed(3),
      "-i",
      path,
      "-t",
      (durationMs / 1000).toFixed(3),
      "-map",
      "0:a:0",
      "-vn",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { encoding: "buffer", windowsHide: true, maxBuffer: 3000000 },
  );
  const bins: number[] = [];
  for (let p = 0; p + 160 <= stdout.length; p += 160) {
    let energy = 0;
    for (let i = p; i < p + 160; i += 2) energy += stdout.readInt16LE(i) ** 2;
    bins.push(Math.sqrt(energy / 80));
  }
  return bins;
}
function audioAgreement(a: number[], b: number[]) {
  if (!a.length || !b.length) throw Error("Missing decoded audio samples");
  if (a.every((x) => x < 4) && b.every((x) => x < 4)) return { silence: true };
  let correlation = -1,
    offsetMs = 0;
  for (let lag = -15; lag <= 15; lag++) {
    let x = 0,
      y = 0,
      xx = 0,
      xy = 0,
      yy = 0,
      n = 0;
    for (
      let i = Math.max(0, -lag);
      i < Math.min(a.length, b.length - lag);
      i++
    ) {
      const u = a[i],
        v = b[i + lag];
      x += u;
      y += v;
      xx += u * u;
      yy += v * v;
      xy += u * v;
      n++;
    }
    const value =
      (xy - (x * y) / n) / Math.sqrt((xx - (x * x) / n) * (yy - (y * y) / n));
    if (value > correlation) {
      correlation = value;
      offsetMs = lag * 10;
    }
  }
  return { correlation, offsetMs };
}
export async function exportJob(
  id: string,
  target: string,
  name = id,
  previewMs?: number,
  editFile?: string,
  addToLibrary = true,
) {
  if (!/^[a-z0-9][a-z0-9_-]{0,70}$/i.test(name))
    throw Error("Use a simple export folder name");
  const db = openDb(true);
  if (!db) throw Error("No local jobs");
  const job = (() => {
    try {
      return db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    } finally {
      db.close();
    }
  })();
  if (!job?.result) throw Error("A rendered clip ID is required");
  const details = JSON.parse(String(job.details));
  if (!details.editorial)
    throw Error("Choose a monitor edit with source metadata");
  let result = JSON.parse(String(job.result));
  const dir = details.request.candidate.outputDir;
  const edit = jsonFile(join(dir, "edit.json")),
    source = jsonFile(
      join(stateDir(), "sources", String(job.session), "source.json"),
    );
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  const destination = join(root, name);
  if (existsSync(destination))
    throw Error("Export already exists: " + destination);
  const temp = mkdtempSync(join(root, ".export-"));
  const ff = process.env.HYPECLIP_FFMPEG || "ffmpeg";
  const run = promisify(execFile);
  try {
    if (editFile) {
      const settings = EditSettings.parse(jsonFile(editFile));
      const req = jsonFile(join(dir, "request.json")) as Request;
      if (!req.output.speech) throw Error("This job has no saved speech pass");
      edit.firstPass = {
        decision: edit.evaluation,
        selection: edit.selection,
        sceneCaption: edit.sceneCaption ?? null,
        sha256: result.sha256,
        fromMs: edit.fromMs,
        toMs: edit.toMs,
      };
      const savedSpeech = () => {
        const files = readdirSync(dir).filter((s) =>
          /^speech-[\da-f]+\.json$/.test(s),
        );
        const path =
          edit.analysis ??
          (files.length === 1 ? join(dir, files[0]) : undefined);
        if (!path)
          throw Error("Saved analysis for this reservation is unavailable");
        return jsonFile(path);
      };
      if (
        (settings.dialogue === "words" ||
          settings.splitScreen?.captions === "words") &&
        !req.output.speech.words &&
        !settings.words &&
        !req.output.speech.withheld
      ) {
        const base = edit.fromMs - edit.selection.reserved[0],
          duration = edit.toMs - edit.fromMs;
        const timed: {
          startMs: number;
          endMs: number;
          text: string;
          probability: number;
        }[] = savedSpeech().words ?? [];
        req.output.speech.words = timed
          .filter(
            (w) =>
              w.probability >= 0.85 &&
              w.startMs >= base &&
              w.endMs <= base + duration,
          )
          .map((w) => ({
            startMs: w.startMs - base,
            endMs: w.endMs - base,
            text: w.text,
          }));
      }
      if (settings.trim) {
        const { fromMs, toMs } = settings.trim,
          [a, b] = edit.selection.reserved;
        const archive =
          source.status === "archive" &&
          source.media === "local replay" &&
          details.request.candidate.startMs === a;
        const availableEnd = archive
          ? (await probe(req.candidate.sourcePath)).durationMs
          : b;
        if (
          fromMs < (archive ? 0 : a) ||
          toMs > availableEnd ||
          toMs - fromMs > 90000 ||
          fromMs > edit.payoffMs ||
          toMs <= edit.payoffMs ||
          req.output.voice
        )
          throw Error(
            "Keep the detected event inside a cut of at most 90 seconds from retained unvoiced media",
          );
        const speech = savedSpeech(),
          start = fromMs - a,
          end = toMs - a;
        req.candidate.startMs = details.request.candidate.startMs + start;
        req.candidate.endMs = details.request.candidate.startMs + end;
        req.output.speech.segments = clipCues(
          speech.segments,
          start,
          end,
          speech.words,
        );
        req.output.speech.captions = clipCues(
          speech.captions,
          start,
          end,
          speech.words,
        );
        req.output.speech.words = (req.output.speech.words ?? [])
          .map((w) => ({
            ...w,
            startMs: w.startMs + edit.fromMs - fromMs,
            endMs: w.endMs + edit.fromMs - fromMs,
          }))
          .filter((w) => w.startMs >= 0 && w.endMs <= toMs - fromMs);
        edit.fromMs = fromMs;
        edit.toMs = toMs;
      }
      if (settings.words) {
        req.output.speech.words = settings.words;
        req.output.speech.withheld = false;
        edit.subtitleReview = undefined;
      }
      const profile =
        settings.splitScreen ??
        req.output.splitScreen ??
        details.editorial.settings.splitScreen;
      const mode = settings.layoutMode ?? (profile?.facecam ? "split" : "auto");
      const layout = await chooseLayout(
        req.candidate.sourcePath,
        req.candidate.startMs,
        req.candidate.endMs,
        source.channel,
        mode,
        profile,
      );
      const split = layout.split;
      const pref = settings.dialogue ?? profile?.captions ?? "auto";
      const dialogue =
        pref === "auto"
          ? (edit.rawDecision?.subtitleTreatment ??
            edit.evaluation?.decision?.subtitleTreatment ??
            "clean")
          : pref;
      if (
        dialogue === "words" &&
        !settings.words &&
        !req.output.speech.words?.length
      ) {
        const offset = edit.fromMs - edit.selection.reserved[0];
        req.output.speech.words = (savedSpeech().words ?? [])
          .filter((w: { probability: number }) => w.probability >= 0.7)
          .filter(
            (w: { startMs: number; endMs: number }) =>
              w.startMs >= offset &&
              w.endMs <= offset + edit.toMs - edit.fromMs,
          )
          .map((w: { startMs: number; endMs: number; text: string }) => ({
            startMs: w.startMs - offset,
            endMs: w.endMs - offset,
            text: w.text,
          }));
      }
      const scene =
        settings.sceneCaption === undefined
          ? req.output.sceneCaption
          : settings.sceneCaption;
      if (scene && scene.endMs > edit.payoffMs - edit.fromMs)
        throw Error("Clear the scene caption before the payoff");
      req.output.sceneCaption = scene ?? undefined;
      req.output.layout = split ? "split-screen" : "fit-pad";
      req.output.overlay = undefined;
      req.output.splitScreen = split
        ? { ...split, captions: dialogue }
        : undefined;
      req.output.presentation = {
        dialogue,
        subtitleY:
          settings.subtitleY ?? req.output.presentation?.subtitleY ?? 0.77,
        gameplayCrop: split
          ? undefined
          : (settings.gameplayCrop ??
            req.output.presentation?.gameplayCrop ??
            (mode === "gameplay" ? profile?.gameplay : undefined)),
      };
      if (settings.narration === "off") {
        req.output.voice = undefined;
        edit.voiceSlot = null;
        edit.narration = "off";
      } else if (settings.narration === "auto" && !req.output.voice) {
        edit.narration =
          "Original audio; no approved essential line and quiet interval in the saved decision";
      }
      edit.presentation = req.output.presentation;
      edit.layout = {
        mode,
        chosen: split ? "Facecam + gameplay" : "Gameplay only",
        reason: layout.reason,
        confidence: layout.confidence,
      };
      edit.override = "Operator presentation edit";
      req.candidate.outputDir = join(temp, ".render");
      const budget = new MachineStageBudget();
      result = await render(req, (stage) => budget.acquire(stage));
      await validateOutput(req, result);
      edit.overlay = "";
      edit.manualEdit = settings.note ?? "Local export settings override";
      edit.languageReview = settings.languageReview;
      edit.splitScreen = split;
      edit.sceneCaption = scene ?? null;
      edit.caption = settings.postCaption ?? edit.caption;
    }
    writeJson(join(temp, "edit-settings.json"), {
      ...(editFile ? EditSettings.parse(jsonFile(editFile)) : {}),
      sceneCaption: edit.sceneCaption ?? null,
      splitScreen: edit.splitScreen,
      layoutMode: edit.layout?.mode,
      dialogue: edit.presentation?.dialogue,
      subtitleY: edit.presentation?.subtitleY,
      gameplayCrop: edit.presentation?.gameplayCrop,
      postCaption: edit.caption,
    });
    writeJson(join(temp, "origin.json"), { state: stateDir(), id });
    const filename = edit.splitScreen ? name + ".mp4" : "highlight.mp4";
    for (const [from, to] of [
      [result.verticalPath, filename],
      [result.subtitlePath, "subtitles.srt"],
      [result.transcriptPath, "transcript.json"],
    ])
      copyFileSync(from, join(temp, to));
    writeFileSync(join(temp, "overlay.txt"), edit.overlay || "", "utf8");
    writeFileSync(join(temp, "post-caption.txt"), edit.caption + "\n", "utf8");
    if (edit.splitScreen || edit.presentation) {
      copyFileSync(
        join(dirname(result.verticalPath), "subtitles.ass"),
        join(temp, "subtitles.ass"),
      );
      if (edit.splitScreen)
        writeJson(join(temp, "crop-settings.json"), edit.splitScreen);
    }
    const video = join(temp, filename),
      media = await probe(video, true);
    if ((await hashFile(video)) !== result.sha256)
      throw Error("MP4 digest mismatch");
    await run(
      ff,
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        video,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-f",
        "null",
        "-",
      ],
      { windowsHide: true, timeout: 180000 },
    );
    await run(
      ff,
      [
        "-v",
        "error",
        "-ss",
        String(Math.max(0, (edit.payoffMs - edit.fromMs) / 1000)),
        "-i",
        video,
        "-frames:v",
        "1",
        "-vf",
        "scale=432:768",
        "-q:v",
        "2",
        join(temp, "payoff.jpg"),
      ],
      { windowsHide: true, timeout: 30000 },
    );
    if (!existsSync(join(temp, "payoff.jpg")))
      throw Error("Could not decode the payoff frame");
    if (edit.splitScreen) {
      const at = previewMs ?? edit.payoffMs - edit.fromMs;
      if (!Number.isInteger(at) || at < 0 || at >= media.durationMs)
        throw Error("Preview timestamp must fall inside the clip");
      await run(
        ff,
        [
          "-v",
          "error",
          "-ss",
          (at / 1000).toFixed(3),
          "-i",
          video,
          "-frames:v",
          "1",
          "-q:v",
          "2",
          join(temp, "preview.jpg"),
        ],
        { windowsHide: true },
      );
      if (!existsSync(join(temp, "preview.jpg")))
        throw Error("Could not decode the preview");
      edit.previewMs = at;
    }
    const stills: Record<string, number> = {
      "opening.jpg": 0,
      "ending.jpg": Math.max(0, media.durationMs - 100),
    };
    if (edit.sceneCaption) {
      const { startMs, endMs } = edit.sceneCaption;
      stills["scene-visible.jpg"] = Math.floor((startMs + endMs) / 2);
      stills["scene-cleared.jpg"] = Math.min(
        endMs + 200,
        media.durationMs - 70,
      );
    }
    for (const [name, ms] of Object.entries(stills)) {
      await run(
        ff,
        [
          "-v",
          "error",
          "-ss",
          String(ms / 1000),
          "-i",
          video,
          "-frames:v",
          "1",
          "-q:v",
          "2",
          join(temp, name),
        ],
        { windowsHide: true },
      );
      if (!existsSync(join(temp, name))) throw Error("Missing scene preview");
    }
    edit.scenePreviewMs = stills;
    const { stdout } = await run(
      process.env.HYPECLIP_FFPROBE || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels",
        "-of",
        "json",
        video,
      ],
      { windowsHide: true },
    );
    const audio = JSON.parse(stdout).streams[0] ?? null;
    const capture = captureInfo(String(job.session));
    const req = details.request.candidate,
      config = JSON.parse(String(capture.config));
    const sourcePath = config.file || req.sourcePath;
    const startMs = config.file
      ? edit.fromMs
      : req.startMs + edit.fromMs - details.spike.startMs;
    const sourceProbe = await run(
      process.env.HYPECLIP_FFPROBE || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        sourcePath,
      ],
      { windowsHide: true },
    );
    if (Boolean(sourceProbe.stdout.trim()) !== Boolean(audio))
      throw Error("Original audio track presence changed");
    let comparison;
    if (audio) {
      const a = await audioSamples(ff, sourcePath, startMs, media.durationMs);
      const b = await audioSamples(ff, video, 0, media.durationMs);
      const slot = edit.voiceSlot;
      const outsideVoice = (_level: number, index: number) =>
        index * 10 < slot.startMs - 200 || index * 10 > slot.endMs + 200;
      comparison = slot
        ? audioAgreement(a.filter(outsideVoice), b.filter(outsideVoice))
        : audioAgreement(a, b);
      if (
        comparison.correlation !== undefined &&
        (comparison.correlation < 0.8 || Math.abs(comparison.offsetMs!) > 60)
      )
        throw Error(
          "Source audio could not be verified (correlation " +
            comparison.correlation.toFixed(3) +
            ")",
        );
    }
    const anchor = capture.anchor;
    const broadcastUrl =
      source.platform === "kick" &&
      source.archiveOffsetMs != null &&
      /^[a-f0-9-]{36}$/i.test(source.broadcastId)
        ? "https://kick.com/" +
          encodeURIComponent(source.channel.toLowerCase()) +
          "/videos/" +
          source.broadcastId +
          "?t=" +
          Math.floor(((source.archiveOffsetMs ?? 0) + edit.fromMs) / 1000)
        : source.url;
    writeJson(join(temp, "results.json"), {
      ...edit,
      scanFromMs: 0,
      scanToMs: capture.head,
      source: {
        ...source,
        broadcastUrl,
        firstFrameUTC: source.status === "archive" ? source.mediaStart : anchor,
        receiverAnchorUTC: anchor,
        timeBase: "milliseconds from first frame of local capture",
      },
      archiveFromMs:
        source.archiveOffsetMs == null
          ? null
          : source.archiveOffsetMs + edit.fromMs,
      archiveToMs:
        source.archiveOffsetMs == null
          ? null
          : source.archiveOffsetMs + edit.toMs,
      render: media,
      audio,
      sourceAudioComparison: comparison,
      sha256: result.sha256,
      decoded: true,
      qualityFlags: result.qualityFlags,
    });
    if (editFile)
      rmSync(join(temp, ".render"), { recursive: true, force: true });
    renameSync(temp, destination);
    if (addToLibrary) registerExport(destination);
    return destination;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function captureInfo(id: string) {
  const db = openDb(true)!;
  try {
    return db
      .prepare("SELECT anchor,config,head FROM live_sources WHERE id=?")
      .get(id)!;
  } finally {
    db.close();
  }
}
