import { captureLimit } from "./capture-slots.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { discover, identify, youtubeJson } from "./platforms.ts";
import { identity } from "./twitch.ts";
import { Overrides } from "./editorial.ts";
import { jsonFile, safeMessage, stateDir, writeJson } from "./local.ts";
import { setTimeout as wait } from "node:timers/promises";

const channel = z.strictObject({
  url: z.url(),
  id: z.string().min(1),
  settings: Overrides.optional(),
  webhookPort: z.number().int().min(1024).max(65535).optional(),
  localReviewRights: z.string().min(4).optional(),
  feedEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});
const observed = z.object({
  source: z.url(),
  at: z.iso.datetime({ offset: true }),
  viewers: z.number().int().nonnegative().nullable(),
  title: z.string(),
  languageTag: z.string().nullable().optional(),
});
export const LanguageSample = z.object({
  url: z.url(),
  atMs: z.number().int().nonnegative(),
  note: z.string().min(3),
  speaker: z.enum(["streamer-en", "mixed", "uncertain", "game", "silent"]),
});
const creator = z.strictObject({
  key: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  channels: z.array(channel).min(1),
  evidence: observed.optional(),
  samples: z.array(LanguageSample).default([]),
});
const profile = z.strictObject({
  creators: z.array(creator),
  pins: z.array(z.string()).default([]),
  additions: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
});
export type Creator = z.output<typeof creator>;
type Channel = z.output<typeof channel>;
export type Observation = z.infer<typeof observed> & {
  live: boolean;
  gta: boolean;
  broadcastId?: string;
  language?: string;
  error?: string;
};
type CacheEntry = {
  next: number;
  failures: number;
  value: Observation;
  lastGame?: Observation;
};
const gta = (s: string) =>
  /\b(?:gta\s*(?:vi|6)|grand theft auto\s+(?:vi|6))\b/i.test(s);
