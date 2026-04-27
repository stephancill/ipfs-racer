const GATEWAYS = [
  "ipfs.stupidtech.net",
  "dweb.link",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
];
const RUNS = 10;

const RESOURCES = [
  {
    name: "html (stephancill.eth)",
    path: "/ipfs/bafybeigh4gxve5vyab2qbus3o6w22fpyex6rpk3k4r2guafjoeezkraf2e/",
  },
  {
    name: "html (vitalik.eth)",
    path: "/ipfs/bafybeiaql2jo3fu5b7c4lmpoi5drh5sam7yt652shwdgwbky4o7uw33u2u/",
  },
  {
    name: "css (vitalik.eth)",
    path: "/ipfs/bafybeiaql2jo3fu5b7c4lmpoi5drh5sam7yt652shwdgwbky4o7uw33u2u/css/main.css",
  },
  {
    name: "css (stephancill.eth)",
    path: "/ipfs/bafybeigh4gxve5vyab2qbus3o6w22fpyex6rpk3k4r2guafjoeezkraf2e/theme.css",
  },
  {
    name: "js (vitalik.eth)",
    path: "/ipfs/bafybeiaql2jo3fu5b7c4lmpoi5drh5sam7yt652shwdgwbky4o7uw33u2u/scripts/tex-svg.js",
  },
];

async function measure(url) {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html,text/css,text/javascript,*/*" },
    });
    const body = await response.text();
    const duration = performance.now() - start;
    return { ok: response.ok, status: response.status, size: body.length, duration };
  } catch (error) {
    return { ok: false, error: error.message, duration: performance.now() - start };
  }
}

function stats(results) {
  const durations = results.map((r) => r.duration).sort((a, b) => a - b);
  const avg = durations.reduce((s, v) => s + v, 0) / durations.length;
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const min = durations[0];
  const max = durations[durations.length - 1];
  const failures = results.filter((r) => !r.ok).length;
  return {
    avg: Math.round(avg),
    p50: Math.round(p50),
    p95: Math.round(p95),
    min: Math.round(min),
    max: Math.round(max),
    failures,
  };
}

console.log("benchmarking ipfs gateways...\n");

for (const resource of RESOURCES) {
  console.log(`${resource.name}`);
  console.log(`  ${resource.path}\n`);

  for (const gateway of GATEWAYS) {
    const url =
      gateway === "ipfs.stupidtech.net"
        ? `https://${gateway}${resource.path}`
        : `https://${gateway}${resource.path}`;
    const results = [];
    for (let i = 0; i < RUNS; i++) {
      results.push(await measure(url));
    }
    const s = stats(results);
    const label = gateway.padEnd(24);
    console.log(
      `  ${label}  avg ${String(s.avg).padStart(4)}ms  p50 ${String(s.p50).padStart(4)}ms  p95 ${String(s.p95).padStart(4)}ms  min ${String(s.min).padStart(4)}ms  max ${String(s.max).padStart(4)}ms${s.failures ? `  (${s.failures} failures)` : ""}`,
    );
  }

  console.log();
}
