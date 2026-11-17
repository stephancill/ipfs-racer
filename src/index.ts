import { cidToV1Base32, isLowercasedCidV0, parseCid } from "./cid";
import { freshnessHtml, lookupContenthashAge, resolveEnsContenthash } from "./ens";
import {
  type IpfsPath,
  NotFoundError,
  TRUSTLESS_GATEWAYS,
  fetchVerified,
  findHttpProviders,
  resolveDnslink,
} from "./trustless";

const ROOT_HOST = "ipfs.stupidtech.net";

// Public gateways that still return deserialized (rendered) content.
// ipfs.io / dweb.link were sunset on 2026-09-21 and pinata refuses to serve HTML.
const DESERIALIZED_GATEWAYS = ["ipfs.raribleuserdata.com"];

const RACE_TIMEOUT_MS = 25_000;

type Env = {
  ASSETS: Fetcher;
  METRICS_DO: DurableObjectNamespace;
};

type Racer = {
  label: string;
  run: (signal: AbortSignal) => Promise<{ response: Response; label?: string }>;
};

function redirect(target: string): Response {
  return Response.redirect(target, 301);
}

function textResponse(body: string, status: number): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

type RaceResult = { label: string; response: Response } | { notFound: true } | null;

function hasNotFound(error: unknown): boolean {
  if (error instanceof NotFoundError) return true;
  return error instanceof AggregateError && error.errors.some(hasNotFound);
}

async function race(racers: Racer[]): Promise<RaceResult> {
  const controllers = racers.map(() => new AbortController());
  const timers = controllers.map((controller) =>
    setTimeout(() => controller.abort(), RACE_TIMEOUT_MS),
  );

  try {
    const winner = await Promise.any(
      racers.map(async (racer, index) => {
        const result = await racer.run(controllers[index].signal);
        return { index, ...result };
      }),
    );

    controllers.forEach((controller, index) => {
      if (index !== winner.index) controller.abort();
    });

    return { label: winner.label ?? racers[winner.index].label, response: winner.response };
  } catch (error) {
    return hasNotFound(error) ? { notFound: true } : null;
  } finally {
    timers.forEach(clearTimeout);
  }
}

function extractSubdomainCID(hostname: string): { cid: string; isIPFS: boolean } | null {
  const parts = hostname.split(".");
  if (parts.length < 3) return null;

  const cid = parts[0];
  if (cid === "ipfs" || cid === "www") return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(cid)) return null;

  return { cid, isIPFS: true };
}

function extractPathCID(pathname: string): { cid: string; isIPFS: boolean } | null {
  const isIPFS = pathname.startsWith("/ipfs/");
  const isIPNS = pathname.startsWith("/ipns/");
  if (!isIPFS && !isIPNS) return null;

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  return { cid: parts[1], isIPFS };
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers.get("Content-Type") ?? "").includes("text/html");
}

