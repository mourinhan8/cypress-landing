'use strict';

/**
 * add event on element
 */

const addEventOnElem = function (elem, type, callback) {
  if (elem.length > 1 && elem !== window) {
    for (let i = 0; i < elem.length; i++) {
      elem[i].addEventListener(type, callback);
    }
  } else {
    elem.addEventListener(type, callback);
  }
}

/**
 * navbar toggle
 */

const navbar = document.querySelector("[data-navbar]");
const navbarLinks = document.querySelectorAll("[data-nav-link]");
const navToggler = document.querySelector("[data-nav-toggler]");

const toggleNavbar = function () {
  navbar.classList.toggle("active");
  navToggler.classList.toggle("active");
  document.body.classList.toggle("active");
  navToggler.setAttribute("aria-expanded", navbar.classList.contains("active"));
}

addEventOnElem(navToggler, "click", toggleNavbar);

const closeNavbar = function () {
  navbar.classList.remove("active");
  navToggler.classList.remove("active");
  document.body.classList.remove("active");
  navToggler.setAttribute("aria-expanded", "false");
}

addEventOnElem(navbarLinks, "click", closeNavbar);

document.addEventListener("click", function (event) {
  if (navbar.classList.contains("active") &&
      !navbar.contains(event.target) &&
      !navToggler.contains(event.target)) {
    closeNavbar();
  }
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && navbar.classList.contains("active")) {
    closeNavbar();
    navToggler.focus();
  }
});

/**
 * header active
 */

const header = document.querySelector("[data-header]");

const activeHeader = function () {
  if (window.scrollY > 300) {
    header.classList.add("active");
  } else {
    header.classList.remove("active");
  }
}

addEventOnElem(window, "scroll", activeHeader);

/**
 * scroll revreal effect
 */

const sections = document.querySelectorAll("[data-section]");

const scrollReveal = function () {
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].getBoundingClientRect().top < window.innerHeight / 1.5) {
      sections[i].classList.add("active");
    } else {
      sections[i].classList.remove("active");
    }
  }
}

scrollReveal();

addEventOnElem(window, "scroll", scrollReveal);

/**
 * live CP market data
 */

const marketPrice = document.querySelector("[data-cp-price]");
const marketLiquidity = document.querySelector("[data-cp-liquidity]");

if (marketPrice && marketLiquidity) {
  const targetPoolAddresses = new Set([
    "0x314e62cf3937a58179360362f32f4b90c13a6693",
    "0x8057a6de149f110358b9ee0b8c124f3e4796f328"
  ]);
  const refreshInterval = 5 * 60 * 1000;
  const requestTimeout = 9000;
  let refreshTimer;
  let lastRequestAt = 0;
  let requestInFlight = false;

  const formatPrice = function (value) {
    let options;

    if (value >= 1) {
      options = { maximumFractionDigits: 4 };
    } else if (value >= 0.01) {
      options = { maximumFractionDigits: 6 };
    } else {
      options = { maximumFractionDigits: 20, maximumSignificantDigits: 6 };
    }

    return "$" + new Intl.NumberFormat("en-US", options).format(value);
  }

  const formatLiquidity = function (value) {
    if (value < 1000) {
      return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
    }

    if (value < 1000000) {
      return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value / 1000) + "K";
    }

    return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value / 1000000) + "M";
  }

  const showUnavailable = function () {
    marketPrice.textContent = "Unavailable";
    marketLiquidity.textContent = "Unavailable";
  }

  const scheduleRefresh = function () {
    window.clearTimeout(refreshTimer);

    if (document.hidden) return;

    const elapsed = Date.now() - lastRequestAt;
    const delay = Math.max(0, refreshInterval - elapsed);
    refreshTimer = window.setTimeout(loadMarketData, delay);
  }

  const loadMarketData = async function () {
    if (requestInFlight) return;

    requestInFlight = true;
    lastRequestAt = Date.now();

    const contractElement = document.querySelector(".contract-address");
    const contractAddress = contractElement ? contractElement.textContent.trim() : "";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), requestTimeout);

    try {
      if (!/^0x[0-9a-f]{40}$/i.test(contractAddress)) {
        throw new Error("CP contract address is unavailable");
      }

      const endpoint = "https://api.geckoterminal.com/api/v2/networks/base/tokens/" +
        encodeURIComponent(contractAddress) + "/pools";
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error("GeckoTerminal returned HTTP " + response.status);
      }

      const payload = await response.json();
      const pools = Array.isArray(payload.data) ? payload.data : [];
      const validPools = pools
        .filter(pool => {
          const address = pool && pool.attributes ? String(pool.attributes.address).toLowerCase() : "";
          return targetPoolAddresses.has(address);
        })
        .map(pool => ({
          price: Number(pool.attributes.token_price_usd),
          liquidity: Number(pool.attributes.reserve_in_usd)
        }))
        .filter(pool =>
          Number.isFinite(pool.price) && pool.price > 0 &&
          Number.isFinite(pool.liquidity) && pool.liquidity > 0
        );

      if (validPools.length === 0) {
        throw new Error("No valid target pools were returned");
      }

      const totalLiquidity = validPools.reduce((total, pool) => total + pool.liquidity, 0);
      const weightedPrice = validPools.reduce(
        (total, pool) => total + (pool.price * pool.liquidity),
        0
      ) / totalLiquidity;

      if (!Number.isFinite(totalLiquidity) || totalLiquidity <= 0 ||
          !Number.isFinite(weightedPrice) || weightedPrice <= 0) {
        throw new Error("Calculated market data is invalid");
      }

      marketPrice.textContent = formatPrice(weightedPrice);
      marketLiquidity.textContent = formatLiquidity(totalLiquidity);
    } catch (error) {
      showUnavailable();
      const message = error instanceof Error ? error.message : "Unknown error";
      console.warn("CP market data unavailable:", message);
    } finally {
      window.clearTimeout(timeout);
      requestInFlight = false;
      scheduleRefresh();
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      window.clearTimeout(refreshTimer);
    } else {
      scheduleRefresh();
    }
  });

  loadMarketData();
}

