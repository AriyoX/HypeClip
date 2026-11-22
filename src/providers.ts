import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { streamlink } from "./platforms.ts";
import { identity } from "./twitch.ts";
import { workerEnv } from "./worker.ts";

export function streamlinkVersion() {
  return promisify(execFile)(streamlink(), ["--version"], {
    timeout: 8000,
    windowsHide: true,
    env: workerEnv(),
  })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
}

export async function providerStatus(check = false) {
  const version = await streamlinkVersion();
  let twitch = process.env.TWITCH_USER_TOKEN
    ? "configured, unverified"
    : "missing TWITCH_USER_TOKEN";
  if (check && process.env.TWITCH_USER_TOKEN) {
    try {
      await identity(process.env.TWITCH_USER_TOKEN);
      twitch = "validated user:read:chat; delivery unverified";
    } catch {
      twitch = "configured, validation failed";
    }
  }
  return providerRows(version, twitch);
}

export function providerRows(
  version: string | null,
  twitch = process.env.TWITCH_USER_TOKEN
    ? "configured, unverified"
    : "missing TWITCH_USER_TOKEN",
) {
  const media = version ? "configured " + version : "missing Streamlink";
  const yt =
    process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN
      ? "configured, delivery unverified"
      : "missing YouTube reader credential";
  return [
    {
      platform: "Twitch",
      discovery: "Public lookup / Helix with token",
      liveMedia: media,
      liveChat: twitch,
      archiveMedia: "local file; authorized VOD via Streamlink",
      replayChat: "original JSONL import",
    },
    {
      platform: "YouTube",
      discovery: "Public live page / videos.list with key or token",
      liveMedia: media,
      liveChat: yt,
      archiveMedia: "public file or creator download",
      replayChat: "original JSONL import; no Data API replay",
    },
    {
      platform: "Kick",
      discovery: "Public category and channel API",
      liveMedia: media,
      liveChat: "Public player polling; webhook delivery unverified",
      archiveMedia: "public VOD interval / downloadable clip",
      replayChat: "public VOD messages / JSONL",
    },
    {
      platform: "TikTok",
      discovery: "Known @handle/live; directory unsupported",
      liveMedia: media + "; room availability unverified",
      liveChat: "native connector unsupported",
      archiveMedia: "creator file",
      replayChat: "creator JSONL only",
    },
  ];
}
