const IPFS_HOSTS = ["dweb.link", "ipfs.io", "gateway.pinata.cloud"];

type Env = {
  ASSETS: Fetcher;
  METRICS_DO: DurableObjectNamespace;
};

function redirect(target: string): Response {
  return Response.redirect(target, 301);
}

import { freshnessHtml, lookupContenthashAge } from "./ens";

async function fetchFirstValidGateway(
  urls: string[],
): Promise<{ index: number; response: Response } | null> {
  const controllers = urls.map(() => new AbortController());

  try {
    const { index, response } = await Promise.any(
      urls.map(async (url, index) => {
        const response = await fetch(url, {
          signal: controllers[index].signal,
        });

        if (!response.ok) {
          throw new Error(`bad status ${response.status}`);
        }

        return { index, response };
      }),
    );

    controllers.forEach((controller, controllerIndex) => {
      if (controllerIndex !== index) {
        controller.abort();
      }
    });

    return { index, response };
  } catch {
    return null;
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { hostname, pathname } = url;

    const subdomain = extractSubdomainCID(hostname);
    const isRootDomain = hostname === "ipfs.stupidtech.net";

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
        const resource = pathname.slice(`/ipfs/${pathCID.cid}`.length).replace(/^\//, "");
        const path = resource ? `/${resource}` : "/";
        return redirect(`https://${pathCID.cid}.ipfs.stupidtech.net${path}${url.search}`);
      }

      const resource = pathname.slice(`/ipns/${pathCID.cid}`.length).replace(/^\//, "");
      return serveContent({ cid: pathCID.cid, isIPFS: false, resource, url, env, ctx });
    }

    if (subdomain) {
      return serveContent({
        cid: subdomain.cid,
        isIPFS: subdomain.isIPFS,
        resource: pathname.slice(1),
        url,
        env,
        ctx,
      });
    }

    return redirect(`https://dweb.link${pathname}${url.search}`);
  },
};

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

  const gatewayPaths = IPFS_HOSTS.map((host) => {
    if (isIPFS && host === "dweb.link") {
      return `https://${cid}.ipfs.${host}${resource ? `/${resource}` : "/"}${gatewaySearch}`;
    }
    const base = `https://${host}/${isIPFS ? "ipfs" : "ipns"}/${cid}`;
    const path = resource ? `${base}/${resource}` : base;
    return `${path}${gatewaySearch}`;
  });

  const startedAt = performance.now();
  const gatewayPromise = fetchFirstValidGateway(gatewayPaths);
  const agePromise = sref ? lookupContenthashAge(sref).catch(() => null) : Promise.resolve(null);
  const result = await gatewayPromise;
  const latencyMs = Math.max(0, performance.now() - startedAt);
  const age = await agePromise;

  const response = result?.response ?? null;
  const record: IpfsMetricsRecord = {
    requestCount: 1,
    errorCount: response ? 0 : 1,
    latencyMs,
    latencySampleCount: 1,
    gatewayHost: result?.index !== undefined ? IPFS_HOSTS[result.index] : undefined,
  };
  ctx.waitUntil(recordIpRequest({ env, record }));

  if (response) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", headers.get("Cache-Control") ?? "public, max-age=300");

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

  return new Response("no reachable gateway", { status: 502 });
}

const COUNTERS_STORAGE_KEY = "counters";

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
    requestsServed: 0,
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
