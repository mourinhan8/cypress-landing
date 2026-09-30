const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("homepage navigation exposes Wallet, Guides, Research, Cypress, and no Home item", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");

  assert.match(english, />Wallet<\/a>[\s\S]*?>Guides<\/a>[\s\S]*?>Research<\/a>[\s\S]*?>Cypress<\/a>/);
  assert.match(vietnamese, />Ví<\/a>[\s\S]*?>Hướng dẫn<\/a>[\s\S]*?>Nghiên cứu<\/a>[\s\S]*?>Cypress<\/a>/);
  assert.match(english, /href="\/wallet\/" class="navbar-link"[^>]*>Wallet<\/a>/);
  assert.match(vietnamese, /href="\/wallet\/" class="navbar-link"[^>]*>Ví<\/a>/);
  assert.match(english, /href="\/wallet\/">Open Wallet<\/a>/);
  assert.match(vietnamese, /href="\/wallet\/">Mở Ví<\/a>/);
  assert.doesNotMatch(english + vietnamese, /https:\/\/swap\.cypress\.work/);
  assert.doesNotMatch(english, />Home<\/a>|Learning Swap/);
  assert.doesNotMatch(vietnamese, />Trang chủ<\/a>|Học Swap/);
  assert.match(css, /\.navbar-link:is\(:hover, :focus, \.active\)/);
});

test("mobile header exposes localized language links inside the menu", () => {
  const css = fs.readFileSync(path.join(root, "assets/css/style_1.css"), "utf8");

  for (const locale of ["index.html", "vi/index.html"]) {
    const html = fs.readFileSync(path.join(root, locale), "utf8");
    assert.match(html, /<div class="desktop-language"[\s\S]*?href="\/"[\s\S]*?>EN<\/a>[\s\S]*?href="\/vi\/"[\s\S]*?>VI<\/a>/);
    assert.match(html, /<li class="navbar-item mobile-language">[\s\S]*?English[\s\S]*?<li class="navbar-item mobile-language">[\s\S]*?Tiếng Việt/);
  }

  assert.match(css, /\.desktop-language\s*{[^}]*display: flex;[^}]*font-size: var\(--fs-8\);/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.mobile-language\s*{[^}]*display: none;/);
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*?\.desktop-language\s*{[^}]*display: none;/);
});

test("homepage positioning and section order match the Cypress IA", () => {
  const locales = [
    ["index.html", "Cypress researches and builds tools around assets on Base, Polkadot Hub and Hydration."],
    ["vi/index.html", "Cypress nghiên cứu và xây dựng công cụ xoay quanh tài sản trên Base, Polkadot Hub và Hydration."]
  ];
  for (const [locale, heroNetworkCopy] of locales) {
    const html = fs.readFileSync(path.join(root, locale), "utf8");
    const order = ["cypress-hero", "wallet-trust-strip", "assets-section", "featured-guides", "featured-research", "history-bridge", "trust-section"];
    let cursor = -1;
    for (const marker of order) {
      const next = html.indexOf(marker, cursor + 1);
      assert.ok(next > cursor, `${locale}: ${marker} is in order`);
      cursor = next;
    }
    assert.ok(html.includes(`<p class="hero-lead">${heroNetworkCopy}</p>`));
    assert.doesNotMatch(html, /network-scope|direction-section|direction-grid/);
    assert.doesNotMatch(html, /wallet-section/);
    assert.match(html, /compact-wallet-note[\s\S]*SubWallet[\s\S]*Polkadot\.js[\s\S]*MetaMask/);
    assert.doesNotMatch(html, /Latest Research|Recent Research|Nghiên cứu mới nhất/);
  }
});

test("CP is the primary Base asset and dotCP remains a secondary experimental link", () => {
  const english = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const vietnamese = fs.readFileSync(path.join(root, "vi/index.html"), "utf8");
  const combined = english + vietnamese;

  for (const required of ["CP / USD", "Total Liquidity", "Trading", "Provide liquidity", "Liquidity Returns", "0x934ef4bfffdce191ac4bcc351b2fe7892865b440"]) {
    assert.ok(english.includes(required), required);
  }
  assert.match(english, /Cypress on Base · CP[\s\S]*<h2[^>]*>Cypress<\/h2>[\s\S]*CP is the ticker for Cypress on Base/);
  assert.match(vietnamese, /Cypress trên Base · CP[\s\S]*<h2[^>]*>Cypress<\/h2>[\s\S]*CP là mã giao dịch của Cypress trên Base/);
  assert.doesNotMatch(combined, /Cypress Coin \(CP\)/);
  assert.match(combined, /https:\/\/basescan\.org\/token\/0x934ef4bfffdce191ac4bcc351b2fe7892865b440/);
  assert.match(english, /dotcp-secondary[\s\S]*dotCP — Cypress Coin on Polkadot[\s\S]*Experimental \/ secondary asset[\s\S]*https:\/\/testswap\.cypress\.work\//);
  assert.match(vietnamese, /dotcp-secondary[\s\S]*dotCP — Cypress Coin trên Polkadot[\s\S]*Tài sản phụ \/ thử nghiệm[\s\S]*https:\/\/testswap\.cypress\.work\//);
  assert.doesNotMatch(combined, /href="https:\/\/testswap\.cypress\.work\/"[^>]*class="(?:x-btn|hero-primary)/);
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
