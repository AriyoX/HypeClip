import { manifest, runLive } from "./live.ts";
import { claimCaptureSlot } from "./capture-slots.ts";
import { jsonFile } from "./local.ts";
import { capture } from "./capture.ts";
import { collect, collectMany } from "./twitch.ts";
import { timestamp } from "./detector.ts";
import { demo } from "./demo.ts";
import { Command, Option } from "commander";
import { z } from "zod";
import { openDb } from "./db.ts";
import { enable, processSession, processJob } from "./pipeline.ts";
import { detect, readChat, Timing } from "./detector.ts";
import { print } from "./publish-cli.ts";
import { setup } from "./setup.ts";
const integer = (s: string) => z.coerce.number().int().parse(s);
function timing(c: Command) {
  return c
    .requiredOption("--chat <jsonl>")
    .requiredOption(
      "--media-start <iso>",
      "UTC or offset timestamp of first OBS frame",
    )
    .option("--offset-ms <signed>", "Add to mapped media time", integer, 0)
    .option(
      "--reaction-ms <ms>",
      "Subtract from chat spike time",
      integer,
      4000,
    );
}
export function sessionCommands(cli: Command) {
  cli
    .command("live-multi")
    .requiredOption("--manifest <json>")
    .option("--once", "Stop each input after its first decision")
    .action(async (o) => {
      const config = manifest.parse(jsonFile(o.manifest));
      const db = openDb()!;
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      try {
        await runLive(
          db,
          config,
          controller.signal,
          (e) => console.log(JSON.stringify({ at: Date.now(), ...e })),
          o.once,
        );
      } finally {
        process.off("SIGINT", stop);
        db.close();
      }
    });
  cli
    .command("collect-multi")
    .requiredOption(
      "--manifest <json>",
      "Explicitly authorized broadcaster IDs, sessions and chat paths",
    )
    .action(async (o) => {
      const channels = z
        .array(
          z.object({
            broadcaster: z.string().min(1),
            session: z.string().min(1),
            path: z.string().min(1),
          }),
        )
        .min(1)
        .max(2)
        .parse(jsonFile(o.manifest));
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      process.once("SIGINT", stop);
      try {
        print(await collectMany(channels, ctrl.signal));
      } finally {
        process.off("SIGINT", stop);
      }
    });
  timing(cli.command("live"))
    .requiredOption("--session <id>")
    .requiredOption("--port <udp-port>", "Local MPEG-TS input port", integer)
    .requiredOption("--rights", "Confirm recording rights")
    .option("--once", "Stop after producing a clip")
    .action(async (o) => {
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      process.once("SIGINT", stop);
      const db = openDb()!;
      let releaseSlot;
      try {
        releaseSlot=claimCaptureSlot(undefined, "udp:" + o.port);
        await capture(
          db,
          {
            session: o.session,
            chat: o.chat,
            mediaStart: o.mediaStart,
            offsetMs: o.offsetMs,
            reactionMs: o.reactionMs,
            layout: "fit-pad",
            rights: !!o.rights,
          },
          o.port,
          !!o.once,
          ctrl.signal,
          print,
        );
      } finally {
        releaseSlot?.();
        process.removeListener("SIGINT", stop);
        db.close();
      }
    });
  cli
    .command("collect")
    .requiredOption("--session <id>")
    .requiredOption("--chat <jsonl>")
    .option("--source <recording>", "Process this finished OBS file on Ctrl+C")
    .option("--media-start <iso>")
    .option("--rights")
    .option("--offset-ms <signed>", "Signed correction", integer, 0)
    .option("--reaction-ms <ms>", "Reaction delay", integer, 4000)
    .action(async (o) => {
      if (o.source) timestamp.parse(o.mediaStart);
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      process.once("SIGINT", stop);
      try {
        print(await collect(o.session, o.chat, ctrl.signal));
      } finally {
        process.removeListener("SIGINT", stop);
      }
      if (o.source) {
        const db = openDb()!;
        try {
          print(
            await processSession(db, {
              session: o.session,
              chat: o.chat,
              source: o.source,
              mediaStart: o.mediaStart,
              rights: !!o.rights,
              offsetMs: o.offsetMs,
              reactionMs: o.reactionMs,
              layout: "fit-pad",
            }),
          );
        } finally {
          db.close();
        }
      }
    });
  cli
    .command("demo")
    .addOption(
      new Option("--prerendered", "Use saved worker artifacts").conflicts(
        "worker",
      ),
    )
    .option(
      "--worker",
      "Invoke the installed Python worker on the local fixture",
    )
    .action(async (o) => {
      const db = openDb()!;
      try {
        print(await demo(db, !o.prerendered));
      } finally {
        db.close();
      }
    });
  cli.command("setup-ollama").action(async () => print(await setup()));
  timing(cli.command("replay"))
    .requiredOption("--duration-ms <ms>", "Source duration", integer)
    .option("--live", "Wait for complete post-roll")
    .action((o) => print(detect(readChat(o.chat), Timing.parse(o))));
  timing(cli.command("process"))
    .requiredOption("--session <id>")
    .requiredOption("--source <recording>")
    .option("--rights", "Confirm recording and reuse rights")
    .addOption(
      new Option("--layout <layout>")
        .choices(["fit-pad", "center-crop"])
        .default("fit-pad"),
    )
    .action(async (o) => {
      const db = openDb()!;
      try {
        print(
          await processSession(db, { ...o, rights: !!o.rights } as Parameters<
            typeof processSession
          >[1]),
        );
      } finally {
        db.close();
      }
    });
  cli
    .command("evaluate <id>")
    .description("Retry a saved candidate using local Ollama")
    .action(async (id) => {
      const db = openDb()!;
      try {
        print(await processJob(db, id, undefined, true));
      } finally {
        db.close();
      }
    });
  cli
    .command("auto-enable")
    .requiredOption("--session <id>")
    .requiredOption("--source <recording>")
    .requiredOption("--channel <id>")
    .requiredOption("--cap <count>", "Maximum intents per session", integer)
    .addOption(
      new Option("--mode <mode>")
        .choices(["addToQueue", "shareNow"])
        .default("addToQueue"),
    )
    .option("--rights", "Confirm source and publication rights")
    .action((o) => {
      const db = openDb()!;
      try {
        enable(db, o.session, o.source, o.channel, o.cap, !!o.rights, o.mode);
        print({
          enabled: o.session,
          channel: o.channel,
          cap: o.cap,
          mode: o.mode,
        });
      } finally {
        db.close();
      }
    });
  cli
    .command("auto-off")
    .option("--session <id>")
    .action((o) => {
      const db = openDb()!;
      try {
        if (o.session)
          db.prepare("DELETE FROM policy WHERE session=?").run(o.session);
        else db.exec("DELETE FROM policy");
        print({ disabled: o.session || "all" });
      } finally {
        db.close();
      }
    });
}
