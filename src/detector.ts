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
  latencyMs: z.number().int().nonnegative().default(0),
  preRollMs: z.number().int().min(20000).max(40000).default(30000),
  glossary: z.record(z.string(), z.string()).optional(),
  bots: z.array(z.string()).optional(),
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
  lastReactionMs?: number;
  mode?: "chat" | "operator" | "audio";
  audioRise?: { levelDb: number; baselineDb: number; segmentEndMs: number };
}
const bucketMs = 5000,
  baselineBuckets = 12,
  userCap = 2;
export function detect(
  messages: Chat[],
  timing: z.input<typeof Timing>,
  mergeOverlaps = true,
) {
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
  const bots = new Set(t.bots);
  for (const m of ordered) {
    if (bots.has(m.userId) || seen.has(m.eventId)) continue;
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
    const audience = raw.filter(
      (m) =>
        !/\b(raid(?:er|ing|ers)?|welcome raiders|follow my channel|buy followers)\b/i.test(
          m.text,
        ),
    );
    const raidCount = raw.length - audience.length;
    if (raidCount >= 3 && raidCount * 3 >= raw.length) {
      counts.set(key, 0);
      continue;
    }
    const copies = new Map<string, number>();
    const users = new Map<string, number>();
    const capped = audience.filter((m) => {
      const normalized = m.text.trim().toLowerCase().replace(/\s+/g, " ");
      if (normalized.length > 50) {
        const count = copies.get(normalized) ?? 0;
        copies.set(normalized, count + 1);
        if (count >= 2) return false;
      }
      const count = users.get(m.userId) ?? 0;
      users.set(m.userId, count + 1);
      return count < userCap;
    });
    const history = Array.from(
      { length: Math.min(baselineBuckets, key) },
      (_, k) => counts.get(key - k - 1) ?? 0,
    );
    // The first five seconds can already contain a busy audience.
    const baseline = history.length
      ? history.reduce((sum, count) => sum + count, 0) / history.length
      : capped.length;
    counts.set(key, capped.length);
    const excess = capped.length - Math.max(1, baseline);
    const relativeRise = excess / Math.max(2, baseline);
    // In a large audience, even a significant rise may be a small percentage.
    // Compare with recent variation once there is enough observed history.
    let standardizedRise = 0;
    if (history.length >= 6 && baseline >= 10) {
      const variance =
        history.reduce((sum, count) => sum + (count - baseline) ** 2, 0) /
        history.length;
      standardizedRise = excess / Math.sqrt(Math.max(baseline, variance)) - 1;
    }
    const reactions = capped.filter(
      (m) =>
        m.emotes.length ||
        Object.keys(t.glossary ?? {}).some((k) =>
          m.text.toLowerCase().includes(k.toLowerCase()),
        ) ||
        /\b(wow|pog(?:gers|champ)?|omg|clutch|hype|insane|gg|lmao|lol|haha+|rofl)\b|🔥|😱/iu.test(
          m.text,
        ),
    ).length;
    const contributions = {
      velocity: Math.round(
        Math.min(50, Math.max(0, relativeRise, standardizedRise) * 12),
      ),
      distinct: Math.min(30, users.size * 5),
      reactions: Math.min(20, reactions * 4),
    };
    const score =
      contributions.velocity + contributions.distinct + contributions.reactions;
    if (users.size < 3 || score < 60) {
      const prev = events.at(-1),
        last = capped.at(-1);
      if (
        prev &&
        last &&
        users.size >= 3 &&
        reactions >= 2 &&
        excess > 0 &&
        last.mediaMs - t.latencyMs - (prev.lastReactionMs ?? prev.peakMs) <=
          8000
      ) {
        prev.lastReactionMs = last.mediaMs - t.latencyMs;
        const extended = Math.max(prev.endMs, prev.lastReactionMs + 4000);
        prev.endMs = t.live ? extended : Math.min(extended, t.durationMs);
        prev.ready = !t.live || prev.endMs <= t.durationMs;
      }
      continue;
    }
    const peakMs = capped[Math.floor((capped.length - 1) / 2)].mediaMs;
    const eventMs = Math.max(0, peakMs - t.latencyMs - t.reactionMs),
      startMs = Math.max(0, eventMs - t.preRollMs);
    const requestedEnd = eventMs + 25000;
    const endMs = t.live ? requestedEnd : Math.min(t.durationMs, requestedEnd);
    const spike: Spike = {
      lastReactionMs: capped.at(-1)!.mediaMs - t.latencyMs,
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
      chat:
        capped.length <= 40
          ? capped
          : [
              ...capped
                .filter((_, i) => i % Math.ceil(capped.length / 32) === 0)
                .slice(0, 32),
              ...capped
                .filter((m) =>
                  /\b(nah|actually|fake|sure|right|fail)\b|\/s\b/i.test(m.text),
                )
                .slice(-8),
            ],
    };
    const prev = events.at(-1);
    if (mergeOverlaps && prev && startMs < prev.endMs) {
      const merged = {
        ...(score > prev.score ? spike : prev),
        startMs: prev.startMs,
        endMs: Math.max(prev.endMs, endMs),
        lastReactionMs: spike.lastReactionMs,
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

export function reactions(spike: Spike, glossary: Record<string, string>) {
  const seen = new Set<string>();
  const rows = spike.chat.flatMap((m) => {
    const text = m.text.replace(/\s+/g, " ").trim().slice(0, 140);
    const emotes = m.emotes
      .slice(0, 4)
      .map((id) => ({ id, meaning: glossary[id] ?? "unknown" }));
    const key = JSON.stringify([text.toLowerCase(), emotes]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        text,
        mediaMs: m.mediaMs,
        eventAt: m.eventAt,
        emotes,
        phrases: Object.entries(glossary)
          .filter(([key]) => text.toLowerCase().includes(key.toLowerCase()))
          .slice(0, 3),
      },
    ];
  });
  const counter = rows.filter((r) =>
    /\b(no|nah|boring|sure|right|actually|fake|fail|surely|sarcasm)\b|\/s\b/i.test(
      r.text,
    ),
  );
  const examples = rows.filter((r) => !counter.includes(r));
  return {
    sample: examples
      .filter((_, i) => i % Math.max(1, Math.ceil(examples.length / 10)) === 0)
      .slice(0, 10),
    counterexamples: counter.slice(0, 4),
  };
}
