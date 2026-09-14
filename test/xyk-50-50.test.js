"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let engine, ui;
const root = path.resolve(__dirname, "..");
const pricePath = JSON.parse(fs.readFileSync(path.join(root, "data/comparison/price-path-v2.json"), "utf8"));
const feeWindow = JSON.parse(fs.readFileSync(path.join(root, "data/comparison/reference-fee-window-v1.json"), "utf8"));

test.before(async () => {
  ui = await import("../assets/js/lp-calculator.mjs");
  engine = ui;
});

function decimal(value) {
  const [integer, fraction = ""] = value.split(".");
  return { numerator: BigInt(integer + fraction).toString(), denominator: (10n ** BigInt(fraction.length)).toString() };
}

function rational(item) {
  return { numerator: BigInt(item.numerator), denominator: BigInt(item.denominator) };
}

function equal(left, right) {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

function add(left, right) {
  return { numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator };
}

test("r = 1 keeps both principals at $1,000 and adds fees only afterward", () => {
  const result = engine.calculateXyk50_50(decimal("2"), decimal("2"), decimal("5"));
  assert.equal(result.priceRatio.decimal, "1");
  assert.equal(result.holdCp.endingValueUsdc.decimal, "1000");
  assert.equal(result.xykLp.principalEndingValueUsdc.decimal, "1000");
  assert.equal(result.xykLp.endingValueIncludingEstimatedFeesUsdc.decimal, "1005");
  assert.equal(result.xykLp.profitLossIncludingEstimatedFeesUsdc.decimal, "5");
});

test("price increase makes Hold exceed XYK before low fees", () => {
  const result = engine.calculateXyk50_50(decimal("1"), decimal("4"), decimal("1"));
  assert.equal(result.holdCp.endingValueUsdc.decimal, "4000");
  assert.equal(result.xykLp.principalEndingValueUsdc.decimal, "2000");
  assert.equal(result.xykLp.endingValueIncludingEstimatedFeesUsdc.decimal, "2001");
  assert.equal(result.differenceIncludingEstimatedFees.leader, "hold_cp");
});

test("price decrease makes XYK decline less than Hold", () => {
  const result = engine.calculateXyk50_50(decimal("4"), decimal("1"), decimal("0"));
  assert.equal(result.holdCp.endingValueUsdc.decimal, "250");
  assert.equal(result.xykLp.principalEndingValueUsdc.decimal, "500");
  assert.equal(result.differenceIncludingEstimatedFees.leader, "xyk_lp");
});

test("extreme valid ratios remain deterministic without floating-point drift", () => {
  const rise = engine.calculateXyk50_50(decimal("0.000000000001"), decimal("1"), decimal("0"));
  const fall = engine.calculateXyk50_50(decimal("1"), decimal("0.000000000001"), decimal("0"));
  assert.equal(rise.priceRatio.decimal, "1000000000000");
  assert.equal(rise.xykLp.principalEndingValueUsdc.decimal, "1000000000");
  assert.equal(fall.xykLp.principalEndingValueUsdc.decimal, "0.001");
  assert.deepEqual(engine.calculateXyk50_50(decimal("1"), decimal("0.000000000001"), decimal("0")), fall);
});

test("fees reconcile exactly after XYK principal with no separate IL deduction", () => {
  const result = engine.calculateXyk50_50(decimal("1"), decimal("2"), decimal("3.25"));
  assert.ok(equal(add(rational(result.xykLp.principalEndingValueUsdc), rational(result.xykLp.estimatedFeesUsdc)),
    rational(result.xykLp.endingValueIncludingEstimatedFeesUsdc)));
  assert.equal(result.model, undefined);
  assert.equal(Object.keys(result.xykLp).some(key => /impermanent|\bil\b/i.test(key)), false);
});

test("all four production periods use XYK principal and preserve approved fee estimates", () => {
  const results = ui.buildComparisonResults(pricePath, feeWindow).periods;
  const expected = {
    "7D": ["1.050066643479060708068020842295638346", "1024.727594768024536810784444022797709943", "0.077189097603419252521561988854071904", "1024.804783865627956063306006011651781847"],
    "30D": ["1.094786315062839215349361485004681562", "1046.320369228679030092105272874036715827", "0.333088946959284199221582093132529263", "1046.65345817563831429132685496716924509"],
    "6M": ["1.197100442888201636769743074259434706", "1094.120853876847389271394194964390648762", "2.009200436088089066570668460507757701", "1096.130054312935478337964863424898406464"],
    "1Y": ["0.885937056040401394794629680706950227", "941.24229401382160521275866293376149016", "3.440159714803134046051491894263070468", "944.682453728624739258810154828024560629"]
  };
  for (const [period, values] of Object.entries(expected)) {
    assert.equal(results[period].kind, "cypress-hold-vs-xyk-50-50-reference");
    assert.deepEqual([results[period].priceRatio.decimal, results[period].xykLp.principalEndingValueUsdc.decimal,
      results[period].xykLp.estimatedFeesUsdc.decimal, results[period].xykLp.endingValueIncludingEstimatedFeesUsdc.decimal], values);
  }
});

test("intra-period path cannot change XYK principal when period endpoints are unchanged", () => {
  const changed = structuredClone(pricePath);
  const range = changed.periods["30D"].pointRange;
  for (let index = range.fromInclusive + 1; index < range.throughInclusive; index += 1) {
    changed.points[index].priceUsd = index % 2
      ? { numerator: "1", denominator: "1000000000" }
      : { numerator: "1000000000", denominator: "1" };
  }
  const fees = decimal("0");
  const original = engine.comparePeriodXyk50_50(pricePath, "30D", fees);
  const oscillating = engine.comparePeriodXyk50_50(changed, "30D", fees);
  assert.deepEqual(oscillating.xykLp.principalEndingValueUsdc, original.xykLp.principalEndingValueUsdc);
  assert.deepEqual(oscillating.holdCp.endingValueUsdc, original.holdCp.endingValueUsdc);
});
