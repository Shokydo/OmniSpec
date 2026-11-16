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

  /* ── фон: сетка и снежинки ────────────────────────────────── */
  var reduceMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  /** Медленно уезжающая сетка из линий в 1px. */
  function drawGrid() {
    var canvas = document.getElementById("fx-grid");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var step = 44;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = 0;
    var h = 0;

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function paint(shift) {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      var x = -step + (shift % step);
      for (; x < w + step; x += step) {
        var alpha = 0.045 + 0.035 * (0.5 + 0.5 * Math.sin(x * 0.01 + shift * 0.004));
        ctx.strokeStyle = "rgba(255,255,255," + alphaStr(alpha) + ")";
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
      }
      var y = -step + ((shift * 0.45) % step);
      for (; y < h + step; y += step) {
        var alphaY = 0.04 + 0.03 * (0.5 + 0.5 * Math.sin(y * 0.012 + shift * 0.003));
        ctx.strokeStyle = "rgba(255,255,255," + alphaStr(alphaY) + ")";
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });

    if (reduceMotion) {
      paint(0);
      return;
    }
    var start = performance.now();
    var last = 0;
    function frame(now) {
      // 30 кадров в секунду достаточно: движение медленное, CPU не греется
      if (now - last > 33) {
        last = now;
        paint((now - start) * 0.012);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function alphaStr(value) {
    return Math.max(0, Math.min(1, value)).toFixed(3);
  }

  /** Снежинки как в лаунчере: падают, покачиваются, оборачиваются по краям. */
  function drawSnow() {
    var canvas = document.getElementById("fx-snow");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = 0;
    var h = 0;
    var flakes = [];
    var COUNT = window.innerWidth < 760 ? 34 : 70;

    function seed() {
      flakes = [];
      for (var i = 0; i < COUNT; i += 1) {
        flakes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.8 + Math.random() * 1.9,
          speed: 0.18 + Math.random() * 0.55,
          drift: 0.12 + Math.random() * 0.4,
          phase: Math.random() * Math.PI * 2,
          alpha: 0.18 + Math.random() * 0.45
        });
      }
    }

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function frame(now) {
      ctx.clearRect(0, 0, w, h);
      var t = now * 0.001;
      for (var i = 0; i < flakes.length; i += 1) {
        var flake = flakes[i];
        flake.y += flake.speed;
        flake.x += Math.sin(t * flake.drift + flake.phase) * 0.35;
        if (flake.y - flake.r > h) {
          flake.y = -flake.r * 2;
          flake.x = Math.random() * w;
        }
        if (flake.x < -6) flake.x = w + 6;
        if (flake.x > w + 6) flake.x = -6;
        ctx.beginPath();
        ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255," + alphaStr(flake.alpha) + ")";
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });
    if (reduceMotion) {
      // без анимации — просто редкие точки в кадре
      for (var i = 0; i < flakes.length; i += 1) {
        ctx.beginPath();
        ctx.arc(flakes[i].x, flakes[i].y, flakes[i].r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255," + alphaStr(flakes[i].alpha * 0.6) + ")";
        ctx.fill();
      }
      return;
    }
    requestAnimationFrame(frame);
  }

  /** Блоки появляются при прокрутке, с небольшой задержкой друг за другом. */
  function revealBlocks() {
    var selector = [
      ".sec-head", ".card", ".gal", ".step", ".rel", ".dl-card", ".note",
      ".code", ".faq details", ".split > div", ".eyebrow", "h1", ".lead",
      ".cta", ".meta-row", ".frame", ".search", ".day"
    ].join(",");
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    if (!nodes.length) return;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      nodes.forEach(function (node) { node.classList.add("reveal", "in"); });
      return;
    }

    nodes.forEach(function (node) {
      node.classList.add("reveal");
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        var siblings = node.parentNode ? Array.prototype.slice.call(node.parentNode.children) : [];
        var index = siblings.indexOf(node);
        var delay = Math.min(140, Math.max(0, index) * 35);
        node.style.transitionDelay = delay + "ms";
        node.classList.add("in");
        observer.unobserve(node);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });

    nodes.forEach(function (node) { observer.observe(node); });
  }

  drawGrid();
  drawSnow();
  revealBlocks();
})();
