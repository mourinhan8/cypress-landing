"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let engine;
const frozenDataset = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/comparison/price-path-v2.json"), "utf8"));

test.before(async () => {
  engine = await import("../tools/comparison/hold-vs-rebalanced-lp.mjs");
});

function decimal(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("invalid test decimal");
  const [integer, fraction = ""] = value.split(".");
  return { numerator: BigInt(integer + fraction), denominator: 10n ** BigInt(fraction.length) };
}

function pricePoint(index, value, overrides = {}) {
  const parsed = decimal(value);
  return {
    id: "point-" + index,
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    priceUsd: { numerator: parsed.numerator.toString(), denominator: parsed.denominator.toString() },
    observed: true,
    estimated: false,
    carriedForward: false,
    source: { provider: "synthetic_test" },
    ...overrides
  };
}

function pricePath(values) {
  return values.map((item, index) => pricePoint(index, item));
}

function outputRational(item) {
  return { numerator: BigInt(item.numerator), denominator: BigInt(item.denominator) };
}

function equalRational(left, right) {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

function addRational(left, right) {
  return {
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  };
}

function subtractRational(left, right) {
  return {
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  };
}

function multiplyRational(left, right) {
  return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
}

function divideRational(left, right) {
  return { numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator };
}

function formatRational(input, places = 36) {
  const integer = input.numerator / input.denominator;
  const fraction = ((input.numerator % input.denominator) * 10n ** BigInt(places) / input.denominator)
    .toString().padStart(places, "0");
  return integer + "." + fraction;
}

test("flat prices preserve exactly 1,000 USDC for both strategies", () => {
  const lp = engine.evaluateRebalancedPath(pricePath(["0.01", "0.01", "0.01"]));
  assert.equal(lp.endingPrincipalValueUsdc.decimal, "1000");
  assert.equal(lp.lowerBoundUsdc.decimal, "1000");
  assert.equal(lp.upperBoundUsdc.decimal, "1000");
  assert.deepEqual(lp.branchCounts, { inside_range: 2, at_or_below_lower_bound: 0, at_or_above_upper_bound: 0 });
});

test("monotonic increases, decreases, and oscillations are deterministic and path-dependent", () => {
  const increasing = engine.evaluateRebalancedPath(pricePath(["1", "1.1", "1.2", "1.3", "1.4"]));
  const decreasing = engine.evaluateRebalancedPath(pricePath(["1", "0.9", "0.8", "0.7", "0.6"]));
  const oscillating = engine.evaluateRebalancedPath(pricePath(["1", "1.2", "0.9", "1.25", "1"]));
  assert.equal(increasing.endingPrincipalValueUsdc.decimal, "1173.051274510140501757570757276112612514");
  assert.equal(decreasing.endingPrincipalValueUsdc.decimal, "759.144255937398671169603955754864329235");
  assert.equal(oscillating.endingPrincipalValueUsdc.decimal, "919.646357693500405542995365279900474406");
  assert.deepEqual(engine.evaluateRebalancedPath(pricePath(["1", "1.2", "0.9", "1.25", "1"])), oscillating);
});

test("single jumps beyond both bounds use the correct all-asset branches", () => {
  const above = engine.evaluateSegmentMultiplier(decimal("1"), decimal("4"));
  const below = engine.evaluateSegmentMultiplier(decimal("1"), decimal("0.25"));
  assert.equal(above.branch, "at_or_above_upper_bound");
  assert.equal(below.branch, "at_or_below_lower_bound");
  assert.equal(above.multiplier.decimal, "1.207106781186547524400844362104849039");
  assert.equal(below.multiplier.decimal, "0.301776695296636881100211090526212259");
});

test("repeated jumps recenter at every observation instead of remaining inactive", () => {
  const result = engine.evaluateRebalancedPath(pricePath(["1", "4", "1", "4", "1"]));
  assert.deepEqual(result.branchCounts, {
    inside_range: 0,
    at_or_below_lower_bound: 2,
    at_or_above_upper_bound: 2
  });
  assert.equal(result.segmentCount, 4);
  assert.equal(result.endingPrincipalValueUsdc.decimal, "132.697510736238830412579158947329597432");
});

test("segment multiplier independently matches canonical V3 reserve equations", () => {
  // Normalize the current price and liquidity to 1. For token0=CP and
  // token1=USDC, canonical V3 reserves inside [0.5, 2] are:
  // amount0=(sqrtB-sqrtP)/(sqrtP*sqrtB), amount1=sqrtP-sqrtA.
  const one = { numerator: 1n, denominator: 1n };
  const two = { numerator: 2n, denominator: 1n };
  const q = decimal("1.414213562373095048801688724209698078");
  const sqrtP = { numerator: 5n, denominator: 4n };
  const price = { numerator: 25n, denominator: 16n };
  const sqrtA = divideRational(one, q);
  const amount0 = divideRational(subtractRational(q, sqrtP), multiplyRational(sqrtP, q));
  const amount1 = subtractRational(sqrtP, sqrtA);
  const endingValue = addRational(multiplyRational(amount0, price), amount1);
  const startingValue = multiplyRational(two, subtractRational(one, sqrtA));
  const reserveMultiplier = divideRational(endingValue, startingValue);
  const formula = engine.evaluateSegmentMultiplier(one, price).multiplier.decimal;
  assert.equal(formula.slice(0, 31), formatRational(reserveMultiplier).slice(0, 31));
});

test("all frozen periods use identical Hold/LP boundaries and return principal before fees", () => {
  const results = engine.compareAllPeriods(frozenDataset);
  assert.deepEqual(Object.keys(results), ["7D", "30D", "6M", "1Y"]);
  const expected = {
    "7D": ["1050.066643479060708068020842295638346408", "1024.002390342140545272434895756582550148"],
    "30D": ["1094.786315062839215349361485004681562974", "1043.850828496562387197363347428236893056"],
    "6M": ["1197.100442888201636769743074259434706061", "1036.151785321738740469145946192706202932"],
    "1Y": ["885.937056040401394794629680706950227539", "862.566008749050441194973309251046524599"]
  };
  for (const [period, result] of Object.entries(results)) {
    const contract = frozenDataset.periods[period].strategyBoundaries;
    assert.deepEqual(contract.holdCp, contract.rebalancedLp);
    assert.equal(result.boundaries.startPointId, contract.holdCp.startPointId);
    assert.equal(result.boundaries.endPointId, contract.holdCp.endPointId);
    assert.equal(result.holdCp.endingValueUsdc.decimal, expected[period][0]);
    assert.equal(result.rebalancedLpPrincipal.endingValueUsdc.decimal, expected[period][1]);
    assert.equal(result.rebalancedLpPrincipal.feesIncluded, false);
  }
});

test("estimated points and source coverage flow through without changing provenance", () => {
  const result = engine.comparePeriod(frozenDataset, "30D");
  assert.equal(result.dataQuality.includesEstimatedPrices, true);
  assert.equal(result.dataQuality.estimatedPointCount, 1);
  assert.deepEqual(result.dataQuality.disclosure, frozenDataset.disclosure);
  assert.equal(result.dataQuality.sourcePointCounts.coingecko_csv, 26);
  assert.equal(result.dataQuality.sourcePointCounts.estimated_interpolation, 1);
  assert.equal(result.dataQuality.sourcePointCounts.geckoterminal, 4);
  assert.equal(result.dataQuality.sourcePointCounts.base_archive_rpc, 2);
  assert.equal(result.dataQuality.observationCount, 31);
  assert.equal(result.strategyAssumptions.recentering, "once_per_normalized_utc_daily_price");
});

test("high-precision prices retain exact Hold arithmetic", () => {
  const dataset = structuredClone(frozenDataset);
  const period = dataset.periods["7D"];
  const start = dataset.points.find(point => point.id === period.strategyBoundaries.holdCp.startPointId);
  const end = dataset.points.find(point => point.id === period.strategyBoundaries.holdCp.endPointId);
  start.priceUsd = { numerator: "123456789012345678901234567890123456", denominator: "10000000000000000000000000000000000000" };
  end.priceUsd = { numerator: "123456789012345678901234567890123457", denominator: "10000000000000000000000000000000000000" };
  const result = engine.comparePeriod(dataset, "7D");
  const quantity = outputRational(result.holdCp.initialCpQuantity);
  const ending = outputRational(result.holdCp.endingValueUsdc);
  assert.ok(equalRational(multiplyRational(quantity, outputRational(result.boundaries.startPriceUsd)), { numerator: 1000n, denominator: 1n }));
  assert.ok(equalRational(ending, multiplyRational(quantity, outputRational(result.boundaries.endPriceUsd))));
});

test("rejects invalid, zero, negative, duplicate, and unordered point data", () => {
  const zero = pricePath(["1", "2"]);
  zero[1].priceUsd.numerator = "0";
  assert.throws(() => engine.evaluateRebalancedPath(zero), /positive rational price/);
  const negative = pricePath(["1", "2"]);
  negative[1].priceUsd.numerator = "-2";
  assert.throws(() => engine.evaluateRebalancedPath(negative), /positive rational price/);
  const duplicateId = pricePath(["1", "2"]);
  duplicateId[1].id = duplicateId[0].id;
  assert.throws(() => engine.evaluateRebalancedPath(duplicateId), /duplicate price point id/);
  const duplicateTime = pricePath(["1", "2"]);
  duplicateTime[1].timestamp = duplicateTime[0].timestamp;
  assert.throws(() => engine.evaluateRebalancedPath(duplicateTime), /strictly increasing/);
  const unordered = pricePath(["1", "2"]);
  unordered.reverse();
  assert.throws(() => engine.evaluateRebalancedPath(unordered), /strictly increasing/);
});

test("rejects mismatched strategy boundaries", () => {
  const dataset = structuredClone(frozenDataset);
  dataset.periods["7D"].strategyBoundaries.rebalancedLp.startPointId = dataset.periods["30D"].strategyBoundaries.holdCp.startPointId;
  assert.throws(() => engine.comparePeriod(dataset, "7D"), /boundaries must be identical/);
});

test("principal, profit/loss, return, difference, and error bounds reconcile exactly", () => {
  const result = engine.comparePeriod(frozenDataset, "6M");
  const capital = outputRational(result.initialCapitalUsdc);
  const holdEnding = outputRational(result.holdCp.endingValueUsdc);
  const holdPl = outputRational(result.holdCp.profitLossUsdc);
  const lpEnding = outputRational(result.rebalancedLpPrincipal.endingValueUsdc);
  const lpPl = outputRational(result.rebalancedLpPrincipal.profitLossUsdc);
  assert.ok(equalRational(addRational(capital, holdPl), holdEnding));
  assert.ok(equalRational(addRational(capital, lpPl), lpEnding));
  assert.ok(equalRational(subtractRational(holdEnding, lpEnding), outputRational(result.difference.holdMinusLpUsdc)));
  const lower = outputRational(result.rebalancedLpPrincipal.numericalLowerBoundUsdc);
  const upper = outputRational(result.rebalancedLpPrincipal.numericalUpperBoundUsdc);
  assert.ok(holdEnding.numerator !== 0n);
  assert.ok(lower.numerator * lpEnding.denominator <= lpEnding.numerator * lower.denominator);
  assert.ok(lpEnding.numerator * upper.denominator <= upper.numerator * lpEnding.denominator);
  assert.equal(result.numericalPolicy.internalDecimalPlaces, 72);
});

test("finer discrete paths converge toward the continuous-rebalancing limit", () => {
  function dividedPath(segments) {
    const points = [];
    for (let index = 0; index <= segments; index += 1) {
      points.push(pricePoint(index, "1", {
        priceUsd: { numerator: String(segments + index), denominator: String(segments) },
        timestamp: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString()
      }));
    }
    return points;
  }
  const coarse = [1, 2, 4, 8, 16, 32].map(segments =>
    outputRational(engine.evaluateRebalancedPath(dividedPath(segments)).endingPrincipalValueUsdc));
  const reference = outputRational(engine.evaluateRebalancedPath(dividedPath(256)).endingPrincipalValueUsdc);
  const errors = coarse.map(item => {
    const difference = subtractRational(reference, item);
    return difference.numerator < 0n ? { numerator: -difference.numerator, denominator: difference.denominator } : difference;
  });
  for (let index = 1; index < errors.length; index += 1) {
    assert.ok(errors[index].numerator * errors[index - 1].denominator
      < errors[index - 1].numerator * errors[index].denominator);
  }
});
