import { execFile } from "node:child_process";
import { verify } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Chat } from "./detector.ts";
import { collectMany, identity } from "./twitch.ts";
import { stateDir } from "./local.ts";

export function identify(raw: string) {
  const u = new URL(raw),
    host = u.hostname.toLowerCase().replace(/^www\./, ""),
    parts = u.pathname.split("/").filter(Boolean);
  if (u.protocol !== "https:" || u.port || u.username || u.password)
    throw Error("Use an HTTPS platform URL");
  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host === "m.youtube.com"
  ) {
    const id =
      host === "youtu.be"
        ? parts[0]
        : u.searchParams.get("v") ||
          (["live", "shorts"].includes(parts[0]) ? parts[1] : undefined);
    if (id && /^[\w-]{11}$/.test(id))
      return { platform: "youtube", handle: id, video: id } as const;
    if (parts[0]?.startsWith("@") && (!parts[1] || parts[1] === "live"))
      return { platform: "youtube", handle: parts[0] } as const;
  }
  if (host === "twitch.tv" && parts[0])
    return {
      platform: "twitch",
      handle: parts[0] === "videos" ? parts[1] : parts[0],
    } as const;
  if (host === "kick.com" && parts[0])
    return { platform: "kick", handle: parts[0] } as const;
  if (
    host === "tiktok.com" &&
    /^@[\w.-]+$/.test(parts[0]) &&
    (!parts[1] || parts[1] === "live")
  )
    return { platform: "tiktok", handle: parts[0] } as const;
  throw Error("Expected a Twitch, YouTube Live, Kick or TikTok LIVE URL");
}
export type Platform = ReturnType<typeof identify>["platform"];
export const chatRequirements: Record<Platform, string> = {
  twitch: "TWITCH_USER_TOKEN with user:read:chat for EventSub",
  youtube: "YOUTUBE_API_KEY or YOUTUBE_ACCESS_TOKEN and an active live chat",
  kick: "Public player chat polling or signed chat.message.sent webhook",
  tiktok:
    "Creator-provided timestamped chat export; no public LIVE audience-chat API identified",
};
export function streamlink() {
  const installed = join(
    process.env.LOCALAPPDATA || stateDir(),
    "HypeClip/tools/streamlink/Scripts/streamlink.exe",
  );
  return (
    process.env.HYPECLIP_STREAMLINK ||
    (existsSync(installed) ? installed : "streamlink")
  );
}
export async function discover(url: string) {
  let output = "";
  try {
    const r = await promisify(execFile)(
      streamlink(),
      ["--no-config", "--http-timeout", "8", "--json", url],
      { windowsHide: true, timeout: 25000, maxBuffer: 2000000 },
    );
    output = r.stdout;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw Error("Streamlink is not installed");
    output = String((e as { stdout?: string }).stdout ?? "");
  }
  // Report only public metadata. Resolved transport URLs can include temporary credentials.
  const d = output.trim() ? JSON.parse(output) : {};
  if (!d.streams || !Object.keys(d.streams).length)
    throw Error(
      String(
        d.error ?? "Public media lookup timed out or returned no variants",
      ).replace(/https?:\/\/\S+/g, "[source]"),
    );
  return {
    broadcastId: d.metadata?.id ? String(d.metadata.id) : undefined,
    channel: d.metadata?.author as string | undefined,
    category: d.metadata?.category as string | undefined,
    title: d.metadata?.title as string | undefined,
    variants: Object.keys(d.streams).filter(
      (k) => k !== "best" && k !== "worst",
    ).length,
  };
}
export async function resolveFeed(url: string, feedEnv?: string) {
  let value = feedEnv ? process.env[feedEnv] : undefined;
  if (feedEnv && !value) throw Error("Missing authorized feed in " + feedEnv);
  if (!feedEnv) {
    const exe = streamlink();
    try {
      const { stdout } = await promisify(execFile)(
        exe,
        ["--no-config", "--stream-url", url, "best"],
        { windowsHide: true, timeout: 25000, maxBuffer: 100000 },
      );
      value = stdout.trim();
    } catch (e) {
      throw Error(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "Install Streamlink or supply the authorized feed"
          : "Streamlink could not resolve a playable single-stream URL; supply the authorized feed",
      );
    }
  }
  const parsed = new URL(value!);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw Error("Expected an HTTP(S) media feed");
  return parsed.href;
}
const sink = (path: string, row: unknown) =>
  appendFileSync(path, JSON.stringify(Chat.parse(row)) + "\n");
