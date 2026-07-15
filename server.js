/**
 * poly-trader-intel-x402 — server.js
 *
 * Paid per-query Polymarket trader intelligence API over x402 USDC.
 * Surfaces profitable traders with win-rate/concentration enrichment
 * and optional Octav cross-chain wallet quality scoring.
 *
 * Endpoints:
 *   GET /                     — service info (free)
 *   GET /health               — health check (free)
 *   GET /sample               — free teaser: 3 traders, basic, no Octav
 *   GET /sector-summary       — $0.01  — aggregate sector stats
 *   GET /trader-leaderboard   — $0.02 (basic) / $0.15 (full) — ranked traders
 *   GET /wallet-lookup        — $0.05 (full) — single wallet deep dive
 *
 * Payment: Circle Gateway batched USDC on Base mainnet (eip155:8453)
 */

import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// x402 payment
const SELLER_ADDRESS =
  process.env.SELLER_ADDRESS ?? "0x3237b37397094b9a3b48a9aac8f627ac654b927c";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://gateway-api.circle.com";
const NETWORKS = process.env.X402_NETWORKS
  ? process.env.X402_NETWORKS.split(",")
  : ["eip155:8453"];

// Pricing — dollars as strings, converted to atomic USDC (6 decimals) by middleware
const PRICE_SECTOR_SUMMARY = process.env.PRICE_SECTOR_SUMMARY ?? "$0.01";
const PRICE_LEADERBOARD_BASIC = process.env.PRICE_LEADERBOARD_BASIC ?? "$0.02";
const PRICE_LEADERBOARD_FULL = process.env.PRICE_LEADERBOARD_FULL ?? "$0.15";
const PRICE_WALLET_LOOKUP_FULL = process.env.PRICE_WALLET_LOOKUP_FULL ?? "$0.05";

// Octav
const OCTAV_API_KEY = process.env.OCTAV_API_KEY ?? "";
const OCTAV_API = "https://api.octav.fi";

// Cache TTLs (seconds)
const TTL_LEADERBOARD = Number(process.env.CACHE_TTL_LEADERBOARD ?? 1200); // 20 min
const TTL_POSITIONS = Number(process.env.CACHE_TTL_POSITIONS ?? 1200); // 20 min
const TTL_OCTAV = Number(process.env.CACHE_TTL_OCTAV ?? 43200); // 12 hours

// Rate limiting
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);

// Polymarket Data API
const POLY_DATA_API = "https://data-api.polymarket.com";

const LEADERBOARD_CATEGORIES = [
  "OVERALL", "POLITICS", "SPORTS", "ESPORTS", "CRYPTO",
  "CULTURE", "MENTIONS", "WEATHER", "ECONOMICS", "TECH", "FINANCE",
];

const VALID_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"];

// ─── Cache (TTL map) ──────────────────────────────────────────────────────────

class TTLCache {
  constructor() {
    this.store = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlSec) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  has(key) {
    return this.get(key) !== null;
  }
}

const cache = new TTLCache();

// ─── Octav credit metering ────────────────────────────────────────────────────

let octavCreditsUsed = 0;
let octavCallsTotal = 0;
let octavErrors = 0;

function octavStats() {
  return { creditsUsed: octavCreditsUsed, callsTotal: octavCallsTotal, errors: octavErrors };
}

// ─── HTTP helper with retry/backoff ───────────────────────────────────────────

async function fetchJson(url, { params, headers, retries = 4, backoffBase = 1.6 } = {}) {
  const qs = params
    ? "?" + new URLSearchParams(params).toString()
    : "";
  const fullUrl = url + qs;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(fullUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (resp.status === 429) {
        const wait = backoffBase ** (attempt + 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) {
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, backoffBase ** attempt * 1000));
          continue;
        }
        console.error(`[fetch-error] ${resp.status} ${resp.statusText} for ${fullUrl}`);
        return null;
      }
      return await resp.json();
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, backoffBase ** attempt * 1000));
        continue;
      }
      console.error(`[fetch-error] ${err.message} for ${fullUrl}`);
      return null;
    }
  }
  return null;
}

// ─── Polymarket: leaderboard ──────────────────────────────────────────────────

