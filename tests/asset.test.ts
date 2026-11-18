import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { hashFile } from "../src/local.ts";
import { host, assetUrl } from "../src/asset.ts";
const file = "tests/fixtures/portrait.mp4";
beforeEach(() => {
  for (const [k, v] of Object.entries({
    HYPECLIP_R2_ACCOUNT_ID: "a".repeat(32),
    HYPECLIP_R2_BUCKET: "fixture-bucket",
    HYPECLIP_R2_ACCESS_KEY_ID: "test-id",
    HYPECLIP_R2_SECRET_ACCESS_KEY: "test-secret",
    HYPECLIP_R2_PUBLIC_URL: "https://example.invalid",
  }))
    vi.stubEnv(k, v);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each(["uploaded", "existing", "bad digest", "login required"])(
  "verifies %s anonymously and preserves object identity",
  async (mode) => {
    const hash = await hashFile(file),
      url = assetUrl(hash),
      bytes = readFileSync(file);
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async (command) => {
        if (!(command instanceof PutObjectCommand))
          throw Error("Expected PutObject");
        const cmd = command;
        expect(cmd.input).toMatchObject({
          Bucket: "fixture-bucket",
          Key: "clips/" + hash + ".mp4",
          IfNoneMatch: "*",
          ContentType: "video/mp4",
        });
        const chunks = [];
        for await (const chunk of cmd.input.Body as AsyncIterable<Buffer>)
          chunks.push(chunk);
        expect(Buffer.concat(chunks)).toEqual(bytes);
        if (mode === "existing")
          throw Object.assign(Error("Exists"), {
            $metadata: { httpStatusCode: 412 },
          });
        return {};
      });
    const get = vi.fn(
      async () =>
        new Response(mode === "bad digest" ? "other bytes" : bytes, {
          headers: { "Content-Type": "video/mp4" },
          status: mode === "login required" ? 403 : 200,
        }),
    );
    vi.stubGlobal("fetch", get);
    if (mode === "login required" || mode === "bad digest")
      await expect(host(file, hash, url)).rejects.toThrow();
    else await host(file, hash, url);
    expect(send).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      "https://example.invalid/clips/" + hash + ".mp4",
      { redirect: "error", signal: expect.any(AbortSignal) },
    );
  },
);
it("rejects expiring URLs and credentials on the public origin", () => {
  for (const url of [
    "http://example.invalid",
    "https://a:b@example.invalid",
    "https://example.invalid?sig=abc",
  ]) {
    vi.stubEnv("HYPECLIP_R2_PUBLIC_URL", url);
    expect(() => assetUrl("hash")).toThrow();
  }
});
