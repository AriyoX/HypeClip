import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  writeSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as wait } from "node:timers/promises";
import { hashFile, jsonFile, writeJson, safeMessage } from "./local.ts";
import { claimCaptureSlot } from "./capture-slots.ts";
import { Chat } from "./detector.ts";
import { probe } from "./probe.ts";

async function get(url: URL, limit = 20000000) {
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      await wait(1000 * 2 ** attempt);
      continue;
    }
    if (resp.ok) {
      if (Number(resp.headers.get("content-length")) > limit)
        throw Error("Oversize archive object");
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > limit) throw Error("Oversize archive object");
      return bytes;
    }
    await resp.body?.cancel();
    if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(resp.status))
      throw Error("Kick archive HTTP " + resp.status);
    await wait(
      1000 *
        Math.max(2 ** attempt, Number(resp.headers.get("retry-after")) || 0),
    );
  }
}
async function json(url: URL) {
  return JSON.parse((await get(url)).toString());
}

async function replay(
  channel: number,
  anchor: number,
  duration: number,
  dest: string,
  takePage: () => void,
) {
  const url = new URL(
    "https://kick.com/api/v2/channels/" + channel + "/messages",
  );
  const endpoint = url.href,
    rows = new Map<string, Chat>();
  url.searchParams.set("start_time", new Date(anchor + duration).toISOString());
  let previous = Infinity;
  for (let pages = 1; pages <= 5000; pages++) {
    takePage();
    const { messages, cursor } = (await json(url)).data;
    const receivedAt = new Date().toISOString();
    for (const m of messages) {
      const t = Date.parse(m.created_at);
      if (
        t < anchor ||
        t >= anchor + duration ||
        m.type !== "message" ||
        !m.content?.trim() ||
        !m.sender?.id
      )
        continue;
      rows.set(
        m.id,
        Chat.parse({
          eventId: m.id,
          eventAt: m.created_at,
          receivedAt,
          userId: createHash("sha256")
            .update(String(m.sender.id))
            .digest("hex")
            .slice(0, 24),
          text: m.content,
          emotes: [...m.content.matchAll(/\[emote:(\d+):([^\]]+)\]/g)].flatMap(
            (m) => [m[1], m[2]],
          ),
        }),
      );
    }
    if (
      !messages.length ||
      !cursor ||
      messages.some(
        (m: { created_at: string }) => Date.parse(m.created_at) < anchor,
      )
    ) {
      const ordered = [...rows.values()].sort(
        (a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt),
      );
      writeFileSync(
        dest + ".tmp",
        ordered.map((m) => JSON.stringify(m) + "\n").join(""),
      );
      renameSync(dest + ".tmp", dest);
      return { endpoint, pages, messages: rows.size };
    }
    if (!(Number(cursor) < previous))
      throw Error("Kick replay cursor stopped advancing");
    previous = Number(cursor);
    url.search = new URLSearchParams({ cursor: String(cursor) }).toString();
    await wait(125);
  }
  throw Error("Kick replay page budget exhausted");
}

async function replayInterval(
  channel: number,
  anchor: number,
  duration: number,
  dest: string,
) {
  const cache = join(dest, ".replay-pages");
  mkdirSync(cache, { recursive: true });
  const slices = Array.from({ length: Math.ceil(duration / 60000) }, (_, i) => {
    const start = anchor + i * 60000,
      ms = Math.min(60000, duration - i * 60000);
    const file = join(cache, channel + "-" + start + "-" + ms + ".jsonl");
    return { start, ms, file, receipt: file + ".json" };
  });
  const pending = [...slices];
  let remaining = 480,
    failure: unknown;
  function takePage() {
    if (failure) throw failure;
    if (remaining <= 0)
      throw Error(
        "Kick replay budget of 480 pages reached; complete minute slices retained",
      );
    remaining--;
  }
  async function collect() {
    for (let s = pending.shift(); s; s = pending.shift()) {
      if (failure) throw failure;
      if (existsSync(s.file) && existsSync(s.receipt)) continue;
      let receipt;
      try {
        receipt = await replay(channel, s.start, s.ms, s.file, takePage);
      } catch (e) {
        failure = e;
        throw e;
      }
      writeJson(s.receipt, receipt);
    }
  }
  const checks = await Promise.allSettled(
    Array.from({ length: 3 }, () => collect()),
  );
  for (const check of checks)
    if (check.status === "rejected") throw check.reason;
  const pages = slices.map((s) => jsonFile(s.receipt));
  writeFileSync(
    join(dest, "chat.jsonl.tmp"),
    slices.map((s) => readFileSync(s.file, "utf8")).join(""),
  );
  renameSync(join(dest, "chat.jsonl.tmp"), join(dest, "chat.jsonl"));
  return {
    endpoint: pages[0].endpoint,
    pages: pages.reduce((n, p) => n + p.pages, 0),
    messages: pages.reduce((n, p) => n + p.messages, 0),
  };
}

