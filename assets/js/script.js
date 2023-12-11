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
  `Người sáng lập: tin rằng giá trị cốt lõi phải từ "phi tập trung và minh bạch", đã tìm tòi nghiên cứu và đầu tư Bitcoin từ năm 2012. Ý nghĩa của dự án: Dự án dành cho những nhà đầu tư trong bình an bằng sản phẩm có mức giá sàn tăng dần 12% một năm ít nhất đến năm 2026, và giá trần tăng theo thị trường. Giúp các thành viên hội đồng quản trị, Cypress Capital Council, có thể phát huy năng lực của mình, đầu tư hiệu quả toàn bộ nguồn vốn. Tầm nhìn của dự án là phi tập trung và minh bạch, chuyển dần quyền quản trị sang cộng đồng.`,
  `Dự án dùng giải pháp Multisig của Moonbeam để giám đốc (Leader), hội đồng quản trị (Council) và đại diện cộng đồng (Core holders) có thể điều hành dự án. Theo nguyên tắc những thứ cần sự an toàn cao nhất sẽ để trong địa chỉ do cộng đồng quản lý ví dụ các thanh khoản cần giữ lâu dài, các tài sản cần dùng ví dụ ngân sách dành cho giao dịch và ngân sách quảng cáo sẽ để trong địa chỉ của giám đốc, các tài sản ở giữa hai mức đó sẽ do hội đồng quản trị nắm giữ ví dụ số lượng token CP chưa đưa vào lưu thông, các thanh khoản còn cần thay đổi tùy theo thị trường.
  
  Nhóm đại diện cộng đồng là nhóm gồm các thành viên có ít nhất từ 1 triệu CP trở lên và tổng số token của nhóm chiếm từ 50% cung lưu thông trở lên mbeam:0x012f3c193E6D78BaBEC52F8AbE6b7B0c443D3bCf thực hiện bằng biểu quyết trên 75%, mỗi thành viên cần giữ 500k CP trong ngân sách họ đang điều hành và sẽ được trả lại khi ngừng tham gia đại diện.
  
  Hội đồng quản trị mbeam:0xF33D7751De5927F0B80Ef3C3e4fA75581754C980 thực hiện bằng đồng thuận trên 90%.
  
  Trách nhiệm khi bạn vào nhóm lãnh đạo là đảm bảo sự phát triển bền vững của dự án, tức là cùng nhau thực hiện các cam kết của dự án với những nhà đầu tư nhỏ lẻ, lợi ích là bạn luôn nắm được tin nội bộ và chủ động trong việc trade, điều này có giá trị rất lớn khi up trend.
  
  Chế độ điểm danh: Đại diện cộng đồng và thành viên quản trị cần điểm danh hàng tháng. Giám đốc cần điểm danh hàng tuần.
  
  Tất cả đều có thực hiện được trên Blockchain, các thành viên không cần biết nhau ở ngoài đời thực.`
];
for (let i = 0; i < infoTabs.length; i++) {
  infoTabs[i].addEventListener("click", function () {
    for (let j = 0; j < infoTabs.length; j++) {
      if (i === j) {
        infoTabs[j].classList.add("active");
        infoText.innerText = infoTexts[i];
      } else {
        infoTabs[j].classList.remove("active");
      }
    }
  });
}

infoTabs[0].click();

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
