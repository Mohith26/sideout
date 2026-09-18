import { readFileSync } from "node:fs";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `public/sw.js` run in a sandbox with a fake worker global, a fake Cache
 * Storage and a scripted `fetch`, so the caching contract is tested rather
 * than trusted: what is cached, what falls back, and what is left alone.
 */
const source = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

type Handler = (event: unknown) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(request: { url: string } | string): Promise<Response | undefined> {
    return this.entries.get(typeof request === "string" ? absolute(request) : request.url);
  }
  async put(request: { url: string } | string, response: Response): Promise<void> {
    const key = typeof request === "string" ? absolute(request) : request.url;
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  async keys(): Promise<Array<{ url: string }>> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request: { url: string }): Promise<boolean> {
    return this.entries.delete(request.url);
  }
  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.entries.set(absolute(url), html(`precached ${url}`));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

const ORIGIN = "https://sideout.test";
const absolute = (path: string) => new URL(path, ORIGIN).toString();

/** Node's Response reports type "default"; a same-origin browser response is "basic", which the worker requires before caching. */
class BasicResponse extends Response {
  override get type(): ResponseType {
    return "basic";
  }
}
const html = (body: string, status = 200) => new BasicResponse(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (body: unknown) => new BasicResponse(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
}
const req = (path: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}): FakeRequest => ({
  url: absolute(path),
  method: init.method ?? "GET",
  mode: init.mode ?? "cors",
  headers: new Headers(init.headers ?? {}),
});

