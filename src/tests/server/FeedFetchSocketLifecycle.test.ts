import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const requestHttps = vi.hoisted(() => vi.fn());

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https") & { default?: typeof import("node:https") }>();
  return {
    ...actual,
    request: requestHttps,
    default: { ...(actual.default ?? actual), request: requestHttps },
  };
});

import { FeedFetchRuntime } from "../../../server/feed/FeedFetchRuntime";

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 as const };

type FakeResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  destroy: ReturnType<typeof vi.fn>;
};

function response(status: number, headers: Record<string, string>): FakeResponse {
  const value = new EventEmitter() as FakeResponse;
  value.statusCode = status;
  value.headers = headers;
  value.destroy = vi.fn();
  return value;
}

function installSocketResponses(responses: FakeResponse[]) {
  const requests: Array<EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }> = [];
  requestHttps.mockImplementation((_options: unknown, callback: (value: FakeResponse) => void) => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected HTTPS request");
    const request = new EventEmitter() as (typeof requests)[number];
    request.setTimeout = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      queueMicrotask(() => {
        callback(next);
        if (next.statusCode >= 200 && next.statusCode < 300) {
          next.emit("data", Buffer.from("{}"));
          next.emit("end");
        }
      });
    });
    requests.push(request);
    return request;
  });
  return requests;
}

describe("FeedFetchRuntime production socket lifecycle", () => {
  it("destroys redirect bodies before opening the revalidated next hop", async () => {
    const redirect = response(302, {
      location: "https://two.example.org/final.json",
    });
    const success = response(200, { "content-type": "application/json" });
    installSocketResponses([redirect, success]);
    const runtime = new FeedFetchRuntime({
      lookup: async () => [PUBLIC_V4],
    });

    await expect(runtime.fetch({ url: "https://one.example.org/start" })).resolves.toMatchObject({
      finalUrl: "https://two.example.org/final.json",
    });
    expect(redirect.destroy).toHaveBeenCalledOnce();
    expect(requestHttps).toHaveBeenCalledTimes(2);
  });

  it("destroys a live body socket when the total deadline expires", async () => {
    const hanging = response(200, { "content-type": "application/json" });
    const requests = installSocketResponses([hanging]);
    // Keep the successful response body open instead of emitting data/end.
    requests.length = 0;
    requestHttps.mockImplementationOnce((_options: unknown, callback: (value: FakeResponse) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      request.setTimeout = vi.fn();
      request.destroy = vi.fn();
      request.end = vi.fn(() => queueMicrotask(() => callback(hanging)));
      requests.push(request);
      return request;
    });
    const runtime = new FeedFetchRuntime({
      lookup: async () => [PUBLIC_V4],
    }, { timeoutMs: 100 });

    await expect(runtime.fetch({ url: "https://feeds.example.org/drip.json" })).rejects.toMatchObject({
      code: "feed_timeout",
      status: 504,
    });
    expect(requests[0]?.destroy).toHaveBeenCalledOnce();
    expect(requests[0]?.destroy.mock.calls[0]?.[0]).toMatchObject({ code: "feed_timeout" });
  });
});
