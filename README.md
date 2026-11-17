# ipfs-racer

Cloudflare Worker that races IPFS retrieval strategies and returns the first valid response.

## Usage

```
https://<cid>.ipfs.stupidtech.net/
https://<cid>.ipfs.stupidtech.net/path/to/resource
```

The path-based format redirects to the subdomain format:

```
https://ipfs.stupidtech.net/ipfs/<cid>/    →  https://<cid>.ipfs.stupidtech.net/
https://ipfs.stupidtech.net/ipns/<name>/   →  served directly
```

## Gateways

Most free deserializing gateways are gone. IPFS started rate limiting backend traffic to `ipfs.io` and
`dweb.link` in 2026 (they now return 429), `trustless-gateway.link` is down, and `gateway.pinata.cloud`
refuses to serve HTML. See [IPFS is moving beyond the sponsored gateways](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/).

Requests race:

- **Deserializing gateways** (one request, fastest when they have the content):
  `ipfs.filebase.io`, `ipfs.raribleuserdata.com` (a Filebase-hosted gateway).
- **Verified retrieval** with [`@helia/verified-fetch`](https://www.npmjs.com/package/@helia/verified-fetch)
  (HTTP-only Helia): raw blocks are fetched from trustless gateways, checked against their CIDs, and
  decoded in the Worker. Block sources:
  - `ipfs.orbitor.dev`, `eu.orbitor.dev`, `apac.orbitor.dev`, `latam.orbitor.dev`
  - `ipfs.greyh.at`, `via0.com`, `ipfs.filebase.io`
  - providers found via delegated routing (`delegated-ipfs.dev`), e.g. `trustless.filebase.io`

`ipfs.orbitor.dev` is only used for verified blocks: its rendered HTML has a Cloudflare challenge
script injected into it.

The list was picked by probing every gateway ever listed in
[ipfs/public-gateway-checker](https://github.com/ipfs/public-gateway-checker) plus the
[MISP list](https://github.com/MISP/misp-warninglists/blob/main/lists/public-ipfs-gateways/list.json)
(183 hosts, November 2026). Update `src/ipfs.ts` and `DESERIALIZED_GATEWAYS` in `src/index.ts` as
gateways come and go.

`/ipns/` names: `.eth` names resolve through their ENS contenthash, everything else (DNSLink, IPNS
keys) through verified-fetch. Successful `/ipfs/` responses are cached at the edge (they are immutable).

CIDv0 (`Qm...`) links are redirected to a base32 CIDv1 subdomain, because hostnames are lowercased
and base58 CIDs are case-sensitive.

## ENS freshness indicator

When visiting via a search engine like [stupid search](https://search.stupidtech.net), a dot appears in the bottom-right corner:

- **Green** — No contenthash changes in the last 24 hours.
- **Orange** — Recently updated (shows how long ago).

## Stats

- `GET /stats`
  - Returns service metrics as JSON, including total requests served, error responses, and average latency, plus how often each gateway won the race.
  - Example: `curl -sS https://ipfs.stupidtech.net/stats`

Metrics are aggregated in a SQLite-backed Durable Object, so the counters are eventually consistent across requests.

The `requestsServed` counter starts from a baseline seed (≈3,500) derived from the prior 30 days of Cloudflare Worker metrics (10,526 gateway subrequests ÷ 3 raced gateways) so the stats page isn't empty on first deploy. `errorResponses`, latency, and gateway wins accrue from real traffic going forward since Cloudflare doesn't expose those per provided-gateway.

## Development

```bash
bun install
bun run dev
```

## Checks

```bash
bun run format
bun run lint
```

## Deploy

```bash
bun run deploy
```
