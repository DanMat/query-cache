import { describe, it, expect, vi } from "vitest";
import { queryCacheKey, QueryCache } from "../src/index.js";

const json = (value: unknown) => ({
  url: "https://api.test/search",
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
});

describe("queryCacheKey", () => {
  it("is a 64-char hex SHA-256 digest", async () => {
    const key = await queryCacheKey(json({ q: 1 }));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical inputs", async () => {
    expect(await queryCacheKey(json({ q: 1 }))).toBe(
      await queryCacheKey(json({ q: 1 })),
    );
  });

  it("changes when the body changes", async () => {
    expect(await queryCacheKey(json({ q: 1 }))).not.toBe(
      await queryCacheKey(json({ q: 2 })),
    );
  });

  it("changes when the content type changes", async () => {
    const a = await queryCacheKey({
      url: "https://api.test/s",
      body: "q=1",
      headers: { "content-type": "application/json" },
    });
    const b = await queryCacheKey({
      url: "https://api.test/s",
      body: "q=1",
      headers: { "content-type": "application/sql" },
    });
    expect(a).not.toBe(b);
  });

  it("is independent of query-parameter order in the URL", async () => {
    const a = await queryCacheKey({
      url: "https://api.test/s?b=2&a=1",
      body: "x",
      headers: { "content-type": "text/plain" },
    });
    const b = await queryCacheKey({
      url: "https://api.test/s?a=1&b=2",
      body: "x",
      headers: { "content-type": "text/plain" },
    });
    expect(a).toBe(b);
  });

  it("folds in configured Vary headers", async () => {
    const base = {
      url: "https://api.test/s",
      body: "x",
      headers: { "content-type": "text/plain", "accept-language": "en" },
    };
    const other = {
      ...base,
      headers: { ...base.headers, "accept-language": "fr" },
    };
    const withoutVary = await queryCacheKey(base);
    expect(await queryCacheKey(other)).toBe(withoutVary); // ignored by default
    expect(
      await queryCacheKey(other, { varyHeaders: ["accept-language"] }),
    ).not.toBe(await queryCacheKey(base, { varyHeaders: ["accept-language"] }));
  });

  it("matches an equivalent Request object", async () => {
    const fromDescriptor = await queryCacheKey(json({ q: 5 }));
    const fromRequest = await queryCacheKey(
      new Request("https://api.test/search", {
        method: "QUERY",
        body: JSON.stringify({ q: 5 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(fromRequest).toBe(fromDescriptor);
  });

  it("applies a body normalizer", async () => {
    const normalizeBody = () => new TextEncoder().encode("CANONICAL");
    expect(await queryCacheKey(json({ q: 1 }), { normalizeBody })).toBe(
      await queryCacheKey(json({ q: 999 }), { normalizeBody }),
    );
  });
});

describe("QueryCache", () => {
  it("stores and matches a response, preserving the body", async () => {
    const cache = new QueryCache();
    await cache.store(json({ q: 1 }), new Response("hello"));

    const hit = await cache.match(json({ q: 1 }));
    expect(hit).toBeInstanceOf(Response);
    expect(await hit!.text()).toBe("hello");
    // Cached entry is reusable after being read.
    const hit2 = await cache.match(json({ q: 1 }));
    expect(await hit2!.text()).toBe("hello");
  });

  it("misses for a different body", async () => {
    const cache = new QueryCache();
    await cache.store(json({ q: 1 }), new Response("hello"));
    expect(await cache.match(json({ q: 2 }))).toBeUndefined();
  });

  it("wrap fetches once, then serves from cache", async () => {
    const cache = new QueryCache();
    const fetcher = vi.fn(async () => new Response("payload"));

    const first = await cache.wrap(json({ q: 1 }), fetcher);
    const second = await cache.wrap(json({ q: 1 }), fetcher);

    expect(await first.text()).toBe("payload");
    expect(await second.text()).toBe("payload");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not store no-store responses", async () => {
    const cache = new QueryCache();
    await cache.store(
      json({ q: 1 }),
      new Response("x", { headers: { "cache-control": "no-store" } }),
    );
    expect(cache.size).toBe(0);
  });

  it("expires entries per max-age", async () => {
    let clock = 1_000_000;
    const cache = new QueryCache({ now: () => clock });
    await cache.store(
      json({ q: 1 }),
      new Response("x", { headers: { "cache-control": "max-age=1" } }),
    );

    expect(await cache.match(json({ q: 1 }))).toBeDefined();
    clock += 1500; // 1.5s later, past the 1s max-age
    expect(await cache.match(json({ q: 1 }))).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts least-recently-used beyond maxEntries", async () => {
    const cache = new QueryCache({ maxEntries: 2 });
    await cache.store(json({ q: 1 }), new Response("1"));
    await cache.store(json({ q: 2 }), new Response("2"));
    // Touch q=1 so q=2 becomes the LRU.
    await cache.match(json({ q: 1 }));
    await cache.store(json({ q: 3 }), new Response("3"));

    expect(cache.size).toBe(2);
    expect(await cache.match(json({ q: 2 }))).toBeUndefined();
    expect(await cache.match(json({ q: 1 }))).toBeDefined();
    expect(await cache.match(json({ q: 3 }))).toBeDefined();
  });

  it("delete and clear work", async () => {
    const cache = new QueryCache();
    await cache.store(json({ q: 1 }), new Response("1"));
    await cache.store(json({ q: 2 }), new Response("2"));

    expect(await cache.delete(json({ q: 1 }))).toBe(true);
    expect(await cache.delete(json({ q: 1 }))).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
