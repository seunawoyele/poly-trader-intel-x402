# Polymarket Trader Intelligence — x402 API

Paid per-query API that surfaces the most profitable Polymarket traders, enriched with win-rate/concentration analysis and optional Octav cross-chain wallet quality scoring. Sold as metered endpoints over x402 USDC micropayments.

**Live:** https://poly-trader-intel-x402.vercel.app
**GitHub:** https://github.com/seunawoyele/poly-trader-intel-x402

## Endpoints

| Endpoint | Price | Description |
|---|---|---|
| `GET /health` | Free | Health check |
| `GET /` | Free | Service info + pricing |
| `GET /sample` | Free | 3 traders from CRYPTO/WEEK, basic enrichment — teaser |
| `GET /sector-summary` | $0.01 | Aggregate sector stats (avg PnL, volume, distribution) |
| `GET /trader-leaderboard` | $0.02 (basic) / $0.15 (full) | Ranked traders with win rate, concentration, optional Octav |
| `GET /wallet-lookup` | $0.05 (full) | Single wallet deep dive with top positions |

## Query Parameters

### `/trader-leaderboard`
- `category` (required) — `OVERALL`, `POLITICS`, `SPORTS`, `ESPORTS`, `CRYPTO`, `CULTURE`, `MENTIONS`, `WEATHER`, `ECONOMICS`, `TECH`, `FINANCE`
- `period` — `DAY`, `WEEK`, `MONTH`, `ALL` (default: `WEEK`)
- `limit` — max traders (default: 20, cap: 100)
- `enrich` — `basic` (Polymarket only) / `full` (adds Octav cross-chain net worth)

### `/wallet-lookup`
- `wallet` (required) — `0x...` address
- `enrich` — `basic` / `full`

### `/sector-summary`
- `category` (required)
- `period` — default `WEEK`

## Payment

- **Protocol:** x402
- **Method:** Circle Gateway batched USDC
- **Network:** Base mainnet (`eip155:8453`)
- **Seller:** `0x3237b37397094b9a3b48a9aac8f627ac654b927c`

Unpaid requests receive HTTP 402 with a `payment-required` header containing the x402 challenge. Use any x402-compatible client (e.g. `circle services pay`) to pay and receive the data in a single call.

## Architecture

- **Data sources:** Polymarket Data API (public, free) + Octav API (Bearer key, 1 credit/wallet)
- **Caching:** TTL-based — leaderboard 20min, positions 20min, Octav 12h
- **Rate limiting:** 30 req/min per IP
- **Octav credit metering:** tracks credits consumed per refresh cycle
- **Graceful degradation:** failed Octav lookups return `octav_status: "error"`, basic data always delivered

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SELLER_ADDRESS` | `0x3237...` | Wallet receiving USDC payments |
| `FACILITATOR_URL` | `https://gateway-api.circle.com` | Circle Gateway facilitator |
| `X402_NETWORKS` | `eip155:8453` | Accepted payment networks |
| `PRICE_SECTOR_SUMMARY` | `0.01` | Price in USD |
| `PRICE_LEADERBOARD_BASIC` | `0.02` | Price in USD |
| `PRICE_LEADERBOARD_FULL` | `0.15` | Price in USD |
| `PRICE_WALLET_LOOKUP_FULL` | `0.05` | Price in USD |
| `OCTAV_API_KEY` | _(empty)_ | Octav API key for `full` enrichment |
| `CACHE_TTL_LEADERBOARD` | `1200` | Seconds (20 min) |
| `CACHE_TTL_POSITIONS` | `1200` | Seconds (20 min) |
| `CACHE_TTL_OCTAV` | `43200` | Seconds (12 hours) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `30` | Max requests per window per IP |
| `PORT` | `3001` | Local dev port |

## Local Development

```bash
npm install
cp .env.example .env  # edit as needed
npm start
```

## Deploy

```bash
vercel --prod
```

## Data Sources

| Source | Auth | Cost | What we pull |
|---|---|---|---|
| `data-api.polymarket.com/v1/leaderboard` | none | free | Ranked traders by PnL/volume |
| `data-api.polymarket.com/v1/positions` | none | free | Per-wallet position detail → win rate, concentration |
| `api.octav.fi/v1/portfolio` | Bearer key | 1 credit/call | Cross-chain net worth for wallet quality scoring |
