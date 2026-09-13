"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let calculator, liveDataset;
const root = path.join(__dirname, "..");

test.before(async () => {
  calculator = await import("../assets/js/lp-calculator.mjs");
  liveDataset = JSON.parse(fs.readFileSync(path.join(root, "api/lp/v1/history.json"), "utf8"));
});

test("live static dataset validates and remains B1-compatible", () => {
  assert.equal(calculator.validateDataset(liveDataset), liveDataset);
  const first = liveDataset.snapshots[0];
  const latest = liveDataset.latestIncludedFinalizedBlock;
  const calculated = calculator.calculateFromDataset(liveDataset, first.blockNumber, latest.blockNumber);
  assert.equal(calculated.result.initial.capitalUsdc.decimal, "1000");
  assert.equal(calculated.result.fees.status, "unavailable");
  assert.equal(calculated.start.blockHash, first.blockHash);
  assert.equal(calculated.end.blockHash, latest.blockHash);
  assert.equal(liveDataset.snapshots.length, 5);
  assert.equal(liveDataset.gaps.length, 0);
  assert.deepEqual(liveDataset.resolutions.slice(0, 4).map(item => item.requestedTimestamp), [
    "2026-09-06T05:36:17.000Z", "2026-09-07T00:00:00.000Z",
    "2026-09-08T00:00:00.000Z", "2026-09-09T00:00:00.000Z"
  ]);
});

test("every ordered live boundary pair preserves B1 asset and HODL identities", () => {
  for (let start = 0; start < liveDataset.snapshots.length; start += 1) {
    for (let end = start; end < liveDataset.snapshots.length; end += 1) {
      const calculated = calculator.calculateFromDataset(
        liveDataset, liveDataset.snapshots[start].blockNumber, liveDataset.snapshots[end].blockNumber
      ).result;
      assert.equal(
        calculated.ending.lpVsHodlUsdc.numerator,
        calculated.ending.assetValueUsdc.numerator - calculated.ending.hodlValueUsdc.numerator
      );
      assert.equal(calculated.fees.status, "unavailable");
    }
  }
});

test("boundary options expose exact resolutions and disable explicit gaps", () => {
  const options = calculator.boundaryOptions(liveDataset);
  assert.ok(options.some(option => option.snapshot?.blockNumber === "50941815"));
  assert.ok(options.some(option => option.latest));
  const unavailableDates = new Set(liveDataset.gaps.map(gap => gap.requestedTimestamp.slice(0, 10)));
  assert.equal(options.filter(option => option.unavailable).length, unavailableDates.size);
  assert.throws(() => calculator.calculateFromDataset(liveDataset, "missing", "50941815"), /unavailable/);
});

test("dataset loader is same-origin, bounded, and fails closed", async () => {
  let request;
  const loaded = await calculator.fetchDataset({ fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return JSON.stringify(liveDataset); } };
  } });
  assert.equal(loaded.kind, "cypress-lp-principal-history");
  assert.equal(request.url, "/api/lp/v1/history.json");
  assert.equal(request.options.credentials, "same-origin");
  await assert.rejects(calculator.fetchDataset({ fetchImpl: async () => ({
    ok: true, status: 200, headers: { get() { return String(calculator.MAX_DATASET_BYTES + 1); } }, async text() { return ""; }
  }) }), /byte bound/);
  await assert.rejects(calculator.fetchDataset({ fetchImpl: async () => ({ ok: false, status: 503, headers: { get() { return null; } } }) }), /HTTP 503/);
  assert.throws(() => calculator.validateDataset({ ...liveDataset, fees: { included: true } }), /bounds or policy/);
});

test("financial formatting uses decimal strings without floating-point loss", () => {
  assert.equal(calculator.formatDecimal("12345678901234567890.123456789", 6), "12,345,678,901,234,567,890.123456");
  assert.equal(calculator.formatDecimal("-0.000001000000000000029077", 8), "−0.000001");
  assert.equal(calculator.formatDecimal("1000.000000", 2), "1,000");
});

