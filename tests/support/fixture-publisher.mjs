import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveAdapter } from "../../src/publisher.ts";
import { sameAsset } from "../../src/buffer.ts";
import { jsonFile } from "../../src/local.ts";

const fixture = jsonFile("tests/fixtures/buffer.json");
const ledger = join(process.env.HYPECLIP_HOME, "provider.jsonl");
const record = (entry) => appendFileSync(ledger, JSON.stringify(entry) + "\n");
const posts = () =>
  readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.post)
    .map((entry) => entry.post);
liveAdapter.assetUrl = (hash) =>
  "https://hypeclip.invalid/clips/" + hash + ".mp4";
liveAdapter.host = async (_path, hash) => {
  record({ operation: "mock-upload", hash });
};
liveAdapter.provider = {
  channel: async (id) => {
    if (id !== fixture.channel.id) throw Error("Unknown fixture channel");
    return fixture.channel;
  },
  create: async (input) => {
    const post = {
      ...fixture.post,
      text: input.text,
      assets: [{ source: input.url }],
    };
    record({ operation: "mock-create", mode: input.mode, post });
    return post.id;
  },
  read: async (id) => {
    const post = posts().find((row) => row.id === id);
    if (!post) throw Error("Unknown fixture post");
    record({ operation: "mock-status", id });
    return post;
  },
  matches: async (_channel, input) =>
    posts().filter((post) => sameAsset(post, input)),
};
