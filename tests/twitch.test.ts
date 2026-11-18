import { it, expect, vi } from "vitest";
import { listen, notification, handoffUrl } from "../src/twitch.ts";
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