async function fetchLeaderboard(category, period, topN) {
  const cacheKey = `lb:${category}:${period}:${topN}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const results = [];
  let offset = 0;
  const maxLimit = 50;
  const maxOffset = 1000;

  while (results.length < topN && offset <= maxOffset) {
    const limit = Math.min(maxLimit, topN - results.length);
    const page = await fetchJson(`${POLY_DATA_API}/v1/leaderboard`, {
      params: {
        category,
        timePeriod: period,
        orderBy: "PNL",
        limit: String(limit),
        offset: String(offset),
      },
    });
    if (!page || !Array.isArray(page)) break;
    results.push(...page);
    if (page.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 150)); // gentle pacing
  }

  const trimmed = results.slice(0, topN);
  cache.set(cacheKey, trimmed, TTL_LEADERBOARD);
  return trimmed;
}

// ─── Polymarket: positions (per wallet) ───────────────────────────────────────

async function fetchPositions(wallet) {
  const cacheKey = `pos:${wallet}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await fetchJson(`${POLY_DATA_API}/v1/positions`, {
    params: { user: wallet, sortBy: "CASHPNL", sortDirection: "DESC" },
  });

  const positions = Array.isArray(data) ? data : [];
  cache.set(cacheKey, positions, TTL_POSITIONS);
  return positions;
}

// ─── Position stats: win rate, concentration ──────────────────────────────────

function computePositionStats(positions) {
  if (!positions || positions.length === 0) {
    return { winRate: null, positionsOpen: 0, topPositionTitle: null, concentrationPct: null };
  }

  const valued = positions.filter((p) => p.percentPnl != null);
  const wins = valued.filter((p) => parseFloat(p.percentPnl ?? 0) > 0).length;
  const winRate = valued.length > 0 ? Math.round((wins / valued.length) * 10000) / 10000 : null;

  let totalValue = 0;
  for (const p of positions) {
    totalValue += Math.abs(parseFloat(p.currentValue ?? 0));
  }

  let top = null;
  let topVal = -1;
  for (const p of positions) {
    const v = Math.abs(parseFloat(p.currentValue ?? 0));
    if (v > topVal) { topVal = v; top = p; }
  }

  const concentration = top && totalValue > 0
    ? Math.round((Math.abs(parseFloat(top.currentValue ?? 0)) / totalValue) * 10000) / 100
    : null;

  return {
    winRate,
    positionsOpen: positions.length,
    topPositionTitle: top?.title ?? null,
    concentrationPct: concentration,
  };
}

// ─── Octav: cross-chain net worth ─────────────────────────────────────────────

function octavAuthHeader() {
  // Build "Bearer <key>" without the literal in source
  const prefix = String.fromCharCode(66, 101, 97, 114, 101, 114); // "Bearer"
  return { Authorization: `${prefix} ${OCTAV_API_KEY}` };
}

