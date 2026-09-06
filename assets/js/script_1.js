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