test("English and Vietnamese pages expose modest calculator actions before chart attribution", () => {
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");
  for (const html of [english, vietnamese]) {
    assert.match(html, /chart-actions[\s\S]*?(?:Trading|Mua bán)[\s\S]*?positions\/create\/v3[\s\S]*?data-lp-open[\s\S]*?<\/p>[\s\S]*?chart-attribution/);
    assert.doesNotMatch(html, /lp-actions|lp-action-primary|lp-action-secondary/);
    assert.match(html, /positions\/create\/v3\?chain=base/);
    assert.match(html, /data-lp-open/);
    assert.match(html, /data-lp-dialog/);
    assert.match(html, /data-lp-boundary="start"/);
    assert.match(html, /data-lp-boundary="end"/);
    assert.match(html, /data-lp-result="lp-vs-hodl"/);
    assert.match(html, /lp-calculator\.mjs\?v=1\.1/);
    assert.doesNotMatch(html, /wallet|connect wallet|APR|APY/i);
  }
  assert.match(english, /Fee estimate unavailable/);
  assert.match(english, /data-lp-open>Liquidity Returns<\/button>/);
  assert.match(english, /id="lp-calculator-title">Liquidity Returns<\/h2>/);
  assert.match(english, /aria-label="Close Liquidity Returns"/);
  assert.doesNotMatch(english, />LP Calculator<\/button>|>LP Calculator<\/h2>|Close LP Calculator/);
  assert.match(english, /Higher fees do not guarantee higher net returns/);
  assert.match(vietnamese, /Chưa có ước tính phí/);
  assert.match(vietnamese, /data-lp-open>Tính lãi của thanh khoản<\/button>/);
  assert.match(vietnamese, /Phí cao hơn không bảo đảm lợi nhuận ròng cao hơn/);
});

test("deployment serves every browser-loaded LP module as JavaScript", () => {
  const nginx = fs.readFileSync(path.join(root, "deploy/cypress-lp/nginx-location.conf"), "utf8");
  for (const modulePath of [
    "/assets/js/lp-calculator.mjs",
    "/tools/lp/full-range-simulator.mjs",
    "/tools/lp/historical-state.mjs"
  ]) {
    assert.ok(nginx.includes(`location = ${modulePath} {
    try_files $uri =404;
    default_type application/javascript;
    limit_except GET {
        deny all;
    }
}`));
  }
});

test("calculator initialization populates boundaries and runs the B1 simulation", async () => {
  const listeners = new Map();
  const start = { options: [], value: "", append(option) { this.options.push(option); } };
  const end = { options: [], value: "", append(option) { this.options.push(option); } };
  const status = { textContent: "", dataset: {} };
  const calculate = {
    disabled: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    click() { listeners.get("click")?.(); }
  };
  const results = { hidden: true };
  const values = new Map([
    "capital", "initial-cp", "start-price", "end-price", "ending-cp", "ending-usdc",
    "asset-value", "asset-pnl", "return", "hodl", "lp-vs-hodl", "start-resolution", "end-resolution"
  ].map(key => [key, { textContent: "" }]));
  const rootElement = {
    dataset: { language: "en" },
    querySelector(selector) {
      if (selector === "[data-lp-status]") return status;
      if (selector === "[data-lp-calculate]") return calculate;
      if (selector === '[data-lp-boundary="start"]') return start;
      if (selector === '[data-lp-boundary="end"]') return end;
      if (selector === "[data-lp-results]") return results;
      const match = selector.match(/^\[data-lp-result="(.+)"\]$/);
      return match ? values.get(match[1]) : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-lp-boundary]") return [start, end];
      if (selector === "select, button[data-lp-calculate]") return [start, end, calculate];
      return [];
    }
  };
  const originalDocument = global.document;
  global.document = { createElement() { return { value: "", textContent: "", disabled: false }; } };
  try {
    await calculator.initializeCalculator(rootElement, { fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async text() { return JSON.stringify(liveDataset); }
    }) });
  } finally {
    global.document = originalDocument;
  }
  assert.equal(status.dataset.state, "ready");
  assert.equal(calculate.disabled, false);
  assert.equal(start.options.length, 5);
  assert.equal(end.options.length, 5);
  assert.equal(start.value, liveDataset.snapshots[0].blockNumber);
  assert.equal(end.value, liveDataset.latestIncludedFinalizedBlock.blockNumber);
  assert.equal(results.hidden, false);
  assert.equal(values.get("capital").textContent, "1,000 USDC");
  assert.match(values.get("asset-value").textContent, /^1,001\.526448 USDC$/);
  assert.match(values.get("start-resolution").textContent, /Block 50941815$/);
});

test("calculator frontend imports B1 math and never contacts RPC or duplicates formulas", () => {
  const source = fs.readFileSync(path.join(root, "assets/js/lp-calculator.mjs"), "utf8");
  assert.match(source, /import \{ POOL, simulateFullRange \}/);
  assert.match(source, /\/api\/lp\/v1\/history\.json/);
  assert.doesNotMatch(source, /eth_call|mainnet\.base\.org|base-rpc|Q96|feeGrowth|APR|APY/);
});

test("calculator styles constrain values and collapse controls on mobile", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  assert.match(css, /\.lp-result-grid dd[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.lp-controls,[\s\S]*?grid-template-columns: 1fr/);
  assert.match(css, /max-width: min\(920px, calc\(100vw - 24px\)\)/);
  assert.match(css, /\.chart-footer-action[\s\S]*?font: inherit/);
  assert.doesNotMatch(css, /\.lp-actions|\.lp-action-primary|\.lp-action-secondary/);
});
