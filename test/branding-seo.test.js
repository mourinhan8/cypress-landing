"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const pages = {
  en: fs.readFileSync(path.join(root, "index.html"), "utf8"),
  vi: fs.readFileSync(path.join(root, "vi/index.html"), "utf8")
};

function content(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<meta ${escaped} content="([^"]+)"`));
  return match && match[1];
}

test("homepage metadata introduces Cypress as the brand and CP as its ticker", () => {
  const expected = {
    en: {
      title: "Cypress (CP) | Crypto Research on Base &amp; Polkadot",
      description: "Cypress is an independent crypto research platform focused on Base and Polkadot, featuring the Cypress (CP) token on Base."
    },
    vi: {
      title: "Cypress (CP) | Nghiên cứu tiền mã hóa về Base và Polkadot",
      description: "Cypress là nền tảng nghiên cứu tiền mã hóa độc lập về Base và Polkadot, đồng thời giới thiệu token Cypress (CP) trên Base."
    }
  };

  for (const locale of Object.keys(pages)) {
    const html = pages[locale];
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    assert.equal(title, expected[locale].title);
    assert.equal(content(html, 'name="description"'), expected[locale].description);
    assert.equal(content(html, 'property="og:title"'), expected[locale].title);
    assert.equal(content(html, 'property="og:description"'), expected[locale].description);
    assert.equal(content(html, 'name="twitter:title"'), expected[locale].title);
    assert.equal(content(html, 'name="twitter:description"'), expected[locale].description);
    assert.ok(title.replaceAll("&amp;", "&").length <= 65);
    assert.ok(expected[locale].description.length <= 160);
  }
});

test("visible homepage naming uses Cypress naturally for current Base infrastructure", () => {
  assert.match(pages.en, />Cypress Token Price</);
  assert.match(pages.en, /aria-label="Live Cypress token market data"/);
  assert.match(pages.en, />Primary Cypress-linked asset · Base</);
  assert.match(pages.en, />Cypress Coin \(CP\)</);
  assert.match(pages.en, />Base CP contract</);
  assert.match(pages.vi, />Giá token Cypress</);
  assert.match(pages.vi, /aria-label="Dữ liệu thị trường token Cypress trực tiếp"/);
  assert.match(pages.vi, />Tài sản chính gắn với Cypress · Base</);
  assert.match(pages.vi, />Cypress Coin \(CP\)</);
  assert.match(pages.vi, />Contract CP trên Base</);
  for (const html of Object.values(pages)) {
    assert.doesNotMatch(html, />CP Token on Base<|>CP Price<|>Giá CP<|>CP Contract on Base</);
  }
});

test("technical ticker, pair, contract, dotCP, and historical labels remain intact", () => {
  for (const html of Object.values(pages)) {
    assert.match(html, />CP \/ USD</);
    assert.match(html, /0x934ef4bfffdce191ac4bcc351b2fe7892865b440/);
  }
  assert.match(pages.en, />dotCP on Polkadot</);
  assert.match(pages.vi, />dotCP trên Polkadot</);
  assert.equal((pages.en.match(/>dotCP on Polkadot</g) || []).length, 1);
  assert.equal((pages.vi.match(/>dotCP trên Polkadot</g) || []).length, 1);
  const history = fs.readFileSync(path.join(root, "cypress/moonbeam-history/index.html"), "utf8");
  assert.match(history, /CP\/WGLMR/);
  assert.match(pages.en, />Start price<[\s\S]*>End price</);
  assert.match(pages.vi, />Giá đầu kỳ<[\s\S]*>Giá cuối kỳ</);
  const legacy = fs.readFileSync(path.join(root, "tools/lp/legacy-full-range-calculator-ui.mjs"), "utf8");
  assert.match(legacy, /simulateFullRange/);
});

test("homepage JSON-LD remains valid and keeps Cypress as the primary name", () => {
  for (const html of Object.values(pages)) {
    const source = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    const data = JSON.parse(source);
    assert.equal(data["@context"], "https://schema.org");
    assert.deepEqual(data["@graph"].map(item => item.name), ["Cypress", "Cypress"]);
    assert.deepEqual(data["@graph"][1].inLanguage, ["en", "vi"]);
  }
});