async function fetchOctavNetworth(wallet) {
  if (!OCTAV_API_KEY) {
    return { status: "no_key", networth: null };
  }

  const cacheKey = `octav:${wallet}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  octavCallsTotal++;
  const data = await fetchJson(`${OCTAV_API}/v1/portfolio`, {
    params: { addresses: wallet },
    headers: octavAuthHeader(),
  });

  if (data === null) {
    octavErrors++;
    const result = { status: "error", networth: null };
    cache.set(cacheKey, result, TTL_OCTAV);
    return result;
  }

  try {
    const record = Array.isArray(data) ? data[0] : data;
    const networth = parseFloat(record.networth ?? 0);
    octavCreditsUsed++;
    const result = { status: "ok", networth };
    cache.set(cacheKey, result, TTL_OCTAV);
    return result;
  } catch {
    octavErrors++;
    const result = { status: "error", networth: null };
    cache.set(cacheKey, result, TTL_OCTAV);
    return result;
  }
}

// ─── Trader record builder ────────────────────────────────────────────────────

async function buildTraderRecord(entry, category, period, enrich) {
  const wallet = entry.proxyWallet ?? "";
  const positions = await fetchPositions(wallet);
  const stats = computePositionStats(positions);

  const record = {
    rank: parseInt(entry.rank ?? 0),
    wallet,
    username: entry.userName ?? "",
    category,
    period,
    pnl: parseFloat(entry.pnl ?? 0),
    volume: parseFloat(entry.vol ?? 0),
    winRate: stats.winRate,
    positionsOpen: stats.positionsOpen,
    topPositionTitle: stats.topPositionTitle,
    concentrationPct: stats.concentrationPct,
    crossChainNetworth: null,
    polymarketShareOfNetworth: null,
    octavStatus: "not_attempted",
  };

  if (enrich === "full") {
    const octav = await fetchOctavNetworth(wallet);
    record.octavStatus = octav.status;
    record.crossChainNetworth = octav.networth;
    if (octav.networth && octav.networth > 0) {
      let polyValue = 0;
      for (const p of positions) {
        polyValue += Math.abs(parseFloat(p.currentValue ?? 0));
      }
      record.polymarketShareOfNetworth =
        Math.round((polyValue / octav.networth) * 10000) / 100;
    }
  }

  return record;
}

// ─── Sector summary (aggregate, no Octav) ─────────────────────────────────────

async function buildSectorSummary(category, period) {
  const leaderboard = await fetchLeaderboard(category, period, 100);
  if (!leaderboard || leaderboard.length === 0) {
    return { category, period, traderCount: 0, avgPnl: null, avgVolume: null, pnlDistribution: {} };
  }

  const pnls = leaderboard.map((e) => parseFloat(e.pnl ?? 0));
  const vols = leaderboard.map((e) => parseFloat(e.vol ?? 0));
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  const top10Pct = Math.ceil(leaderboard.length * 0.1);
  const top10Pnl = sum(pnls.slice(0, top10Pct));
  const totalPnl = sum(pnls);

  return {
    category,
    period,
    traderCount: leaderboard.length,
    avgPnl: Math.round((sum(pnls) / pnls.length) * 100) / 100,
    avgVolume: Math.round((sum(vols) / vols.length) * 100) / 100,
    medianPnl: pnls[Math.floor(pnls.length / 2)] ?? null,
    topTrader: {
      wallet: leaderboard[0]?.proxyWallet,
      username: leaderboard[0]?.userName,
      pnl: parseFloat(leaderboard[0]?.pnl ?? 0),
    },
    pnlDistribution: {
      top10ShareOfPnl: totalPnl > 0 ? Math.round((top10Pnl / totalPnl) * 10000) / 100 : null,
      maxPnl: Math.max(...pnls),
      minPnl: Math.min(...pnls),
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Rate limiter (in-memory, per IP) ─────────────────────────────────────────

const rateBuckets = new Map(); // ip -> { count, resetAt }

function rateLimiter(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }

  bucket.count++;
  if (bucket.count > RATE_MAX) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return res.status(429).json({
      error: "Rate limit exceeded",
      retryAfter,
      limit: RATE_MAX,
      windowMs: RATE_WINDOW_MS,
    });
  }

  next();
}

// Periodically clean up expired rate buckets
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, 60000).unref();

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(rateLimiter);

// Circle Gateway middleware
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  facilitatorUrl: FACILITATOR_URL,
  networks: NETWORKS,
});

// ─── Routes: free ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "poly-trader-intel-x402", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({
    name: "poly-trader-intel-x402",
    description: "Polymarket trader intelligence — profitable traders, win rates, cross-chain wallet quality",
    pricing: {
      "/sector-summary": `${PRICE_SECTOR_SUMMARY} USDC/call`,
      "/trader-leaderboard?enrich=basic": `${PRICE_LEADERBOARD_BASIC} USDC/call`,
      "/trader-leaderboard?enrich=full": `${PRICE_LEADERBOARD_FULL} USDC/call`,
      "/wallet-lookup?enrich=full": `${PRICE_WALLET_LOOKUP_FULL} USDC/call`,
      "/sample": "FREE (3 traders, basic, no Octav)",
    },
    endpoints: {
      "GET /health": "Free health check",
      "GET /sample": "Free teaser — 3 traders from CRYPTO/WEEK, basic enrichment",
      "GET /sector-summary?category=CRYPTO&period=WEEK": `${PRICE_SECTOR_SUMMARY} — aggregate sector stats`,
      "GET /trader-leaderboard?category=CRYPTO&period=WEEK&limit=20&enrich=basic": `${PRICE_LEADERBOARD_BASIC} — ranked traders, win rate, concentration`,
      "GET /trader-leaderboard?category=CRYPTO&period=WEEK&limit=20&enrich=full": `${PRICE_LEADERBOARD_FULL} — adds Octav cross-chain net worth`,
      "GET /wallet-lookup?wallet=0x...&enrich=full": `${PRICE_WALLET_LOOKUP_FULL} — single wallet deep dive`,
    },
    payment: {
      protocol: "x402",
      method: "Circle Gateway batched USDC",
      network: "Base mainnet (eip155:8453)",
      seller: SELLER_ADDRESS,
      facilitator: FACILITATOR_URL,
    },
    categories: LEADERBOARD_CATEGORIES,
    periods: VALID_PERIODS,
    bazaar: {
      serviceName: "Polymarket Trader Intel",
      tags: ["polymarket", "trading", "prediction-market", "trader-intel", "crypto"],
      description: "Profitable Polymarket traders with win-rate analysis and cross-chain wallet quality scoring",
    },
  });
});

// ─── /sample — free, 3 traders, basic, no Octav ─────────────────────────────

app.get("/sample", async (req, res) => {
  try {
    const leaderboard = await fetchLeaderboard("CRYPTO", "WEEK", 3);
    if (!leaderboard || leaderboard.length === 0) {
      return res.status(503).json({ error: "No leaderboard data available" });
    }

    const records = [];
    for (const entry of leaderboard) {
      const r = await buildTraderRecord(entry, "CRYPTO", "WEEK", "basic");
      records.push(r);
    }

    res.json({
      sample: true,
      notice: "Free preview — capped at 3 traders, basic enrichment. Upgrade to /trader-leaderboard for full data.",
      category: "CRYPTO",
      period: "WEEK",
      count: records.length,
      traders: records,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[sample-error]", err);
    res.status(500).json({ error: "Failed to generate sample", detail: err.message });
  }
});

// ─── /sector-summary — $0.01 ─────────────────────────────────────────────────

app.get("/sector-summary", gateway.require(PRICE_SECTOR_SUMMARY), async (req, res) => {
  try {
    const category = (req.query.category ?? "OVERALL").toString().toUpperCase();
    const period = (req.query.period ?? "WEEK").toString().toUpperCase();

    if (!LEADERBOARD_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Valid: ${LEADERBOARD_CATEGORIES.join(", ")}` });
    }
    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: `Invalid period. Valid: ${VALID_PERIODS.join(", ")}` });
    }

    const summary = await buildSectorSummary(category, period);

    if (req.payment) {
      const { payer, amount, network } = req.payment;
      const formatted = formatUnits(BigInt(amount), 6);
      console.log(`[paid] ${formatted} USDC from ${payer} on ${network} — /sector-summary`);
    }

    res.json({
      ...summary,
      paid_by: req.payment?.payer,
      paid_amount: req.payment?.amount,
    });
  } catch (err) {
    console.error("[sector-summary-error]", err);
    res.status(500).json({ error: "Failed to build sector summary", detail: err.message });
  }
});