function invalidCidResponse(cid: string): Response {
  if (isLowercasedCidV0(cid)) {
    return textResponse(
      `"${cid}" looks like a CIDv0 ("Qm...") that was lowercased. CIDv0 is case-sensitive, so it ` +
        `cannot be used as a subdomain. Use https://${ROOT_HOST}/ipfs/<Qm...>/ with the original ` +
        `casing and you will be redirected to a working URL.`,
      400,
    );
  }
  return textResponse(`invalid CID: ${cid}`, 400);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { hostname, pathname } = url;

    const subdomain = extractSubdomainCID(hostname);
    const isRootDomain = hostname === ROOT_HOST;

    if (isRootDomain) {
      if (pathname === "/stats") {
        const metrics = await getIpfsMetricsSnapshot({ env });
        return jsonResponse({ ok: true, metrics });
      }

      if (pathname === "/" || pathname === "") {
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
      }

      const pathCID = extractPathCID(pathname);
      if (!pathCID) {
        return env.ASSETS.fetch(request);
      }

      if (pathCID.isIPFS) {
        const parsed = parseCid(pathCID.cid);
        if (!parsed) return invalidCidResponse(pathCID.cid);

        const resource = pathname.slice(`/ipfs/${pathCID.cid}`.length).replace(/^\//, "");
        // Subdomains are case-insensitive, so always redirect to CIDv1 base32.
        const cidV1 = cidToV1Base32(parsed);
        if (cidV1.length <= 63) {
          const path = resource ? `/${resource}` : "/";
          return redirect(`https://${cidV1}.${ROOT_HOST}${path}${url.search}`);
        }
        return serveContent({ cid: cidV1, isIPFS: true, resource, url, env, ctx });
      }

      const resource = pathname.slice(`/ipns/${pathCID.cid}`.length).replace(/^\//, "");
      return serveContent({ cid: pathCID.cid, isIPFS: false, resource, url, env, ctx });
    }

    if (subdomain) {
      const parsed = parseCid(subdomain.cid);
      if (!parsed) return invalidCidResponse(subdomain.cid);

      return serveContent({
        cid: cidToV1Base32(parsed),
        isIPFS: subdomain.isIPFS,
        resource: pathname.slice(1),
        url,
        env,
        ctx,
      });
    }

    return redirect(`https://${ROOT_HOST}${pathname}${url.search}`);
  },
};

function directoryRedirect(url: URL): Response {
  const target = new URL(url);
  target.pathname += "/";
  return redirect(target.toString());
}

function resourceSegments(resource: string): string[] {
  return resource
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

async function resolveIpnsName(name: string): Promise<IpfsPath | null> {
  if (parseCid(name)) return null; // libp2p-key names need signed-record verification
  if (name.endsWith(".eth")) return resolveEnsContenthash(name);
  return resolveDnslink(name);
}

function buildRacers({
  cid,
  isIPFS,
  resource,
  url,
  gatewaySearch,
}: {
  cid: string;
  isIPFS: boolean;
  resource: string;
  url: URL;
  gatewaySearch: string;
}): Racer[] {
  const trailingSlash = url.pathname.endsWith("/");

  const deserialized: Racer[] = DESERIALIZED_GATEWAYS.map((host) => ({
    label: host,
    run: async (signal) => {
      const base = `https://${host}/${isIPFS ? "ipfs" : "ipns"}/${cid}`;
      const response = await fetch(`${resource ? `${base}/${resource}` : base}${gatewaySearch}`, {
        signal,
      });
      if (!response.ok) throw new Error(`bad status ${response.status}`);
      if (!trailingSlash && response.redirected && new URL(response.url).pathname.endsWith("/")) {
        return { response: directoryRedirect(url) };
      }
      return { response };
    },
  }));

  // Verified retrieval from trustless gateways. Resolve the target once and share it.
  let targetPromise: Promise<IpfsPath | null> | undefined;
  const target = () => {
    targetPromise ??= isIPFS
      ? Promise.resolve(parseCid(cid) ? { root: parseCid(cid)!, path: [] } : null)
      : resolveIpnsName(cid).catch(() => null);
    return targetPromise;
  };

  const verified = async (gateway: string, signal: AbortSignal) => {
    const resolved = await target();
    if (!resolved) throw new Error("unresolvable name");
    const result = await fetchVerified({
      gateway,
      root: resolved.root,
      path: [...resolved.path, ...resourceSegments(resource)],
      trailingSlash,
      signal,
    });
    if (result.kind === "directory-redirect") return directoryRedirect(url);
    return new Response(result.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "content-type": result.contentType,
        "cache-control": isIPFS ? "public, max-age=31536000, immutable" : "public, max-age=300",
        "x-ipfs-roots": cidToV1Base32(resolved.root),
      },
    });
  };

  const trustless: Racer[] = TRUSTLESS_GATEWAYS.map((gateway) => ({
    label: `trustless:${new URL(gateway).host}`,
    run: async (signal) => ({ response: await verified(gateway, signal) }),
  }));

  // Providers discovered through delegated routing (e.g. the pinning service hosting the CID).
  const routed: Racer = {
    label: "trustless:routed",
    run: async (signal) => {
      const resolved = await target();
      if (!resolved) throw new Error("unresolvable name");
      const providers = await findHttpProviders(resolved.root, signal);
      return Promise.any(
        providers.map(async (gateway) => ({
          response: await verified(gateway, signal),
          label: `trustless:${new URL(gateway).host}`,
        })),
      );
    },
  };

  return [...deserialized, ...trustless, routed];
}

