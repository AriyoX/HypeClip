import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createReadStream,
  statSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, hashFile } from "./local.ts";
import { probe } from "./probe.ts";
export function assetUrl(hash: string) {
  const base = new URL(env("HYPECLIP_R2_PUBLIC_URL"));
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error("Use a permanent public HTTPS R2 URL");
  return base.href.replace(/\/$/, "") + "/clips/" + hash + ".mp4";
}
export async function host(path: string, hash: string, url: string) {
  const account = env("HYPECLIP_R2_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/i.test(account)) throw Error("Invalid R2 account ID");
  const client = new S3Client({
    requestChecksumCalculation: "WHEN_REQUIRED",
    region: "auto",
    endpoint: "https://" + account + ".r2.cloudflarestorage.com",
    credentials: {
      accessKeyId: env("HYPECLIP_R2_ACCESS_KEY_ID"),
      secretAccessKey: env("HYPECLIP_R2_SECRET_ACCESS_KEY"),
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "hypeclip-upload-"));
  const final = join(dir, "final.mp4");
  try {
    copyFileSync(path, final);
    if ((await hashFile(final)) !== hash)
      throw Error("Selected video changed during preparation");
    await probe(final, true);
    await client.send(
      new PutObjectCommand({
        Bucket: env("HYPECLIP_R2_BUCKET"),
        Key: "clips/" + hash + ".mp4",
        IfNoneMatch: "*",
        Body: createReadStream(final),
        ContentLength: statSync(final).size,
        ContentType: "video/mp4",
      }),
    );
  } catch (e) {
    if (
      (e as { $metadata?: { httpStatusCode: number } }).$metadata
        ?.httpStatusCode !== 412
    )
      throw e;
  } finally {
    client.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";")[0] !== "video/mp4" ||
    !response.body
  )
    throw Error(
      "Anonymous public video check failed (" + response.status + ")",
    );
  const digest = createHash("sha256");
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
    digest.update(chunk);
  if (digest.digest("hex") !== hash)
    throw Error("Public video digest mismatch");
}
