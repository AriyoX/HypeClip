import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { atomic } from "./db.ts";
import { probe } from "./probe.ts";
import { assetUrl, host } from "./asset.ts";
import { buffer, ProviderError, restriction, sameAsset } from "./buffer.ts";
import type { Provider, Channel, Input, Mode, Post } from "./buffer.ts";
import { hashFile, safeMessage, fixturePath } from "./local.ts";
export interface Intent {
  inFlightUntil: number;
  id: number;
  channel: string;
  hash: string;
  path: string;
  caption: string;
  url: string;
  mode: Mode;
  state: string;
  remoteId: string | null;
  session: string | null;
  reason: string | null;
  sentAt: string | null;
  externalLink: string | null;
}
type Auto = { session: string; source: string };
type Options = {
  path: string;
  highlight: string;
  caption: string;
  channel: string;
  mode: Mode;
  live: boolean;
  auto?: Auto;
  expectedHash?: string;
};
// Known public test assets remain local even when copied out of their fixture directory.
async function knownFixture(hash: string) {
  // Keep copies of the original 720p demo local after upgrading a worktree.
  if (
    hash === "5c68b9adedf2ca0eb2617ec822b573393a7faf7d689f85b3bee3c9c877ed3c86"
  )
    return true;
  for (const name of ["portrait.mp4", "cut-vertical.mp4"]) {
    if (
      hash ===
      (await hashFile(
        fileURLToPath(new URL("../tests/fixtures/" + name, import.meta.url)),
      ))
    )
      return true;
  }
  return false;
}
export const liveAdapter = {
  provider: buffer,
  host,
  assetUrl,
  delay: (ms: number) => sleep(ms),
  polls: 5,
};
export type Adapter = typeof liveAdapter;
function row(db: DatabaseSync, id: number) {
  const r = db.prepare("SELECT * FROM intents WHERE id=?").get(id);
  if (!r) throw Error("Unknown intent");
  return r as unknown as Intent;
}
function until(db: DatabaseSync, channel: string) {
  return Number(
    db.prepare("SELECT untilMs FROM cooldown WHERE channel=?").get(channel)
      ?.untilMs ?? 0,
  );
}
function recordError(db: DatabaseSync, i: Intent, e: unknown) {
  if (e instanceof ProviderError && e.retryAt)
    db.prepare(
      "INSERT INTO cooldown VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET untilMs=max(untilMs,excluded.untilMs)",
    ).run(i.channel, e.retryAt);
  db.prepare("UPDATE intents SET reason=? WHERE id=? AND state=?").run(
    safeMessage(e),
    i.id,
    i.state,
  );
}
function allowed(db: DatabaseSync, auto: Auto, channel: string) {
  return db
    .prepare(
      "SELECT cap FROM policy WHERE session=? AND source=? AND channel=?",
    )
    .get(auto.session, auto.source, channel);
}
function reserve(db: DatabaseSync, o: Options, hash: string, url: string) {
  return atomic(db, () => {
    const alias = db
      .prepare("SELECT intent FROM highlights WHERE channel=? AND highlight=?")
      .get(o.channel, o.highlight);
    if (alias) {
      const old = row(db, Number(alias.intent));
      if (old.hash !== hash)
        throw Error("Stable highlight ID already bound to a different video");
      return old;
    }
    const dup = db
      .prepare("SELECT id FROM intents WHERE channel=? AND hash=?")
      .get(o.channel, hash);
    let id = Number(dup?.id);
    if (!dup) {
      if (o.auto) {
        const policy = allowed(db, o.auto, o.channel);
        const used = db
          .prepare(
            "SELECT count(*) AS n FROM intents WHERE channel=? AND session=?",
          )
          .get(o.channel, o.auto.session)!;
        const budget = db
          .prepare("SELECT min(cap) cap FROM policy WHERE channel=?")
          .get(o.channel)!;
        const total = db
          .prepare(
            "SELECT count(*) n FROM intents WHERE channel=? AND session IS NOT NULL",
          )
          .get(o.channel)!;
        if (
          !policy ||
          Number(used.n) >= Number(policy.cap) ||
          Number(total.n) >= Number(budget.cap)
        )
          throw Error(
            "Auto-publish disabled or session cap reached (shared destination budget)",
          );
      }
      id = Number(
        db
          .prepare(
            "INSERT INTO intents(channel,hash,path,caption,url,mode,session,state) VALUES(?,?,?,?,?,?,?,'ready')",
          )
          .run(
            o.channel,
            hash,
            resolve(o.path),
            o.caption,
            url,
            o.mode,
            o.auto?.session ?? null,
          ).lastInsertRowid,
      );
    }
    db.prepare("INSERT INTO highlights VALUES(?,?,?)").run(
      o.channel,
      o.highlight,
      id,
    );
    if (o.auto)
      db.prepare("UPDATE jobs SET intent=? WHERE id=? AND session=?").run(
        id,
        o.highlight,
        o.auto.session,
      );
    return row(db, id);
  });
}
function input(i: Intent): Input {
  return { channelId: i.channel, text: i.caption, url: i.url, mode: i.mode };
}
function remoteState(p: Post) {
  if (p.status === "error") {
    return /privacy|commercial|disclos|approval|notification|manual publish/i.test(
      p.error?.message ?? "",
    )
      ? "review"
      : "failed";
  }
  if (
    p.schedulingType !== "automatic" ||
    p.notificationStatus ||
    ["draft", "needs_approval"].includes(p.status)
  )
    return "review";
  if (p.status === "sent" && p.sentAt && Number.isFinite(Date.parse(p.sentAt)))
    return "published";
  return "pending";
}
async function poll(db: DatabaseSync, i: Intent, a: Adapter) {
  for (let n = 0; n < a.polls; n++) {
    if (until(db, i.channel) > Date.now()) break;
    try {
      const post = await a.provider.read(i.remoteId!);
      if (post.id !== i.remoteId || post.channelId !== i.channel)
        throw Error("Buffer returned a different post or channel");
      const state = remoteState(post);
      db.prepare(
        "UPDATE intents SET state=?,reason=?,sentAt=?,externalLink=?,remoteStatus=?,schedulingType=?,notificationStatus=? WHERE id=? AND state='pending'",
      ).run(
        state,
        post.error?.message
          ? safeMessage(Error(post.error.message))
          : state === "review"
            ? "Buffer requires review: " +
              post.status +
              " / " +
              post.schedulingType
            : null,
        post.sentAt,
        post.externalLink,
        post.status,
        post.schedulingType,
        post.notificationStatus,
        i.id,
      );
      if (state !== "pending") break;
    } catch (e) {
      recordError(db, i, e);
      if (e instanceof ProviderError && e.retryAt) break;
    }
    if (n + 1 < a.polls) await a.delay(1000 * 2 ** n);
  }
  return row(db, i.id);
}
export async function reconcile(
  db: DatabaseSync,
  id: number,
  a = liveAdapter,
  remoteId?: string,
) {
  const i = row(db, id);
  if (until(db, i.channel) > Date.now() || i.inFlightUntil > Date.now())
    return i;
  if (i.state === "pending") return poll(db, i, a);
  if (i.state !== "needs_reconciliation") return i;
  try {
    let matches: Post[];
    if (remoteId) {
      const p = await a.provider.read(remoteId);
      matches = p.id === remoteId && sameAsset(p, input(i)) ? [p] : [];
    } else {
      const c = await a.provider.channel(i.channel);
      matches = await a.provider.matches(c, input(i));
    }
    if (matches.length !== 1)
      throw Error(
        "Found " +
          matches.length +
          " matching Buffer posts. Inspect Buffer and run reconcile " +
          id +
          " --post-id <verified-id>.",
      );
    db.prepare(
      "UPDATE intents SET state='pending',remoteId=?,reason=NULL WHERE id=? AND state='needs_reconciliation'",
    ).run(matches[0].id, id);
  } catch (e) {
    recordError(db, i, e);
    return row(db, id);
  }
  return poll(db, row(db, id), a);
}
export async function publish(
  db: DatabaseSync | null,
  o: Options,
  a = liveAdapter,
) {
  const media = await probe(resolve(o.path), true);
  const hash = await hashFile(o.path);
  if (
    o.live &&
    a === liveAdapter &&
    (fixturePath(realpathSync(o.path)) ||
      db
        ?.prepare(
          "SELECT 1 FROM jobs WHERE json_extract(details,'$.fixture')=1 AND json_extract(result,'$.sha256')=?",
        )
        .get(hash) ||
      (await knownFixture(hash)))
  )
    throw Error("Fixture assets are local only. Select a real clip.");
  if (o.expectedHash && o.expectedHash !== hash)
    throw Error("Rendered file changed since evaluation");
  if (!o.caption.trim() || !o.highlight.trim())
    throw Error("A caption and stable highlight ID are required");
  if (db && until(db, o.channel) > Date.now())
    throw Error(
      "Buffer Retry-After active until " +
        new Date(until(db, o.channel)).toISOString(),
    );
  let c: Channel;
  try {
    c = await a.provider.channel(o.channel);
  } catch (e) {
    if (e instanceof ProviderError && e.retryAt && db && o.live)
      db.prepare(
        "INSERT INTO cooldown VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET untilMs=max(untilMs,excluded.untilMs)",
      ).run(o.channel, e.retryAt);
    if (!o.live)
      return {
        state: "dry_run",
        channel: o.channel,
        verified: false,
        reason: safeMessage(e),
        hash,
        ...media,
        caption: o.caption,
        mode: o.mode,
      };
    throw e;
  }
  console.error("TikTok destination: " + c.name + " (" + c.id + ")");
  if (!o.live)
    return {
      state: "dry_run",
      channel: c.id,
      name: c.name,
      hash,
      ...media,
      caption: o.caption,
      mode: o.mode,
      requirement: restriction(c) || null,
    };
  if (!db) throw Error("Live publishing requires SQLite");
  const i = reserve(db, o, hash, a.assetUrl(hash));
  if (i.state !== "ready") return reconcile(db, i.id, a);
  if (i.session !== (o.auto?.session ?? null)) return i;
  const why = restriction(c);
  if (why) {
    db.prepare(
      "UPDATE intents SET state='review',reason=? WHERE id=? AND state='ready'",
    ).run(why, i.id);
    return row(db, i.id);
  }
  // R2 puts are idempotent. Only the winner of the durable claim can call createPost.
  if ((await hashFile(i.path)) !== i.hash) throw Error("Intent file changed");
  if (i.session && (!o.auto || !allowed(db, o.auto, i.channel)))
    throw Error("Session is no longer enabled");
  try {
    await a.host(i.path, i.hash, i.url);
  } catch (e) {
    recordError(db, i, e);
    throw e;
  }
  const claimed = atomic(db, () => {
    if (until(db, i.channel) > Date.now()) return false;
    if (i.session && (!o.auto || !allowed(db, o.auto, i.channel))) return false;
    return (
      db
        .prepare(
          "UPDATE intents SET state='needs_reconciliation',inFlightUntil=?,reason='Creation may be in flight. Reconcile before taking action.' WHERE id=? AND state='ready'",
        )
        .run(Date.now() + 120000, i.id).changes === 1
    );
  });
  if (!claimed) return row(db, i.id);
  try {
    const remote = await a.provider.create(input(i));
    db.prepare(
      "UPDATE intents SET remoteId=?,inFlightUntil=0,state='pending',reason=NULL WHERE id=? AND state='needs_reconciliation'",
    ).run(remote, i.id);
  } catch (e) {
    db.prepare("UPDATE intents SET inFlightUntil=0 WHERE id=?").run(i.id);
    const current = row(db, i.id);
    recordError(db, current, e);
    if (e instanceof ProviderError && e.definitive)
      db.prepare(
        "UPDATE intents SET state=? WHERE id=? AND state='needs_reconciliation'",
      ).run(e.retryAt ? "ready" : "review", i.id);
    if (!(e instanceof ProviderError && e.definitive))
      return reconcile(db, i.id, a);
    return row(db, i.id);
  }
  return reconcile(db, i.id, a);
}
