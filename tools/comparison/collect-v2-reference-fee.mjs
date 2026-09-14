#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRpcClient, resolveFinalizedBlockAtOrBefore } from "../lp/historical-state.mjs";

export const V2_POOL = "0xa290c53cc25f0b857d21421b2f757f9a3434f80e";
export const WETH = "0x4200000000000000000000000000000000000006";
export const CP = "0x934ef4bfffdce191ac4bcc351b2fe7892865b440";
export const POOL_CREATED_AT = "2026-09-06T04:52:55.000Z";
export const LP_FEE_FRACTION = Object.freeze({ numerator: 1n, denominator: 400n });

const DAY_MS = 86_400_000;
const GET_RESERVES_SELECTOR = "0x0902f1ac";
const API_ROOT = "https://api.geckoterminal.com/api/v2";

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator = 1n) {
  if (denominator <= 0n) throw new Error("invalid rational denominator");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function multiply(left, right) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function decimal(value, label) {
  const rendered = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rendered)) throw new Error(label + " is invalid");
  const [integer, fraction = ""] = rendered.split(".");
  return rational(BigInt(integer + fraction), 10n ** BigInt(fraction.length));
}

function serialized(value) {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function utcDay(timestamp) {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error("generated timestamp is invalid");
  return Math.floor(milliseconds / DAY_MS) * DAY_MS;
}

function blockTag(number) {
  return "0x" + BigInt(number).toString(16);
}

function words(result) {
  if (typeof result !== "string" || !/^0x[0-9a-f]{192}$/i.test(result)) throw new Error("getReserves response is malformed");
  return result.slice(2).match(/.{64}/g).map(word => BigInt("0x" + word));
}

async function geckoJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json;version=20230203" } });
  if (!response.ok) throw new Error("GeckoTerminal returned HTTP " + response.status);
  return response.json();
}

function normalizeCandles(payload) {
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error("GeckoTerminal OHLCV response is malformed");
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== 6 || !Number.isInteger(row[0])) throw new Error("OHLCV row is malformed");
    return { timestampMs: row[0] * 1000, open: decimal(row[1], "open"), close: decimal(row[4], "close"),
      volume: decimal(row[5], "volume") };
  }).sort((left, right) => left.timestampMs - right.timestampMs);
}

function priceAtBoundary(candles, boundaryMs) {
  const exact = candles.find(candle => candle.timestampMs === boundaryMs);
  if (exact) return { price: exact.open, sourceTimestampMs: exact.timestampMs, priceField: "open" };
  const prior = candles.filter(candle => candle.timestampMs < boundaryMs).at(-1);
  if (!prior) throw new Error("no price is available at boundary");
  return { price: prior.close, sourceTimestampMs: prior.timestampMs, priceField: "close_carried_forward_no_swaps" };
}