async function serveContent({
  cid,
  isIPFS,
  resource,
  url,
  env,
  ctx,
}: {
  cid: string;
  isIPFS: boolean;
  resource: string;
  url: URL;
  env: Env;
  ctx: ExecutionContext;
}): Promise<Response> {
  const sref = url.searchParams.get("_sref");
  const gatewayParams = new URLSearchParams(url.searchParams);
  gatewayParams.delete("_sref");
  const gatewaySearch = gatewayParams.size ? `?${gatewayParams.toString()}` : "";

  const startedAt = performance.now();
  const agePromise = sref ? lookupContenthashAge(sref).catch(() => null) : Promise.resolve(null);

  // /ipfs/ content is immutable, so cache it at the edge (keyed without `_sref`).
  const cache = isIPFS ? (caches as unknown as { default: Cache }).default : null;
  const cacheKey = new Request(`${url.origin}${url.pathname}${gatewaySearch}`);
  const cached = cache ? await cache.match(cacheKey).catch(() => undefined) : undefined;

  const raced = cached
    ? { label: "cache", response: cached }
    : await race(buildRacers({ cid, isIPFS, resource, url, gatewaySearch }));
  const notFound = raced !== null && "notFound" in raced;
  const result = raced !== null && "response" in raced ? raced : null;
  const latencyMs = Math.max(0, performance.now() - startedAt);
  const age = await agePromise;

  const response = result?.response ?? null;
  const record: IpfsMetricsRecord = {
    requestCount: 1,
    errorCount: response ? 0 : 1,
    latencyMs,
    latencySampleCount: 1,
    gatewayHost: result?.label,
  };
  ctx.waitUntil(recordIpRequest({ env, record }));

  if (response) {
    if (response.status >= 300 && response.status < 400) return response;

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", headers.get("Cache-Control") ?? "public, max-age=300");
    headers.delete("Set-Cookie");

    if (cache && !cached && response.status === 200) {
      const forCache = new Response(response.clone().body, { status: 200, headers });
      ctx.waitUntil(cache.put(cacheKey, forCache).catch(() => undefined));
    }

    if (isHtmlResponse(response)) {
      let body = await response.text();
      if (sref && age !== null) {
        body = `${body}${freshnessHtml(sref, age)}`;
      }
      headers.delete("Content-Length");
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (notFound) return textResponse("not found", 404);
  return textResponse("no reachable gateway", 502);
}

const COUNTERS_STORAGE_KEY = "counters";

// Initial `requestsServed` for a freshly-created Durable Object, so the stats
// page starts from a realistic baseline instead of zero. Seeded from the past
// 30 days of Cloudflare Worker metrics: 10,526 gateway subrequests / 3 gateways
// raced per request ≈ 3,509 content races.
const SEED_REQUESTS_SERVED = 3509;

type MetricsStorageSnapshot = {
  requestsServed: number;
  errorResponses: number;
  latencySumMs: number;
  latencyCount: number;
  latencyMaxMs: number;
  latencyBuckets: Record<string, number>;
  gatewayWins: Record<string, number>;
};

type MetricsCounters = MetricsStorageSnapshot;

type IpfsMetricsSnapshot = MetricsStorageSnapshot & {
  averageLatencyMs: number;
};

type IpfsMetricsRecord = {
  requestCount: number;
  errorCount: number;
  latencyMs: number;
  latencySampleCount: number;
  gatewayHost?: string;
};

function defaultMetricsSnapshot(): MetricsStorageSnapshot {
  return {
    requestsServed: SEED_REQUESTS_SERVED,
    errorResponses: 0,
    latencySumMs: 0,
    latencyCount: 0,
    latencyMaxMs: 0,
    latencyBuckets: {
      "0-100": 0,
      "100-250": 0,
      "250-500": 0,
      "500-1000": 0,
      "1000-2000": 0,
      "2000+": 0,
    },
    gatewayWins: {},
  };
}

function normalizeCounters(counters: Partial<MetricsCounters>): MetricsCounters {
  const defaults = defaultMetricsSnapshot();
  return {
    requestsServed: Math.max(0, Math.trunc(counters.requestsServed ?? 0)),
    errorResponses: Math.max(0, Math.trunc(counters.errorResponses ?? 0)),
    latencySumMs: Math.max(0, counters.latencySumMs ?? 0),
    latencyCount: Math.max(0, Math.trunc(counters.latencyCount ?? 0)),
    latencyMaxMs: Math.max(0, counters.latencyMaxMs ?? 0),
    latencyBuckets: {
      ...defaults.latencyBuckets,
      ...counters.latencyBuckets,
    },
    gatewayWins: { ...counters.gatewayWins },
  };
}

function latencyBucket({
  latencyMs,
}: {
  latencyMs: number;
}): keyof MetricsStorageSnapshot["latencyBuckets"] {
  if (latencyMs < 100) {
    return "0-100";
  }
  if (latencyMs < 250) {
    return "100-250";
  }
  if (latencyMs < 500) {
    return "250-500";
  }
  if (latencyMs < 1000) {
    return "500-1000";
  }
  if (latencyMs < 2000) {
    return "1000-2000";
  }

  return "2000+";
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...init?.headers,
    },
  });
}

