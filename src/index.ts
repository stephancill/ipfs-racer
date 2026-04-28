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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { hostname, pathname } = url;

    const subdomain = extractSubdomainCID(hostname);
    const isRootDomain = hostname === "ipfs.stupidtech.net";

    if (isRootDomain) {
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
      return serveContent({ cid: pathCID.cid, isIPFS: false, resource, url });
    }

    if (subdomain) {
      return serveContent({
        cid: subdomain.cid,
        isIPFS: subdomain.isIPFS,
        resource: pathname.slice(1),
        url,
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
}: {
  cid: string;
  isIPFS: boolean;
  resource: string;
  url: URL;
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

  const [response, age] = await Promise.all([
    fetchFirstValidGatewayResponse(gatewayPaths),
    sref ? lookupContenthashAge(sref).catch(() => null) : Promise.resolve(null),
  ]);

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