export async function collectV2ReferenceFeeWindow(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const endMs = options.endMs ?? utcDay(generatedAt);
  const startMs = endMs - 7 * DAY_MS;
  if (startMs < Date.parse(POOL_CREATED_AT)) throw new Error("V2 pool does not have seven complete days");
  const fetchImpl = options.fetchImpl || fetch;
  const client = options.client || createRpcClient({ rpcUrl: options.rpcUrl });
  const poolUrl = API_ROOT + "/networks/base/pools/" + V2_POOL + "?include=base_token,quote_token";
  const ohlcvUrl = API_ROOT + "/networks/base/pools/" + V2_POOL + "/ohlcv/day?aggregate=1&limit=10&currency=usd";
  const [poolPayload, ohlcvPayload] = await Promise.all([geckoJson(fetchImpl, poolUrl), geckoJson(fetchImpl, ohlcvUrl)]);
  const attributes = poolPayload?.data?.attributes;
  const relationships = poolPayload?.data?.relationships;
  if (attributes?.address?.toLowerCase() !== V2_POOL || attributes?.name !== "CP / WETH"
      || attributes?.pool_created_at !== "2026-09-06T04:52:55Z"
      || relationships?.base_token?.data?.id?.toLowerCase() !== "base_" + CP
      || relationships?.quote_token?.data?.id?.toLowerCase() !== "base_" + WETH
      || relationships?.dex?.data?.id !== "uniswap-v2-base") throw new Error("V2 pool identity mismatch");
  const candles = normalizeCandles(ohlcvPayload);
  const boundaries = Array.from({ length: 8 }, (_, index) => startMs + index * DAY_MS);
  const snapshots = [];
  for (const boundaryMs of boundaries) {
    const timestamp = new Date(boundaryMs).toISOString();
    const block = await resolveFinalizedBlockAtOrBefore(client, timestamp);
    const [wethReserveRaw, cpReserveRaw] = words(await client.request("eth_call", [{
      to: V2_POOL, data: GET_RESERVES_SELECTOR
    }, blockTag(block.numberString)]));
    const price = priceAtBoundary(candles, boundaryMs);
    const cpValueUsd = multiply(rational(cpReserveRaw, 10n ** 18n), price.price);
    snapshots.push({
      blockNumber: block.numberString,
      blockHash: block.hash,
      timestamp,
      stateBlockTimestamp: block.timestamp,
      token0WethReserveRaw: wethReserveRaw.toString(),
      token1CpReserveRaw: cpReserveRaw.toString(),
      cpPriceUsd: serialized(price.price),
      priceSourceTimestamp: new Date(price.sourceTimestampMs).toISOString(),
      priceField: price.priceField,
      tvlUsd: serialized(multiply(cpValueUsd, rational(2n)))
    });
  }
  const intervals = boundaries.slice(0, -1).map((boundaryMs, index) => {
    const candle = candles.find(item => item.timestampMs === boundaryMs);
    return {
      startTimestamp: new Date(boundaryMs).toISOString(),
      endTimestamp: new Date(boundaries[index + 1]).toISOString(),
      volumeUsd: serialized(candle?.volume || rational(0n)),
      finalized: true,
      sourceCandleTimestamp: candle ? new Date(candle.timestampMs).toISOString() : null,
      missingCandleMeansZeroSwaps: !candle
    };
  });
  return {
    schemaVersion: 2,
    kind: "cypress-v2-reference-fee-window",
    generatedAt,
    identity: {
      chainId: 8453,
      dex: "uniswap-v2-base",
      pool: V2_POOL,
      token0: WETH,
      token1: CP,
      lpFeeFraction: serialized(LP_FEE_FRACTION)
    },
    window: {
      requestedDays: 7,
      poolCreatedAt: POOL_CREATED_AT,
      startTimestamp: new Date(startMs).toISOString(),
      endTimestamp: new Date(endMs).toISOString(),
      partial: false,
      latestBoundaryBlock: { blockNumber: snapshots.at(-1).blockNumber, blockHash: snapshots.at(-1).blockHash,
        timestamp: snapshots.at(-1).stateBlockTimestamp }
    },
    volume: {
      source: "geckoterminal_daily_ohlcv",
      endpoint: ohlcvUrl,
      coverageStart: new Date(startMs).toISOString(),
      coverageEnd: new Date(endMs).toISOString(),
      sparseIntervalsMeanZeroVolume: true,
      intervals
    },
    tvl: {
      method: "daily_block_pinned_v2_reserves_geckoterminal_price_trapezoidal",
      reserveMethod: "UniswapV2Pair_getReserves_at_pinned_block",
      priceMethod: "GeckoTerminal_CP_USD_daily_boundary_with_no_swap_carry_forward",
      valuationMethod: "two_times_CP_reserve_times_CP_USD_price",
      snapshots
    }
  };
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("usage: collect-v2-reference-fee.mjs OUTPUT.json");
  const cache = await collectV2ReferenceFeeWindow();
  fs.writeFileSync(path.resolve(output), JSON.stringify(cache, null, 2) + "\n", { flag: "wx" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
