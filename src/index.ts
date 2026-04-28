const IPFS_HOSTS = ["dweb.link", "ipfs.io", "gateway.pinata.cloud"];

type Env = {
  ASSETS: Fetcher;
};

function redirect(target: string): Response {
  return Response.redirect(target, 301);
}

import { freshnessHtml, lookupContenthashAge } from "./ens";

async function fetchFirstValidGatewayResponse(urls: string[]): Promise<Response | null> {
  const controllers = urls.map(() => new AbortController());

  try {
    const { index, response } = await Promise.any(
      urls.map(async (url, index) => {
        const response = await fetch(url, {
          headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
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

    return response;
  } catch {
    return null;
  }
}

function extractCID(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const isIPFS = pathname.startsWith("/ipfs/");
    const isIPNS = pathname.startsWith("/ipns/");

    if (!isIPFS && !isIPNS) {
      if (pathname === "/" || pathname === "") {
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
      }

      return redirect(`https://dweb.link${pathname}${url.search}`);
    }

    const cid = extractCID(pathname);
    if (!cid) {
      return new Response("invalid path", { status: 400 });
    }

    const prefix = isIPFS ? "/ipfs/" : "/ipns/";
    if (!pathname.endsWith("/") && pathname.slice(prefix.length) === cid) {
      return redirect(`${url.origin}${url.pathname}/${url.search}`);
    }

    const resource = pathname.slice(prefix.length).slice(cid.length).replace(/^\//, "");
    const sref = url.searchParams.get("_sref");
    const gatewayParams = new URLSearchParams(url.searchParams);
    gatewayParams.delete("_sref");
    const gatewaySearch = gatewayParams.size ? `?${gatewayParams.toString()}` : "";
    const gatewayPaths = IPFS_HOSTS.map((host) => {
      const base = `https://${host}/${isIPFS ? "ipfs" : "ipns"}/${cid}`;
      const path = resource ? `${base}/${resource}` : base;
      return `${path}${gatewaySearch}`;
    });

    const [response, age] = await Promise.all([
      fetchFirstValidGatewayResponse(gatewayPaths),
      sref ? lookupContenthashAge(sref).catch(() => null) : Promise.resolve(null),
    ]);

    if (response) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", headers.get("Cache-Control") ?? "public, max-age=300");

      if (
        sref &&
        age !== null &&
        (response.headers.get("Content-Type") ?? "").includes("text/html")
      ) {
        const body = await response.text();
        const enriched = `${body}${freshnessHtml(sref, age)}`;
        headers.delete("Content-Length");
        return new Response(enriched, {
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
  },
};
