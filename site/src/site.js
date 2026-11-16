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

  /* ── фон: частицы, сетка и снежинки ───────────────────────── */
  var reduceMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  // сдвиг фона от прокрутки: сетка «плывёт» вместе со страницей, но медленнее
  var fxState = { scroll: 0 };

  function alphaStr(value) {
    return Math.max(0, Math.min(1, value)).toFixed(3);
  }

  /** Размер полотна в CSS-пикселях и подготовка канваса под плотность экрана. */
  function setupCanvas(id) {
    var canvas = document.getElementById(id);
    if (!canvas || !canvas.getContext) return null;
    var ctx = canvas.getContext("2d");
    var state = { canvas: canvas, ctx: ctx, w: 0, h: 0, dpr: Math.min(2, window.devicePixelRatio || 1) };
    state.resize = function () {
      state.w = window.innerWidth;
      state.h = window.innerHeight;
      canvas.width = Math.round(state.w * state.dpr);
      canvas.height = Math.round(state.h * state.dpr);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    };
    state.resize();
    window.addEventListener("resize", state.resize, { passive: true });
    return state;
  }

  /**
   * Фон: сетка из точек и связей — по настройкам автора макета:
   * 130 точек, связь до 150 px, скорость 0.6, курсор притягивает в радиусе
   * 220 px с силой 55, толщина связей 0.3, пульс точек 60, пульс связей 0.
   */
  var PLEX = {
    color: "#ffffff",
    count: 130,
    countNarrow: 56,
    distance: 150,
    distanceNarrow: 118,
    speed: 0.6,
    cursorRadius: 220,
    strength: 55,
    lineOp: 0.3,
    cursor: "attract",
    linkPulse: 0,
    linkPulseSpeed: 1.5,
    dotPulse: 60,
    maxSpeed: 4,
    dotAlpha: 0.6
  };

  function drawPlexus() {
    var view = setupCanvas("fx-plex");
    if (!view) return;
    var ctx = view.ctx;
    var narrow = window.innerWidth < 760;
    var count = narrow ? PLEX.countNarrow : PLEX.count;
    var distance = narrow ? PLEX.distanceNarrow : PLEX.distance;
    var pointer = { x: -9999, y: -9999 };
    var points = [];

    function seed() {
      points = [];
      for (var i = 0; i < count; i += 1) {
        points.push({
          x: Math.random() * view.w,
          y: Math.random() * view.h,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          r: 1 + Math.random() * 1.5
        });
      }
    }

    /** Один кадр: движение, связи, точки. `time` в секундах. */
    function paint(time) {
      ctx.clearRect(0, 0, view.w, view.h);

      // пульс связей и точек — те же коэффициенты, что в макете
      var linkPulse = Math.max(0, Math.min(1, PLEX.linkPulse / 100));
      var linkFactor = (1 - linkPulse) + linkPulse * (0.5 + 0.5 * Math.sin(time * PLEX.linkPulseSpeed * Math.PI * 2));
      var dotPulse = Math.max(0, Math.min(1, PLEX.dotPulse / 100));
      var radiusFactor = 1 + dotPulse * 0.35 * Math.sin(time * 2.4);
      var i;
      var j;

      for (i = 0; i < points.length; i += 1) {
        var point = points[i];
        var dx = point.x - pointer.x;
        var dy = point.y - pointer.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < PLEX.cursorRadius && d > 0.01) {
          var force = (1 - d / PLEX.cursorRadius) * (PLEX.strength / 100) * 0.6;
          if (PLEX.cursor === "attract") {
            point.vx -= (dx / d) * force;
            point.vy -= (dy / d) * force;
          } else if (PLEX.cursor === "repel") {
            point.vx += (dx / d) * force;
            point.vy += (dy / d) * force;
          }
        }
        var speed = Math.sqrt(point.vx * point.vx + point.vy * point.vy);
        if (speed > PLEX.maxSpeed) {
          point.vx = (point.vx / speed) * PLEX.maxSpeed;
          point.vy = (point.vy / speed) * PLEX.maxSpeed;
        }
        point.x += point.vx * PLEX.speed;
        point.y += point.vy * PLEX.speed;
        if (point.x < 0 || point.x > view.w) point.vx *= -1;
        if (point.y < 0 || point.y > view.h) point.vy *= -1;
      }

      ctx.lineWidth = 1;
      for (i = 0; i < points.length; i += 1) {
        for (j = i + 1; j < points.length; j += 1) {
          var lx = points[i].x - points[j].x;
          var ly = points[i].y - points[j].y;
          var ld = Math.sqrt(lx * lx + ly * ly);
          if (ld < distance) {
            ctx.strokeStyle = "rgba(255,255,255," + alphaStr((1 - ld / distance) * PLEX.lineOp * linkFactor) + ")";
            ctx.beginPath();
            ctx.moveTo(points[i].x, points[i].y);
            ctx.lineTo(points[j].x, points[j].y);
            ctx.stroke();
          }
        }
      }

      // линия к курсору — только если в настройках выбран режим «grab»
      if (PLEX.cursor === "attract" && pointer.x > -999) {
        for (i = 0; i < points.length; i += 1) {
          var cx = points[i].x - pointer.x;
          var cy = points[i].y - pointer.y;
          var cd = Math.sqrt(cx * cx + cy * cy);
          if (cd < PLEX.cursorRadius) {
            ctx.strokeStyle = "rgba(255,255,255," + alphaStr((1 - cd / PLEX.cursorRadius) * 0.22) + ")";
            ctx.beginPath();
            ctx.moveTo(pointer.x, pointer.y);
            ctx.lineTo(points[i].x, points[i].y);
            ctx.stroke();
          }
        }
      }

      ctx.fillStyle = "rgba(255,255,255," + alphaStr(PLEX.dotAlpha) + ")";
      for (i = 0; i < points.length; i += 1) {
        ctx.beginPath();
        ctx.arc(points[i].x, points[i].y, points[i].r * radiusFactor, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    seed();
    window.addEventListener("resize", seed, { passive: true });
    window.addEventListener("pointermove", function (event) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }, { passive: true });
    window.addEventListener("pointerleave", function () {
      pointer.x = -9999;
      pointer.y = -9999;
    }, { passive: true });

    if (reduceMotion) { paint(0); return; }
    var started = performance.now();
    function frame(now) {
      paint((now - started) / 1000);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /** Медленно уезжающая сетка из линий в 1px. */
  function drawGrid() {
    var view = setupCanvas("fx-grid");
    if (!view) return;
    var ctx = view.ctx;
    var step = 44;

    function paint(shift) {
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.lineWidth = 1;
      var x = -step + (shift % step);
      for (; x < view.w + step; x += step) {
        var alpha = 0.045 + 0.035 * (0.5 + 0.5 * Math.sin(x * 0.01 + shift * 0.004));
        ctx.strokeStyle = "rgba(255,255,255," + alphaStr(alpha) + ")";
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, view.h);
        ctx.stroke();
      }
      var y = -step + ((shift * 0.45) % step);
      for (; y < view.h + step; y += step) {
        var alphaY = 0.04 + 0.03 * (0.5 + 0.5 * Math.sin(y * 0.012 + shift * 0.003));
        ctx.strokeStyle = "rgba(255,255,255," + alphaStr(alphaY) + ")";
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(view.w, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }

    if (reduceMotion) { paint(0); return; }
    var start = performance.now();
    var last = 0;
    function frame(now) {
      // 30 кадров в секунду достаточно: движение медленное, CPU не греется
      if (now - last > 33) {
        last = now;
        paint((now - start) * 0.012 + fxState.scroll);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /**
   * Снежинки: три слоя глубины — дальние мелкие и медленные, ближние крупные
   * и быстрые. Ветер и покачивание у каждого свои, края заворачиваются.
   */
  function drawSnow() {
    var view = setupCanvas("fx-snow");
    if (!view) return;
    var ctx = view.ctx;
    var narrow = window.innerWidth < 760;
    var LAYERS = narrow
      ? [{ count: 16, r: [0.7, 1.1], speed: [14, 26], alpha: 0.22 }, { count: 12, r: [1.1, 1.7], speed: [26, 46], alpha: 0.34 }, { count: 6, r: [1.7, 2.4], speed: [46, 72], alpha: 0.5 }]
      : [{ count: 38, r: [0.7, 1.2], speed: [18, 34], alpha: 0.24 }, { count: 28, r: [1.2, 1.9], speed: [34, 60], alpha: 0.38 }, { count: 16, r: [1.9, 2.8], speed: [58, 96], alpha: 0.55 }];
    var flakes = [];

    function seed() {
      flakes = [];
      LAYERS.forEach(function (layer, depth) {
        for (var i = 0; i < layer.count; i += 1) {
          flakes.push({
            depth: depth,
            x: Math.random() * view.w,
            y: Math.random() * view.h,
            r: layer.r[0] + Math.random() * (layer.r[1] - layer.r[0]),
            speed: layer.speed[0] + Math.random() * (layer.speed[1] - layer.speed[0]),
            drift: 0.2 + Math.random() * 0.6,
            sway: 6 + Math.random() * 16,
            phase: Math.random() * Math.PI * 2,
            spin: (Math.random() - 0.5) * 0.6,
            alpha: layer.alpha * (0.75 + Math.random() * 0.5)
          });
        }
      });
    }

    function paint(dt, time) {
      ctx.clearRect(0, 0, view.w, view.h);
      for (var i = 0; i < flakes.length; i += 1) {
        var flake = flakes[i];
        ctx.beginPath();
        if (flake.r > 2.1) {
          // крупная снежинка — звёздочка из трёх штрихов
          var arm = flake.r * 1.9;
          var spin = flake.phase + time * flake.spin;
          ctx.strokeStyle = "rgba(255,255,255," + alphaStr(flake.alpha) + ")";
          ctx.lineWidth = 1;
          for (var k = 0; k < 3; k += 1) {
            var angle = spin + (k * Math.PI) / 3;
            ctx.moveTo(flake.x - Math.cos(angle) * arm, flake.y - Math.sin(angle) * arm);
            ctx.lineTo(flake.x + Math.cos(angle) * arm, flake.y + Math.sin(angle) * arm);
          }
          ctx.stroke();
        } else {
          ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,255,255," + alphaStr(flake.alpha) + ")";
          ctx.fill();
        }
      }
    }

    function step(dt, time) {
      for (var i = 0; i < flakes.length; i += 1) {
        var flake = flakes[i];
        flake.y += flake.speed * dt;
        flake.x += (Math.sin(time * flake.drift + flake.phase) * flake.sway + 8 * (flake.depth + 1) * 0.35) * dt;
        if (flake.y - flake.r > view.h) {
          flake.y = -flake.r * 3;
          flake.x = Math.random() * view.w;
        }
        if (flake.x < -12) flake.x = view.w + 12;
        if (flake.x > view.w + 12) flake.x = -12;
      }
    }

    seed();
    window.addEventListener("resize", seed, { passive: true });

    if (reduceMotion) { paint(0, 0); return; }
    var last = performance.now();
    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt, now / 1000);
      paint(dt, now / 1000);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /** Блоки появляются при прокрутке, друг за другом внутри своего ряда. */
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

    nodes.forEach(function (node) { node.classList.add("reveal"); });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        var siblings = node.parentNode ? Array.prototype.slice.call(node.parentNode.children) : [];
        var index = siblings.indexOf(node);
        var delay = Math.min(220, Math.max(0, index) * 45);
        node.style.transitionDelay = delay + "ms";
        node.classList.add("in");
        observer.unobserve(node);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });

    nodes.forEach(function (node) { observer.observe(node); });
  }

  /**
   * Меню: бегунок под активным пунктом и подсветка раздела, который сейчас на
   * экране. Переходы по ссылкам — плавные (в CSS), бегунок едет за ними.
   */
  function navMotion() {
    var nav = document.getElementById("nav");
    if (!nav) return;
    var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
    if (!links.length) return;

    var mark = document.createElement("span");
    mark.className = "nav-mark";
    mark.setAttribute("aria-hidden", "true");
    nav.appendChild(mark);

    function moveTo(link) {
      if (!link || window.innerWidth <= 820) { mark.style.opacity = "0"; return; }
      var box = link.getBoundingClientRect();
      var base = nav.getBoundingClientRect();
      mark.style.opacity = "1";
      mark.style.width = box.width - 12 + "px";
      mark.style.transform = "translate(" + (box.left - base.left + 6) + "px," + (box.height - 4) + "px)";
    }

    var current = null;
    links.forEach(function (link) {
      link.addEventListener("pointerenter", function () { moveTo(link); });
      link.addEventListener("focus", function () { moveTo(link); });
    });
    nav.addEventListener("pointerleave", function () { moveTo(current); });

    var sections = links
      .map(function (link) {
        var id = link.getAttribute("href").slice(1);
        var section = id ? document.getElementById(id) : null;
        return section ? { link: link, section: section } : null;
      })
      .filter(Boolean);

    if ("IntersectionObserver" in window && sections.length) {
      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          sections.forEach(function (item) { item.link.classList.toggle("is-current", item.section === entry.target); });
          current = (sections.find(function (item) { return item.section === entry.target; }) || {}).link || current;
          moveTo(current);
        });
      }, { rootMargin: "-45% 0px -50% 0px" });
      sections.forEach(function (item) { spy.observe(item.section); });
    }
  }

  /**
   * Движение при прокрутке: шапка поджимается, первый экран чуть отстаёт,
   * блоки секций плавно смещаются. Без рывков — всё на transform.
   */
  function scrollMotion() {
    var header = document.querySelector(".hdr");
    var frames = Array.prototype.slice.call(document.querySelectorAll(".frame, .gal"));
    var queued = false;

    function apply() {
      queued = false;
      var y = window.scrollY || window.pageYOffset || 0;
      if (header) header.classList.toggle("is-stuck", y > 12);
      if (reduceMotion) return;
      // фон едет медленнее страницы — читаемость не страдает, движение видно
      fxState.scroll = y * 0.06;
      frames.forEach(function (frame) {
        var rect = frame.getBoundingClientRect();
        if (!rect.height) return;
        var shift = (rect.top + rect.height / 2 - window.innerHeight / 2) * -0.028;
        var offset = Math.max(-18, Math.min(18, shift)).toFixed(1);
        frame.style.transform = "translate3d(0," + offset + "px,0)";
      });
    }

    window.addEventListener("scroll", function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(apply);
    }, { passive: true });
    window.addEventListener("resize", apply, { passive: true });
    apply();
  }

  drawPlexus();
  drawGrid();
  drawSnow();
  revealBlocks();
  navMotion();
  scrollMotion();
})();
