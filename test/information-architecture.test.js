"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("localized guide and Cypress routes have unique SEO and canonical metadata", () => {
  const routes = [
    ["guides/index.html", "https://cypress.work/guides/"],
    ["vi/huong-dan/index.html", "https://cypress.work/vi/huong-dan/"],
    ["cypress/index.html", "https://cypress.work/cypress/"],
    ["vi/cypress/index.html", "https://cypress.work/vi/cypress/"],
    ["cypress/moonbeam-history/index.html", "https://cypress.work/cypress/moonbeam-history/"],
    ["vi/cypress/lich-su-moonbeam/index.html", "https://cypress.work/vi/cypress/lich-su-moonbeam/"]
  ];
  for (const [file, canonical] of routes) {
    const html = read(file);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
    assert.match(html, /hreflang="en"/);
    assert.match(html, /hreflang="vi"/);
  }
});

test("featured guide is published with verification metadata and practical scope", () => {
  const home = read("index.html");
  const guide = read("guides/ethereum-to-hydration/index.html");
  assert.match(home, /Featured Guides/);
  assert.doesNotMatch(home, /Latest Guides/);
  assert.match(home, /href="\/guides\/ethereum-to-hydration\/"/);
  assert.match(guide, /Published[\s\S]*28 September 2026/);
  assert.match(guide, /Last verified[\s\S]*29 September 2026/);
  assert.match(guide, /Treat the move as two separate jobs/);
  assert.match(guide, /WETH \(MRL\)/);
  assert.doesNotMatch(guide, /guide content pending verification/i);
});

test("Cypress pages include every required factual section and disclosure", () => {
  const english = read("cypress/index.html");
  const vietnamese = read("vi/cypress/index.html");
  for (const heading of ["What does Cypress do today?", "Where does Cypress focus?", "Mission", "Where is Cypress going?", "Cypress’s economic interests", "How does Cypress classify information?", "How can Cypress information be verified?", "Security", "What Cypress is not", "Guides", "Research", "Principles"]) {
    assert.ok(english.includes(`<h2>${heading}</h2>`), heading);
  }
  assert.match(english, /not yet a system that can automatically determine the “best path”/);
  assert.match(english, /economic interests connected to:[\s\S]*CP on Base[\s\S]*dotCP/);
  assert.match(vietnamese, /chưa phải một hệ thống có thể tự động tìm ra “con đường tốt nhất”/);
});

test("sitemap enumerates all new localized routes", () => {
  const sitemap = read("sitemap.xml");
  for (const route of ["/wallet/", "/guides/", "/vi/huong-dan/", "/guides/ethereum-to-hydration/", "/vi/huong-dan/ethereum-to-hydration/", "/cypress/", "/vi/cypress/", "/cypress/moonbeam-history/", "/vi/cypress/lich-su-moonbeam/"]) {
    assert.ok(sitemap.includes(`https://cypress.work${route}`), route);
  }
});

test("Moonbeam continuity is historical and does not change current network scope", () => {
  const englishHome = read("index.html");
  const vietnameseHome = read("vi/index.html");
  const englishArchive = read("cypress/moonbeam-history/index.html");
  const vietnameseArchive = read("vi/cypress/lich-su-moonbeam/index.html");

  assert.match(englishHome, /assets-section[\s\S]*history-bridge[\s\S]*trust-section/);
  assert.match(vietnameseHome, /assets-section[\s\S]*history-bridge[\s\S]*trust-section/);
  assert.match(englishHome, /From Moonbeam to today[\s\S]*href="\/cypress\/moonbeam-history\/"/);
  assert.match(vietnameseHome, /Từ Moonbeam đến hôm nay[\s\S]*href="\/vi\/cypress\/lich-su-moonbeam\/"/);
  assert.match(englishArchive, /no longer (?:in|within) Cypress(?:'s)? active product scope/i);
  assert.match(vietnameseArchive, /không còn nằm trong phạm vi sản phẩm đang hoạt động của Cypress/i);
  for (const html of [englishHome, vietnameseHome]) {
    assert.match(html, /Base[\s\S]*Polkadot Hub[\s\S]*Hydration/);
    assert.doesNotMatch(html, /network-list[^<]*Moonbeam|Phạm vi mạng lưới[^<]*Moonbeam/i);
  }
});

test("Moonbeam archives separate evidence levels and preserve verified legacy records", () => {
  const english = read("cypress/moonbeam-history/index.html");
  const vietnamese = read("vi/cypress/lich-su-moonbeam/index.html");
  const combined = english + vietnamese;
  const legacyRoutes = [
    "/polkadot-va-token-cp.html",
    "/bao-mat.html",
    "/videos.html",
    "/videos-english.html",
    "/vi/nghien-cuu/evm-mac-dong-phuc-0x-polkadot-mac-dong-phuc-1.html"
  ];

  for (const label of ["Repository record", "Project-authored record", "Retained snapshot", "Unresolved"]) {
    assert.match(english, new RegExp(label));
  }
  for (const route of legacyRoutes) {
    assert.ok(english.includes(`href="${route}"`), `EN archive links ${route}`);
    assert.ok(vietnamese.includes(`href="${route}"`), `VI archive links ${route}`);
    assert.ok(fs.existsSync(path.join(root, route.slice(1))), `${route} exists`);
  }

  assert.match(combined, /0x6021D2C27B6FBd6e7608D1F39B41398CAee2F824/);
  assert.match(combined, /0x302c5c4eb1b7b28017e4231cc1a75c577fca0d60/);
  assert.match(combined, /assets\/images\/history\/moonscan-final-1800\.webp/);
  assert.match(combined, /assets\/images\/history\/geckoterminal-history-1800\.webp/);
  assert.match(english, /does not independently establish that launch date/);
  assert.match(vietnamese, /không xác lập độc lập ngày ra mắt này/);
  assert.doesNotMatch(combined, /6,?274|102,?976|supply (?:was )?reduced|Aerodrome|migration ratio/i);
});