export async function inspectKickArchive(url: string) {
  const match = /^https:\/\/kick\.com\/([\w-]+)\/videos\/([\da-f-]{36})$/i.exec(
    url,
  );
  if (!match) throw Error("Use a Kick broadcast archive URL");
  const page = await json(new URL("https://kick.com/api/v1/video/" + match[2]));
  const live = page.livestream;
  if (
    page.uuid !== match[2] ||
    page.is_private ||
    page.is_pruned ||
    live?.channel?.slug?.toLowerCase() !== match[1].toLowerCase() ||
    !page.source
  )
    throw Error("This archive is unavailable");
  return {
    channel: live.channel.slug,
    broadcastId: page.uuid,
    title: live.session_title,
    language: live.language,
    category: live.categories?.[0]?.name,
    media: "Public Kick archive",
    chat: "Original replay supported; checked during acquisition",
  };
}
export async function acquireInterval(
  specFile: string,
  dest: string,
  rights: string,
  mediaOnly = false,
) {
  const spec = jsonFile(specFile),
    { startMs: start, endMs: end } = spec;
  const match = /^https:\/\/kick\.com\/([\w-]+)\/videos\/([\da-f-]{36})$/.exec(
    spec.url,
  );
  if (
    !rights.trim() ||
    !match ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > 3600000
  )
    throw Error("Supply an authorized Kick VOD interval up to one hour");
  const release = claimCaptureSlot(undefined, "kick:" + match[2]);
  try {
    mkdirSync(dest, { recursive: true });
    const page = await json(
        new URL("https://kick.com/api/v1/video/" + match[2]),
      ),
      live = page.livestream;
    if (
      page.uuid !== match[2] ||
      page.is_private ||
      page.is_pruned ||
      live.channel.slug.toLowerCase() !== match[1]
    )
      throw Error("Archive identity or availability changed");
    const file = join(dest, "interval.mp4"),
      receipt = join(dest, "acquisition.json");
    let saved;
    if (existsSync(receipt)) {
      saved = jsonFile(receipt);
      if (
        saved.url !== spec.url ||
        saved.startMs !== start ||
        saved.endMs !== end ||
        saved.sha256 !== (await hashFile(file))
      )
        throw Error("Existing acquisition differs");
    } else {
      if (existsSync(file)) throw Error("Choose a fresh acquisition directory");
      const master = new URL(page.source);
      if (master.protocol !== "https:" || master.hostname !== "stream.kick.com")
        throw Error("Expected public Kick VOD media");
      const variants = (await get(master))
        .toString()
        .split(/\r?\n/)
        .filter((s) => /^[\w.-]+\/playlist\.m3u8$/.test(s));
      const variant = variants.find((s) => s.startsWith("720p")) ?? variants[0];
      if (!variant) throw Error("No archived rendition");
      const base = new URL(variant, master),
        lines = (await get(base)).toString().split(/\r?\n/);
      if (
        !lines.includes("#EXT-X-ENDLIST") ||
        lines.some((s) => /^#EXT-X-(KEY|BYTERANGE)/.test(s))
      )
        throw Error("Expected a complete clear archive");
      const segments: URL[] = [];
      let cursor = 0,
        length = 0,
        utc = NaN,
        first = -1,
        anchor = NaN;
      for (const row of lines) {
        if (row.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
          utc = Date.parse(row.slice(25));
        else if (row.startsWith("#EXTINF:"))
          length = Math.round(parseFloat(row.slice(8)) * 1000);
        else if (row && !row.startsWith("#")) {
          if (cursor < end && cursor + length > start) {
            if (!/^[\w.-]+\.ts$/.test(row) || !Number.isFinite(utc))
              throw Error("Invalid archive segment or UTC anchor");
            if (first < 0) {
              first = cursor;
              anchor = utc + start - first;
            }
            if (Math.abs(utc - anchor - (cursor - start)) > 150)
              throw Error("Archive timeline has a discontinuity");
            segments.push(new URL(row, base));
          }
          cursor += length;
          if (cursor >= end) break;
        }
      }
      if (cursor < end || !segments.length)
        throw Error("Archive is shorter than the committed interval");
      const temp = mkdtempSync(join(dest, ".acquire-"));
      try {
        const ts = join(temp, "capture.ts"),
          fd = openSync(ts, "wx");
        try {
          for (let i = 0; i < segments.length; i += 4) {
            const group = await Promise.all(
              segments.slice(i, i + 4).map((u) => get(u)),
            );
            for (const bytes of group) {
              if (bytes[0] !== 0x47 || bytes.length % 188 !== 0)
                throw Error("Incomplete transport segment");
              let pos = 0;
              while (pos < bytes.length)
                pos += writeSync(fd, bytes, pos, bytes.length - pos);
            }
          }
        } finally {
          closeSync(fd);
        }
        const output = join(temp, "interval.mp4");
        await promisify(execFile)(
          process.env.HYPECLIP_FFMPEG || "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-ss",
            String((start - first) / 1000),
            "-i",
            ts,
            "-t",
            String((end - start) / 1000),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-r",
            "30",
            "-g",
            "60",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            output,
          ],
          { windowsHide: true, timeout: 1800000 },
        );
        if (Math.abs((await probe(output)).durationMs - (end - start)) > 80)
          throw Error("Acquired interval duration mismatch");
        saved = {
          ...spec,
          localReviewRights: rights,
          mediaStart: new Date(anchor).toISOString(),
          variant,
          segments: segments.length,
          languageTag: live.language,
          title: live.session_title,
          channelId: live.channel_id,
          sha256: await hashFile(output),
        };
        renameSync(output, file);
        writeJson(receipt, saved);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
    if (mediaOnly) return { ...saved, selectionMode: "media only" };
    if (!saved.chat || saved.chat.error) {
      try {
        saved.chat = await replayInterval(
          live.channel_id,
          Date.parse(saved.mediaStart),
          end - start,
          dest,
        );
      } catch (e) {
        saved.chat = { error: safeMessage(e) };
      }
      writeJson(receipt, saved);
    }
    return saved;
  } finally {
    release();
  }
}