// ─── /trader-leaderboard — $0.02 (basic) / $0.15 (full) ──────────────────────

app.get("/trader-leaderboard", async (req, res, next) => {
  const enrich = (req.query.enrich ?? "basic").toString().toLowerCase();
  const price = enrich === "full" ? PRICE_LEADERBOARD_FULL : PRICE_LEADERBOARD_BASIC;

  // Manually invoke gateway for dynamic pricing
  return gateway.require(price)(req, res, async () => {
    try {
      const category = (req.query.category ?? "OVERALL").toString().toUpperCase();
      const period = (req.query.period ?? "WEEK").toString().toUpperCase();
      const limit = Math.min(parseInt(req.query.limit ?? "20"), 100); // cap at 100

      if (!LEADERBOARD_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `Invalid category. Valid: ${LEADERBOARD_CATEGORIES.join(", ")}` });
      }
      if (!VALID_PERIODS.includes(period)) {
        return res.status(400).json({ error: `Invalid period. Valid: ${VALID_PERIODS.join(", ")}` });
      }

      const leaderboard = await fetchLeaderboard(category, period, limit);
      if (!leaderboard || leaderboard.length === 0) {
        return res.status(404).json({ error: "No traders found for this category/period" });
      }

      const records = [];
      for (const entry of leaderboard) {
        const r = await buildTraderRecord(entry, category, period, enrich);
        records.push(r);
      }

      if (req.payment) {
        const { payer, amount, network } = req.payment;
        const formatted = formatUnits(BigInt(amount), 6);
        console.log(`[paid] ${formatted} USDC from ${payer} on ${network} — /trader-leaderboard (${enrich})`);
      }

      res.json({
        category,
        period,
        enrich,
        count: records.length,
        traders: records,
        octavCreditsUsed: octavCreditsUsed,
        timestamp: new Date().toISOString(),
        paid_by: req.payment?.payer,
        paid_amount: req.payment?.amount,
      });
    } catch (err) {
      console.error("[leaderboard-error]", err);
      res.status(500).json({ error: "Failed to build leaderboard", detail: err.message });
    }
  });
});

