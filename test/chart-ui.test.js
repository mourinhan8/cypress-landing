"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const chart = require("../assets/js/cp-chart.js");

function apiSnapshot(timeframe, candles, overrides) {
  return {
    schema_version: 1, status: "ok", timeframe, interval: timeframe === "7D" ? "hourly" : "daily",
    range_start: "2026-08-01T00:00:00.000Z", range_end: "2026-09-07T04:00:00.000Z",
    generated_at: "2026-09-07T04:00:00.000Z", updated_at: "2026-09-07T03:30:00.000Z",
    stale: false, freshness: { status: "fresh", age_seconds: 600, stale_after_seconds: 7200, last_known_good: true },
    partial_history: timeframe === "7D", sources: [], candle_count: candles.length, candles,
    ...(overrides || {})
  };
}

function candle(time, source) {
  const base = {
    time, interval_end: new Date(Date.parse(time) + 3600000).toISOString(),
    open: "0.01000001", high: "0.01234567", low: "0.00987654", close: "0.01111111",
    source_kind: source === "history" ? "daily_close" : "real_ohlcv",
    quality: source === "history" ? "synthetic_close_derived" : "real_ohlcv"
  };
  return source === "history"
    ? { ...base, source: "coingecko_csv", methodology: "synthetic_close_derived_ohlc", rule_version: "v1" }
    : { ...base, source: "geckoterminal", source_stream_version: "base-v1", network: "base", pool: "0xpool" };
}

test("all five selectors map only to bounded same-origin endpoints", () => {
  assert.deepEqual(Object.keys(chart.TIMEFRAMES), ["7D", "1M", "3M", "1Y", "MAX"]);
  assert.deepEqual(Object.keys(chart.TIMEFRAMES).map(chart.endpointFor), [
    "/api/chart/v1/7d.json", "/api/chart/v1/1m.json", "/api/chart/v1/3m.json",
    "/api/chart/v1/1y.json", "/api/chart/v1/max.json"
  ]);
  assert.throws(() => chart.endpointFor("YTD"), /Unsupported/);
});

test("frontend validation maps candles without fabricating sparse times", () => {
  const candles = [candle("2026-09-06T12:00:00.000Z", "current"), candle("2026-09-07T02:00:00.000Z", "current")];
  const snapshot = apiSnapshot("7D", candles);
  assert.equal(chart.validateSnapshot(snapshot, "7D"), snapshot);
  assert.deepEqual(chart.chartPoints(snapshot).map(item => item.time), [1788696000, 1788746400]);
  const invalid = apiSnapshot("7D", [{ ...candles[0], source: "coingecko_csv" }]);
  assert.throws(() => chart.validateSnapshot(invalid, "7D"), /provenance/);
  assert.throws(() => chart.validateSnapshot({ ...snapshot, status: "unavailable" }, "7D"), /must be empty/);
});

test("tooltip uses compact display prices without mutating exact OHLC values", () => {
  const historical = candle("2026-09-05T00:00:00.000Z", "history");
  const original = structuredClone(historical);
  const english = chart.tooltipText(historical, "en");
  const vietnamese = chart.tooltipText(historical, "vi");
  assert.match(english, /O \$0\.01  H \$0\.012346  L \$0\.009877  C \$0\.011111/);
  assert.doesNotMatch(english, /\d+\.\d{7,}/);
  assert.equal(english.split("\n").length, 2);
  assert.equal(vietnamese.split("\n").length, 2);
  assert.doesNotMatch(english, /Historical|Current|synthetic|GeckoTerminal/);
  assert.doesNotMatch(vietnamese, /Lịch sử|Hiện tại|tổng hợp|GeckoTerminal/);
  assert.equal(chart.formatUsd("1.230000"), "$1.23");
  assert.equal(chart.formatUsd("0.0000001234567"), "$0.0000001235");
  assert.notEqual(chart.formatUsd("0.0000001234567"), "$0");
  assert.equal(chart.formatAxisUsd(0.000001234567), "$0.000001235");
  assert.deepEqual(historical, original);
  assert.deepEqual(chart.chartPoints(apiSnapshot("1Y", [historical]))[0], {
    time: 1788566400, open: 0.01000001, high: 0.01234567, low: 0.00987654, close: 0.01111111
  });
  const fresh = apiSnapshot("7D", [candle("2026-09-06T12:00:00.000Z", "current")]);
  assert.equal(chart.snapshotIsStale(fresh, Date.parse("2026-09-07T03:40:00.000Z")), false);
  assert.equal(chart.snapshotIsStale(fresh, Date.parse("2026-09-07T05:30:00.001Z")), true);
});

test("request loading enforces response bounds, schema, timeout signal, and same origin", async () => {
  const snapshot = apiSnapshot("7D", [candle("2026-09-06T12:00:00.000Z", "current")]);
  let request;
  const loaded = await chart.fetchSnapshot("7D", {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return JSON.stringify(snapshot); } };
    }, timeoutMs: 20
  });
  assert.equal(loaded.candle_count, 1);
  assert.equal(request.url, "/api/chart/v1/7d.json");
  assert.equal(request.options.credentials, "same-origin");
  await assert.rejects(chart.fetchSnapshot("7D", {
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get() { return String(chart.MAX_RESPONSE_BYTES + 1); } }, async text() { return ""; } })
  }), /byte bound/);
});

