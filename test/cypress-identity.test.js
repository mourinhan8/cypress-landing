"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const english = read("cypress/index.html");
const vietnamese = read("vi/cypress/index.html");

test("canonical identity routes publish reciprocal localized metadata", () => {
  const enUrl = "https://cypress.work/cypress/";
  const viUrl = "https://cypress.work/vi/cypress/";
  assert.match(english, /<title>Cypress — Scope, Mission and Principles<\/title>/);
  assert.match(vietnamese, /<title>Cypress — Phạm vi, Mục tiêu và Nguyên tắc<\/title>/);
  assert.ok(english.includes(`<link rel="canonical" href="${enUrl}">`));
  assert.ok(vietnamese.includes(`<link rel="canonical" href="${viUrl}">`));
  for (const html of [english, vietnamese]) {
    assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="${enUrl}">`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="vi" href="${viUrl}">`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${enUrl}">`));
  }
});

test("approved section order and substantive identity copy are preserved", () => {
  const enHeadings = [
    "What does Cypress do today?", "Where does Cypress focus?", "Mission",
    "Where is Cypress going?", "Cypress’s economic interests",
    "How does Cypress classify information?", "How can Cypress information be verified?",
    "Security", "What Cypress is not", "Guides", "Research", "Principles"
  ];
  const viHeadings = [
    "Cypress đang làm gì hôm nay?", "Cypress tập trung vào đâu?", "Mục tiêu",
    "Cypress đang đi về đâu?", "Lợi ích kinh tế của Cypress",
    "Cypress phân biệt thông tin như thế nào?", "Làm sao kiểm tra thông tin của Cypress?",
    "An toàn", "Cypress không phải là gì?", "Guides", "Research", "Nguyên tắc"
  ];
  for (const [html, headings] of [[english, enHeadings], [vietnamese, viHeadings]]) {
    let position = -1;
    for (const heading of headings) {
      const next = html.indexOf(`<h2>${heading}</h2>`);
      assert.ok(next > position, `${heading} follows the approved order`);
      position = next;
    }
  }
  assert.match(english, /Cypress helps people understand where their assets are/);
  assert.match(vietnamese, /Cypress giúp người dùng biết tài sản của mình đang ở đâu/);
});

test("current network scope and signer examples remain explicit", () => {
  for (const html of [english, vietnamese]) {
    assert.match(html, /identity-network-scope[\s\S]*Base[\s\S]*Polkadot Hub[\s\S]*Hydration/);
    assert.match(html, /signer-inline[\s\S]*SubWallet[\s\S]*Polkadot\.js[\s\S]*MetaMask/);
  }
  assert.match(english, /does not hold users’ private keys/);
  assert.match(vietnamese, /không giữ private key/);
});

test("economic conflict and three evidence classes remain prominent", () => {
  for (const html of [english, vietnamese]) {
    assert.match(html, /economic-interests/);
    assert.match(html, /CP/);
    assert.match(html, /dotCP/);
    assert.match(html, /classification-fact/);
    assert.match(html, /classification-observation/);
    assert.match(html, /classification-interpretation/);
  }
  assert.match(english, /This creates a potential conflict of interest/);
  assert.match(vietnamese, /Điều này có thể tạo ra xung đột lợi ích/);
  assert.match(english, /If something has not been verified, Cypress should not present it as fact/);
  assert.match(vietnamese, /Nếu chưa kiểm được, Cypress không nên viết như một sự thật/);
});

test("security responsibility covers transaction construction details", () => {
  for (const phrase of ["wrong asset", "wrong network", "wrong destination", "calculates fees incorrectly", "builds the wrong transaction", "contract or pallet", "special warnings"]) {
    assert.match(english, new RegExp(phrase));
  }
  for (const phrase of ["nhầm tài sản", "sai mạng", "sai địa chỉ", "tính sai phí", "tạo sai transaction", "contract hoặc pallet", "cảnh báo đặc biệt"]) {
    assert.match(vietnamese, new RegExp(phrase));
  }
});

test("identity pages link to current products and localized history without duplicating the archive", () => {
  for (const route of ["/wallet/", "/guides/", "/research/", "/cypress/moonbeam-history/"]) assert.ok(english.includes(`href="${route}"`), route);
  for (const route of ["/wallet/", "/vi/huong-dan/", "/vi/nghien-cuu/", "/vi/cypress/lich-su-moonbeam/"]) assert.ok(vietnamese.includes(`href="${route}"`), route);
  assert.doesNotMatch(english + vietnamese, /0x6021D2C27B6FBd6e7608D1F39B41398CAee2F824|0x302c5c4eb1b7b28017e4231cc1a75c577fca0d60/);
});

test("AboutPage and BreadcrumbList structured data is valid JSON", () => {
  for (const html of [english, vietnamese]) {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const data = JSON.parse(blocks[0][1]);
    assert.equal(data["@context"], "https://schema.org");
    assert.ok(data["@graph"].some(item => item["@type"] === "AboutPage"));
    assert.ok(data["@graph"].some(item => item["@type"] === "BreadcrumbList"));
  }
});
