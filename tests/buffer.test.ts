import { it, expect, afterEach, vi } from "vitest";
import { buffer, restriction } from "../src/buffer.ts";
import { jsonFile } from "../src/local.ts";
const input = {
  text: 'A "quote" and newline\n',
  channelId: "test",
  url: "https://example.invalid/clips/hash.mp4",
  mode: "shareNow" as const,
};
const fixture = jsonFile("tests/fixtures/buffer.json");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  vi.stubEnv("BUFFER_ACCESS_TOKEN", "test-only-secret");
  const mock = vi.fn(async () => Response.json(body, { status, headers }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
it("uses createPost variables, correct video input and automatic scheduling", async () => {
  const fetch = response({
    data: {
      createPost: { __typename: "PostActionSuccess", post: { id: "123" } },
    },
  });
  expect(await buffer.create(input)).toBe("123");
  expect(fetch).toHaveBeenCalledWith(
    "https://api.buffer.com",
    expect.objectContaining({ method: "POST" }),
  );
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const payload = JSON.parse(String(init.body));
  expect(payload.query).toContain("$input:CreatePostInput!");
  expect(payload.query).not.toContain(input.text);
  expect(payload.variables.input).toEqual({
    channelId: "test",
    mode: "shareNow",
    schedulingType: "automatic",
    text: input.text,
    assets: [{ video: { url: input.url } }],
  });
});
it("distinguishes HTTP, GraphQL and mutation errors", async () => {
  response({}, 429, { "retry-after": "20" });
  await expect(buffer.create(input)).rejects.toMatchObject({
    definitive: true,
    retryAt: expect.any(Number),
  });
  response({ errors: [{ message: "Bad test-only-secret" }] });
  await expect(buffer.create(input)).rejects.toThrow("Bad [redacted]");
  response({
    data: {
      createPost: {
        __typename: "InvalidInputError",
        message: "Commercial disclosure required",
      },
    },
  });
  await expect(buffer.create(input)).rejects.toMatchObject({
    message: "Commercial disclosure required",
    definitive: true,
  });
});
it("requires actual matching channel, caption and asset across remote pages", async () => {
  const p = {
    ...fixture.post,
    text: input.text,
    assets: [{ source: input.url }],
  };
  const fetch = response({
    data: { posts: { edges: [{ node: p }], pageInfo: { hasNextPage: false } } },
  });
  fetch.mockResolvedValueOnce(
    Response.json({
      data: {
        posts: {
          edges: [{ node: { ...p, id: "other", channelId: "other" } }],
          pageInfo: { hasNextPage: true, endCursor: "two" },
        },
      },
    }),
  );
  expect(await buffer.matches(fixture.channel, input)).toEqual([p]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("surfaces configured privacy and notification requirements", () => {
  vi.stubEnv(
    "HYPECLIP_CHANNEL_REQUIREMENTS",
    "Set commercial disclosure in TikTok",
  );
  expect(restriction(fixture.channel)).toMatch(/commercial/);
});
