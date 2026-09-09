"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

let lp;

const INITIAL_SQRT_X96 = 638407101806347576136442032642785978n;
const LATER_SQRT_X96 = 637434091718179387822692496724259019n;

function fixture(overrides = {}) {
  return {
    chainId: 8453,
    pool: "0x962265593a7F6f5F0804b6A3eD203AA5d2E0D1E9",
    token0: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    token1: { address: "0x934ef4bfffdce191ac4bcc351b2fe7892865b440", decimals: 18 },
    fee: 10000,
    tickSpacing: 200,
    blockNumber: 50_941_815n,
    timestamp: "2026-09-06T05:36:17.000Z",
    sqrtPriceX96: INITIAL_SQRT_X96,
    ...overrides
  };
}

function normalized(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

test.before(async () => {
  lp = await import("../tools/lp/full-range-simulator.mjs");
});

test("matches canonical Uniswap TickMath reference vectors", () => {
  // Reference: Uniswap/v3-core TickMath.sol getSqrtRatioAtTick.
  assert.equal(lp.getSqrtRatioAtTick(0), 79228162514264337593543950336n);
  assert.equal(lp.getSqrtRatioAtTick(-200), 78439868342809377387252074393n);
  assert.equal(lp.getSqrtRatioAtTick(200), 80024378775772204256025656563n);
  assert.equal(lp.getSqrtRatioAtTick(lp.MIN_TICK), lp.MIN_SQRT_RATIO);
  assert.equal(lp.getSqrtRatioAtTick(lp.MAX_TICK), lp.MAX_SQRT_RATIO);
  assert.equal(lp.FULL_RANGE_SQRT_LOWER_X96, 4310618292n);
  assert.equal(lp.FULL_RANGE_SQRT_UPPER_X96, 1456195216270955103206513029158776779468408838535n);
});

test("matches canonical SqrtPriceMath rounding vectors at small and extreme values", () => {
  const q96 = lp.MATH_CONSTANTS.Q96;
  assert.deepEqual(
    [lp.getAmount0Delta(q96, 2n * q96, 1n), lp.getAmount0Delta(q96, 2n * q96, 1n, true)],
    [0n, 1n]
  );
  assert.deepEqual(
    [lp.getAmount1Delta(q96, 2n * q96, 1n), lp.getAmount1Delta(q96, 2n * q96, 1n, true)],
    [1n, 1n]
  );
  const maxLiquidity = (1n << 128n) - 1n;
  assert.equal(
    lp.getAmount0Delta(lp.FULL_RANGE_SQRT_LOWER_X96, lp.FULL_RANGE_SQRT_UPPER_X96, maxLiquidity),
    6254310829883760859489020858778379320596570610389862234692n
  );
  assert.equal(
    lp.getAmount1Delta(lp.FULL_RANGE_SQRT_LOWER_X96, lp.FULL_RANGE_SQRT_UPPER_X96, maxLiquidity, true),
    6254310830475399242956278194434840659144126494451713969701n
  );
});

test("uses the audited token ordering and 6/18 decimal inversion", () => {
  const result = lp.simulateFullRange({ start: fixture(), end: fixture() });
  assert.equal(result.start.cpPriceUsdc.decimal, "0.01540152582256633385881587147082629");
  assert.equal(result.initial.usdcBudget.decimal, "500");
  assert.equal(result.initial.cpBudget.decimal, "32464.315922997668736402");
  assert.equal(result.initial.cpBudget.raw, 32_464_315_922_997_668_736_402n);
  assert.equal(result.fees.status, "unavailable");
});

test("same start and end price preserves value apart from canonical atomic rounding", () => {
  const result = lp.simulateFullRange({ start: fixture(), end: fixture() });
  assert.equal(result.position.liquidity, 4_028_915_233_843_823n);
  assert.equal(result.ending.assetValueUsdc.decimal, "999.999998999999999999970922");
  assert.equal(result.ending.assetPnlUsdc.decimal, "-0.000001000000000000029077");
  assert.ok(result.ending.lpVsHodlUsdc.numerator < 0n);
});

test("CP price increase raises asset value but trails HODL before fees", () => {
  const end = fixture({ blockNumber: 51_064_756n, timestamp: "2026-09-09T01:54:19.000Z", sqrtPriceX96: LATER_SQRT_X96 });
  const result = lp.simulateFullRange({ start: fixture(), end });
  assert.ok(result.end.cpPriceUsdc.numerator * result.start.cpPriceUsdc.denominator
    > result.start.cpPriceUsdc.numerator * result.end.cpPriceUsdc.denominator);
  assert.ok(result.ending.assetPnlUsdc.numerator > 0n);
  assert.ok(result.ending.lpVsHodlUsdc.numerator < 0n);
});

test("CP price decrease lowers asset value and trails HODL before fees", () => {
  const end = fixture({ blockNumber: 51_064_756n, timestamp: "2026-09-09T01:54:19.000Z", sqrtPriceX96: lp.getSqrtRatioAtTick(330_000) });
  const start = fixture({ sqrtPriceX96: lp.getSqrtRatioAtTick(318_000) });
  const result = lp.simulateFullRange({ start, end });
  assert.ok(result.ending.assetPnlUsdc.numerator < 0n);
  assert.ok(result.ending.lpVsHodlUsdc.numerator < 0n);
});

test("large price movements remain integer-only and deterministic", () => {
  const start = fixture({ sqrtPriceX96: lp.getSqrtRatioAtTick(320_000) });
  const end = fixture({ blockNumber: 51_064_756n, timestamp: "2026-09-09T01:54:19.000Z", sqrtPriceX96: lp.getSqrtRatioAtTick(250_000) });
  const first = lp.simulateFullRange({ start, end });
  const second = lp.simulateFullRange({ start: { ...start }, end: { ...end } });
  assert.deepEqual(normalized(first), normalized(second));
  assert.doesNotMatch(first.ending.assetValueUsdc.decimal, /e[+-]/i);
});

test("consumed amounts and unused dust exactly reconcile both budgets", () => {
  const result = lp.simulateFullRange({ start: fixture(), end: fixture() });
  assert.equal(result.position.consumed.usdc.raw + result.position.unused.usdc.raw, result.initial.usdcBudget.raw);
  assert.equal(result.position.consumed.cp.raw + result.position.unused.cp.raw, result.initial.cpBudget.raw);
  assert.equal(result.position.unused.usdc.raw, 0n);
  assert.equal(result.position.unused.cp.raw, 7_401_177n);
  assert.equal(
    result.ending.lpPrincipal.usdc.raw + result.position.unused.usdc.raw,
    result.ending.totalAssetsIncludingDust.usdc.raw
  );
  assert.equal(
    result.ending.lpPrincipal.cp.raw + result.position.unused.cp.raw,
    result.ending.totalAssetsIncludingDust.cp.raw
  );
});

test("full-range boundaries and prices outside the usable range select one token", () => {
  const liquidity = 123_456_789n;
  for (const price of [lp.MIN_SQRT_RATIO, lp.FULL_RANGE_SQRT_LOWER_X96]) {
    const amounts = lp.getAmountsForLiquidity(price, lp.FULL_RANGE_SQRT_LOWER_X96, lp.FULL_RANGE_SQRT_UPPER_X96, liquidity);
    assert.ok(amounts.amount0 > 0n);
    assert.equal(amounts.amount1, 0n);
  }
  for (const price of [lp.FULL_RANGE_SQRT_UPPER_X96, lp.MAX_SQRT_RATIO - 1n]) {
    const amounts = lp.getAmountsForLiquidity(price, lp.FULL_RANGE_SQRT_LOWER_X96, lp.FULL_RANGE_SQRT_UPPER_X96, liquidity);
    assert.equal(amounts.amount0, 0n);
    assert.ok(amounts.amount1 > 0n);
  }
  assert.throws(
    () => lp.simulateFullRange({
      start: fixture({ sqrtPriceX96: lp.MIN_SQRT_RATIO }),
      end: fixture({ sqrtPriceX96: lp.MAX_SQRT_RATIO - 1n })
    }),
    /zero mintable liquidity/
  );
});

test("accounting fractions obey nominal capital, HODL, and P/L identities", () => {
  const end = fixture({ blockNumber: 51_064_756n, timestamp: "2026-09-09T01:54:19.000Z", sqrtPriceX96: LATER_SQRT_X96 });
  const result = lp.simulateFullRange({ start: fixture(), end });
  const asset = result.ending.assetValueUsdc;
  const pnl = result.ending.assetPnlUsdc;
  assert.equal(asset.denominator, pnl.denominator);
  assert.equal(pnl.numerator, asset.numerator - 1000n * asset.denominator);
  assert.equal(
    result.ending.lpVsHodlUsdc.numerator,
    result.ending.assetValueUsdc.numerator - result.ending.hodlValueUsdc.numerator
  );
});

test("formatting is locale-independent and preserves exact raw strings", () => {
  const originalBigIntLocale = BigInt.prototype.toLocaleString;
  const originalNumberLocale = Number.prototype.toLocaleString;
  BigInt.prototype.toLocaleString = () => { throw new Error("locale formatting used"); };
  Number.prototype.toLocaleString = () => { throw new Error("locale formatting used"); };
  try {
    const result = lp.simulateFullRange({ start: fixture(), end: fixture() });
    assert.equal(result.position.liquidityString, result.position.liquidity.toString());
    assert.equal(result.initial.cpBudget.rawString, result.initial.cpBudget.raw.toString());
  } finally {
    BigInt.prototype.toLocaleString = originalBigIntLocale;
    Number.prototype.toLocaleString = originalNumberLocale;
  }
});

test("rejects missing, pre-initialization, reversed, zero, and malformed states", () => {
  assert.throws(() => lp.simulateFullRange(), /input is required/);
  assert.throws(() => lp.simulateFullRange({ start: null, end: fixture() }), /start state is required/);
  assert.throws(() => lp.simulateFullRange({ start: fixture({ blockNumber: 50_941_814n }), end: fixture() }), /predates/);
  assert.throws(() => lp.simulateFullRange({ start: fixture({ timestamp: "2026-09-06T05:36:16.000Z" }), end: fixture() }), /predates/);
  assert.throws(() => lp.simulateFullRange({ start: fixture({ token0: fixture().token1 }), end: fixture() }), /token0 identity/);
  assert.throws(() => lp.simulateFullRange({ start: fixture({ sqrtPriceX96: 0n }), end: fixture() }), /sqrtPriceX96/);
  assert.throws(() => lp.simulateFullRange({ start: fixture({ sqrtPriceX96: "1" }), end: fixture() }), /sqrtPriceX96/);
  assert.throws(() => lp.simulateFullRange({ start: fixture(), end: fixture({ blockNumber: 50_941_814n }) }), /predates/);
  assert.throws(() => lp.simulateFullRange({
    start: fixture({ blockNumber: 50_941_900n, timestamp: "2026-09-06T05:40:00.000Z" }),
    end: fixture()
  }), /must not precede/);
});