export function gtaBroadcast(title: string, categories: string[] = []) {
  const known = categories.filter((name) => name.trim());
  return known.length ? known.some(gta) : gta(title);
}
const keyOf = (c: Channel) => identify(c.url).platform + ":" + c.id;
function verified(c: Creator) {
  return (
    !c.samples.some((s) => s.speaker === "mixed") &&
    new Set(
      c.samples
        .filter((s) => s.speaker === "streamer-en")
        .map((s) => s.url + "#" + s.atMs),
    ).size >= 3
  );
}
export function roster(
  raw: unknown,
  obs: Record<string, CacheEntry> = {},
  now = Date.now(),
) {
  const p = profile.parse(raw),
    groups: Creator[][] = [];
  for (const c of p.creators) {
    const ids = new Set(c.channels.map(keyOf));
    const matches = groups.filter((g) =>
      g.some(
        (x) => x.key === c.key || x.channels.some((ch) => ids.has(keyOf(ch))),
      ),
    );
    for (const group of matches) groups.splice(groups.indexOf(group), 1);
    groups.push([...matches.flat(), c]);
  }
  const rows = groups.flatMap((group) => {
    const keys = group.map((c) => c.key);
    if (keys.some((k) => p.exclusions.includes(k))) return [];
    const c = {
      ...group[0],
      channels: [
        ...new Map(
          group
            .toReversed()
            .flatMap((c) => c.channels.map((ch) => [keyOf(ch), ch] as const)),
        ).values(),
      ],
      samples: group.flatMap((c) => c.samples),
    };
    const pinned = keys.some((k) => p.pins.includes(k)),
      added = keys.some((k) => p.additions.includes(k));
    const channels = c.channels.map((ch) => ({
      ...ch,
      platform: identify(ch.url).platform,
      observation: obs[keyOf(ch)]?.value,
    }));
    const live = channels.filter(
      (ch) =>
        ch.observation?.live &&
        ch.observation.gta &&
        now - Date.parse(ch.observation.at) < 900000,
    );
    const historical = [
      ...group.map((c) => c.evidence),
      ...channels.map((ch) => obs[keyOf(ch)]?.lastGame),
    ]
      .filter((e) => e && now - Date.parse(e.at) < 7 * 86400000)
      .sort((a, b) => Date.parse(b!.at) - Date.parse(a!.at))[0];
    const english = verified(c);
    const evidence =
      live
        .map((ch) => ch.observation!)
        .sort((a, b) => (b.viewers ?? -1) - (a.viewers ?? -1))[0] ?? historical;
    return [{ ...c, channels, pinned, added, english, evidence, live }];
  });
  rows.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.added) - Number(a.added) ||
      Number(!!b.live.length) - Number(!!a.live.length) ||
      (b.evidence?.viewers ?? -1) - (a.evidence?.viewers ?? -1) ||
      a.key.localeCompare(b.key),
  );
  const watch = rows
    .filter((r) => r.pinned || r.added || (r.english && r.evidence))
    .slice(0, 20);
  return {
    watch,
    review: rows.filter((r) => !watch.includes(r)),
    capacity: 20,
  };
}
async function publicJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("Provider HTTP " + r.status);
  return r.json();
}
async function inspect(ch: Channel): Promise<Omit<Observation, "at">> {
  const { platform, handle } = identify(ch.url);
  const base = {
    source: ch.url,
    title: "",
    viewers: null,
    live: false,
    gta: false,
  };
  if (platform === "kick") {
    const url =
        "https://kick.com/api/v2/channels/" + encodeURIComponent(handle),
      doc = await publicJson(url);
    if (
      String(doc.id) !== ch.id ||
      doc.slug.toLowerCase() !== handle.toLowerCase()
    )
      throw Error("Kick stable ID mismatch");
    const stream = doc.livestream;
    return {
      ...base,
      source: url,
      live: !!stream?.is_live,
      viewers:
        stream?.show_view_count === false
          ? null
          : (stream?.viewer_count ?? null),
      gta: gtaBroadcast(
        stream?.session_title ?? "",
        stream?.categories?.map((c: { name: string }) => c.name),
      ),
      language: stream?.language,
      title: stream?.session_title ?? "",
      broadcastId: stream ? String(stream.id) : undefined,
    };
  }
  if (platform === "twitch") {
    let stream;
    if (process.env.TWITCH_USER_TOKEN) {
      const token = process.env.TWITCH_USER_TOKEN,
        id = await identity(token);
      const url =
        "https://api.twitch.tv/helix/streams?user_id=" +
        encodeURIComponent(ch.id);
      stream = (
        await publicJson(url, {
          "Client-Id": id.client_id,
          Authorization: "Bearer " + token,
        })
      ).data[0];
      if (stream && stream.user_login.toLowerCase() !== handle.toLowerCase())
        throw Error("Twitch channel changed");
      return {
        ...base,
        source: url,
        live: !!stream,
        broadcastId: stream?.id,
        title: stream?.title ?? "",
        language: stream?.language,
        gta: gta(stream?.game_name ?? ""),
        viewers: stream?.viewer_count ?? null,
      };
    }
    const url =
        "https://api.ivr.fi/v2/twitch/user?login=" + encodeURIComponent(handle),
      [u] = await publicJson(url);
    if (u?.id !== ch.id || u.login !== handle.toLowerCase())
      throw Error("Twitch stable ID mismatch");
    stream = u.stream;
    return {
      ...base,
      source: url,
      live: stream?.type === "live",
      broadcastId: stream?.id,
      title: stream?.title ?? "",
      gta: gta(stream?.game?.displayName ?? stream?.game?.name ?? ""),
      viewers: stream?.viewersCount ?? null,
    };
  }
  if (platform === "tiktok") {
    const path = "/embed/" + handle,
      res = await fetch("https://www.tiktok.com" + path, {
        signal: AbortSignal.timeout(15000),
      });
    const data = (await res.text()).match(
      /<script id="__FRONTITY_CONNECT_STATE__" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    const author = data && JSON.parse(data).source?.data?.[path]?.userInfo;
    if (
      !res.ok ||
      String(author?.id) !== ch.id ||
      author.uniqueId?.toLowerCase() !== handle.slice(1).toLowerCase()
    )
      throw Error("TikTok numeric creator identity unavailable or changed");
  }
  const found = await discover(ch.url);
  if (platform === "youtube" && found.broadcastId) {
    const url =
      "https://www.youtube.com/watch?v=" +
      encodeURIComponent(found.broadcastId);
    if (process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN) {
      const doc = await youtubeJson(
        "videos",
        { part: "snippet,liveStreamingDetails", id: found.broadcastId },
        new AbortController().signal,
      );
      const video = doc.items?.[0],
        count = video?.liveStreamingDetails?.concurrentViewers;
      if (video?.snippet?.channelId !== ch.id)
        throw Error("YouTube stable ID mismatch");
      return {
        ...base,
        source: url,
        live: video.snippet.liveBroadcastContent === "live",
        gta: gta(video.snippet.title),
        title: video.snippet.title,
        language: video.snippet.defaultAudioLanguage,
        viewers: count === undefined ? null : Number(count),
        broadcastId: found.broadcastId,
      };
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw Error("YouTube identity HTTP " + res.status);
    const html = await res.text(),
      player = html.match(
        /"videoDetails":\{"videoId".{1,18000}?"channelId":"(UC[\w-]{22})"/s,
      );
    if (player?.[1] !== ch.id)
      throw Error("YouTube stable ID unavailable or changed");
    const count =
      html.match(/"simpleText":"([\d,]+) watching now"/i) ??
      html.match(/"text":"([\d,]+)"\},\{"text":" watching now"/i);
    return {
      ...base,
      source: url,
      live:
        /"isLive":true/.test(player[0]) || html.includes('"isLiveNow":true'),
      gta: gta(found.title ?? ""),
      title: found.title ?? "",
      viewers: count ? Number(count[1].replaceAll(",", "")) : null,
      broadcastId: found.broadcastId,
    };
  }
  // The TikTok plugin exposes a room ID and author handle; its room ID changes per broadcast.
  if (
    platform === "tiktok" &&
    found.channel?.replace(/^@/, "").toLowerCase() !==
      handle.slice(1).toLowerCase()
  )
    throw Error("TikTok author identity unavailable");
  return {
    ...base,
    live: !!found.broadcastId,
    gta: gta(found.title ?? ""),
    title: found.title ?? "",
    broadcastId: found.broadcastId,
  };
}
export async function refresh(file: string) {
  const parsed = profile.parse(jsonFile(file)),
    path = join(
      stateDir(),
      "watchlist",
      createHash("sha256").update(file).digest("hex").slice(0, 16) + ".json",
    );
  const cache: Record<string, CacheEntry> = existsSync(path)
    ? jsonFile(path)
    : {};
  const directoryPath = path + ".directory.json";
  let directory = existsSync(directoryPath)
    ? jsonFile(directoryPath)
    : { next: 0, failures: 0, creators: [] };
  if (directory.next <= Date.now()) {
    try {
      const url =
        "https://kick.com/stream/livestreams/en?subcategory_id=13155&sort=desc&limit=50";
      const page = await publicJson(url),
        at = new Date().toISOString(),
        found: Creator[] = [];
      for (const s of page.data) {
        if (
          !s.is_live ||
          !s.categories?.some((c: { name: string }) => gta(c.name)) ||
          !s.channel?.id
        )
          continue;
        const slug = String(s.channel.slug),
          id = String(s.channel.id);
        if (!/^[\w-]+$/.test(slug)) continue;
        const evidence = {
          source: url,
          at,
          title: String(s.session_title),
          viewers:
            s.show_view_count === false ? null : (s.viewer_count ?? null),
        };
        found.push({
          key: "kick-" + id,
          name: s.channel.user?.username ?? slug,
          channels: [{ id, url: "https://kick.com/" + slug }],
          samples: [],
          evidence,
        });
        const value = {
          ...evidence,
          live: true,
          gta: true,
          broadcastId: String(s.id),
          language: s.language,
        };
        cache["kick:" + id] = {
          next: Date.now() + 90000,
          failures: 0,
          value,
          lastGame: value,
        };
      }
      directory = { next: Date.now() + 300000, failures: 0, creators: found };
    } catch (e) {
      directory.failures++;
      directory.next =
        Date.now() +
        Math.min(3600000, 60000 * 2 ** Math.min(directory.failures, 6));
      directory.error = safeMessage(e);
    }
    writeJson(directoryPath, directory);
  }
  const todo = [
    ...new Map(
      parsed.creators
        .filter((c) => !parsed.exclusions.includes(c.key))
        .flatMap((c) => c.channels.map((ch) => [keyOf(ch), ch] as const)),
    ).values(),
  ];
  const twitchPath = path + ".twitch.json";
  let twitch = existsSync(twitchPath)
    ? jsonFile(twitchPath)
    : { next: 0, failures: 0, creators: [] };
  const token = process.env.TWITCH_USER_TOKEN;
  if (token && twitch.next <= Date.now()) {
    try {
      const id = await identity(token),
        headers = {
          "Client-Id": id.client_id,
          Authorization: "Bearer " + token,
        };
      const game =
        twitch.gameId ??
        (
          await publicJson(
            "https://api.twitch.tv/helix/games?name=Grand%20Theft%20Auto%20VI",
            headers,
          )
        ).data[0]?.id;
      if (!game) throw Error("No Twitch category ID for Grand Theft Auto VI");
      const source =
        "https://api.twitch.tv/helix/streams?game_id=" +
        encodeURIComponent(game) +
        "&language=en&first=50";
      const page = await publicJson(source, headers),
        at = new Date().toISOString(),
        creators: Creator[] = [];
      for (const stream of page.data) {
        if (stream.type !== "live" || stream.game_id !== game) continue;
        const id = String(stream.user_id),
          url = "https://www.twitch.tv/" + stream.user_login;
        const evidence = {
          source,
          at,
          title: stream.title,
          viewers: stream.viewer_count ?? null,
          languageTag: stream.language,
        };
        creators.push({
          key: "twitch-" + id,
          name: stream.user_name,
          channels: [{ url, id }],
          samples: [],
          evidence,
        });
        const value = {
          ...evidence,
          live: true,
          gta: true,
          broadcastId: String(stream.id),
          language: stream.language,
        };
        cache["twitch:" + id] = {
          value,
          lastGame: value,
          next: Date.now() + 90000,
          failures: 0,
        };
      }
      twitch = {
        next: Date.now() + 300000,
        failures: 0,
        gameId: game,
        creators,
      };
    } catch (e) {
      twitch.failures++;
      twitch.next =
        Date.now() +
        Math.min(3600000, 60000 * 2 ** Math.min(twitch.failures, 6));
      twitch.error = safeMessage(e);
    }
    writeJson(twitchPath, twitch);
  }
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(
      todo.slice(i, i + 3).map(async (ch) => {
        const k = keyOf(ch),
          prior = cache[k],
          now = Date.now();
        if (prior?.next > now) return;
        const at = new Date(now).toISOString();
        const lastGame =
          prior?.value.live && prior.value.gta ? prior.value : prior?.lastGame;
        try {
          const value = { ...(await inspect(ch)), at };
          cache[k] = {
            value,
            lastGame: value.live && value.gta ? value : lastGame,
            next: now + (value.live ? 90000 : 300000),
            failures: 0,
          };
        } catch (e) {
          const failures = (prior?.failures ?? 0) + 1;
          cache[k] = {
            lastGame,
            value: {
              at,
              source: ch.url,
              title: "",
              viewers: null,
              live: false,
              gta: false,
              error: safeMessage(e),
            },
            failures,
            next: now + Math.min(3600000, 60000 * 2 ** Math.min(failures, 6)),
          };
        }
      }),
    );
  }
  writeJson(path, cache);
  return roster(
    {
      ...parsed,
      creators: [
        ...parsed.creators,
        ...directory.creators,
        ...(token ? twitch.creators : []),
      ],
    },
    cache,
  );
}

type Active = { drain: boolean; task: Promise<void>; broadcast: string };
type WatchRow = ReturnType<typeof roster>["watch"][number];
export function preferredCaptures(rows: WatchRow[], rights?: string) {
  return rows
    .flatMap((r) => {
      if (!r.english) return [];
      const candidates = r.live.filter(
        (ch) =>
          (ch.localReviewRights || rights) &&
          (!ch.observation?.language ||
            /^(en(?:[-_].*)?|english)$/i.test(ch.observation.language)),
      );
      const quality = (ch: (typeof candidates)[number]) =>
        Number(!!ch.settings?.splitScreen) * 4 +
        Number(
          ch.platform === "kick" ||
            (ch.platform === "twitch" && !!process.env.TWITCH_USER_TOKEN) ||
            (ch.platform === "youtube" &&
              !!(
                process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN
              )),
        ) *
          2;
      const best = candidates.sort(
        (a, b) =>
          quality(b) - quality(a) ||
          (b.observation?.viewers ?? -1) - (a.observation?.viewers ?? -1),
      )[0];
      return best
        ? [
            {
              creator: r.key,
              samples: r.samples,
              channel: best,
              pinned: r.pinned,
              quality: quality(best),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.quality - a.quality ||
        (b.channel.observation?.viewers ?? -1) -
          (a.channel.observation?.viewers ?? -1),
    )
    .slice(0, captureLimit());
}
export async function follow(
  file: string,
  rights: string | undefined,
  once: boolean,
  signal: AbortSignal,
  capture: (
    c: ReturnType<typeof preferredCaptures>[number],
    drain: () => boolean,
  ) => Promise<void>,
  report: (v: Record<string, unknown>) => void,
) {
  const active = new Map<string, Active>(),
    backoff = new Map<string, number>();
  try {
    do {
      const { watch, review } = await refresh(file);
      report({
        event: "watchlist",
        size: watch.length,
        review: review.length,
        roster: watch.map((r) => ({
          name: r.name,
          pinned: r.pinned,
          english: r.english,
          broadcasts: r.live.map(
            (c) => c.platform + ":" + c.observation?.broadcastId,
          ),
          state:
            r.live.length &&
            r.live.every(
              (c) =>
                c.observation?.language &&
                !/^(en(?:[-_].*)?|english)$/i.test(c.observation.language),
            )
              ? "Ineligible language"
              : r.live.length
                ? "Eligible"
                : r.channels.some((c) => c.observation?.live)
                  ? "Ineligible game"
                  : r.channels.every((c) => c.observation?.error)
                    ? "Unavailable"
                    : "Offline",
        })),
      });
      const ready = preferredCaptures(
        watch.map((r) => ({
          ...r,
          live: r.live.filter((ch) => (backoff.get(ch.url) ?? 0) < Date.now()),
        })),
        rights,
      );
      const broadcast = (s: (typeof ready)[number]) =>
        keyOf(s.channel) + "/" + s.channel.observation?.broadcastId;
      for (const [key, slot] of active)
        if (
          !ready.some(
            (s) => s.creator === key && broadcast(s) === slot.broadcast,
          )
        )
          slot.drain = true;
      for (const s of ready) {
        if (
          active.has(s.creator) ||
          active.size >= captureLimit() ||
          signal.aborted
        )
          continue;
        const slot: Active = {
          drain: false,
          task: Promise.resolve(),
          broadcast: broadcast(s),
        };
        active.set(s.creator, slot);
        slot.task = capture(s, () => slot.drain)
          .catch((e) =>
            report({
              event: "capture-error",
              creator: s.creator,
              error: safeMessage(e),
            }),
          )
          .finally(() => {
            active.delete(s.creator);
            backoff.set(s.channel.url, Date.now() + 120000);
          });
      }
      if (once) break;
      await wait(15000, undefined, { signal }).catch(() => {});
    } while (!signal.aborted);
  } finally {
    await Promise.allSettled([...active.values()].map((a) => a.task));
  }
}