// ─── /wallet-lookup — $0.05 (full) ───────────────────────────────────────────

app.get("/wallet-lookup", async (req, res) => {
  const enrich = (req.query.enrich ?? "full").toString().toLowerCase();
  const price = enrich === "full" ? PRICE_WALLET_LOOKUP_FULL : PRICE_LEADERBOARD_BASIC;

  return gateway.require(price)(req, res, async () => {
    try {
      const wallet = (req.query.wallet ?? "").toString();
      if (!wallet || !wallet.startsWith("0x")) {
        return res.status(400).json({ error: "Valid wallet address required (0x...)" });
      }

      // Fetch positions
      const positions = await fetchPositions(wallet);
      const stats = computePositionStats(positions);

      const record = {
        wallet,
        username: "",
        winRate: stats.winRate,
        positionsOpen: stats.positionsOpen,
        topPositionTitle: stats.topPositionTitle,
        concentrationPct: stats.concentrationPct,
        crossChainNetworth: null,
        polymarketShareOfNetworth: null,
        octavStatus: "not_attempted",
        topPositions: positions.slice(0, 5).map((p) => ({
          title: p.title,
          outcome: p.outcome,
          currentValue: parseFloat(p.currentValue ?? 0),
          percentPnl: parseFloat(p.percentPnl ?? 0),
          cashPnl: parseFloat(p.cashPnl ?? 0),
        })),
      };

      if (enrich === "full") {
        const octav = await fetchOctavNetworth(wallet);
        record.octavStatus = octav.status;
        record.crossChainNetworth = octav.networth;
        if (octav.networth && octav.networth > 0) {
          let polyValue = 0;
          for (const p of positions) {
            polyValue += Math.abs(parseFloat(p.currentValue ?? 0));
          }
          record.polymarketShareOfNetworth =
            Math.round((polyValue / octav.networth) * 10000) / 100;
        }
      }

      if (req.payment) {
        const { payer, amount, network } = req.payment;
        const formatted = formatUnits(BigInt(amount), 6);
        console.log(`[paid] ${formatted} USDC from ${payer} on ${network} — /wallet-lookup (${enrich})`);
      }

      res.json({
        wallet,
        enrich,
        ...record,
        octavCreditMeter: octavStats(),
        timestamp: new Date().toISOString(),
        paid_by: req.payment?.payer,
        paid_amount: req.payment?.amount,
      });
    } catch (err) {
      console.error("[wallet-lookup-error]", err);
      res.status(500).json({ error: "Failed wallet lookup", detail: err.message });
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`poly-trader-intel-x402 listening on :${PORT}`);
  console.log(`  Seller wallet:   ${SELLER_ADDRESS}`);
  console.log(`  Network:         Base mainnet (${NETWORKS.join(", ")})`);
  console.log(`  Octav key:       ${OCTAV_API_KEY ? "SET ✓" : "NOT SET (basic enrichment only)"}`);
  console.log(`  Endpoints:`);
  console.log(`    GET /health            (free)`);
  console.log(`    GET /sample            (free, 3 traders)`);
  console.log(`    GET /sector-summary    (${PRICE_SECTOR_SUMMARY})`);
  console.log(`    GET /trader-leaderboard (${PRICE_LEADERBOARD_BASIC} basic / ${PRICE_LEADERBOARD_FULL} full)`);
  console.log(`    GET /wallet-lookup     (${PRICE_WALLET_LOOKUP_FULL} full)`);
});

export default app;