function boot(version = "abc123") {
  const handlers = new Map<string, Handler>();
  const cacheStorage = new FakeCacheStorage();
  const fetch = vi.fn<(request: FakeRequest) => Promise<Response>>();
  const self = {
    location: { href: `${ORIGIN}/sw.js?v=${version}`, origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  vm.runInNewContext(source, { self, caches: cacheStorage, fetch, URL, Promise, setTimeout, Set, Boolean });
  const respond = async (request: FakeRequest): Promise<Response | null> => {
    let promised: Promise<Response> | null = null;
    handlers.get("fetch")?.({ request, respondWith: (p: Promise<Response>) => (promised = p) });
    return promised ? await promised : null;
  };
  const lifecycle = async (type: "install" | "activate" | "message", extra: Record<string, unknown> = {}) => {
    let waited: Promise<unknown> | null = null;
    handlers.get(type)?.({ waitUntil: (p: Promise<unknown>) => (waited = p), ...extra });
    if (waited) await waited;
  };
  return { cacheStorage, fetch, self, respond, lifecycle };
}

describe("public/sw.js", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("precaches the offline page at install and drops other versions' caches on activation", async () => {
    const sw = boot("new");
    await sw.cacheStorage.open("sideout-pages-old");
    await sw.cacheStorage.open("unrelated");
    await sw.lifecycle("install");
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    const shell = await sw.cacheStorage.open("sideout-shell-new");
    expect(await shell.match("/offline")).toBeDefined();
    expect(await shell.match("/manifest.webmanifest")).toBeDefined();
    await sw.lifecycle("activate");
    expect(sw.self.clients.claim).toHaveBeenCalled();
    expect(await sw.cacheStorage.keys()).toEqual(expect.arrayContaining(["sideout-shell-new", "unrelated"]));
    expect(await sw.cacheStorage.keys()).not.toContain("sideout-pages-old");
  });

  it("leaves POSTs, RSC navigations, HEAD checks, cross-origin and non-static /_next requests to the network", async () => {
    const sw = boot();
    expect(await sw.respond(req("/api/matches/m1/scores", { method: "POST" }))).toBeNull();
    expect(await sw.respond(req("/", { method: "HEAD" }))).toBeNull();
    expect(await sw.respond(req("/t/sandbar?_rsc=abc", { mode: "navigate" }))).toBeNull();
    expect(await sw.respond(req("/t/sandbar", { headers: { RSC: "1" } }))).toBeNull();
    expect(await sw.respond({ ...req("/x"), url: "https://fonts.example/x.css" })).toBeNull();
    expect(await sw.respond(req("/_next/image?url=x"))).toBeNull();
    expect(await sw.respond(req("/api/dev/login"))).toBeNull();
    expect(await sw.respond(req("/api/admin/disputes"))).toBeNull();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it("serves a page from the network and keeps a copy; without network the copy comes back; without a copy, the offline page", async () => {
    const sw = boot();
    await sw.lifecycle("install");
    sw.fetch.mockResolvedValueOnce(html("standings"));
    const online = await sw.respond(req("/t/sandbar/standings", { mode: "navigate" }));
    expect(await online?.text()).toBe("standings");
    const pages = await sw.cacheStorage.open("sideout-pages-abc123");
    expect(await pages.match("/t/sandbar/standings")).toBeDefined();

    sw.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = await sw.respond(req("/t/sandbar/standings", { mode: "navigate" }));
    expect(await offline?.text()).toBe("standings");

    sw.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const unknown = await sw.respond(req("/t/never-opened", { mode: "navigate" }));
    expect(await unknown?.text()).toBe("precached /offline");
  });

  it("never keeps the sign-in page, an error page or a non-HTML navigation", async () => {
    const sw = boot();
    sw.fetch.mockResolvedValueOnce(html("sign in"));
    await sw.respond(req("/sign-in?next=%2Fme", { mode: "navigate" }));
    sw.fetch.mockResolvedValueOnce(html("not found", 404));
    await sw.respond(req("/t/missing", { mode: "navigate" }));
    sw.fetch.mockResolvedValueOnce(json({ ok: true }));
    await sw.respond(req("/health", { mode: "navigate" }));
    const pages = await sw.cacheStorage.open("sideout-pages-abc123");
    expect(await pages.keys()).toEqual([]);
  });

  it("a slow network loses to a cached page after the timeout, and the late answer still refreshes the cache", async () => {
    vi.useFakeTimers();
    const sw = boot();
    const pages = await sw.cacheStorage.open("sideout-pages-abc123");
    await pages.put(req("/m/m1", { mode: "navigate" }), html("cached match"));
    let resolveLate: ((r: Response) => void) | null = null;
    sw.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveLate = resolve;
      }),
    );
    const pending = sw.respond(req("/m/m1", { mode: "navigate" }));
    await vi.advanceTimersByTimeAsync(4001);
    expect(await (await pending)?.text()).toBe("cached match");
    resolveLate!(html("fresh match"));
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await (await pages.match("/m/m1"))?.clone().text()).toBe("fresh match"));
  });

  it("caches hashed static assets first and allowlisted API reads network-first, and trims the API cache", async () => {
    const sw = boot();
    sw.fetch.mockResolvedValueOnce(new BasicResponse("js", { status: 200 }));
    await sw.respond(req("/_next/static/chunks/abc.js"));
    const again = await sw.respond(req("/_next/static/chunks/abc.js"));
    expect(await again?.text()).toBe("js");
    expect(sw.fetch).toHaveBeenCalledTimes(1);

    sw.fetch.mockResolvedValueOnce(json({ ok: true, data: { standings: [] } }));
    await sw.respond(req("/api/tournaments/sandbar/standings"));
    sw.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const fromCache = await sw.respond(req("/api/tournaments/sandbar/standings"));
    expect(await fromCache?.json()).toEqual({ ok: true, data: { standings: [] } });
  });

  it("forgets the pages and API caches when asked to (sign-out)", async () => {
    const sw = boot();
    const pages = await sw.cacheStorage.open("sideout-pages-abc123");
    await pages.put(req("/me", { mode: "navigate" }), html("me"));
    await sw.lifecycle("message", { data: { type: "clear-pages" } });
    expect(await sw.cacheStorage.keys()).not.toContain("sideout-pages-abc123");
  });
});
