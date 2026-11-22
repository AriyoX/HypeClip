import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { freemem, totalmem, platform, release } from "node:os";
import { statfsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { localModel, writeJson, modelFile } from "./local.ts";
import { chatSchema } from "./evaluator.ts";
import { workerEnv } from "./worker.ts";
const exec = promisify(execFile);
const defaultModel = "qwen3:4b";
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
type Model = Awaited<ReturnType<typeof inventory>>[number];
const matches = (name: string, tag: string) =>
  name === tag || (!tag.includes(":") && name === tag + ":latest");
const localCompletion = (model: Model) =>
  !model.remote_model &&
  !/cloud|embed/i.test(model.name) &&
  model.size > 0 &&
  (!model.capabilities || model.capabilities.includes("completion"));

export async function ollamaStatus() {
  const config = localModel();
  const models = await inventory(config.baseUrl).catch(() => null);
  return {
    service: !!models,
    model:
      config.verified &&
      models?.some((m) => matches(m.name, config.model) && localCompletion(m))
        ? config.model
        : "",
  };
}

export async function setup(progress?: (message: string) => void) {
  const report = progress ?? console.log;
  if (!progress) {
    const disk = statfsSync(process.cwd());
    const gpu = await exec(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"],
      { windowsHide: true, timeout: 5000 },
    )
      .then((r) => r.stdout.trim())
      .catch(() => null);
    console.log(
      JSON.stringify({
        os: platform() + " " + release(),
        freeRam: freemem(),
        totalRam: totalmem(),
        freeDisk: disk.bavail * disk.bsize,
        gpu,
      }),
    );
  }
  const config = localModel();
  const requested = process.env.OLLAMA_MODEL;
  if (requested && /cloud|embed/i.test(requested))
    throw Error("Choose a local text model in OLLAMA_MODEL.");
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
    report("Starting Ollama…");
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...workerEnv(),
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => /^OLLAMA_/.test(key)),
        ),
      },
    });
    child.on("error", () => {});
    child.unref();
    for (let attempt = 0; attempt < 12 && !models; attempt++) {
      await sleep(500);
      models = await inventory(base).catch(() => null);
    }
  }
  if (!models) throw Error("Local Ollama service unavailable at " + base);
  if (!progress)
    console.log("Installed models: " + models.map((m) => m.name).join(", "));
  const schema = z.strictObject({
    decision: z.enum(["review", "accept", "reject"]),
    score: z.number().int().min(0).max(100),
  });
  async function verify(tag: string) {
    report("Verifying " + tag + "…");
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
        localCompletion(m) &&
        (requested ? matches(m.name, requested) : m.size < totalmem() * 0.7),
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
      await verify(requested || m.name);
      tag = requested || m.name;
      break;
    } catch {
      if (requested)
        throw Error(
          "The model in OLLAMA_MODEL failed the structured-output check.",
        );
      if (!progress) console.log("Structured-output check failed: " + m.name);
    }
  }
  if (!tag) {
    tag = requested || defaultModel;
    const installed = models.find((m) => matches(m.name, tag));
    if (installed && !localCompletion(installed))
      throw Error("Choose a local Ollama text model.");
    if (!installed) {
      report("Downloading " + tag + "…");
      const pull = await fetch(base + "/api/pull", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: tag, stream: false }),
        signal: AbortSignal.timeout(3600000),
      }).catch(() => null);
      if (!pull?.ok || (await pull.json()).status !== "success")
        throw Error(
          "Couldn’t download " +
            tag +
            ". Check Ollama, your connection and free disk space, then retry.",
        );
      downloaded = true;
    }
    await verify(tag);
  }
  writeJson(modelFile(), { baseUrl: base, model: tag });
  return { model: tag, baseUrl: base, downloaded, config: modelFile() };
}
