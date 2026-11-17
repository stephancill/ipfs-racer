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

Most free deserializing gateways are gone: `ipfs.io` and `dweb.link` were sunset on 2026-09-21 (they now
return 429 for everything), and `gateway.pinata.cloud` refuses to serve HTML. Requests race:

- **Verified trustless retrieval**: fetches a CAR for `/ipfs/<cid>/<path>` from
  [trustless gateways](https://specs.ipfs.tech/http-gateways/trustless-gateway/), checks every block
  against its hash, and decodes UnixFS (files, directories, HAMT shards, `index.html`) in the Worker.
  - `ipfs.orbitor.dev`
  - HTTP providers discovered via delegated routing (`delegated-ipfs.dev`), e.g. `trustless.filebase.io`
- **Deserializing gateway**: `ipfs.raribleuserdata.com` (path)

`/ipns/` names are resolved via ENS contenthash (`.eth`) or DNSLink for the trustless path.
Successful `/ipfs/` responses are cached at the edge, since they are immutable.

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
