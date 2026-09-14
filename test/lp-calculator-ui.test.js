"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pricePath = JSON.parse(fs.readFileSync(path.join(root, "data/comparison/price-path-v2.json"), "utf8"));
const feeWindow = JSON.parse(fs.readFileSync(path.join(root, "data/comparison/reference-fee-window-v1.json"), "utf8"));
let ui;

test.before(async () => {
  ui = await import("../assets/js/lp-calculator.mjs");
});

test("all four periods use exact Step 3A results", () => {
  const comparison = ui.buildComparisonResults(pricePath, feeWindow);
  assert.deepEqual(Object.keys(comparison.periods), ["7D", "30D", "6M", "1Y"]);
  assert.equal(comparison.referenceApr.lpNetAprPercent.decimal, "0.395965604483489442492957090429168111");
  const expected = {
    "7D": ["0.014712000486675314", "0.015448580969905454573194645155919808", "1050.066643479060708068020842295638346408", "1024.079579439743964524956457745436622052", "0.077189097603419252521561988854071904", "25.987064039316743543064384550201724355"],
    "30D": ["0.014111046838413145", "0.015448580969905454573194645155919808", "1094.786315062839215349361485004681562974", "1044.183917443521671396584929521369422319", "0.333088946959284199221582093132529263", "50.602397619317543952776555483312140654"],
    "6M": ["0.012904999794865344", "0.015448580969905454573194645155919808", "1197.100442888201636769743074259434706061", "1038.160985757826829535716614653213960633", "2.009200436088089066570668460507757701", "158.939457130374807234026459606220745427"],
    "1Y": ["0.017437560450345304", "0.015448580969905454573194645155919808", "885.937056040401394794629680706950227539", "866.006168463853575241024801145309595067", "3.440159714803134046051491894263070468", "19.930887576547819553604879561640632471"]
  };
  for (const period of ui.PERIODS) {
    const result = comparison.periods[period];
    assert.deepEqual([
      result.boundaries.startPriceUsd.decimal,
      result.boundaries.endPriceUsd.decimal,
      result.holdCp.endingValueUsdc.decimal,
      result.rebalancedLp.endingValueIncludingEstimatedFeesUsdc.decimal,
      result.rebalancedLp.estimatedFeesUsdc.decimal,
      result.differenceIncludingEstimatedFees.holdMinusLpUsdc.decimal
    ], expected[period]);
    assert.equal(result.differenceIncludingEstimatedFees.leader, "hold_cp");
  }
});

test("display formatting includes USD, percent, conclusion and partial-window APR", () => {
  const comparison = ui.buildComparisonResults(pricePath, feeWindow);
  assert.equal(ui.formatUsd("1050.066643"), "$1,050.07");
  assert.equal(ui.formatSignedUsd("-114.062943"), "−$114.06");
  assert.equal(ui.formatSignedPercent("5.006664"), "+5.01%");
  assert.equal(ui.conclusionText(comparison.periods["7D"], "en"), "Hold ahead by $25.99");
  assert.equal(ui.referenceAprText(comparison.referenceApr, "en"), "Reference fee APR: 0.40% (estimate) · 3.31 days observed");
  assert.equal(ui.referenceAprText(comparison.referenceApr, "vi"), "APR phí tham chiếu: 0,40% (ước tính) · 3,31 ngày quan sát");
});

function fixture() {
  const keys = ["start-price","end-price","hold-ending","hold-pl","hold-return","lp-ending","lp-pl","lp-return","estimated-fees","conclusion"];
  const values = new Map(keys.map(key => [key, { textContent: "" }]));
  const buttons = ui.PERIODS.map(period => ({ dataset:{ lpPeriod:period }, attributes:{}, setAttribute(key,value){ this.attributes[key]=value; } }));
  const apr = { textContent:"" };
  const results = { hidden:true };
  return {
    values, buttons,
    root: {
      dataset:{},
      querySelector(selector) {
        if (selector === "[data-lp-reference-apr]") return apr;
        if (selector === "[data-lp-results]") return results;
        const match = selector.match(/^\[data-lp-result="(.+)"\]$/);
        return match ? values.get(match[1]) : null;
      },
      querySelectorAll(selector) { return selector === "[data-lp-period]" ? buttons : []; }
    }
  };
}

