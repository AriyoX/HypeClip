import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Spike } from "./detector.ts";

export function audioRise(history: number[], level: number) {
  const baseline =
    [...history].sort((a, b) => a - b)[Math.floor(history.length / 2)] ?? level;
  const eligible = history.length >= 4 && level > baseline + 8 && level > -36;
  history.push(level);
  if (history.length > 16) history.shift();
  return eligible ? { levelDb: level, baselineDb: baseline } : undefined;
}

export function fallbackSpike(
  mode: "audio" | "operator",
  startMs: number,
  eventMs: number,
  endMs: number,
): Spike {
  return {
    mode,
    startMs,
    endMs,
    eventMs,
    peakMs: eventMs,
    ready: true,
    score: 0,
    contributions: { velocity: 0, distinct: 0, reactions: 0 },
    baseline: 0,
    distinctUsers: 0,
    acceptedMessages: 0,
    chat: [],
  };
}
export async function audioPeak(path: string) {
  // Decode a short, downsampled audio envelope per finalized segment; never invoke AI here.
  try {
    const { stdout } = await promisify(execFile)(
      process.env.HYPECLIP_FFMPEG || "ffmpeg",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
        path,
        "-t",
        "4",
        "-vn",
        "-ar",
        "4000",
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { encoding: "buffer", windowsHide: true, timeout: 6000 },
    );
    let energy = 0;
    for (let i = 0; i + 1 < stdout.length; i += 2)
      energy += (stdout.readInt16LE(i) / 32768) ** 2;
    return stdout.length
      ? 10 * Math.log10(Math.max(1e-10, energy / (stdout.length / 2)))
      : null;
  } catch {
    return null;
  }
}
