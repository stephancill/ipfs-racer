const IPFS_HOSTS = ["dweb.link", "ipfs.io", "cloudflare-ipfs.com", "gateway.pinata.cloud"];

function redirect(target: string): Response {
  return Response.redirect(target, 301);
}

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
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const isIPFS = pathname.startsWith("/ipfs/");
    const isIPNS = pathname.startsWith("/ipns/");

    if (!isIPFS && !isIPNS) {
      if (pathname === "/" || pathname === "") {
        return new Response("ipfs.stupidtech.net — IPFS/IPNS gateway racer", {
          headers: { "Content-Type": "text/plain" },
        });
      }

      return redirect(`https://dweb.link${pathname}${url.search}`);
    }

    const cid = extractCID(pathname);
    if (!cid) {
      return new Response("invalid path", { status: 400 });
    }

    const prefix = isIPFS ? "/ipfs/" : "/ipns/";
    if (!pathname.endsWith("/") && pathname.slice(prefix.length) === cid) {
      return redirect(`${url.pathname}/${url.search}`);
    }

    const resource = pathname.slice(prefix.length).slice(cid.length).replace(/^\//, "");
    const gatewayPaths = IPFS_HOSTS.map((host) => {
      const base = `https://${host}/${isIPFS ? "ipfs" : "ipns"}/${cid}`;
      return resource ? `${base}/${resource}` : base;
    });

    const response = await fetchFirstValidGatewayResponse(gatewayPaths);
    if (response) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", headers.get("Cache-Control") ?? "public, max-age=300");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return new Response("no reachable gateway", { status: 502 });
  },
};
