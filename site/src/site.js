/* OmniSpec — сайт: меню на узком экране, лайтбокс скриншотов,
   поиск по списку изменений. Без внешних зависимостей. */
(function () {
  "use strict";

  /* меню на телефоне */
  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var on = nav.classList.toggle("on");
      toggle.setAttribute("aria-expanded", on ? "true" : "false");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        nav.classList.remove("on");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* лайтбокс */
  var lb = document.getElementById("lb");
  var lbImg = document.getElementById("lb-img");
  var lbClose = document.getElementById("lb-close");
  function closeLb() {
    lb.classList.remove("on");
    lbImg.removeAttribute("src");
    document.body.style.overflow = "";
  }
  if (lb && lbImg) {
    document.addEventListener("click", function (e) {
      var fig = e.target.closest ? e.target.closest(".gal") : null;
      if (fig) {
        var img = fig.querySelector("img");
        var src = (img && (img.currentSrc || img.src)) || fig.getAttribute("data-src");
        if (src) {
          lbImg.src = src;
          lbImg.alt = (fig.querySelector("figcaption") || {}).textContent || "";
          lb.classList.add("on");
          document.body.style.overflow = "hidden";
        }
      }
    });
    lb.addEventListener("click", function (e) {
      if (e.target === lb || e.target === lbClose) closeLb();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && lb.classList.contains("on")) closeLb();
    });
  }

  /* поиск по списку изменений */
  var input = document.getElementById("rel-search");
  if (input) {
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-rel]"));
    var days = Array.prototype.slice.call(document.querySelectorAll("[data-day]"));
    var empty = document.getElementById("rel-empty");
    var count = document.getElementById("rel-count");
    var total = items.length;
    var filter = function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      items.forEach(function (el) {
        var hit = !q || (el.textContent || "").toLowerCase().indexOf(q) >= 0;
        el.hidden = !hit;
        if (hit) shown += 1;
      });
      days.forEach(function (day) {
        var next = day.nextElementSibling;
        var any = false;
        while (next && !next.hasAttribute("data-day")) {
          if (next.hasAttribute("data-rel") && !next.hidden) { any = true; break; }
          next = next.nextElementSibling;
        }
        day.hidden = !any;
      });
      if (empty) empty.hidden = shown !== 0;
      if (count) count.textContent = q ? shown + " из " + total : total + " релизов";
    };
    input.addEventListener("input", filter);
    filter();
  }
})();
