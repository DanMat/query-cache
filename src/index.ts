/**
 * @danmat/query-cache
 *
 * RFC 10008-correct caching for the HTTP QUERY method. Unlike `GET`, a QUERY's
 * identity lives in its *body*, so a cache key must incorporate the request
 * content — not just the URL. This module derives such keys and ships a small,
 * dependency-free in-memory cache built on them.
 *
 * @see https://www.rfc-editor.org/rfc/rfc10008#name-caching
 */

/** A plain description of a QUERY request, as an alternative to a `Request`. */
export interface QueryKeyInput {
  url: string | URL;
  /** Defaults to `"QUERY"`. */
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
}

export interface QueryCacheKeyOptions {
  /**
   * Additional request header names to fold into the key (a `Vary`-like list).
   * `content-type` is always included. Names are matched case-insensitively.
   */
  varyHeaders?: string[];
  /**
   * Transform the raw body bytes before hashing — e.g. to canonicalize JSON so
   * that semantically-equal bodies share a key. Receives the bytes and the
   * effective content type.
   */
  normalizeBody?: (
    body: Uint8Array,
    contentType: string | null,
  ) => Uint8Array | Promise<Uint8Array>;
}

async function getSubtle(): Promise<SubtleCrypto> {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto?.subtle) return globalCrypto.subtle;
  // Older Node without a global `crypto`. This branch is never reached in
  // browsers/workers. The specifier is kept non-literal so this stays free of
  // a `@types/node` dependency and bundlers leave the dynamic import alone.
  const specifier = "node:crypto";
  const nodeCrypto = (await import(specifier)) as {
    webcrypto: { subtle: SubtleCrypto };
  };
  return nodeCrypto.webcrypto.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Normalize a URL for keying: absolute form with sorted query params. */
function normalizeUrl(url: string | URL): string {
  try {
    const parsed = new URL(String(url));
    parsed.searchParams.sort();
    return parsed.href;
  } catch {
    return String(url);
  }
}

/** Coerce any `BodyInit` to bytes using a throwaway POST request. */
async function bodyToBytes(body: BodyInit | null | undefined): Promise<{
  bytes: Uint8Array;
  derivedContentType: string | null;
}> {
  if (body == null) return { bytes: new Uint8Array(0), derivedContentType: null };
  // POST always permits a body, so this works regardless of the real method.
  const probe = new Request("http://query-cache.invalid/", {
    method: "POST",
    body,
  });
  const bytes = new Uint8Array(await probe.arrayBuffer());
  return { bytes, derivedContentType: probe.headers.get("content-type") };
}

interface Extracted {
  method: string;
  url: string;
  contentType: string | null;
  headers: Headers;
  bytes: Uint8Array;
}

async function extract(input: Request | QueryKeyInput): Promise<Extracted> {
  if (input instanceof Request) {
    const bytes = new Uint8Array(await input.clone().arrayBuffer());
    return {
      method: input.method.toUpperCase(),
      url: normalizeUrl(input.url),
      contentType: input.headers.get("content-type"),
      headers: input.headers,
      bytes,
    };
  }

  const headers = new Headers(input.headers);
  const { bytes, derivedContentType } = await bodyToBytes(input.body);
  return {
    method: (input.method ?? "QUERY").toUpperCase(),
    url: normalizeUrl(input.url),
    contentType: headers.get("content-type") ?? derivedContentType,
    headers,
    bytes,
  };
}

/**
 * Derive a stable, collision-resistant cache key (SHA-256 hex) for a QUERY
 * request. The key incorporates the method, normalized URL, content type, any
 * configured `Vary` headers, and — crucially — the request body bytes.
 *
 * Two requests produce the same key iff those inputs are byte-identical, so
 * caches never conflate distinct queries that happen to share a URL.
 *
 * @example
 * ```ts
 * const key = await queryCacheKey({
 *   url: "https://api.example.com/search",
 *   body: JSON.stringify({ q: "http query" }),
 *   headers: { "content-type": "application/json" },
 * });
 * ```
 */
