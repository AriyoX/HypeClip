import { z } from "zod";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
export const timestamp = z.iso.datetime({ offset: true });
export const Chat = z.object({
  eventId: z.string().min(1),
  eventAt: timestamp,
  receivedAt: timestamp,
  userId: z.string().min(1),
  text: z.string(),
  emotes: z.array(z.string()).default([]),
  fixture: z.boolean().default(false),
});
export type Chat = z.infer<typeof Chat>;
export function readChat(path: string, live = false): Chat[] {
  const bytes = readFileSync(path, "utf8");
  const complete = live ? bytes.slice(0, bytes.lastIndexOf("\n") + 1) : bytes;
  return complete
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [Chat.parse(JSON.parse(line))];
      } catch {
        throw Error("Invalid chat JSONL at line " + (index + 1));
      }
    });
}
export const Timing = z.object({
  mediaStart: timestamp,
  durationMs: z.number().int().positive(),
  offsetMs: z.number().int().default(0),
  reactionMs: z.number().int().nonnegative().default(4000),
  live: z.boolean().default(false),
});
type Mapped = Chat & { mediaMs: number };
type Signals = { velocity: number; distinct: number; reactions: number };
export interface Spike {
  peakMs: number;
  eventMs: number;
  startMs: number;
  endMs: number;
  ready: boolean;
  score: number;
  contributions: Signals;
  baseline: number;
  distinctUsers: number;
  acceptedMessages: number;
  chat: Mapped[];
}
const bucketMs = 5000,
  baselineBuckets = 12,
  userCap = 2;
export function detect(messages: Chat[], timing: z.input<typeof Timing>) {
  const t = Timing.parse(timing);
  const anchor = Date.parse(t.mediaStart);
  const buckets = new Map<number, Mapped[]>();
  const seen = new Set<string>();
  const ordered = [...messages].sort(
    (a, b) =>
      Date.parse(a.eventAt) - Date.parse(b.eventAt) ||
      a.eventId.localeCompare(b.eventId, "en") ||
      a.receivedAt.localeCompare(b.receivedAt, "en"),
  );
  for (const m of ordered) {
    if (seen.has(m.eventId)) continue;
    seen.add(m.eventId);
    const mediaMs = Date.parse(m.eventAt) - anchor + t.offsetMs;
    if (mediaMs < 0 || mediaMs > t.durationMs) continue;
    const key = Math.floor(mediaMs / bucketMs);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ ...m, mediaMs });
    buckets.set(key, bucket);
  }
  const counts = new Map<number, number>(),
    events: Spike[] = [];
  for (const [key, raw] of buckets) {
    const users = new Map<string, number>();
    const capped = raw.filter((m) => {
      const count = users.get(m.userId) ?? 0;
      users.set(m.userId, count + 1);
      return count < userCap;
    });
    let prior = 0;
    for (let k = 1; k <= baselineBuckets; k++)
      prior += counts.get(key - k) ?? 0;
    const baseline = prior / Math.min(baselineBuckets, Math.max(1, key));
    counts.set(key, capped.length);
    const reactions = capped.filter(
      (m) =>
        m.emotes.length ||
        /\b(wow|pog(?:gers|champ)?|omg|clutch|hype|insane|gg|lmao)\b|🔥|😱/iu.test(
          m.text,
        ),
    ).length;
    const contributions = {
      velocity: Math.round(
        Math.min(
          50,
          Math.max(
            0,
            ((capped.length - Math.max(1, baseline)) / Math.max(2, baseline)) *
              12,
          ),
        ),
      ),
      distinct: Math.min(30, users.size * 5),
      reactions: Math.min(20, reactions * 4),
    };
    const score =
      contributions.velocity + contributions.distinct + contributions.reactions;
    if (users.size < 3 || score < 60) continue;
    const peakMs = capped[Math.floor((capped.length - 1) / 2)].mediaMs;
    const eventMs = Math.max(0, peakMs - t.reactionMs),
      startMs = Math.max(0, eventMs - 30000);
    const requestedEnd = eventMs + 25000;
    const endMs = t.live ? requestedEnd : Math.min(t.durationMs, requestedEnd);
    const spike: Spike = {
      peakMs,
      eventMs,
      startMs,
      endMs,
      ready: !t.live || requestedEnd <= t.durationMs,
      score,
      contributions,
      baseline,
      distinctUsers: users.size,
      acceptedMessages: capped.length,
      chat: capped.slice(0, 40),
    };
    const prev = events.at(-1);
    if (prev && startMs < prev.endMs) {
      const merged = {
        ...(score > prev.score ? spike : prev),
        startMs: prev.startMs,
        endMs: Math.max(prev.endMs, endMs),
        ready: prev.ready && spike.ready,
        chat: [...prev.chat, ...spike.chat].slice(0, 80),
      };
      events[events.length - 1] = merged;
    } else events.push(spike);
  }
  return events;
}
export function highlightId(session: string, s: Spike) {
  return createHash("sha256")
    .update(JSON.stringify([session, s.startMs, s.endMs]))
    .digest("hex")
    .slice(0, 24);
}
