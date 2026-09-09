"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const metrics = require("../assets/js/cp-market-metrics.js");
let fx;

test.before(async () => { fx = await import("../tools/fx/refresh-usd-vnd.mjs"); });

function response(payload) {
  return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return JSON.stringify(payload); } };
}

function provider(rate) { return { result: "success", base_code: "USD", rates: { VND: rate } }; }
function snapshot(rate = 25_000) {
  return { schemaVersion: 1, base: "USD", quote: "VND", provider: "ExchangeRate-API", rate, updatedAt: "2026-09-09T00:00:00.000Z", checkedAt: "2026-09-09T00:00:00.000Z" };
}
function market() { return { cpPriceUsd: 0.0155, totalLiquidityUsd: 24_500, blockNumber: 1, fetchedAt: 1 }; }

test("fixed supply market cap uses the exact displayed CP price state", () => {
  const source = market();
  const result = metrics.deriveMetrics(source, snapshot());
  assert.equal(metrics.TOTAL_SUPPLY_CP, 25_000_000);
  assert.equal(result.usd.price, source.cpPriceUsd);
  assert.equal(result.usd.marketCap, source.cpPriceUsd * 25_000_000);
});

test("all three VND values use one cached rate", () => {
  const result = metrics.deriveMetrics(market(), snapshot(24_750));
  assert.equal(result.vnd.price, result.usd.price * result.rate);
  assert.equal(result.vnd.liquidity, result.usd.liquidity * result.rate);
  assert.equal(result.vnd.marketCap, result.usd.marketCap * result.rate);
});

test("USD metrics remain available without FX", () => {
  const result = metrics.deriveMetrics(market(), null);
  assert.equal(result.usd.liquidity, 24_500);
  assert.equal(result.usd.marketCap, 387_500);
  assert.equal(result.vnd, null);
  assert.match(metrics.unavailableVnd("en"), /unavailable/);
  assert.match(metrics.unavailableVnd("vi"), /không khả dụng/);
});

test("browser FX loader is same-origin, bounded, and validates the snapshot", async () => {
  let request;
  const loaded = await metrics.fetchFxSnapshot({ fetchImpl: async (url, options) => {
    request = { url, options };
    return response(snapshot());
  } });
  assert.equal(loaded.rate, 25_000);
  assert.equal(request.url, "/api/fx/v1/usd-vnd.json");
  assert.equal(request.options.credentials, "same-origin");
  await assert.rejects(metrics.fetchFxSnapshot({ fetchImpl: async () => ({
    ok: true, headers: { get() { return String(metrics.MAX_FX_BYTES + 1); } }, async text() { return ""; }
  }) }), /byte bound/);
});

test("provider validation rejects invalid, missing, zero, negative, and non-finite rates", () => {
  for (const rate of [undefined, 0, -1, Infinity, NaN]) {
    assert.throws(() => fx.validateProviderPayload(provider(rate)), /finite and positive/);
  }
  assert.throws(() => fx.validateProviderPayload({ result: "error" }), /identity/);
});

test("daily refresh persists atomically and skips another request within 24 hours", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-fx-"));
  const cacheFile = path.join(directory, "usd-vnd.json");
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(provider(25_123.5)); };
  const first = await fx.refreshUsdVnd({ cacheFile, fetchImpl, now: () => new Date("2026-09-09T00:00:00.000Z") });
  const second = await fx.refreshUsdVnd({ cacheFile, fetchImpl, now: () => new Date("2026-09-09T23:59:59.000Z") });
  assert.equal(first.status, "updated");
  assert.equal(second.status, "reused");
  assert.equal(calls, 1);
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o640);
  assert.equal(fx.readFxSnapshot(cacheFile).rate, 25_123.5);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("failed refresh retains the last valid rate and records the attempt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-fx-fallback-"));
  const cacheFile = path.join(directory, "usd-vnd.json");
  fx.writeFxSnapshotAtomic(cacheFile, snapshot(25_000));
  const result = await fx.refreshUsdVnd({
    cacheFile, now: () => new Date("2026-09-10T00:00:01.000Z"),
    fetchImpl: async () => ({ ok: false, status: 503, headers: { get() { return null; } } })
  });
  assert.equal(result.status, "stale");
  assert.equal(result.snapshot.rate, 25_000);
  assert.equal(result.snapshot.updatedAt, "2026-09-09T00:00:00.000Z");
  assert.equal(result.snapshot.checkedAt, "2026-09-10T00:00:01.000Z");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("first-run failure publishes an unavailable cache and remains rate-limited", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-fx-first-"));
  const cacheFile = path.join(directory, "usd-vnd.json");
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("offline"); };
  const first = await fx.refreshUsdVnd({ cacheFile, fetchImpl, now: () => new Date("2026-09-09T00:00:00.000Z") });
  const second = await fx.refreshUsdVnd({ cacheFile, fetchImpl, now: () => new Date("2026-09-09T01:00:00.000Z") });
  assert.equal(first.status, "unavailable");
  assert.equal(second.status, "unavailable");
  assert.equal(second.snapshot.rate, null);
  assert.equal(calls, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("EN and VI render three USD/VND metrics without changing chart, LP, or Swap", () => {
  const root = path.join(__dirname, "..");
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");
  for (const html of [english, vietnamese]) {
    assert.equal((html.match(/data-cp-(?:price|liquidity|market-cap)>/g) || []).length, 3);
    assert.equal((html.match(/data-cp-(?:price|liquidity|market-cap)-vnd>/g) || []).length, 3);
    assert.match(html, /ExchangeRate-API/);
    assert.match(html, /cp-market-data\.js[\s\S]*cp-market-metrics\.js[\s\S]*cp-market-ui\.js/);
    assert.match(html, /data-cp-chart/);
    assert.match(html, /data-lp-dialog/);
    assert.match(html, /swap\.cypress\.work/);
    assert.match(html, /testswap\.cypress\.work/);
  }
  assert.match(english, /Market Cap[\s\S]*25M CP fixed supply/);
  assert.match(vietnamese, /Vốn hóa[\s\S]*tổng cung cố định 25 triệu CP/);
  assert.doesNotMatch(vietnamese, /Cypress hiện hoạt động trên Base|Tổng cung đã giảm còn 25%/);
});

test("metric layout uses three desktop columns and a safe mobile stack", () => {
  const css = fs.readFileSync(path.join(__dirname, "../assets/css/style_1.css"), "utf8");
  assert.match(css, /\.market-metrics[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.market-metrics[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /\.market-metric strong[\s\S]*overflow-wrap: anywhere/);
});
