import { setTimeout as sleep } from "node:timers/promises";
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { env } from "./local.ts";
import { openDb, status } from "./db.ts";
import { publish, reconcile } from "./publisher.ts";
export const print = (v: unknown) =>
  console.log(
    JSON.stringify(
      v,
      (k, value) =>
        ["result", "evaluation", "contributions"].includes(k) &&
        typeof value === "string"
          ? JSON.parse(value)
          : value,
      2,
    ),
  );
export function publisherCommands(cli: Command) {
  cli
    .command("status")
    .description("Read local jobs, publishing intents and policy")
    .action(() => print(status()));
  cli
    .command("publish")
    .requiredOption("--file <mp4>")
    .requiredOption("--highlight <id>")
    .requiredOption("--caption-file <path>")
    .option(
      "--channel <id>",
      "Confirm configured TikTok destination for live send",
    )
    .addOption(
      new Option("--mode <mode>")
        .choices(["shareNow", "addToQueue"])
        .default("addToQueue"),
    )
    .addOption(new Option("--dry-run").conflicts("live"))
    .option("--live", "Upload and send the selected video")
    .action(async (o) => {
      const channel = o.live
        ? env("BUFFER_CHANNEL_ID")
        : process.env.BUFFER_CHANNEL_ID || "unconfigured";
      if (o.live && o.channel !== channel)
        throw Error("--live requires --channel matching BUFFER_CHANNEL_ID");
      const db = openDb(!o.live);
      try {
        print(
          await publish(db, {
            path: o.file,
            highlight: o.highlight,
            caption: readFileSync(o.captionFile, "utf8").trim(),
            channel,
            mode: o.mode,
            live: !!o.live,
          }),
        );
      } finally {
        db?.close();
      }
    });
  cli
    .command("sync")
    .description("Refresh pending Buffer posts")
    .option("--watch", "Continue until pending posts settle")
    .action(async (o) => {
      const db = openDb()!;
      try {
        do {
          const pending = db
            .prepare("SELECT id FROM intents WHERE state='pending'")
            .all();
          if (!pending.length) break;
          for (const row of pending) print(await reconcile(db, Number(row.id)));
          if (
            !o.watch ||
            !db.prepare("SELECT 1 FROM intents WHERE state='pending'").get()
          )
            break;
          await sleep(30000);
        } while (true);
      } finally {
        db.close();
      }
    });
  cli
    .command("reconcile <intent>")
    .option("--post-id <id>", "Verify a specific remote post")
    .addOption(
      new Option(
        "--close-unposted",
        "Confirm manual verification that Buffer has no post and retire this intent",
      ).conflicts("postId"),
    )
    .action(async (id, o) => {
      const db = openDb()!;
      try {
        const intent = z.coerce.number().int().positive().parse(id);
        if (o.closeUnposted) {
          const r = db
            .prepare(
              "UPDATE intents SET state='closed_unposted',reason='Operator confirmed no remote post' WHERE id=? AND state='needs_reconciliation' AND remoteId IS NULL AND inFlightUntil<=?",
            )
            .run(intent, Date.now());
          if (!r.changes)
            throw Error("Only unresolved creations can be closed");
        }
        print(await reconcile(db, intent, undefined, o.postId));
      } finally {
        db.close();
      }
    });
}
