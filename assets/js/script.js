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
}

addEventOnElem(navToggler, "click", toggleNavbar);

const closeNavbar = function () {
  navbar.classList.remove("active");
  navToggler.classList.remove("active");
  document.body.classList.remove("active");
}

addEventOnElem(navbarLinks, "click", closeNavbar);

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
 * information tab
 */

const infoTabs = document.querySelectorAll("[data-info]");
const infoText = document.querySelector("[data-info-text]");
const infoTexts = [
  `The Founder believes in the core values of "decentralization and transparency," has been exploring research and investing in Bitcoin since 2012. 
  Project Significance: Tailored for investors prioritizing security, the project features a product with a floor that increases by 12% annually, while the ceiling price adjusts based on market conditions. The project operates under the guidance of a leader, a council, and a team of core holders. With a vision of decentralization and transparency, the project aims to progressively shift management authority to the community.`,
  `The project utilizes Moonbeam's Multisig solution for the governance of the Leader, Council, and Core Holders in the community. According to the principle, items requiring the highest security are stored in addresses managed by the community, such as long-term liquidity holdings. Assets needed for transactions and advertising budgets, for example, are stored in the director's address. Assets between these two levels are held by the Council, such as the quantity of CP tokens not yet in circulation and liquidity that needs to be adjusted based on market conditions.

  The community representative group consists of members holding at least 1 million CP, and the total tokens of the group account for 50% or more of the circulating supply mbeam:0x012f3c193E6D78BaBEC52F8AbE6b7B0c443D3bCf. Decisions are made through a vote with over 75% approval. Each member needs to hold 500k CP in their operating budget, which will be returned when they cease to be a representative.
  
  The Council, identified by the address mbeam:0xF33D7751De5927F0B80Ef3C3e4fA75581754C980, operates through consensus with over 90% agreement.
  
  The responsibility when joining the leadership team is to ensure the sustainable development of the project. This involves fulfilling the project's commitments to small investors, and the benefit is that you always have insider information and are proactive in trading, which is valuable during an uptrend.
  
  Attendance is mandatory: Community representatives and management members need to check in monthly, while the director needs to check in weekly.
  
  All of these processes are executed on the blockchain, and members don't need to know each other in real life.`
];

var i = 0;
var txt = `

`; /* The text */

var speed = 50; /* The speed/duration of the effect in milliseconds */

if (infoTabs.length > 0) {
  for (let i = 0; i < infoTabs.length; i++) {
    infoTabs[i].addEventListener("click", function () {
      for (let j = 0; j < infoTabs.length; j++) {
        if (i === j) {
          infoTabs[j].classList.add("active");
          let count = 0;
          const txt = infoTexts[i]
          infoText.innerText = infoTexts[i];
          // function typeWriter() {
          //   if (count < txt.length) {
          //     infoText.innerText += txt.charAt(count);
          //     count++;
          //     setTimeout(typeWriter, speed);
          //   }
          // }
          // typeWriter()
        } else {
          infoTabs[j].classList.remove("active");
        }
      }
    });
  }

  infoTabs[0].click();
}

const form = document.querySelector('#feedback-form');

form.addEventListener('submit', event => {
  event.preventDefault();
  event.stopPropagation();
  form.classList.add('was-validated');
  if (form.checkValidity()) {
    const name = document.querySelector("#name").value;
    const email = document.querySelector("#email").value;
    const feedback = document.querySelector("#feedback").value;
    console.log("will submit", { name, email, feedback });
    setTimeout(() => {
      swal("Tin nhắn đã được gửi đi!", "Cảm ơn bạn về tin nhắn này. Chúng tôi sẽ liên hệ lại với bạn ngay khi có thể.", "success");
    }, 1000);
  }
}, false);

const swiper = new Swiper('.swiper', {
  // Optional parameters
  direction: 'horizontal',
  loop: false,

  // If we need pagination
  pagination: {
    el: '.swiper-pagination',
  },

  // Navigation arrows
  navigation: {
    nextEl: '.swiper-button-next',
    prevEl: '.swiper-button-prev',
  },

  // And if we need scrollbar
  scrollbar: {
    el: '.swiper-scrollbar',
  },
});