function api(url: URL, signal: AbortSignal, token?: string) {
  return fetch(url, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
  });
}
export async function youtubeJson(
  route: string,
  params: Record<string, string>,
  signal: AbortSignal,
) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + route);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (process.env.YOUTUBE_API_KEY)
    url.searchParams.set("key", process.env.YOUTUBE_API_KEY);
  const r = await api(url, signal, process.env.YOUTUBE_ACCESS_TOKEN);
  if (!r.ok) throw Error("YouTube " + route + " HTTP " + r.status);
  return r.json();
}
export function youtubeEvent(raw: any, chatId: string, receivedAt: string) {
  const s = raw.snippet;
  if (s?.liveChatId !== chatId || s.type !== "textMessageEvent") return;
  return Chat.parse({
    eventId: raw.id,
    eventAt: s.publishedAt,
    receivedAt,
    userId: s.authorChannelId,
    text: s.displayMessage,
  });
}
export async function youtubeChat(
  video: string,
  path: string,
  signal: AbortSignal,
) {
  const doc = await youtubeJson(
    "videos",
    { part: "liveStreamingDetails", id: video },
    signal,
  );
  const id = doc.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!id)
    throw Error(
      "YouTube activeLiveChatId unavailable; archived chat requires its original export",
    );
  let token = "",
    failures = 0;
  while (!signal.aborted) {
    try {
      const page = await youtubeJson(
        "liveChat/messages",
        {
          part: "id,snippet",
          liveChatId: id,
          ...(token ? { pageToken: token } : {}),
        },
        signal,
      );
      for (const item of page.items ?? []) {
        const row = youtubeEvent(item, id, new Date().toISOString());
        if (row) sink(path, row);
      }
      token = page.nextPageToken || token;
      if (page.offlineAt) throw Error("YouTube chat ended");
      failures = 0;
      await delay(
        Math.max(1000, page.pollingIntervalMillis ?? 5000),
        undefined,
        { signal },
      );
    } catch (e) {
      if (signal.aborted) return;
      if (++failures >= 3 || /HTTP 40[134]|chat ended/.test(String(e))) throw e;
      await delay(1000 * 2 ** failures, undefined, { signal });
    }
  }
}
export function kickEvent(
  body: Buffer,
  h: Record<string, string | undefined>,
  publicKey: string,
  channel: string,
  receivedAt: string,
) {
  const id = h["kick-event-message-id"],
    ts = h["kick-event-message-timestamp"],
    sig = h["kick-event-signature"];
  if (
    !id ||
    !ts ||
    !sig ||
    h["kick-event-type"] !== "chat.message.sent" ||
    h["kick-event-version"] !== "1" ||
    !verify(
      "RSA-SHA256",
      Buffer.concat([Buffer.from(id + "." + ts + "."), body]),
      publicKey,
      Buffer.from(sig, "base64"),
    )
  )
    throw Error("Invalid Kick event");
  const e = JSON.parse(body.toString("utf8"));
  if (
    e.broadcaster.channel_slug.toLowerCase() !== channel.toLowerCase() ||
    !e.sender.user_id
  )
    throw Error("Unexpected Kick channel or sender");
  const emotes = [
    ...String(e.content).matchAll(/\[emote:(\d+):([^\]]+)\]/g),
  ].flatMap((m) => [m[1], m[2]]);
  return Chat.parse({
    eventId: e.message_id,
    eventAt: e.created_at || ts,
    receivedAt,
    userId: String(e.sender.user_id),
    text: e.content,
    emotes,
  });
}
export async function kickPlayerChat(channel:string,path:string,signal:AbortSignal){
  const endpoint="https://kick.com/api/v2/channels/";
  const lookup=await api(new URL(endpoint+encodeURIComponent(channel)),signal);
  if(!lookup.ok)throw Error("Kick channel lookup HTTP "+lookup.status);
  const doc=await lookup.json();
  if(doc.slug?.toLowerCase()!==channel.toLowerCase() || !Number.isSafeInteger(doc.id))
    throw Error("Kick player channel mismatch");
  const since=Date.now()-5000;
  let seen=new Set<string>(),failures=0;
  while(!signal.aborted){
    try{
      const url=new URL(endpoint+doc.id+"/messages");
      // Request the public player's current UTC page. A cached default page can be stale.
      url.searchParams.set("start_time",new Date().toISOString());
      const r=await api(url,signal);
      if(!r.ok)throw Error("Kick player messages HTTP "+r.status);
      const page=await r.json(),receivedAt=new Date().toISOString(),next=new Set<string>();
      for(const m of [...page.data.messages].reverse()){
        if(String(m.chat_id)!==String(doc.chatroom?.id??doc.id) && String(m.chat_id)!==String(doc.id))continue;
        if(m.type!=="message" || !m.sender?.id || !m.id || !m.content || Date.parse(m.created_at)<since)continue;
        next.add(m.id);
        if(!seen.has(m.id))sink(path,{eventId:m.id,eventAt:m.created_at,receivedAt,userId:String(m.sender.id),text:m.content,
          emotes:[...String(m.content).matchAll(/\[emote:(\d+):([^\]]+)\]/g)].flatMap(m=>[m[1],m[2]])});
      }
      if(next.size)seen=next;
      failures=0;
      await delay(3000,undefined,{signal});
    }catch(e){
      if(signal.aborted)return;
      if(++failures>=3 || /HTTP 40[13]/.test(String(e)))throw e;
      await delay(3000*2**failures,undefined,{signal});
    }
  }
}
type KickReceiver={channels:Map<string,string>;ready:Promise<void>;server:ReturnType<typeof createServer>};
const receivers=new Map<number,KickReceiver>();
function openKickReceiver(port:number):KickReceiver{
  const channels=new Map<string,string>();
  let key="";
  const server=createServer(async(req,res)=>{
    if(req.method!=="POST" || req.url!=="/events"){res.writeHead(404).end();return}
    try{
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw Error("Oversize event");chunks.push(chunk)}
      const body=Buffer.concat(chunks);
      const slug=z.string().parse(JSON.parse(body.toString("utf8")).broadcaster?.channel_slug).toLowerCase();
      const row=kickEvent(body,req.headers as Record<string,string>,key,slug,new Date().toISOString());
      const path=channels.get(slug);
      if(path)sink(path,row);
      res.writeHead(204).end();
    }catch{res.writeHead(400).end()}
  });
  const ready=(async()=>{
    const r=await api(new URL("https://api.kick.com/public/v1/public-key"),AbortSignal.timeout(12000));
    if(!r.ok)throw Error("Kick signing key HTTP "+r.status);
    key=z.string().min(64).parse((await r.json()).data?.public_key);
    await new Promise<void>((ok,fail)=>server.once("error",fail).listen(port,"127.0.0.1",ok));
  })();
  return {channels,server,ready};
}
async function kickChat(channel:string,path:string,port:number,signal:AbortSignal){
  const receiver=receivers.get(port)??openKickReceiver(port);
  receivers.set(port,receiver);
  const slug=channel.toLowerCase();
  if(receiver.channels.has(slug))throw Error("Kick channel already has a receiver");
  receiver.channels.set(slug,path);
  try{
    await receiver.ready;
    if(!signal.aborted)await new Promise<void>(ok=>signal.addEventListener("abort",()=>ok(),{once:true}));
  }finally{
    receiver.channels.delete(slug);
    if(!receiver.channels.size){
      receivers.delete(port);
      if(receiver.server.listening)await new Promise<void>(ok=>receiver.server.close(()=>ok()));
    }
  }
}
export function liveChat(
  platform: Platform,
  channel: string,
  video: string | undefined,
  broadcaster: string | undefined,
  port: number | undefined,
) {
  if (
    platform === "youtube" &&
    video &&
    (process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN)
  )
    return (path: string, signal: AbortSignal) =>
      youtubeChat(video, path, signal);
  if (platform === "twitch" && process.env.TWITCH_USER_TOKEN)
    return async (path: string, signal: AbortSignal) => {
      const token = process.env.TWITCH_USER_TOKEN!,
        actor = await identity(token);
      const url = new URL("https://api.twitch.tv/helix/users");
      url.searchParams.set("login", channel);
      const response = await fetch(url, {
        headers: {
          "Client-Id": actor.client_id,
          Authorization: "Bearer " + token,
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok)
        throw Error("Twitch channel lookup HTTP " + response.status);
      const user = (await response.json()).data?.[0];
      if (
        !user?.id ||
        user.login.toLowerCase() !== channel.toLowerCase() ||
        (broadcaster && broadcaster !== user.id)
      )
        throw Error("Twitch broadcaster identity mismatch");
      await collectMany(
        [{ broadcaster: user.id, session: channel, path }],
        signal,
      );
    };
  if (platform === "kick" && port)
    return (path: string, signal: AbortSignal) =>
      kickChat(channel, path, port, signal);
  if (platform === "kick")
    return (path:string,signal:AbortSignal)=>kickPlayerChat(channel,path,signal);
}
