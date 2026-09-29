"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const english = read("guides/ethereum-to-hydration/index.html");
const vietnamese = read("vi/huong-dan/ethereum-to-hydration/index.html");

test("guide routes publish reciprocal canonical and hreflang metadata", () => {
  const enUrl = "https://cypress.work/guides/ethereum-to-hydration/";
  const viUrl = "https://cypress.work/vi/huong-dan/ethereum-to-hydration/";
  assert.ok(english.includes(`<link rel="canonical" href="${enUrl}">`));
  assert.ok(vietnamese.includes(`<link rel="canonical" href="${viUrl}">`));
  for (const html of [english, vietnamese]) {
    assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="${enUrl}">`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="vi" href="${viUrl}">`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${enUrl}">`));
  }
});

test("both guides distinguish the ETH representation from moving the main USDC amount", () => {
  assert.match(english, /Choose the ETH representation[\s\S]*Move the main capital/);
  assert.match(vietnamese, /Chọn đúng representation của ETH[\s\S]*Chuyển phần vốn chính/);
  for (const html of [english, vietnamese]) {
    assert.match(html, /WETH \(MRL\)/);
    assert.match(html, /Ethereum USDC[\s\S]*Basejump[\s\S]*Hydration USDC/);
  }
});

test("answer-first summaries expose the current practical routes and actions", () => {
  const hydrationRoute = "https://app.hydration.net/cross-chain?srcChain=ethereum&amp;srcAsset=eth&amp;destChain=hydration&amp;destAsset=eth";
  assert.match(english, /<h2 id="quick-answer-title">Quick answer<\/h2>/);
  assert.match(vietnamese, /<h2 id="quick-answer-title">Tóm tắt<\/h2>/);
  for (const html of [english, vietnamese]) {
    assert.ok(html.includes(`href="${hydrationRoute}"`));
    assert.ok(html.includes('href="#route-explanation"'));
    assert.match(html, /Native ETH|ETH native/);
    assert.match(html, /Snowbridge/);
    assert.match(html, /0\.1 USDC/);
    assert.match(html, /landing-pool liquidity|landing pool đủ thanh khoản/);
  }
});

test("Snowbridge is one user-facing flow while Polkadot Hub remains architecture context", () => {
  assert.match(english, /one Ethereum-to-Hydration transfer flow[\s\S]*separate manual transfer to Polkadot Hub/);
  assert.match(vietnamese, /một flow chuyển từ Ethereum sang Hydration[\s\S]*không cần tự thực hiện thêm một giao dịch riêng tới Polkadot Hub/);
  for (const html of [english, vietnamese]) {
    assert.match(html, /Hydration Cross-chain \/ Snowbridge/);
    assert.match(html, /Polkadot Hub/);
  }
});

test("volatile Basejump values are qualified and the two capacity concepts remain separate", () => {
  for (const html of [english, vietnamese]) {
    assert.match(html, /0\.1 USDC/);
    assert.match(html, /100,000 USDC/);
    assert.match(html, /10,000 USDC/);
    assert.match(html, /FIFO/);
    assert.match(html, /fulfillPending\(\)/);
    assert.match(html, /3ff51bc793c71c6add464574d8839d9d44a79fc2/);
  }
  assert.match(english, /Landing-pool liquidity is not the NTT rate limit/);
  assert.match(english, /10,000 USDC[\s\S]{0,180}not[\s\S]{0,120}per-transfer maximum/);
  assert.match(vietnamese, /Thanh khoản landing pool không phải NTT rate limit/);
  assert.match(vietnamese, /10,000 USDC[\s\S]{0,180}không phải[\s\S]{0,120}mỗi transfer/);
});

test("guide avoids unsupported timing, ranking, and circular bootstrap promises", () => {
  for (const html of [english, vietnamese]) {
    assert.doesNotMatch(html, /always (?:takes?|completes?|arrives?)/i);
    assert.doesNotMatch(html, /globally best|best bridge/i);
    assert.doesNotMatch(html, /\$5|\$10/);
    assert.doesNotMatch(html, /Snowbridge ETH[^<]{0,120}swap[^<]{0,120}WETH[^<]{0,120}(?:solves?|gas)/i);
  }
  assert.match(english, /not a promised completion time/);
  assert.match(vietnamese, /không phải cam kết thời gian hoàn tất/);
});

test("guide includes required primary sources and internal destinations", () => {
  const primarySources = [
    "https://docs.hydration.net/products/trading/fees/",
    "https://docs.hydration.net/guides/deposit/from_ethereum/",
    "https://docs.hydration.net/devs/evm/",
    "https://docs.snowbridge.network/",
    "https://github.com/galacticcouncil/whm/blob/3ff51bc793c71c6add464574d8839d9d44a79fc2/docs/basejump/spec.md",
    "https://hydration.subsquare.io/referenda/404"
  ];
  for (const html of [english, vietnamese]) {
    for (const source of primarySources) assert.ok(html.includes(`href="${source}"`), source);
    assert.ok(html.includes("/wallet/"));
  }
  for (const route of ["/guides/", "/research/", "/cypress/"]) assert.ok(english.includes(`href="${route}"`), route);
  for (const route of ["/vi/huong-dan/", "/vi/nghien-cuu/", "/vi/cypress/"]) assert.ok(vietnamese.includes(`href="${route}"`), route);
  assert.doesNotMatch(english + vietnamese, /testswap\.cypress\.work|swap\.cypress\.work/);
});

test("Article and BreadcrumbList structured data is valid JSON on both routes", () => {
  for (const html of [english, vietnamese]) {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const data = JSON.parse(blocks[0][1]);
    assert.equal(data["@context"], "https://schema.org");
    assert.ok(data["@graph"].some(item => item["@type"] === "Article"));
    assert.ok(data["@graph"].some(item => item["@type"] === "BreadcrumbList"));
  }
});
