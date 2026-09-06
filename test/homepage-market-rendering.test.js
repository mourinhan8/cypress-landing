"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function homepage(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("English homepage loads the Uniswap data client and accurate attribution", () => {
  const html = homepage("index.html");
  assert.match(html, /data-market-status>Aggregated from Uniswap pools on Base/);
  assert.match(html, /cp-market-data\.js[\s\S]*script_1\.js[\s\S]*cp-market-ui\.js/);
});

test("Vietnamese homepage loads the same client with localized attribution", () => {
  const html = homepage("vi/index.html");
  assert.match(html, /data-market-status>Tổng hợp từ các pool Uniswap trên Base/);
  assert.match(html, /cp-market-data\.js[\s\S]*script_1\.js[\s\S]*cp-market-ui\.js/);
});

test("runtime market scripts contain no legacy pool or GeckoTerminal API source", () => {
  const scripts = homepage("assets/js/cp-market-data.js") + homepage("assets/js/cp-market-ui.js");
  assert.doesNotMatch(scripts, /314e62cf|8057a6de|api\.geckoterminal/i);
});