test("rendering each selector updates ending values, P/L, fees and conclusion", () => {
  const comparison = ui.buildComparisonResults(pricePath, feeWindow);
  const view = fixture();
  const expected = {
    "7D": ["$1,050.07","+$50.07","+5.01%","$1,024.08","+$24.08","+2.41%","$0.08","Hold ahead by $25.99"],
    "30D": ["$1,094.79","+$94.79","+9.48%","$1,044.18","+$44.18","+4.42%","$0.33","Hold ahead by $50.60"],
    "6M": ["$1,197.10","+$197.10","+19.71%","$1,038.16","+$38.16","+3.82%","$2.01","Hold ahead by $158.94"],
    "1Y": ["$885.94","−$114.06","−11.41%","$866.01","−$133.99","−13.40%","$3.44","Hold ahead by $19.93"]
  };
  for (const period of ui.PERIODS) {
    ui.renderPeriod(view.root, comparison, period, "en");
    assert.deepEqual(["hold-ending","hold-pl","hold-return","lp-ending","lp-pl","lp-return","estimated-fees","conclusion"].map(key => view.values.get(key).textContent), expected[period]);
    assert.equal(view.root.dataset.activePeriod, period);
    assert.equal(view.buttons.find(button => button.dataset.lpPeriod === period).attributes["aria-pressed"], "true");
  }
});

test("loader requests only bounded same-origin comparison datasets", async () => {
  const requests = [];
  const bodies = new Map([[ui.PRICE_PATH_URL, JSON.stringify(pricePath)], [ui.REFERENCE_FEE_URL, JSON.stringify(feeWindow)]]);
  await ui.fetchComparisonData({ fetchImpl: async (url, options) => {
    requests.push({url,options});
    return {ok:true,headers:{get(){return null;}},async text(){return bodies.get(url);}};
  }});
  assert.deepEqual(requests.map(item => item.url), [ui.PRICE_PATH_URL, ui.REFERENCE_FEE_URL]);
  assert.ok(requests.every(item => item.options.credentials === "same-origin"));
});

test("EN and VI dialogs are localized, accessible and concise", () => {
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");
  for (const html of [english, vietnamese]) {
    const dialog = html.match(/<dialog class="lp-dialog"[\s\S]*?<\/dialog>/)[0];
    assert.deepEqual([...dialog.matchAll(/data-lp-period="([^"]+)"/g)].map(match => match[1]), ["7D","30D","6M","1Y"]);
    assert.match(dialog, /<fieldset class="lp-periods" aria-label="[^"]+">/);
    assert.match(dialog, /aria-pressed="true"/);
    assert.match(dialog, /<details class="lp-explanation">/);
    assert.doesNotMatch(dialog, /<details[^>]+open|impermanent loss|tổn thất vô thường/i);
    assert.doesNotMatch(dialog, /data-lp-boundary|fee-growth|NFT position|full range/i);
    assert.match(html, /lp-calculator\.mjs\?v=2\.0/);
  }
  assert.match(english, /Liquidity Returns/);
  assert.match(english, /Simulation based on historical price data, using daily average prices and linear interpolation for days with missing data\./);
  assert.match(english, /Why LP can differ from Hold/);
  assert.match(vietnamese, /Tính lãi của thanh khoản/);
  assert.match(vietnamese, /Kết quả mô phỏng dựa trên dữ liệu giá lịch sử, sử dụng giá trung bình theo ngày và nội suy tuyến tính cho các ngày không có dữ liệu\./);
  assert.match(vietnamese, /Vì sao LP có thể khác Hold/);
});

test("responsive styles provide stacked cards and visible focus", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  assert.match(css, /max-width: min\(880px, calc\(100vw - 24px\)\)/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /\.lp-period-options button:focus-visible[\s\S]*outline: 2px solid/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.lp-strategy-grid,[\s\S]*grid-template-columns: 1fr/);
});

test("legacy full-range code remains preserved but is no longer primary", () => {
  const legacy = fs.readFileSync(path.join(root, "tools/lp/legacy-full-range-calculator-ui.mjs"), "utf8");
  const active = fs.readFileSync(path.join(root, "assets/js/lp-calculator.mjs"), "utf8");
  assert.match(legacy, /import \{ POOL, simulateFullRange \}/);
  assert.match(legacy, /calculateFromDataset/);
  assert.match(active, /projectAllPeriodFees/);
  assert.doesNotMatch(active, /simulateFullRange|data-lp-boundary/);
  assert.ok(fs.existsSync(path.join(root, "tools/lp/full-range-simulator.mjs")));
});

test("deployment serves the active comparison dependency graph", () => {
  const nginx = fs.readFileSync(path.join(root, "deploy/cypress-lp/nginx-location.conf"), "utf8");
  for (const asset of ["/assets/js/lp-calculator.mjs","/tools/comparison/hold-vs-rebalanced-lp.mjs","/tools/comparison/reference-fee.mjs","/data/comparison/price-path-v2.json","/data/comparison/reference-fee-window-v1.json"]) {
    assert.ok(nginx.includes("location = " + asset + " {"));
  }
});
