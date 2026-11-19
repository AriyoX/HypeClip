import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atomic } from "./db.ts";
import { detect, readChat, highlightId, Timing } from "./detector.ts";
import type { Spike } from "./detector.ts";
import { render, validateOutput, InvalidWorkerOutput } from "./worker.ts";
import type { Request, Result } from "./worker.ts";
import { evaluate } from "./evaluator.ts";
import { probe } from "./probe.ts";
import type { Intent } from "./publisher.ts";
import type { Mode } from "./buffer.ts";
import { publish, liveAdapter, reconcile } from "./publisher.ts";
import { safeMessage, stateDir, fixturePath } from "./local.ts";
export const runtime = { render, evaluate, publisher: liveAdapter };
export interface Session {
  session: string;
  source: string;
  chat: string;
  mediaStart: string;
  offsetMs: number;
  reactionMs: number;
  rights: boolean;
  fixture?: boolean;
  live?: boolean;
  layout: "fit-pad" | "center-crop";
}
interface Details {
  request: Request;
  spike: Spike;
  rights: boolean;
  fixture: boolean;
}
export function enable(
  db: DatabaseSync,
  session: string,
  source: string,
  channel: string,
  cap: number,
  rights: boolean,
  mode: Mode = "addToQueue",
) {
  source = realpathSync(source);
  if (
    !rights ||
    fixturePath(source) ||
    session === "demo" ||
    !Number.isSafeInteger(cap) ||
    cap < 1
  )
    throw Error(
      "Select a real source, confirm rights and choose a positive session cap",
    );
  if (channel !== process.env.BUFFER_CHANNEL_ID)
    throw Error("Destination must match BUFFER_CHANNEL_ID");
  atomic(db, () => {
    const other = db
      .prepare("SELECT channel FROM policy WHERE channel<>?")
      .get(channel);
    if (other) throw Error("Disable the previous destination first");
    db.prepare(
      "INSERT INTO policy(session,source,channel,cap,mode) VALUES(?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET source=excluded.source,channel=excluded.channel,cap=excluded.cap,mode=excluded.mode",
    ).run(session, source, channel, cap, mode);
  });
}
function snapshot(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "SELECT j.id,coalesce(i.state,j.state) state,coalesce(i.reason,j.reason) reason,j.result,j.evaluation,j.intent FROM jobs j LEFT JOIN intents i ON j.intent=i.id WHERE j.id=?",
    )
    .get(id)!;
}
function ownerAlive(owner: string) {
  const pid = Number(owner.split("-")[0]);
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function processJob(
  db: DatabaseSync,
  id: string,
  rt = runtime,
  retry = false,
) {
  const linked = db
    .prepare(
      "SELECT i.*,j.source FROM jobs j JOIN intents i ON j.intent=i.id WHERE j.id=?",
    )
    .get(id) as unknown as (Intent & { source: string }) | undefined;
  if (linked) {
    if (
      linked.state === "ready" &&
      linked.session &&
      db
        .prepare(
          "SELECT 1 FROM policy WHERE session=? AND source=? AND channel=?",
        )
        .get(linked.session, linked.source, linked.channel) &&
      linked.channel === process.env.BUFFER_CHANNEL_ID
    ) {
      await publish(
        db,
        {
          path: linked.path,
          expectedHash: linked.hash,
          highlight: id,
          caption: linked.caption,
          channel: linked.channel,
          mode: linked.mode,
          live: true,
          auto: { session: linked.session, source: linked.source },
        },
        rt.publisher,
      );
    } else await reconcile(db, linked.id, rt.publisher);
    return snapshot(db, id);
  }
  const owner = process.pid + "-" + randomUUID();
  const job = atomic(db, () => {
    const j = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!j) throw Error("Unknown clip ID");
    if (
      j.owner &&
      Number(j.leaseUntil) > Date.now() &&
      ownerAlive(String(j.owner))
    )
      return;
    if (
      j.intent ||
      (!retry &&
        ![
          "queued",
          "rendering",
          "evaluating",
          "accepted",
          "render_error",
        ].includes(String(j.state)))
    )
      return;
    db.prepare("UPDATE jobs SET owner=?,leaseUntil=? WHERE id=?").run(
      owner,
      Date.now() + 2 * 3600000,
      id,
    );
    return j;
  });
  if (!job) return snapshot(db, id);
  const details: Details = JSON.parse(String(job.details));
  let phase = "render_error";
  const update = (state: string, reason: string | null = null) =>
    db
      .prepare("UPDATE jobs SET state=?,reason=? WHERE id=? AND owner=?")
      .run(state, reason, id, owner);
  try {
    let result: Result;
    const request = details.request;
    if (job.result) {
      result = JSON.parse(String(job.result));
    } else {
      update("rendering");
      result = await rt.render(request);
    }
    phase = "invalid_output";
    const transcript = await validateOutput(request, result);
    db.prepare(
      "UPDATE jobs SET result=?,state='evaluating' WHERE id=? AND owner=?",
    ).run(JSON.stringify(result), id, owner);
    phase = "review";
    const evaluation = await rt.evaluate(transcript, details.spike);
    atomic(db, () => {
      const outcome = JSON.stringify(evaluation);
      db.prepare(
        "INSERT INTO evaluations(job,evaluatedAt,provider,model,outcome) VALUES(?,?,?,?,?)",
      ).run(
        id,
        new Date().toISOString(),
        evaluation.provider,
        evaluation.model,
        outcome,
      );
      db.prepare("UPDATE jobs SET evaluation=? WHERE id=? AND owner=?").run(
        outcome,
        id,
        owner,
      );
    });
    const decision = evaluation.decision;
    if (!decision || evaluation.error) {
      update("review", evaluation.error || "Evaluation missing");
    } else if (decision.decision === "reject") {
      update("rejected", decision.reason);
    } else if (
      !details.rights ||
      result.qualityFlags.length ||
      !transcript.segments.length ||
      decision.decision !== "accept" ||
      decision.reviewFlags.length ||
      !decision.suggestedCaption.trim()
    ) {
      update(
        "review",
        [
          !details.rights ? "Source rights unconfirmed" : "",
          ...result.qualityFlags,
          ...decision.reviewFlags,
          !transcript.segments.length ? "Visual-only event" : "",
          decision.reason,
        ]
          .filter(Boolean)
          .join(". "),
      );
    } else {
      const policy = db
        .prepare("SELECT channel,mode FROM policy WHERE session=? AND source=?")
        .get(job.session, job.source);
      if (
        details.fixture ||
        !evaluation.verified ||
        !policy ||
        policy.channel !== process.env.BUFFER_CHANNEL_ID
      ) {
        update(
          "review",
          details.fixture
            ? "Local fixture"
            : !evaluation.verified
              ? "Model has not passed setup-ollama"
              : "Accepted for local review",
        );
      } else {
        update("accepted");
        const outcome = await publish(
          db,
          {
            path: result.verticalPath,
            expectedHash: result.sha256,
            highlight: id,
            caption: decision.suggestedCaption,
            channel: String(policy.channel),
            mode: policy.mode as Mode,
            live: true,
            auto: { session: String(job.session), source: String(job.source) },
          },
          rt.publisher,
        );
        if (!("id" in outcome)) throw Error("Missing publish intent");
        db.prepare(
          "UPDATE jobs SET intent=?,state=?,reason=? WHERE id=? AND owner=?",
        ).run(outcome.id, outcome.state, outcome.reason, id, owner);
      }
    }
  } catch (e) {
    update(
      e instanceof InvalidWorkerOutput ? "invalid_output" : phase,
      safeMessage(e),
    );
  } finally {
    db.prepare(
      "UPDATE jobs SET owner=NULL,leaseUntil=NULL WHERE id=? AND owner=?",
    ).run(id, owner);
  }
  return snapshot(db, id);
}
export async function processSession(
  db: DatabaseSync,
  s: Session,
  rt = runtime,
) {
  const source = realpathSync(s.source),
    chatPath = realpathSync(s.chat);
  const { durationMs } = await probe(source);
  const chat = readChat(chatPath, !!s.live);
  const timing = Timing.parse({ ...s, durationMs });
  const fixture =
    !!s.fixture ||
    fixturePath(source) ||
    fixturePath(chatPath) ||
    chat.some((m) => m.fixture);
  const session = [
    s.session,
    source,
    timing.mediaStart,
    timing.offsetMs,
    timing.reactionMs,
    Number(fixture),
  ] as const;
  atomic(db, () => {
    db.prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?)").run(
      ...session,
    );
    if (
      !db
        .prepare(
          "SELECT id FROM sessions WHERE id=? AND source=? AND mediaStart=? AND offsetMs=? AND reactionMs=? AND fixture=?",
        )
        .get(...session)
    )
      throw Error(
        "Session already bound to another source, mapping or provenance",
      );
  });
  const records = [];
  for (const spike of detect(chat, timing)) {
    if (!spike.ready) continue;
    const id = highlightId(s.session, spike);
    if (
      s.live &&
      db
        .prepare(
          "SELECT 1 FROM jobs WHERE session=? AND id<>? AND json_extract(details,'$.spike.startMs')<? AND json_extract(details,'$.spike.endMs')>?",
        )
        .get(s.session, id, spike.endMs, spike.startMs)
    )
      continue;
    const request: Request = {
      version: 1,
      candidate: {
        sessionId: s.session,
        candidateId: id,
        sourcePath: source,
        startMs: spike.startMs,
        endMs: spike.endMs,
        outputDir: join(stateDir(), "clips", id),
      },
      output: { width: 1080, height: 1920, layout: s.layout },
    };
    const details: Details = {
      request,
      spike,
      fixture,
      rights:
        s.rights ||
        !!db
          .prepare(
            "SELECT session FROM policy WHERE session=? AND source=? AND channel=?",
          )
          .get(s.session, source, process.env.BUFFER_CHANNEL_ID || ""),
    };
    db.prepare(
      "INSERT OR IGNORE INTO jobs(id,session,source,state,details) VALUES(?,?,?,'queued',?)",
    ).run(id, s.session, source, JSON.stringify(details));
    records.push(await processJob(db, id, rt));
  }
  return records;
}