test("coordinator avoids duplicate requests and discards stale timeframe responses", async () => {
  let resolveSeven;
  let calls = 0;
  const rendered = [];
  const states = [];
  const coordinator = chart.createCoordinator({
    load(timeframe) {
      calls += 1;
      if (timeframe === "7D") return new Promise(resolve => { resolveSeven = resolve; });
      return apiSnapshot(timeframe, [candle("2026-09-06T12:00:00.000Z", "current")]);
    },
    render(snapshot) { rendered.push(snapshot.timeframe); },
    state(name, timeframe) { states.push(name + ":" + timeframe); },
    now() { return Date.parse("2026-09-07T03:40:00.000Z"); }
  });
  const sameOne = coordinator.request("MAX");
  const sameTwo = coordinator.request("MAX");
  assert.equal(sameOne, sameTwo);
  await sameOne;
  assert.equal(calls, 1);
  const old = coordinator.select("7D");
  const current = coordinator.select("1M");
  await current;
  resolveSeven(apiSnapshot("7D", [candle("2026-09-06T12:00:00.000Z", "current")]));
  assert.equal((await old).discarded, true);
  assert.deepEqual(rendered, ["1M"]);
  assert.ok(states.includes("loading:7D") && states.includes("ready:1M"));
});

test("coordinator exposes empty, error, stale, and last-known-good states", async () => {
  let mode = "fresh";
  const rendered = [];
  const states = [];
  const coordinator = chart.createCoordinator({
    load(timeframe) {
      if (mode === "error") throw new Error("offline");
      if (mode === "empty") return { schema_version: 1, status: "unavailable", timeframe, candle_count: 0, candles: [] };
      return apiSnapshot(timeframe, [candle("2026-09-06T12:00:00.000Z", "current")], { stale: mode === "stale" });
    },
    render(snapshot, options) { rendered.push({ timeframe: snapshot.timeframe, stale: options.stale }); },
    state(name) { states.push(name); },
    now() { return Date.parse("2026-09-07T03:40:00.000Z"); }
  });
  await coordinator.select("7D");
  mode = "error";
  assert.equal((await coordinator.select("7D")).stale, true);
  mode = "empty";
  assert.equal((await coordinator.select("1M")).empty, true);
  mode = "error";
  assert.ok((await coordinator.select("3M")).error);
  mode = "stale";
  await coordinator.select("1Y");
  assert.ok(states.includes("loading") && states.includes("ready") && states.includes("stale") && states.includes("empty") && states.includes("error"));
  assert.deepEqual(rendered.at(-1), { timeframe: "1Y", stale: true });
});