function buildPublicIpfsSnapshot({
  snapshot,
}: {
  snapshot: MetricsStorageSnapshot;
}): IpfsMetricsSnapshot {
  return {
    ...snapshot,
    averageLatencyMs:
      snapshot.latencyCount === 0 ? 0 : snapshot.latencySumMs / snapshot.latencyCount,
  };
}

async function getIpfsMetricsSnapshot({ env }: { env: Env }): Promise<IpfsMetricsSnapshot> {
  try {
    const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
    const response = await stub.fetch("https://metrics.internal/snapshot");
    if (!response.ok) {
      throw new Error("Failed to read metrics snapshot");
    }

    const snapshot = (await response.json()) as MetricsStorageSnapshot;
    return buildPublicIpfsSnapshot({ snapshot });
  } catch {
    return buildPublicIpfsSnapshot({ snapshot: defaultMetricsSnapshot() });
  }
}

async function recordIpRequest({
  env,
  record,
}: {
  env: Env;
  record: IpfsMetricsRecord;
}): Promise<void> {
  const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
  await stub.fetch("https://metrics.internal/record", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(record),
  });
}

export class MetricsDurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const snapshot = await this.readSnapshot();
      return jsonResponse(snapshot);
    }

    if (request.method === "POST" && url.pathname === "/record") {
      let record: IpfsMetricsRecord;
      try {
        record = (await request.json()) as IpfsMetricsRecord;
      } catch {
        return jsonResponse({ error: "Invalid metrics payload" }, { status: 400 });
      }

      const counters = await this.readCounters();
      counters.requestsServed += Math.max(0, Math.trunc(record.requestCount ?? 0));
      counters.errorResponses += Math.max(0, Math.trunc(record.errorCount ?? 0));

      if (record.gatewayHost !== undefined) {
        counters.gatewayWins[record.gatewayHost] =
          (counters.gatewayWins[record.gatewayHost] ?? 0) + 1;
      }

      const latencySampleCount = Math.max(0, Math.trunc(record.latencySampleCount ?? 0));
      if (latencySampleCount > 0) {
        const latencyMs = Math.max(0, record.latencyMs ?? 0);
        counters.latencyCount += latencySampleCount;
        counters.latencySumMs += latencyMs;
        counters.latencyMaxMs = Math.max(counters.latencyMaxMs, latencyMs);

        const bucket = latencyBucket({ latencyMs });
        counters.latencyBuckets[bucket] = (counters.latencyBuckets[bucket] ?? 0) + 1;
      }

      await this.state.storage.put(COUNTERS_STORAGE_KEY, counters);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  private async readSnapshot(): Promise<MetricsStorageSnapshot> {
    return this.readCounters();
  }

  private async readCounters(): Promise<MetricsCounters> {
    const stored = await this.state.storage.get<Partial<MetricsCounters>>(COUNTERS_STORAGE_KEY);
    if (stored !== undefined) {
      return normalizeCounters(stored);
    }

    const initial = defaultMetricsSnapshot();
    await this.state.storage.put(COUNTERS_STORAGE_KEY, initial);
    return initial;
  }
}
