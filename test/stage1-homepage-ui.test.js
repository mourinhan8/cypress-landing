const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("active homepage navigation stays visually lighter than the Learning Swap CTA", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");

  assert.match(css, /\.nav-normal:is\(:hover, :focus, \.active\)\s*{[^}]*color: hsl\(214, 100%, 74%\);[^}]*box-shadow: inset 0 -2px currentColor;/);
  assert.doesNotMatch(css, /\.nav-normal:is\(:hover, :focus, \.active\)\s*{[^}]*background-color: var\(--blue-crayola\)/);

  for (const html of [english, vietnamese]) {
    assert.match(html, /class="navbar-link nav-normal active"/);
    assert.match(html, /class="x-btn btn-outline desktop-swap"[^>]*>\s*(?:Learning Swap|Học Swap)<\/a>/);
  }
});

test("mobile header exposes languages and moves Learning Swap into the menu", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");

  for (const locale of ["index.html", "vi/index.html"]) {
    const html = fs.readFileSync(path.join(root, locale), "utf8");
    assert.match(html, /<div class="desktop-language"[\s\S]*?href="\/"[\s\S]*?>EN<\/a>[\s\S]*?href="\/vi\/"[\s\S]*?>VI<\/a>/);
    assert.match(html, /<li class="navbar-item mobile-swap">[\s\S]*?swap\.cypress\.work[\s\S]*?(?:Learning Swap|Học Swap)<\/a>/);
    assert.doesNotMatch(html, /mobile-language/);
  }

  assert.match(css, /\.desktop-language\s*{[^}]*display: flex;[^}]*font-size: var\(--fs-8\);/);
  assert.match(css, /\.desktop-swap\s*{[^}]*display: none;/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.mobile-swap,[\s\S]*?display: none;[\s\S]*?\.desktop-swap\s*{[^}]*display: block;/);
});

test("chart tooltip is compact and fixed to the bottom-left", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  const chartSource = fs.readFileSync(path.join(root, "assets/js/cp-chart.js"), "utf8");

  assert.match(css, /\.chart-tooltip\s*{[^}]*inset: auto auto 10px 10px;[^}]*padding: 5px 7px;/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.chart-tooltip\s*{[^}]*inset: auto auto 6px 6px;/);
  assert.doesNotMatch(css, /\.chart-tooltip-source/);
  assert.doesNotMatch(chartSource, /Historical · close-derived|Current · GeckoTerminal|Lịch sử · OHLC|Hiện tại · OHLCV/);
  assert.match(chartSource, /tooltip\.replaceChildren\(date, values\)/);
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
