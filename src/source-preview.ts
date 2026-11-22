import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimCaptureSlot } from "./capture-slots.ts";
import { chooseLayout, calibratedSettings } from "./editorial.ts";
import { acquireInterval } from "./kick-interval.ts";
import { resolveFeed } from "./platforms.ts";
import { writeJson } from "./local.ts";
import { probe } from "./probe.ts";
import { runWorkerModule } from "./worker.ts";
import type { CheckedSource } from "./dashboard-sources.ts";

export async function previewSource(
  source: CheckedSource,
  directory: string,
  options: Parameters<typeof calibratedSettings>[0],
) {
  const set = calibratedSettings(options);
  mkdirSync(directory, { recursive: true });
  let path = source.form.file;
  if (!path) {
    if (source.form.kind !== "url")
      throw Error("Choose an individual source to preview");
    const sample = join(directory, source.id + "-" + source.form.startMinute);
    mkdirSync(sample, { recursive: true });
    path = join(sample, "interval.mp4");
    if (!existsSync(path)) {
      const ms = Math.round(source.form.startMinute * 60000);
      if (source.archive && source.platform === "kick") {
        const spec = join(sample, "selection.json");
        writeJson(spec, { url: source.url, startMs: ms, endMs: ms + 6000 });
        await acquireInterval(
          spec,
          sample,
          "User requested local composition preview",
          true,
        );
      } else {
        const free = claimCaptureSlot(
          undefined,
          source.platform + ":" + source.broadcastId,
        );
        try {
          const feed = await resolveFeed(source.url);
          const tmp = join(sample, randomUUID() + ".mp4");
          await promisify(execFile)(
            process.env.HYPECLIP_FFMPEG || "ffmpeg",
            [
              "-v",
              "error",
              "-nostdin",
              ...(source.archive ? ["-ss", String(ms / 1000)] : []),
              "-i",
              feed,
              "-t",
              "6",
              "-an",
              "-map",
              "0:v:0",
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              tmp,
            ],
            { windowsHide: true, timeout: 45000 },
          );
          const { renameSync } = await import("node:fs");
          renameSync(tmp, path);
        } catch {
          throw Error(
            "Preview unavailable. Check the stream connection or choose a local recording.",
          );
        } finally {
          free();
        }
      }
    }
  }
  const end = Math.min(6000, (await probe(path)).durationMs);
  const layout = await chooseLayout(
    path,
    0,
    end,
    source.name,
    set.layoutMode,
    set.splitScreen,
  );
  const id = randomUUID(),
    file = join(directory, id + ".jpg");
  const presentation = {
    dialogue: "clean",
    subtitleY: set.subtitleY ?? layout.subtitleY ?? 0.77,
    gameplayCrop: layout.split
      ? undefined
      : (set.gameplayCrop ??
        (set.layoutMode === "gameplay"
          ? set.splitScreen?.gameplay
          : undefined)),
  };
  await runWorkerModule("media.layout_preview", [
    path,
    file,
    String(Math.floor(end / 2)),
    JSON.stringify({ split: layout.split, presentation }),
  ]);
  return { id, reason: layout.reason, split: layout.split };
}
