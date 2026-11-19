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
  // Фон живёт всегда. Системная настройка «уменьшить движение» лишь делает его
  // спокойнее (реже кадры и меньше частиц), но не превращает в статичную картинку.
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
    speed: 1.6,
    cursorRadius: 220,
    strength: 55,
    lineOp: 0.34,
    cursor: "grab+attract",
    // связи «дышат» — как в пресете «Живой плексус»
    linkPulse: 70,
    linkPulseSpeed: 1.2,
    dotPulse: 60,
    // собственное течение: точки не замирают, даже когда курсор далеко
    swirl: 0.1,
    swirlSpeed: 0.28,
    maxSpeed: 4,
    dotAlpha: 0.75
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
    var cursorMode = String(PLEX.cursor || "");
    var cursorGrab = cursorMode.indexOf("grab") >= 0;
    var cursorAttract = cursorMode.indexOf("attract") >= 0;
    var cursorRepel = cursorMode.indexOf("repel") >= 0;

    function seed() {
      points = [];
      for (var i = 0; i < count; i += 1) {
        points.push({
          x: Math.random() * view.w,
          y: Math.random() * view.h,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          r: 1 + Math.random() * 2.2,
          phase: Math.random() * Math.PI * 2,
          phaseY: Math.random() * Math.PI * 2
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
          if (cursorAttract) {
            point.vx -= (dx / d) * force;
            point.vy -= (dy / d) * force;
          }
          if (cursorRepel) {
            point.vx += (dx / d) * force;
            point.vy += (dy / d) * force;
          }
        }
        // собственное течение: у каждой точки свой угол и своя фаза волны
        point.vx += Math.cos(time * PLEX.swirlSpeed + point.phase) * PLEX.swirl;
        point.vy += Math.sin(time * PLEX.swirlSpeed + point.phaseY) * PLEX.swirl;
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

      // линии от курсора к ближним точкам — режим «grab»
      if (cursorGrab && pointer.x > -999) {
        for (i = 0; i < points.length; i += 1) {
          var cx = points[i].x - pointer.x;
          var cy = points[i].y - pointer.y;
          var cd = Math.sqrt(cx * cx + cy * cy);
          if (cd < PLEX.cursorRadius) {
            ctx.strokeStyle = "rgba(255,255,255," + alphaStr((1 - cd / PLEX.cursorRadius) * 0.3) + ")";
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

    var started = performance.now();
    var lastPaint = 0;
    function frame(now) {
      // в «спокойном» режиме — 20 кадров в секунду вместо 60
      if (!reduceMotion || now - lastPaint > 50) {
        lastPaint = now;
        paint((now - started) / 1000);
      }
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
          // крупная снежинка — шесть лучей с веточками-галочками
          var arm = flake.r * 2.2;
          var spin = flake.phase + time * flake.spin;
          ctx.strokeStyle = "rgba(255,255,255," + alphaStr(flake.alpha) + ")";
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (var k = 0; k < 6; k += 1) {
            var a = spin + (k * Math.PI) / 3;
            var dx = Math.cos(a);
            var dy = Math.sin(a);
            ctx.moveTo(flake.x, flake.y);
            ctx.lineTo(flake.x + dx * arm, flake.y + dy * arm);
            [0.5, 0.78].forEach(function (t) {
              var bx = flake.x + dx * arm * t;
              var by = flake.y + dy * arm * t;
              var bl = arm * 0.34 * (1.15 - t);
              var spread = 0.62;
              ctx.moveTo(bx, by);
              ctx.lineTo(bx + Math.cos(a - spread) * bl, by + Math.sin(a - spread) * bl);
              ctx.moveTo(bx, by);
              ctx.lineTo(bx + Math.cos(a + spread) * bl, by + Math.sin(a + spread) * bl);
            });
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

  /**
   * Фигуры: падающие лепестки, крестики, ромбы, треугольники и кольца.
   * Два слоя глубины — дальние мелкие и медленные, ближние крупнее.
   * Лепестки падают с покачиванием, остальные медленно дрейфуют и крутятся.
   * Всё белым по чёрному, без градиентов — как остальной фон.
   */
  function drawShapes() {
    var view = setupCanvas("fx-shapes");
    if (!view) return;
    var ctx = view.ctx;
    var narrow = window.innerWidth < 760;
    var KINDS = ["petal", "cross", "diamond", "triangle", "ring"];
    var LAYERS = narrow
      ? [{ count: 14, s: [2.5, 4.5], speed: [10, 22], alpha: 0.3 }, { count: 10, s: [4.5, 7.5], speed: [22, 40], alpha: 0.5 }]
      : [{ count: 26, s: [2.5, 5], speed: [12, 26], alpha: 0.32 }, { count: 18, s: [5, 8.5], speed: [26, 48], alpha: 0.52 }];
    var parts = [];

    function seed() {
      parts = [];
      LAYERS.forEach(function (layer, depth) {
        for (var i = 0; i < layer.count; i += 1) {
          parts.push({
            kind: KINDS[Math.floor(Math.random() * KINDS.length)],
            depth: depth,
            x: Math.random() * view.w,
            y: Math.random() * view.h,
            s: layer.s[0] + Math.random() * (layer.s[1] - layer.s[0]),
            speed: layer.speed[0] + Math.random() * (layer.speed[1] - layer.speed[0]),
            drift: 0.15 + Math.random() * 0.5,
            sway: 8 + Math.random() * 20,
            phase: Math.random() * Math.PI * 2,
            spin: (Math.random() - 0.5) * 1.1,
            alpha: layer.alpha * (0.7 + Math.random() * 0.6)
          });
        }
      });
    }

    function paint(time) {
      ctx.clearRect(0, 0, view.w, view.h);
      for (var i = 0; i < parts.length; i += 1) {
        var p = parts[i];
        var rot = p.phase + time * p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rot);
        var color = "rgba(255,255,255," + alphaStr(p.alpha) + ")";
        if (p.kind === "petal") {
          // лепесток — заострённый овал
          ctx.beginPath();
          ctx.moveTo(0, -p.s);
          ctx.quadraticCurveTo(p.s * 0.95, -p.s * 0.15, 0, p.s);
          ctx.quadraticCurveTo(-p.s * 0.95, -p.s * 0.15, 0, -p.s);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        } else if (p.kind === "cross") {
          ctx.beginPath();
          ctx.moveTo(-p.s, 0);
          ctx.lineTo(p.s, 0);
          ctx.moveTo(0, -p.s);
          ctx.lineTo(0, p.s);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (p.kind === "diamond") {
          ctx.beginPath();
          ctx.moveTo(0, -p.s);
          ctx.lineTo(p.s * 0.72, 0);
          ctx.lineTo(0, p.s);
          ctx.lineTo(-p.s * 0.72, 0);
          ctx.closePath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (p.kind === "triangle") {
          ctx.beginPath();
          for (var k = 0; k < 3; k += 1) {
            var a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
            var px = Math.cos(a) * p.s;
            var py = Math.sin(a) * p.s;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.s * 0.8, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    function step(dt, time) {
      for (var i = 0; i < parts.length; i += 1) {
        var p = parts[i];
        p.y += p.speed * dt;
        p.x += (Math.sin(time * p.drift + p.phase) * p.sway + 6 * (p.depth + 1) * 0.3) * dt;
        if (p.y - p.s > view.h) {
          p.y = -p.s * 3;
          p.x = Math.random() * view.w;
        }
        if (p.x < -16) p.x = view.w + 16;
        if (p.x > view.w + 16) p.x = -16;
      }
    }

    seed();
    window.addEventListener("resize", seed, { passive: true });

    var last = performance.now();
    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt, now / 1000);
      paint(now / 1000);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /** Блоки появляются при прокрутке, друг за другом внутри своего ряда. */
  /**
   * Появление интерфейса: окна раскрываются сверху вниз, ячейки встают
   * волной по диагонали, текст проявляется слева направо, как набор в консоли.
   * Базовые классы ставятся сразу (элемент спрятан), а `.in` — когда он
   * доходит до экрана; поэтому переход всегда проигрывается, а без скриптов
   * страница просто видна целиком.
   */
  function motionReveal() {
    var WINDOWS = ".frame, .gal";
    var CELLS = ".card, .dl-card, .step, .note, .rel, .day, .search, .faq details";
    var TEXTS = [
      ".lead", ".kicker", ".sec-head h2", ".sec-head p", ".list li", ".code",
      ".faq summary", ".faq p", ".card h3", ".card p", ".step h3", ".step p",
      ".dl-card h3", ".dl-card p", ".note p", ".day h3"
    ].join(",");
    var FADES = ".eyebrow, .cta, .meta-row, .tag";

    function list(selector) {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    }

    var queue = [];
    var byNode = new Map();

    function push(node, cls, delay) {
      if (byNode.has(node)) { byNode.get(node).delay = delay; return; }
      var item = { node: node, cls: cls, delay: delay };
      queue.push(item);
      byNode.set(node, item);
      node.classList.add(cls);
      node.dataset.revealDelay = delay;
    }

    /** насколько поздно элемент встаёт в своей сетке: волна по диагонали */
    function wave(node, stepRow, stepCol, cap) {
      var parent = node.parentNode;
      if (!parent) return 0;
      var tops = [];
      var lefts = [];
      Array.prototype.slice.call(parent.children).forEach(function (item) {
        var t = Math.round(item.offsetTop);
        var l = Math.round(item.offsetLeft);
        if (tops.indexOf(t) < 0) tops.push(t);
        if (lefts.indexOf(l) < 0) lefts.push(l);
      });
      tops.sort(function (a, b) { return a - b; });
      lefts.sort(function (a, b) { return a - b; });
      var row = tops.indexOf(Math.round(node.offsetTop));
      var col = lefts.indexOf(Math.round(node.offsetLeft));
      return Math.min(cap, Math.max(0, row) * stepRow + Math.max(0, col) * stepCol);
    }

    /** текст ждёт свою карточку/окно: сначала встаёт коробка, потом строка */
    function parentDelay(node) {
      var box = node.parentNode;
      while (box && box !== document.body) {
        if (byNode.has(box)) return byNode.get(box).delay + 120;
        box = box.parentNode;
      }
      return 0;
    }

    list(WINDOWS).forEach(function (node) { push(node, "rv-win", wave(node, 70, 90, 460)); });
    list(CELLS).forEach(function (node) { push(node, "rv-cell", wave(node, 45, 65, 520)); });
    list(TEXTS).forEach(function (node) {
      var delay = parentDelay(node);
      if (!delay && node.parentNode) {
        // заголовок раздела: надзаголовок → h2 → пояснение идут лесенкой,
        // даже если их общая коробка не анимируется
        var sibs = Array.prototype.slice.call(node.parentNode.children).filter(function (item) {
          return item.matches && item.matches(TEXTS);
        });
        delay = Math.max(0, sibs.indexOf(node)) * 70;
      }
      push(node, "rv-text", delay);
    });
    list(FADES).forEach(function (node) { push(node, "rv-fade", parentDelay(node)); });

    /* первый экран: своя очередь, чтобы появление читалось как вступление */
    var hero = document.querySelector(".hero");
    if (hero) {
      [[".eyebrow", 40], [".lead", 470], [".cta", 620], [".meta-row", 710], [".frame", 790]]
        .forEach(function (pair) {
          var node = hero.querySelector(pair[0]);
          if (node) push(node, byNode.has(node) ? byNode.get(node).cls : "rv-fade", pair[1]);
        });
    }

    // классы расставлены — показываем main; спрятанное состояние уже посчитано
    document.documentElement.classList.remove("js-boot");

    if (!queue.length) return;

    function show(item) {
      item.node.style.setProperty("--d", item.delay + "ms");
      item.node.style.willChange = "opacity, transform";
      item.node.classList.add("in");
      window.setTimeout(function () { item.node.style.willChange = ""; }, item.delay + 1600);
    }

    /* Следим за коробкой-родителем, а не за самим элементом: так появление
       запускается синхронно для всей группы (ячейка и её текст), даже если сам
       элемент сейчас прозрачный. */
    function anchorOf(item) {
      var node = item.node;
      while (node) {
        var clipped = node.classList.contains("rv-win") || node.classList.contains("rv-text");
        if (!clipped) return node;
        node = node.parentElement;
      }
      return item.node;
    }

    if (!("IntersectionObserver" in window)) {
      queue.forEach(show);
    } else {
      var groups = new Map();
      queue.forEach(function (item) {
        var anchor = anchorOf(item);
        if (!groups.has(anchor)) groups.set(anchor, []);
        groups.get(anchor).push(item);
      });

      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          (groups.get(entry.target) || []).forEach(show);
        });
      }, { rootMargin: "0px 0px -6% 0px", threshold: 0.02 });

      groups.forEach(function (items, anchor) { observer.observe(anchor); });
    }

    /* заголовок первого экрана — по словам */
    var title = document.querySelector("h1");
    if (!title || title.querySelector(".w")) return;

    var words = [];
    Array.prototype.slice.call(title.childNodes).forEach(function (part) {
      if (part.nodeType !== 3) return;
      var frag = document.createDocumentFragment();
      part.textContent.split(/(\s+)/).forEach(function (chunk) {
        if (!chunk) return;
        if (/^\s+$/.test(chunk)) { frag.appendChild(document.createTextNode(chunk)); return; }
        var span = document.createElement("span");
        span.className = "w";
        span.textContent = chunk;
        frag.appendChild(span);
        words.push(span);
      });
      title.replaceChild(frag, part);
    });

    words.forEach(function (word, index) {
      word.style.setProperty("--d", 130 + index * 60 + "ms");
    });

    function showTitle() {
      words.forEach(function (word) { word.classList.add("in"); });
    }

    if (!("IntersectionObserver" in window)) { showTitle(); return; }
    var titleObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        titleObserver.disconnect();
        showTitle();
      });
    }, { threshold: 0.02 });
    titleObserver.observe(title);
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
  drawShapes();
  motionReveal();
  navMotion();
  scrollMotion();
})();
