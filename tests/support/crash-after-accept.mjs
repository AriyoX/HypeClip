import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "../../src/db.ts";
import { jsonFile } from "../../src/local.ts";
import { publish } from "../../src/publisher.ts";

const fixture = jsonFile("tests/fixtures/buffer.json");
const remote = resolve(process.env.HYPECLIP_HOME, "remote.jsonl");
await publish(
  openDb(),
  {
    path: resolve("tests/fixtures/portrait.mp4"),
    channel: "test",
    caption: "caption",
    highlight: "h1",
    live: true,
    mode: "shareNow",
  },
  {
    host: async () => {},
    assetUrl: () => "https://example.invalid/asset.mp4",
    provider: {
      channel: async () => fixture.channel,
      create: async (input) => {
        const accepted = {
          ...fixture.post,
          channelId: input.channelId,
          text: input.text,
          assets: [{ source: input.url }],
        };
        appendFileSync(remote, JSON.stringify(accepted) + "\n", {
          flush: true,
        });
        process.exit(86);
      },
    },
  },
);
