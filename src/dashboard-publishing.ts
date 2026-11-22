import { join } from "node:path";
import { assetUrl } from "./asset.ts";
import {
  buffer,
  bufferOrganizations,
  bufferTikTokChannels,
  restriction,
} from "./buffer.ts";
import { openDb } from "./db.ts";

const bufferKeys = ["BUFFER_ACCESS_TOKEN", "BUFFER_CHANNEL_ID"] as const;
const r2Keys = [
  "HYPECLIP_R2_ACCOUNT_ID",
  "HYPECLIP_R2_BUCKET",
  "HYPECLIP_R2_ACCESS_KEY_ID",
  "HYPECLIP_R2_SECRET_ACCESS_KEY",
  "HYPECLIP_R2_PUBLIC_URL",
] as const;
const present = (name: string) => {
  const value = process.env[name]?.trim();
  return !!value && !/^<.*>$/.test(value);
};

function policyStatus() {
  try {
    const db = openDb(true);
    if (!db) return { state: "off", sessions: 0 };
    try {
      const { total, matching } = db
        .prepare(
          "SELECT count(*) total, count(CASE WHEN channel=? THEN 1 END) matching FROM policy",
        )
        .get(process.env.BUFFER_CHANNEL_ID ?? "")!;
      const sessions = Number(total);
      return {
        state: !sessions
          ? "off"
          : Number(matching)
            ? "enabled"
            : "other-destination",
        sessions: Number(matching) || sessions,
      };
    } finally {
      db.close();
    }
  } catch {
    return { state: "unavailable", sessions: 0 };
  }
}

function r2Status() {
  const requirements = r2Keys.map((key) => ({
    key,
    status: present(key) ? "present" : "missing",
  }));
  if (
    present(r2Keys[0]) &&
    !/^[a-f\d]{32}$/i.test(process.env[r2Keys[0]]!.trim())
  )
    requirements[0].status = "invalid";
  if (present(r2Keys[4])) {
    try {
      const url = new URL(assetUrl("check"));
      if (url.hostname.endsWith(".r2.cloudflarestorage.com"))
        requirements[4].status = "api-endpoint";
    } catch {
      requirements[4].status = "invalid";
    }
  }
  return requirements;
}

// Dashboard checks use Buffer reads only. No policy writes, asset hosting, or post creation.
export function dashboardPublishing() {
  let connection: "unchecked" | "verified" | "failed" = "unchecked";
  let destination: "unchecked" | "verified" | "disconnected" | "failed" =
    "unchecked";
  let name = "",
    requirement = "";

  return {
    status() {
      return {
        envPath: join(process.cwd(), ".env"),
        buffer: present(bufferKeys[0]) ? connection : "missing",
        destination: present(bufferKeys[1]) ? destination : "missing",
        name,
        requirement,
        r2: r2Status(),
        automatic: policyStatus(),
      };
    },
    async check() {
      if (!present(bufferKeys[0]) || !present(bufferKeys[1]))
        throw Error(
          "Add the Buffer API key and TikTok channel ID to .env, then restart HypeClip.",
        );
      try {
        // Match the destination setting and the adapter used for a live send.
        const channel = await buffer.channel(process.env.BUFFER_CHANNEL_ID!);
        connection = "verified";
        destination = channel.isDisconnected ? "disconnected" : "verified";
        name = channel.name;
        const reason = restriction(channel);
        requirement =
          reason && reason === process.env.HYPECLIP_CHANNEL_REQUIREMENTS
            ? "Manual posting requirements are configured in .env."
            : reason;
      } catch {
        connection = "failed";
        destination = "failed";
        name = requirement = "";
      }
    },
    async find() {
      if (!present(bufferKeys[0]))
        throw Error("Add the Buffer API key to .env, then restart HypeClip.");
      let authenticated = false;
      try {
        const organizations = await bufferOrganizations();
        connection = "verified";
        authenticated = true;
        const found = [];
        for (const org of organizations) {
          for (const channel of await bufferTikTokChannels(org.id))
            found.push({
              id: channel.id,
              name: channel.displayName || channel.name,
              organization: org.name,
            });
        }
        return found;
      } catch {
        if (!authenticated) connection = "failed";
        throw Error(
          "Couldn’t list TikTok channels. Check your Buffer API key and try again.",
        );
      }
    },
  };
}
