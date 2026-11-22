import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jsonFile, stateDir, writeJson } from "./local.ts";

const groups = [
  {
    id: "twitch",
    label: "Twitch chat",
    fields: [
      { key: "TWITCH_USER_TOKEN", label: "User token", secret: true },
      { key: "TWITCH_BROADCASTER_ID", label: "Broadcaster ID for collect" },
    ],
  },
  {
    id: "youtube",
    label: "YouTube chat",
    fields: [
      { key: "YOUTUBE_API_KEY", label: "Data API key", secret: true },
      {
        key: "YOUTUBE_ACCESS_TOKEN",
        label: "OAuth access token",
        secret: true,
      },
    ],
  },
  {
    id: "buffer",
    label: "Buffer",
    fields: [
      { key: "BUFFER_ACCESS_TOKEN", label: "API key", secret: true },
      { key: "BUFFER_CHANNEL_ID", label: "TikTok channel ID" },
    ],
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    fields: [
      { key: "HYPECLIP_R2_ACCOUNT_ID", label: "Account ID" },
      { key: "HYPECLIP_R2_BUCKET", label: "Bucket name" },
      {
        key: "HYPECLIP_R2_ACCESS_KEY_ID",
        label: "Access key ID",
        secret: true,
      },
      {
        key: "HYPECLIP_R2_SECRET_ACCESS_KEY",
        label: "Secret access key",
        secret: true,
      },
      { key: "HYPECLIP_R2_PUBLIC_URL", label: "Public media URL" },
      {
        key: "HYPECLIP_CHANNEL_REQUIREMENTS",
        label: "Manual posting requirements",
      },
    ],
  },
] as const;
const fields = groups.flatMap((group) => [...group.fields]);
const keys = fields.map((field) => field.key);
const secretKeys = new Set<string>(
  fields.filter((field) => "secret" in field).map((field) => field.key),
);
const settings = z.partialRecord(
  z.enum(keys),
  z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value) && !/^<.*>$/.test(value))
    .nullable(),
);

export function loadConfiguration() {
  const isolated = !!process.env.HYPECLIP_ISOLATED;
  const inherited = new Set(
    keys.filter((key) => process.env[key] !== undefined),
  );
  if (!isolated && existsSync(".env")) process.loadEnvFile(".env");

  const path = join(stateDir(), "connections.json");
  let saved: z.infer<typeof settings> = {};
  if (!isolated && existsSync(path)) {
    try {
      saved = settings.parse(jsonFile(path));
    } catch {
      throw Error("Couldn’t read the connection settings at " + path);
    }
  }
  function apply() {
    for (const key of keys) {
      if (!inherited.has(key) && Object.hasOwn(saved, key))
        process.env[key] = saved[key] ?? "";
    }
  }
  apply();

  return {
    status() {
      return groups.map(({ id, label, fields }) => ({
        id,
        label,
        fields: fields.map((field) => ({
          ...field,
          configured: !!process.env[field.key]?.trim(),
          locked: isolated || inherited.has(field.key),
        })),
      }));
    },
    save(value: unknown) {
      if (isolated)
        throw Error("Restart without HYPECLIP_ISOLATED to save connections.");
      const updates = settings.safeParse(value);
      if (!updates.success)
        throw Error("Enter a valid connection value on one line.");
      const changed = keys.filter((key) => Object.hasOwn(updates.data, key));
      if (!changed.length) throw Error("Enter a value to save.");
      for (const key of changed) {
        if (inherited.has(key))
          throw Error(key + " is set by the launch environment.");
        const entry = updates.data[key];
        if (
          secretKeys.has(key) &&
          entry &&
          (entry.length < 8 ||
            /\s/.test(entry) ||
            keys.some((name) => name === entry))
        )
          throw Error("Paste the full token or key without spaces.");
      }
      const next = { ...saved, ...updates.data };
      writeJson(path, next);
      saved = next;
      apply();
      return changed;
    },
  };
}

export type Connections = ReturnType<typeof loadConfiguration>;