test("English and Vietnamese homepages include native chart copy and required attribution", () => {
  const root = path.join(__dirname, "..");
  const tradingUrl = "https://app.uniswap.org/swap?chain=base&amp;inputCurrency=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amp;outputCurrency=0x934ef4bfffdce191ac4bcc351b2fe7892865b440";
  const englishLiquidityUrl = "https://app.uniswap.org/positions/create/v3?chain=base&amp;currencyA=0x934ef4bfffdce191ac4bcc351b2fe7892865b440&amp;currencyB=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amp;fee=%7B%22isDynamic%22%3Afalse%2C%22feeAmount%22%3A500%2C%22tickSpacing%22%3A10%7D&amp;priceRangeState=%7B%22priceInverted%22%3Atrue%7D&amp;lng=en-US";
  const vietnameseLiquidityUrl = "https://app.uniswap.org/positions/create/v3?chain=base&amp;currencyA=0x934ef4bfffdce191ac4bcc351b2fe7892865b440&amp;currencyB=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amp;fee=%7B%22isDynamic%22%3Afalse%2C%22feeAmount%22%3A500%2C%22tickSpacing%22%3A10%7D&amp;priceRangeState=%7B%22priceInverted%22%3Atrue%7D&amp;lng=vi-VN";
  const geckoTerminalUrl = "https://www.geckoterminal.com/base/pools/0x2ddcc7c2cc6ddf1e4f91894d4862c370827ed1a1";
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  for (const html of [english, vietnamese]) {
    assert.doesNotMatch(html, /<iframe[^>]+geckoterminal/i);
    assert.match(html, /lightweight-charts\.standalone\.production\.js\?v=5\.2\.0[\s\S]*cp-chart\.js/);
    assert.equal((html.match(/data-chart-timeframe=/g) || []).length, 2);
    assert.match(html, /data-chart-timeframe="1Y" aria-selected="true"/);
    assert.match(html, /data-chart-timeframe="MAX" aria-selected="false"/);
    assert.doesNotMatch(html, /data-chart-timeframe="(?:7D|1M|3M)"/);
    assert.match(html, /coingecko\.com\/en\/coins\/cypress/);
    assert.equal((html.match(new RegExp(geckoTerminalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
    assert.match(html, /tradingview\.com/);
    assert.match(html, /class="chart-actions"[\s\S]*?<a[^>]+>(?:Trading|Mua bán)<\/a>[\s\S]*?·[\s\S]*?positions\/create\/v3[\s\S]*?·[\s\S]*?data-lp-open[\s\S]*?<\/p>[\s\S]*?class="chart-attribution"[\s\S]*?Source:\s*<a[^>]+>CoinGecko<\/a>[\s\S]*?·[\s\S]*?<a[^>]+>GeckoTerminal<\/a>[\s\S]*?·[\s\S]*?Charts by <a[^>]+>TradingView<\/a>/);
    assert.equal((html.match(new RegExp(tradingUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
    assert.doesNotMatch(html, /(?:minTick|maxTick|depositState|hook=undefined)/);
    assert.doesNotMatch(html, /positions\/create\/v3[^"\n]*feeAmount%22%3A10000/);
    assert.doesNotMatch(html, /Historical data:|Current market data:|Dữ liệu lịch sử:|Dữ liệu thị trường hiện tại:/);
    assert.doesNotMatch(html, /chart-provenance|How to read this chart|Cách đọc biểu đồ này/);
    assert.doesNotMatch(html, /chart-summary|data-chart-summary/);
  }
  assert.match(english, />Trading<\/a>/);
  assert.equal((english.match(new RegExp(englishLiquidityUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  assert.match(english, /data-lp-open>Liquidity Returns<\/button>/);
  assert.doesNotMatch(english, />Mua bán<\/a>|data-lp-open>LP Calculator<\/button>/);
  assert.match(vietnamese, />Mua bán<\/a>/);
  assert.equal((vietnamese.match(new RegExp(vietnameseLiquidityUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  assert.match(vietnamese, /data-lp-open>Tính lãi của thanh khoản<\/button>/);
  assert.doesNotMatch(vietnamese, />Trading<\/a>/);
  const marketData = fs.readFileSync(path.join(root, "assets/js/cp-market-data.js"), "utf8");
  const priceHistory = fs.readFileSync(path.join(root, "tools/comparison/price-path.mjs"), "utf8");
  assert.match(marketData, /v3Pool:\s*"0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9"/);
  assert.match(priceHistory, /0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*chart-canvas/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.chart-attribution a,[\s\S]*?\.chart-footer-action[\s\S]*?color: hsl\(214, 100%, 74%\)[\s\S]*?text-decoration: underline[\s\S]*?text-decoration-color: currentColor/);
  assert.match(css, /\.chart-attribution a:hover,[\s\S]*?\.chart-footer-action:hover[\s\S]*?color: hsl\(214, 100%, 82%\)/);
  assert.match(css, /\.chart-attribution a:focus-visible,[\s\S]*?\.chart-footer-action:focus-visible[\s\S]*?color: hsl\(214, 100%, 82%\)[\s\S]*?outline: 2px solid currentColor/);
  assert.match(css, /@media \(prefers-color-scheme: light\)[\s\S]*?\.chart-attribution a,[\s\S]*?\.chart-footer-action[\s\S]*?color: hsl\(216, 100%, 40%\)[\s\S]*?\.chart-attribution a:hover,[\s\S]*?\.chart-footer-action:focus-visible[\s\S]*?color: hsl\(216, 100%, 32%\)/);
  const source = fs.readFileSync(path.join(root, "assets/js/cp-chart.js"), "utf8");
  assert.match(source, /barSpacing:\s*10, minBarSpacing:\s*4, maxBarSpacing:\s*18/);
  assert.match(source, /coordinator\.select\("1Y"\)/);
});

test("chart frontend never calls providers, wallets, raw CSV, or mutable RPC", () => {
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/cp-chart.js"), "utf8");
  assert.doesNotMatch(source, /api\.geckoterminal|api\.coingecko|cp-usd-max|eth_sendTransaction|wallet|\.csv/i);
  assert.match(source, /\/api\/chart\/v1\//);
  assert.doesNotMatch(source, /setInterval/);
});

test("vendored chart library is the pinned Apache-2.0 artifact with required notices", () => {
  const root = path.join(__dirname, "../assets/vendor/lightweight-charts");
  const artifact = fs.readFileSync(path.join(root, "lightweight-charts.standalone.production.js"));
  assert.equal(crypto.createHash("sha256").update(artifact).digest("hex"), "c0992580867c4912cc9385b3c2728315bcc1a76c7f1087dca908430fccdf31d7");
  assert.match(artifact.toString("utf8", 0, 250), /Lightweight Charts™ v5\.2\.0[\s\S]*Apache License 2\.0/);
  assert.match(fs.readFileSync(path.join(root, "LICENSE"), "utf8"), /Apache License[\s\S]*Version 2\.0/);
  assert.match(fs.readFileSync(path.join(root, "NOTICE"), "utf8"), /TradingView Lightweight Charts/);
  assert.match(fs.readFileSync(path.join(root, "VERSION"), "utf8"), /lightweight-charts 5\.2\.0/);
});
