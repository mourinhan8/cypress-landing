const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("homepage navigation contains only the three primary destinations", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");

  assert.match(css, /\.nav-normal:is\(:hover, :focus, \.active\)\s*{[^}]*color: hsl\(214, 100%, 74%\);[^}]*box-shadow: inset 0 -2px currentColor;/);
  assert.doesNotMatch(css, /\.nav-normal:is\(:hover, :focus, \.active\)\s*{[^}]*background-color: var\(--blue-crayola\)/);

  const englishNav = english.match(/<nav class="x-navbar"[\s\S]*?<\/nav>/)[0];
  const vietnameseNav = vietnamese.match(/<nav class="x-navbar"[\s\S]*?<\/nav>/)[0];
  const labels = html => [...html.matchAll(/class="navbar-link[^\"]*"[^>]*>([^<]+)<\/a>/g)].map(match => match[1]);

  assert.deepEqual(labels(englishNav), ["Home", "Research", "Wallet"]);
  assert.deepEqual(labels(vietnameseNav), ["Trang chủ", "Nghiên cứu", "Wallet"]);
  for (const nav of [englishNav, vietnameseNav]) {
    assert.match(nav, /href="https:\/\/testswap\.cypress\.work\/" class="navbar-link" target="_blank" rel="noopener noreferrer"[^>]*>Wallet<\/a>/);
    assert.doesNotMatch(nav, /Information|Thông tin|Moonbeam Legacy|Di sản Moonbeam|Learning Swap|Học Swap/);
  }
  assert.match(english, /<section class="section market" id="information"[\s\S]*?<section class="history-gallery" id="moonbeam-legacy"/);
  assert.match(vietnamese, /<section class="section market" id="information"[\s\S]*?<section class="history-gallery" id="moonbeam-legacy"/);
});

test("desktop and mobile share exactly one compact locale switcher", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");

  for (const locale of ["index.html", "vi/index.html"]) {
    const html = fs.readFileSync(path.join(root, locale), "utf8");
    const header = html.match(/<header class="header"[\s\S]*?<\/header>/)[0];
    assert.equal((header.match(/class="desktop-language"/g) || []).length, 1);
    assert.match(header, /<div class="desktop-language"[^>]*>[\s\S]*?href="\/"[\s\S]*?>EN<\/a>[\s\S]*?\|[\s\S]*?href="\/vi\/"[\s\S]*?>VI<\/a>[\s\S]*?<\/div>/);
    assert.doesNotMatch(html, /mobile-language/);
    assert.doesNotMatch(header, />English<|>Tiếng Việt</);
  }

  assert.match(css, /\.desktop-language\s*{[^}]*display: flex;[^}]*font-size: var\(--fs-8\);/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.desktop-language\s*{[^}]*font-size: var\(--fs-7\);/);
});

test("chart selection is compact and rendered above the plotting area", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  const chartSource = fs.readFileSync(path.join(root, "assets/js/cp-chart.js"), "utf8");

  assert.match(css, /\.chart-heading\s*{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.chart-selection\s*{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.doesNotMatch(css, /\.chart-tooltip/);
  assert.doesNotMatch(css, /\.chart-tooltip-source/);
  assert.doesNotMatch(chartSource, /Historical · close-derived|Current · GeckoTerminal|Lịch sử · OHLC|Hiện tại · OHLCV/);
  assert.match(chartSource, /selection\.replaceChildren\(date, values\)/);
});

test("chart footer prioritizes actions and omits the candle-count status", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  const chartSource = fs.readFileSync(path.join(root, "assets/js/cp-chart.js"), "utf8");

  for (const locale of ["index.html", "vi/index.html"]) {
    const html = fs.readFileSync(path.join(root, locale), "utf8");
    assert.match(html, /<div class="chart-footer">[\s\S]*?<p class="chart-actions"[\s\S]*?<p class="chart-attribution">/);
    assert.doesNotMatch(html, /chart-summary|data-chart-summary|54 candles|54 nến/);
    assert.match(html, /chart-actions[\s\S]*?data-lp-open[\s\S]*?chart-attribution[\s\S]*?TradingView/);
  }

  assert.doesNotMatch(chartSource, /data-chart-summary|candle_count \+ " " \+ countWord/);
  assert.match(css, /\.chart-footer\s*{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.chart-footer\s*{[^}]*flex-direction: column;/);
  assert.match(css, /\.chart-actions\s*{[^}]*font-size: var\(--fs-7\);[^}]*font-weight: var\(--fw-700\);/);
});
