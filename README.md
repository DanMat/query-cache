# @danmat/query-cache

[![CI](https://github.com/DanMat/query-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/DanMat/query-cache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@danmat/query-cache.svg)](https://www.npmjs.com/package/@danmat/query-cache)
[![minified + gzip size](https://img.shields.io/bundlejs/size/@danmat/query-cache)](https://bundlejs.com/?q=@danmat/query-cache)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

RFC 10008-correct caching for the HTTP **QUERY** method. A QUERY's identity lives in its **body**, not its URL — so a correct cache key must incorporate the request *content*. This library derives such keys and ships a tiny in-memory cache built on them.

**Zero dependencies. Fully typed. Isomorphic** (Node 18+, Deno, Bun, browsers, edge — anywhere Web Crypto exists).

```ts
import { QueryCache } from "@danmat/query-cache";

const cache = new QueryCache({ maxEntries: 500 });

const res = await cache.wrap(
  { url: "https://api.example.com/search", body, headers },
  () => query(url, { body, headers }), // your fetcher, only called on a miss
);
```

## The problem

RFC 10008 says QUERY responses *are* cacheable, but with a catch:

> The cache key for a QUERY request **MUST incorporate the request content** and related metadata.

Every existing HTTP cache keys on the URL. For QUERY, two requests to the *same URL* with *different bodies* are different queries — key on the URL alone and you'll serve one query's results for another. This library does the body-aware keying the spec requires.

## Install

```sh
npm install @danmat/query-cache
```

## API

### `queryCacheKey(input, options?): Promise<string>`

Derives a stable, collision-resistant **SHA-256** key that incorporates the method, normalized URL (query params sorted), content type, any configured `Vary` headers, and the request body bytes. Accepts either a `Request` or a plain `{ url, method?, body?, headers? }` descriptor.

```ts
const key = await queryCacheKey({
  url: "https://api.example.com/search",
  body: JSON.stringify({ filter: { status: "active" } }),
  headers: { "content-type": "application/json" },
});
// "9f2c…" — same bytes ⇒ same key; different body ⇒ different key
```

| Option | Type | Description |
| --- | --- | --- |
| `varyHeaders` | `string[]` | Extra request headers to fold into the key. `content-type` is always included. |
| `normalizeBody` | `(bytes, contentType) => Uint8Array` | Canonicalize the body before hashing (e.g. sorted-key JSON) so semantically-equal bodies collapse to one key. |

### `class QueryCache`

A minimal in-memory cache keyed by `queryCacheKey`. Honors `Cache-Control: no-store` and `max-age`, with optional LRU eviction and a default TTL. Responses are cloned on store and retrieval, so cached bodies stay readable.

```ts
const cache = new QueryCache({ maxEntries: 1000, ttl: 60_000 });

await cache.store(input, response);        // respects no-store / max-age
const hit = await cache.match(input);      // Response clone, or undefined
const res = await cache.wrap(input, fetch); // match-or-fetch-and-store
await cache.delete(input);
cache.clear();
cache.size; // number of live entries
```

Constructor options extend the key options above plus `maxEntries`, `ttl` (ms), and `now` (clock injection for testing).

## Notes

- **Hashing** uses the Web Crypto `SubtleCrypto.digest` global, with a `node:crypto` fallback for older Node — no dependencies either way.
- **Determinism:** identical bytes hash identically. `FormData` bodies aren't recommended as cache inputs — their multipart boundary is randomized, so they won't produce stable keys. Prefer JSON/text/SQL payloads (which QUERY is designed for), or supply `normalizeBody`.

## Related

- [`@danmat/query-fetch`](https://github.com/DanMat/query-fetch) — a tiny client for the HTTP QUERY method.
- [`@danmat/accept-query`](https://github.com/DanMat/accept-query) — parse/build/negotiate the `Accept-Query` header.

## License

[MIT](./LICENSE) © Dan Matthew
