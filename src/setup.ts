import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { freemem, totalmem, platform, release } from "node:os";
import { statfsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { localModel, writeJson, modelFile } from "./local.ts";
import { chatSchema } from "./evaluator.ts";
const exec = promisify(execFile);
async function inventory(url: string) {
  const res = await fetch(url + "/api/tags", {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!res.ok) throw Error("Ollama tags HTTP " + res.status);
  return z
    .object({
      models: z.array(
        z.object({
          name: z.string(),
          size: z.number(),
          remote_model: z.string().optional(),
          capabilities: z.array(z.string()).optional(),
        }),
      ),
    })
    .parse(await res.json()).models;
}
export async function setup() {
  const disk = statfsSync(process.cwd());
  const gpu = await exec(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"],
    { windowsHide: true },
  )
    .then((r) => r.stdout.trim())
    .catch(() => null);
  const hardware = {
    os: platform() + " " + release(),
    freeRam: freemem(),
    totalRam: totalmem(),
    freeDisk: disk.bavail * disk.bsize,
    gpu,
  };
  console.log(JSON.stringify(hardware));
  const config = localModel();
  let base = config.baseUrl;
  let models = await inventory(base).catch(() => null);
  if (!models && /microsoft/i.test(release())) {
    const route = await exec("ip", ["route", "show", "default"]).catch(() => ({
      stdout: "",
    }));
    const ip = route.stdout.match(/via (\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (ip) {
      const windows = "http://" + ip + ":11434";
      models = await inventory(windows).catch(() => null);
      if (models) base = windows;
    }
  }
  if (!models) {
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    for (let attempt = 0; attempt < 12 && !models; attempt++) {
      await sleep(500);
      models = await inventory(base).catch(() => null);
    }
  }
  if (!models) throw Error("Local Ollama service unavailable at " + base);
  console.log("Installed models: " + models.map((m) => m.name).join(", "));
  const schema = z.strictObject({
    decision: z.enum(["review", "accept", "reject"]),
    score: z.number().int().min(0).max(100),
  });
  async function verify(tag: string) {
    const result = schema.parse(
      await chatSchema(
        base,
        tag,
        "Follow the requested decision and score exactly.",
        { decision: "review", score: 42 },
        z.toJSONSchema(schema),
      ),
    );
    if (result.decision !== "review" || result.score !== 42)
      throw Error("Model failed instruction check");
  }
  const candidates = models
    .filter(
      (m) =>
        !m.remote_model &&
        !/cloud|embed/i.test(m.name) &&
        m.size > 0 &&
        m.size < totalmem() * 0.7 &&
        (!m.capabilities || m.capabilities.includes("completion")),
    )
    .sort(
      (a, b) =>
        Number(b.name === config.model) - Number(a.name === config.model) ||
        a.size - b.size,
    );
  let tag = "",
    downloaded = false;
  for (const m of candidates) {
    try {
      await verify(m.name);
      tag = m.name;
      break;
    } catch {
      console.log("Structured-output check failed: " + m.name);
    }
  }
  if (!tag) {
    tag = "qwen3:4b";
    const pull = await fetch(base + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag, stream: false }),
      signal: AbortSignal.timeout(3600000),
    });
    if (!pull.ok || (await pull.json()).status !== "success")
      throw Error("Ollama pull failed");
    await verify(tag);
    downloaded = !models.some((m) => m.name === tag);
  }
  writeJson(modelFile(), { baseUrl: base, model: tag });
  return { model: tag, baseUrl: base, downloaded, config: modelFile() };
}
