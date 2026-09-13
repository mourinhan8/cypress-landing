"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const chart = require("../assets/js/cp-chart.js");
const root = path.join(__dirname, "..");

function candle(day, close) {
  return {
    time: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    open: close,
    high: close,
    low: close,
    close
  };
}

test("EN and VI render one selected-candle output in the chart header and none over the plot", () => {
  for (const locale of ["index.html", "vi/index.html"]) {
    const html = fs.readFileSync(path.join(root, locale), "utf8");
    assert.match(html, /class="chart-toolbar"[\s\S]*?class="chart-heading"[\s\S]*?class="chart-title">CP \/ USD<[\s\S]*?data-chart-selection[\s\S]*?class="chart-timeframes"/);
    assert.equal((html.match(/data-chart-selection/g) || []).length, 1);
    assert.doesNotMatch(html, /data-chart-tooltip|class="chart-tooltip"/);
    assert.match(html, /class="chart-stage"[\s\S]*?data-chart-canvas[\s\S]*?data-chart-status/);
    assert.doesNotMatch(html, /Historical data:|Current market data:|Dữ liệu lịch sử:|Dữ liệu thị trường hiện tại:/);
  }
});

test("nearest candle selection clamps to the range and resolves midpoint ties consistently", () => {
  const candles = [candle(1, "0.01"), candle(3, "0.02"), candle(8, "0.03")];
  const seconds = value => Date.parse(value) / 1000;
  assert.equal(chart.nearestCandleIndex(candles, seconds("2026-08-01T00:00:00.000Z")), 0);
  assert.equal(chart.nearestCandleIndex(candles, seconds("2026-09-02T00:00:00.000Z")), 0);
  assert.equal(chart.nearestCandleIndex(candles, seconds("2026-09-06T00:00:00.000Z")), 2);
  assert.equal(chart.nearestCandleIndex(candles, seconds("2026-10-01T00:00:00.000Z")), 2);
  assert.equal(chart.nearestLogicalIndex(-4.2, candles.length), 0);
  assert.equal(chart.nearestLogicalIndex(1.51, candles.length), 2);
  assert.equal(chart.nearestLogicalIndex(9, candles.length), 2);
});

test("one selection model serves latest default, hover time, tap index, and retained release state", () => {
  const candles = [candle(1, "0.01"), candle(3, "0.02"), candle(8, "0.03")];
  const rendered = [];
  const selection = chart.createSelectionModel((selected, index) => rendered.push({ selected, index }));
  selection.setCandles(candles);
  assert.equal(selection.selected(), candles[2]);
  assert.equal(selection.selectTime(Date.parse("2026-09-03T00:00:00.000Z") / 1000), candles[1]);
  assert.equal(selection.selectIndex(0), candles[0]);
  assert.equal(selection.selectIndex(1), candles[1]);
  assert.equal(selection.selected(), candles[1]);
  assert.deepEqual(rendered.map(item => item.index), [2, 1, 0, 1]);
});

test("gesture intent distinguishes horizontal candle dragging from vertical page scrolling", () => {
  assert.equal(chart.gestureAxis(3, 2), "pending");
  assert.equal(chart.gestureAxis(18, 5), "horizontal");
  assert.equal(chart.gestureAxis(-18, 5), "horizontal");
  assert.equal(chart.gestureAxis(5, 18), "vertical");
  assert.equal(chart.gestureAxis(9, 9), "vertical");
});

test("browser wiring updates the shared model for hover and touch drag without clearing on release", () => {
  const source = fs.readFileSync(path.join(root, "assets/js/cp-chart.js"), "utf8");
  assert.match(source, /subscribeCrosshairMove[\s\S]*?selection\.selectTime/);
  assert.match(source, /addEventListener\("pointerdown"[\s\S]*?selectAtPointer\(event\)/);
  assert.match(source, /addEventListener\("pointermove"[\s\S]*?gestureAxis[\s\S]*?preventDefault[\s\S]*?selectAtPointer\(event\)/);
  assert.match(source, /setCrosshairPosition/);
  assert.match(source, /addEventListener\("pointerup", finishPointer\)/);
  assert.match(source, /shouldRetainCrosshair[\s\S]*?positionCrosshair\(selection\.selected\(\)\)/);
  assert.doesNotMatch(source, /pointerup[\s\S]{0,180}(?:setCandles|selectIndex|selectTime|clearCrosshairPosition)/);
});

test("responsive header can wrap without changing chart canvas touch or visual behavior", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  assert.match(css, /\.chart-heading\s*{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/);
  assert.match(css, /\.chart-selection\s*{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/);
  assert.match(css, /\.chart-canvas\s*{[^}]*touch-action: pan-y;/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.chart-selection\s*{[^}]*flex-basis: 100%;/);
  assert.doesNotMatch(css, /\.chart-selection\s*{[^}]*position: absolute;/);
  const source = fs.readFileSync(path.join(root, "assets/js/cp-chart.js"), "utf8");
  assert.match(source, /handleScroll:\s*{\s*horzTouchDrag: false,\s*vertTouchDrag: false\s*}/);
});

test("header rendering keeps localized timestamps and existing display precision", () => {
  const selected = candle(3, "0.0000001234567");
  selected.open = "0.01000001";
  selected.high = "0.01234567";
  selected.low = "0.00987654";
  const english = chart.tooltipText(selected, "en");
  const vietnamese = chart.tooltipText(selected, "vi");
  assert.match(english, /O \$0\.01  H \$0\.012346  L \$0\.009877  C \$0\.0000001235/);
  assert.equal(english.split("\n").length, 2);
  assert.equal(vietnamese.split("\n").length, 2);
  assert.doesNotMatch(english + vietnamese, /Historical|Current|Lịch sử|Hiện tại|GeckoTerminal/);
});
