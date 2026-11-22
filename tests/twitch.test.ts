import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectMany,
  listen,
  notification,
  handoffUrl,
} from "../src/twitch.ts";
it("preserves raw nanoseconds, receipt timestamp and both Twitch IDs", () => {
  const ts = "2026-01-01T00:01:00.123456789Z",
    received = "2026-01-01T00:01:01Z";
  const frame = {
    metadata: {
      message_id: "delivery",
      subscription_type: "channel.chat.message",
      message_timestamp: ts,
    },
    payload: {
      event: {
        broadcaster_user_id: "1",
        message_id: "message",
        chatter_user_id: "2",
        message: { text: "Pog", fragments: [{ type: "emote", text: "Pog" }] },
      },
    },
  };
  expect(notification(frame, "1", received)).toMatchObject({
    eventId: "delivery",
    messageId: "message",
    eventAt: ts,
    receivedAt: received,
    emotes: ["Pog"],
  });
  expect(() => notification(frame, "another", received)).toThrow();
  expect(() => handoffUrl("wss://example.com")).toThrow();
});
it("subscribes once and keeps old socket through handoff welcome", async () => {
  class Socket extends EventTarget {
    close = vi.fn(() => {
      this.dispatchEvent(new Event("close"));
    });
    frame(kind: string, payload: object) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ metadata: { message_type: kind }, payload }),
        }),
      );
    }
  }
  const sockets: Socket[] = [];
  const subscribe = vi.fn(async () => {});
  const ctrl = new AbortController();
  const task = listen(
    {
      connect: () => {
        const s = new Socket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      subscribe,
      write: vi.fn(),
      validate: async () => {},
    },
    ctrl.signal,
  );
  const welcome = { session: { id: "ws1", keepalive_timeout_seconds: 10 } };
  sockets[0].frame("session_welcome", welcome);
  sockets[0].frame("session_reconnect", {
    session: { reconnect_url: "wss://eventsub.wss.twitch.tv/reconnect" },
  });
  expect(sockets).toHaveLength(2);
  expect(sockets[0].close).not.toHaveBeenCalled();
  sockets[1].frame("session_welcome", welcome);
  expect(sockets[0].close).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledOnce();
  ctrl.abort();
  await task;
});

it("multiplexes two explicit mock subscriptions and routes duplicate IDs per source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-mux-"));
  const sockets: EventTarget[] = [];
  class MockSocket extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
    }
    close() {}
  }
  const subscribed: string[] = [];
  const ctrl = new AbortController();
  try {
    vi.stubEnv("TWITCH_USER_TOKEN", "mock-token");
    vi.stubEnv("HYPECLIP_ISOLATED", "");
    vi.stubGlobal("WebSocket", MockSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/validate"))
          return Response.json({
            client_id: "mock",
            user_id: "test",
            scopes: ["user:read:chat"],
          });
        subscribed.push(
          JSON.parse(String(init.body)).condition.broadcaster_user_id,
        );
        return new Response(null, { status: 202 });
      }),
    );
    const channels = ["a", "b"].map((broadcaster) => ({
      broadcaster,
      session: broadcaster,
      path: join(dir, broadcaster + ".jsonl"),
    }));
    const task = collectMany(channels, ctrl.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const frame = (data: unknown) =>
      sockets[0].dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) }),
      );
    frame({
      metadata: { message_type: "session_welcome" },
      payload: { session: { id: "test", keepalive_timeout_seconds: 20 } },
    });
    await vi.waitFor(() => expect(subscribed).toEqual(["a", "b"]));
    for (const broadcaster of ["a", "b", "a"]) {
      frame({
        metadata: {
          message_type: "notification",
          subscription_type: "channel.chat.message",
          message_id: "duplicate",
          message_timestamp: new Date().toISOString(),
        },
        payload: {
          event: {
            broadcaster_user_id: broadcaster,
            message_id: "message",
            chatter_user_id: "mock",
            message: { text: broadcaster, fragments: [] },
          },
        },
      });
    }
    ctrl.abort();
    expect((await task).map((s) => s.messages)).toEqual([1, 1]);
    for (const c of channels)
      expect(JSON.parse(readFileSync(c.path, "utf8")).text).toBe(c.broadcaster);
  } finally {
    ctrl.abort();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
