"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const market = require("../assets/js/cp-market-data.js");
const metrics = require("../assets/js/cp-market-metrics.js");

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
  v3Fee500: {
    token0: market.CONFIG.usdc,
    token1: market.CONFIG.cp,
    factory: market.CONFIG.v3Factory,
    fee: 500n,
    tickSpacing: 10n,
    usdcBalance: 3111884567n,
    cpBalance: 833278608262767231271370n
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
  return {
    v3: { ...BASE_STATE.v3 },
    v3Fee500: { ...BASE_STATE.v3Fee500 },
    v2: { ...BASE_STATE.v2 },
    blockNumber: BASE_STATE.blockNumber
  };
}

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

function uintWord(value) {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(value) {
  return "0x" + value.slice(2).padStart(64, "0");
}

test("keeps both existing pools and adds only the requested third pool", () => {
  assert.equal(market.CONFIG.v3Pool, "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9");
  assert.equal(market.CONFIG.v2Pool, "0xa290c53cc25f0b857d21421b2f757f9a3434f80e");
  assert.equal(market.CONFIG.v3Fee500Pool, "0x2ddcc7c2cc6ddf1e4f91894d4862c370827ed1a1");
  assert.equal(market.CONFIG.v3Fee500, 500n);
  assert.equal(market.CONFIG.v3Fee500TickSpacing, 10n);
});

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

test("normalizes and values the new V3 0.05% pool balances", () => {
  const result = market.deriveMarketData(cloneState(), 1000);
  assert.ok(Math.abs(result.v3Fee500LiquidityUsd - 15994.298119239007) < 1e-8);
});

test("aggregates exactly three pool TVLs once without price averaging", () => {
  const result = market.deriveMarketData(cloneState(), 1000);
  assert.equal(result.liquidityPoolCount, 3);
  assert.equal(
    result.totalLiquidityUsd,
    result.v2LiquidityUsd + result.v3LiquidityUsd + result.v3Fee500LiquidityUsd
  );
  assert.equal(result.cpPriceUsd, market.deriveMarketData(cloneState(), 2000).cpPriceUsd);
});

test("third-pool liquidity does not change the price source or market cap", () => {
  const original = market.deriveMarketData(cloneState(), 1000);
  const changedState = cloneState();
  changedState.v3Fee500.usdcBalance *= 2n;
  changedState.v3Fee500.cpBalance *= 2n;
  const changed = market.deriveMarketData(changedState, 1000);
  assert.equal(changed.cpPriceUsd, original.cpPriceUsd);
  assert.notEqual(changed.totalLiquidityUsd, original.totalLiquidityUsd);
  assert.equal(
    metrics.deriveMetrics(changed).usd.marketCap,
    metrics.deriveMetrics(original).usd.marketCap
  );
});

test("reads all three pools from one pinned Base block", async () => {
  const requests = [];
  const responses = new Map([
    [2, addressWord(market.CONFIG.usdc)], [3, addressWord(market.CONFIG.cp)],
    [4, addressWord(market.CONFIG.v3Factory)], [5, uintWord(market.CONFIG.v3Fee)],
    [6, uintWord(market.CONFIG.v3TickSpacing)], [7, uintWord(BASE_STATE.v3.sqrtPriceX96)],
    [8, addressWord(market.CONFIG.weth)], [9, addressWord(market.CONFIG.cp)],
    [10, addressWord(market.CONFIG.v2Factory)],
    [11, uintWord(BASE_STATE.v2.reserveWeth) + uintWord(BASE_STATE.v2.reserveCp).slice(2)],
    [12, uintWord(BASE_STATE.v3.usdcBalance)], [13, uintWord(BASE_STATE.v3.cpBalance)],
    [14, addressWord(market.CONFIG.usdc)], [15, addressWord(market.CONFIG.cp)],
    [16, addressWord(market.CONFIG.v3Factory)], [17, uintWord(market.CONFIG.v3Fee500)],
    [18, uintWord(market.CONFIG.v3Fee500TickSpacing)],
    [19, uintWord(BASE_STATE.v3Fee500.usdcBalance)], [20, uintWord(BASE_STATE.v3Fee500.cpBalance)]
  ]);
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    if (!Array.isArray(payload)) return { ok: true, json: async () => ({ id: 1, result: "0x10" }) };
    return {
      ok: true,
      json: async () => payload.map(call => ({ id: call.id, result: responses.get(call.id) }))
    };
  };
  const result = await market.readMarketData({ fetchImpl, now: () => 1000 });
  assert.equal(result.liquidityPoolCount, 3);
  const calls = requests.flatMap(request => Array.isArray(request) ? request : []);
  assert.ok(calls.every(call => call.params[1] === "0x10"));
  const targets = new Set(calls.map(call => call.params[0].to));
  assert.ok(targets.has(market.CONFIG.v3Pool));
  assert.ok(targets.has(market.CONFIG.v2Pool));
  assert.ok(targets.has(market.CONFIG.v3Fee500Pool));
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
  const newFee = cloneState();
  newFee.v3Fee500.fee = 3000n;
  assert.throws(() => market.deriveMarketData(newFee), /V3 0\.05% fee identity mismatch/);
  const newSpacing = cloneState();
  newSpacing.v3Fee500.tickSpacing = 60n;
  assert.throws(() => market.deriveMarketData(newSpacing), /V3 0\.05% tick spacing identity mismatch/);
});

test("returns no market result for missing pool values", () => {
  const state = cloneState();
  state.v2.reserveCp = 0n;
  assert.throws(() => market.deriveMarketData(state), /V2 reserves are unavailable/);
  const newPool = cloneState();
  newPool.v3Fee500.cpBalance = 0n;
  assert.throws(() => market.deriveMarketData(newPool), /V3 0\.05% token balances are unavailable/);
});

test("cache preserves valid last-known-good data for at most 24 hours", () => {
  const storage = memoryStorage();
  const data = market.deriveMarketData(cloneState(), 1000);
  market.writeCache(storage, data);
  assert.deepEqual(market.readCache(storage, 2000), data);
  assert.equal(market.readCache(storage, 1001 + market.MAX_CACHE_AGE_MS), null);
});

test("one-pool failure falls back only to a validated three-pool cache", () => {
  const storage = memoryStorage();
  const lastKnownGood = market.deriveMarketData(cloneState(), 1000);
  market.writeCache(storage, lastKnownGood);
  const failed = cloneState();
  failed.v3Fee500.usdcBalance = 0n;
  assert.throws(() => market.deriveMarketData(failed), /V3 0\.05% token balances are unavailable/);
  assert.deepEqual(market.readCache(storage, 2000), lastKnownGood);

  const invalidStorage = memoryStorage({
    [market.CACHE_KEY]: JSON.stringify({ ...lastKnownGood, liquidityPoolCount: 2 })
  });
  assert.equal(market.readCache(invalidStorage, 2000), null);
});

test("cache rejects malformed and fabricated zero values", () => {
  assert.equal(market.readCache(memoryStorage({ [market.CACHE_KEY]: "{" }), 2000), null);
  const zero = memoryStorage({
    [market.CACHE_KEY]: JSON.stringify({ cpPriceUsd: 0, totalLiquidityUsd: 1, blockNumber: 1, fetchedAt: 1000 })
  });
  assert.equal(market.readCache(zero, 2000), null);
  const valid = market.deriveMarketData(cloneState(), 1000);
  const mismatched = memoryStorage({
    [market.CACHE_KEY]: JSON.stringify({ ...valid, totalLiquidityUsd: valid.totalLiquidityUsd + 1 })
  });
  assert.equal(market.readCache(mismatched, 2000), null);
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