export async function queryCacheKey(
  input: Request | QueryKeyInput,
  options: QueryCacheKeyOptions = {},
): Promise<string> {
  const { method, url, contentType, headers, bytes } = await extract(input);

  let body = bytes;
  if (options.normalizeBody) {
    body = await options.normalizeBody(bytes, contentType);
  }

  const varyLines: string[] = [];
  for (const name of options.varyHeaders ?? []) {
    varyLines.push(`${name.toLowerCase()}: ${headers.get(name) ?? ""}`);
  }
  varyLines.sort();

  const preamble = [method, url, `content-type: ${contentType ?? ""}`, ...varyLines].join(
    "\n",
  );
  const data = concat(new TextEncoder().encode(preamble + "\n\n"), body);

  const subtle = await getSubtle();
  const digest = await subtle.digest("SHA-256", data);
  return toHex(digest);
}

interface CacheEntry {
  response: Response;
  expires: number; // epoch ms; Infinity for no explicit expiry
}

function parseCacheControl(response: Response): {
  noStore: boolean;
  maxAge: number | undefined;
} {
  const value = response.headers.get("cache-control");
  if (!value) return { noStore: false, maxAge: undefined };
  const lower = value.toLowerCase();
  const noStore = /(?:^|,)\s*no-store\s*(?:,|$)/.test(lower);
  const match = lower.match(/max-age\s*=\s*(\d+)/);
  return { noStore, maxAge: match ? Number(match[1]) : undefined };
}

export interface QueryCacheOptions extends QueryCacheKeyOptions {
  /** Evict the least-recently-used entry beyond this many. Default: unlimited. */
  maxEntries?: number;
  /**
   * Fallback lifetime in milliseconds for responses without a `max-age`.
   * Default: no expiry (entries live until evicted or cleared).
   */
  ttl?: number;
  /** Clock injection for testing. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A minimal, dependency-free in-memory cache for QUERY responses, keyed by
 * {@link queryCacheKey}. Honors `Cache-Control: no-store` and `max-age`, with
 * optional LRU eviction and a default TTL.
 *
 * Responses are cloned on store and on retrieval, so a cached body can be read
 * any number of times.
 */
export class QueryCache {
  #store = new Map<string, CacheEntry>();
  #options: QueryCacheOptions;
  #now: () => number;

  constructor(options: QueryCacheOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The number of live entries currently held. */
  get size(): number {
    return this.#store.size;
  }

  /** Compute the cache key for a request without touching the store. */
  key(input: Request | QueryKeyInput): Promise<string> {
    return queryCacheKey(input, this.#options);
  }

  /** Return a cached response clone, or `undefined` on miss/expiry. */
  async match(input: Request | QueryKeyInput): Promise<Response | undefined> {
    const key = await this.key(input);
    const entry = this.#store.get(key);
    if (!entry) return undefined;

    if (entry.expires <= this.#now()) {
      this.#store.delete(key);
      return undefined;
    }

    // Refresh LRU recency.
    this.#store.delete(key);
    this.#store.set(key, entry);
    return entry.response.clone();
  }

  /** Store a response for a request. Respects `Cache-Control: no-store`. */
  async store(
    input: Request | QueryKeyInput,
    response: Response,
  ): Promise<void> {
    const { noStore, maxAge } = parseCacheControl(response);
    if (noStore) return;

    const lifetime =
      maxAge !== undefined ? maxAge * 1000 : this.#options.ttl;
    const expires =
      lifetime !== undefined ? this.#now() + lifetime : Number.POSITIVE_INFINITY;

    const key = await this.key(input);
    this.#store.delete(key);
    this.#store.set(key, { response: response.clone(), expires });

    const max = this.#options.maxEntries;
    if (max !== undefined && this.#store.size > max) {
      const oldest = this.#store.keys().next().value;
      if (oldest !== undefined) this.#store.delete(oldest);
    }
  }

  /**
   * Return a cached response if present, otherwise call `fetcher`, store its
   * result, and return it. The fetcher runs at most once per cache miss.
   */
  async wrap(
    input: Request | QueryKeyInput,
    fetcher: () => Promise<Response>,
  ): Promise<Response> {
    const hit = await this.match(input);
    if (hit) return hit;

    const response = await fetcher();
    await this.store(input, response);
    return response;
  }

  /** Remove a single entry. Resolves to whether one was present. */
  async delete(input: Request | QueryKeyInput): Promise<boolean> {
    return this.#store.delete(await this.key(input));
  }

  /** Drop all entries. */
  clear(): void {
    this.#store.clear();
  }
}
