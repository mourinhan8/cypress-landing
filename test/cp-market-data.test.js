"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const market = require("../assets/js/cp-market-data.js");

const BASE_STATE = {
  blockNumber: 50973127,
  v3: {
    token0: market.CONFIG.usdc,
    token1: market.CONFIG.cp,
    factory: market.CONFIG.v3Factory,
    fee: 10000n,
    tickSpacing: 200n,
    sqrtPriceX96: 637200461648009429704775779601818105n,
    usdcBalance: 3697597130n,
    cpBalance: 1046830923770241638565011n
  },
  v2: {
    token0: market.CONFIG.weth,
    token1: market.CONFIG.cp,
    factory: market.CONFIG.v2Factory,
    reserveWeth: 904413064503971876n,
    reserveCp: 145436510048961339758543n
  }
};

function cloneState() {
  return { v3: { ...BASE_STATE.v3 }, v2: { ...BASE_STATE.v2 }, blockNumber: BASE_STATE.blockNumber };
}

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

test("derives V3 CP/USDC spot price with token decimals", () => {
  const result = market.deriveMarketData(cloneState(), 1000);
  assert.ok(Math.abs(result.cpPriceUsd - 0.015459911516385224) < 1e-15);
});

test("values actual V3 pool token balances rather than global liquidity", () => {
  const result = market.deriveMarketData(cloneState(), 1000);
  assert.ok(Math.abs(result.v3LiquidityUsd - 19881.51058410374) < 1e-8);
});

test("normalizes and values both actual V2 reserve sides", () => {
  const result = market.deriveMarketData(cloneState(), 1000);
  assert.ok(Math.abs(result.v2LiquidityUsd - 4496.871153217626) < 1e-8);
  assert.ok(Math.abs(result.impliedWethUsd - 2486.0715361757566) < 1e-8);
});

test("aggregates the two pool TVLs once without price averaging", () => {
  const result = market.deriveMarketData(cloneState(), 1000);
  assert.equal(result.totalLiquidityUsd, result.v2LiquidityUsd + result.v3LiquidityUsd);
  assert.equal(result.cpPriceUsd, market.deriveMarketData(cloneState(), 2000).cpPriceUsd);
});

test("rejects reversed token order", () => {
  const state = cloneState();
  state.v3.token0 = market.CONFIG.cp;
  assert.throws(() => market.deriveMarketData(state), /V3 token0 identity mismatch/);
});

test("rejects incorrect pool factory, fee, and tick spacing", () => {
  const factory = cloneState();
  factory.v2.factory = market.CONFIG.v3Factory;
  assert.throws(() => market.deriveMarketData(factory), /V2 factory identity mismatch/);
  const fee = cloneState();
  fee.v3.fee = 3000n;
  assert.throws(() => market.deriveMarketData(fee), /V3 fee identity mismatch/);
  const spacing = cloneState();
  spacing.v3.tickSpacing = 60n;
  assert.throws(() => market.deriveMarketData(spacing), /V3 tick spacing identity mismatch/);
});

test("returns no market result for missing pool values", () => {
  const state = cloneState();
  state.v2.reserveCp = 0n;
  assert.throws(() => market.deriveMarketData(state), /V2 reserves are unavailable/);
});

test("cache preserves valid last-known-good data for at most 24 hours", () => {
  const storage = memoryStorage();
  const data = market.deriveMarketData(cloneState(), 1000);
  market.writeCache(storage, data);
  assert.deepEqual(market.readCache(storage, 2000), data);
  assert.equal(market.readCache(storage, 1001 + market.MAX_CACHE_AGE_MS), null);
});

test("cache rejects malformed and fabricated zero values", () => {
  assert.equal(market.readCache(memoryStorage({ [market.CACHE_KEY]: "{" }), 2000), null);
  const zero = memoryStorage({
    [market.CACHE_KEY]: JSON.stringify({ cpPriceUsd: 0, totalLiquidityUsd: 1, blockNumber: 1, fetchedAt: 1000 })
  });
  assert.equal(market.readCache(zero, 2000), null);
});

test("RPC HTTP failure is explicit", async () => {
  await assert.rejects(market.rpcRequest("https://example.invalid", {}, {
    fetchImpl: async () => ({ ok: false, status: 503 }), timeoutMs: 20
  }), /HTTP 503/);
});

test("RPC timeout aborts the bounded request", async () => {
  await assert.rejects(market.rpcRequest("https://example.invalid", {}, {
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })
  }), /aborted/);
});

test("fresh, stale, and unavailable states render in English and Vietnamese", () => {
  assert.match(market.statusText("en", "fresh", 1000, 1000), /Aggregated from Uniswap/);
  assert.match(market.statusText("vi", "fresh", 1000, 1000), /Uniswap trên Base/);
  assert.match(market.statusText("en", "stale", 1000, 121000), /Stale.*2 min/);
  assert.match(market.statusText("vi", "stale", 1000, 121000), /đã cũ.*2 phút/);
  assert.match(market.statusText("en", "unavailable", 0, 0), /unavailable/);
  assert.match(market.statusText("vi", "unavailable", 0, 0), /không khả dụng/);
});