/**
 * information content
 */

const infoText = document.querySelector("[data-info-text]");
const infoTexts = [
  `📖 Cypress History

2022

Cypress was launched on the Moonbeam network with a mission to build an independent crypto research community. CP became the native token of the ecosystem.

2022–2026

Over four years on Moonbeam, Cypress gradually established its on-chain presence.

The CP smart contract was deployed and source-code verified on Moonbeam.

Trading was available through the CP/WGLMR liquidity pool on Zenlink and tracked by GeckoTerminal.

Before the Moonbeam network sunset, the CP ecosystem had grown to more than 6,200 holders and over 100,000 on-chain transactions.

These records are preserved below as historical snapshots of the Moonbeam era.

2026

Following the announced sunset of the Moonbeam network, Cypress migrated to Base to ensure the long-term continuity of the project.

During the migration:

• CP was redeployed on Base.

• Total token supply was reduced to 25% of its previous level.

• Trading liquidity migrated to Aerodrome.

Today

Cypress continues as an independent crypto research platform focused on the Base and Polkadot ecosystems.

The Moonbeam chapter became the foundation for Cypress's next stage of development on Base.`
];

if (infoText) {
  const infoTextVi = `📖 Lịch sử Cypress

2022

Cypress được ra mắt trên mạng Moonbeam với sứ mệnh xây dựng một cộng đồng nghiên cứu tiền mã hóa độc lập. CP trở thành token gốc của hệ sinh thái.

2022–2026

Trong bốn năm trên Moonbeam, Cypress từng bước xây dựng sự hiện diện on-chain.

Smart contract CP đã được triển khai và xác minh mã nguồn trên Moonbeam.

Giao dịch được thực hiện qua pool thanh khoản CP/WGLMR trên Zenlink và được GeckoTerminal theo dõi.

Trước khi mạng Moonbeam ngừng hoạt động, hệ sinh thái CP đã phát triển lên hơn 6.200 người nắm giữ và hơn 100.000 giao dịch on-chain.

Các bản ghi này được lưu giữ bên dưới dưới dạng ảnh chụp lịch sử của thời kỳ Moonbeam.

2026

Sau thông báo ngừng hoạt động của mạng Moonbeam, Cypress đã chuyển sang Base để bảo đảm tính liên tục lâu dài của dự án.

Trong quá trình chuyển đổi:

• CP được triển khai lại trên Base.

• Tổng cung token giảm còn 25% so với mức trước đây.

• Thanh khoản giao dịch chuyển sang Aerodrome.

Hiện nay

Cypress tiếp tục là một nền tảng nghiên cứu tiền mã hóa độc lập, tập trung vào các hệ sinh thái Base và Polkadot.

Chặng đường Moonbeam đã trở thành nền tảng cho giai đoạn phát triển tiếp theo của Cypress trên Base.`;

  infoText.innerText = document.documentElement.lang === "vi" ? infoTextVi : infoTexts[0];
}

