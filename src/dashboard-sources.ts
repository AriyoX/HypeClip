import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { discover, identify, chatRequirements, liveChat } from "./platforms.ts";
import { inspectKickArchive } from "./kick-interval.ts";
import { gtaBroadcast, roster } from "./watchlist.ts";
import { jsonFile, safeMessage } from "./local.ts";
import { probe } from "./probe.ts";
import { Overrides } from "./editorial.ts";

export const SourceForm = z.object({
  kind: z.enum(["url", "recording", "watchlist"]),
  url: z.string().trim().max(1200).optional(),
  file: z.string().trim().optional(),
  chat: z.string().trim().optional(),
  mediaStart: z.string().trim().optional(),
  startMinute: z.number().min(0).max(1440).default(0),
  minutes: z.number().min(1).max(60).default(10),
  settings: Overrides.optional(),
  archive: z.boolean().optional(),
});
export type InputForm = z.output<typeof SourceForm>;
export type CheckedSource = Awaited<ReturnType<typeof inspectSource>>;
export function watchRows() {
  return roster(jsonFile("docs/watchlist.json")).watch;
}
const idFor = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export async function inspectSource(raw: unknown) {
  const form = SourceForm.parse(raw);
  const base = {
    form,
    available: true,
    eligible: true,
    archive: false,
    platform: "",
    broadcastId: "",
    title: "",
    media: "",
    chat: "",
    name: "",
    id: "",
    reason: "",
    url: "",
    english: false,
  };
  if (form.kind === "watchlist")
    return {
      ...base,
      id: "watchlist",
      name: "GTA VI watchlist",
      media: "20 ranked creators",
      english: true,
    };
  if (form.kind === "recording") {
    if (
      !form.file ||
      !existsSync(form.file) ||
      !/\.(mp4|mkv|mov|ts|m4v|webm)$/i.test(form.file)
    )
      throw Error("Choose an existing video recording");
    const file = realpathSync(form.file),
      info = await probe(file),
      url = pathToFileURL(file).href;
    if (
      form.chat &&
      (!existsSync(form.chat) ||
        extname(form.chat).toLowerCase() !== ".jsonl" ||
        !Number.isFinite(Date.parse(form.mediaStart ?? "")))
    )
      throw Error(
        "A chat JSONL import needs its first video frame time in UTC",
      );
    const id = idFor(file.toLowerCase());
    return {
      ...base,
      id,
      url,
      broadcastId: id,
      archive: true,
      platform: "local",
      name: basename(file),
      media: `${info.width} × ${info.height} · ${Math.round(info.durationMs / 1000)} s`,
      chat: form.chat ? "Timestamped chat import" : "Media-only detection",
      form: { ...form, file },
    };
  }
  if (!form.url) throw Error("Enter a channel, stream or archive URL");
  const parsed = new URL(
    form.url.startsWith("https://") ? form.url : "https://" + form.url,
  );
  const { platform, handle, video } = identify(parsed.href);
  if (!handle) throw Error("Enter a channel or video URL");
  if (
    (platform === "tiktok" || platform === "youtube") &&
    parsed.pathname.startsWith("/@") &&
    parsed.pathname.split("/").filter(Boolean).length === 1
  )
    parsed.pathname += "/live";
  parsed.hash = "";
  for (const k of [...parsed.searchParams.keys()])
    if (!(platform === "youtube" && k === "v")) parsed.searchParams.delete(k);
  const url = parsed.href.replace(/\/$/, "");
  const kick = platform === "kick" && /\/videos\/[\da-f-]{36}$/i.test(url);
  const archive =
    kick ||
    (platform === "twitch" && parsed.pathname.startsWith("/videos/")) ||
    !!form.archive;
  const known = watchRows().find((r) =>
    r.channels.some(
      (c) =>
        c.url.replace(/\/$/, "").toLowerCase() === url.toLowerCase() ||
        (c.platform === platform &&
          identify(c.url).handle.toLowerCase() === handle.toLowerCase()),
    ),
  );
  const row = {
    ...base,
    url,
    archive,
    platform,
    name: known?.name ?? handle,
    english: !!known?.english,
    id: idFor(platform + ":" + url.toLowerCase()),
    form: { ...form, url },
  };
  try {
    const found = kick ? await inspectKickArchive(url) : await discover(url);
    const broadcastId = found.broadcastId ?? video ?? "";
    const eligible =
      (!found.category || gtaBroadcast(found.title ?? "", [found.category])) &&
      (!("language" in found) ||
        !found.language ||
        /^(en|english)$/i.test(String(found.language)));
    const canChat =
      !archive &&
      !!liveChat(platform, handle, broadcastId, undefined, undefined);
    return {
      ...row,
      name: found.channel ?? row.name,
      broadcastId,
      title: found.title ?? "",
      eligible,
      available: !!broadcastId,
      reason: !eligible
        ? "Current game or broadcast language is ineligible"
        : !broadcastId
          ? "Provider did not resolve a broadcast ID"
          : "",
      id: broadcastId ? idFor(platform + ":" + broadcastId) : row.id,
      media: kick
        ? "Accessible Kick archive"
        : archive
          ? "Streamlink archive"
          : "Live media variants resolved",
      chat: kick
        ? "Replay chat checked at acquisition"
        : canChat
          ? platform === "kick"
            ? "Public player polling"
            : "Reader configured · delivery unverified"
          : "Media-only detection · " +
            (archive
              ? "No replay chat from this adapter"
              : chatRequirements[platform]),
    };
  } catch (e) {
    return {
      ...row,
      available: false,
      media: "No playable media",
      chat: "Unverified",
      reason: safeMessage(e),
    };
  }
}
