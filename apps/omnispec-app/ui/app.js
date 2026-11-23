/* OmniSpec — клиентская часть.
 * Работает в двух режимах:
 *   1) внутри Tauri (window.__TAURI__) — настоящие вызовы ядра на Rust;
 *   2) в обычном браузере — демо-данные, чтобы можно было смотреть интерфейс.
 */
(() => {
  "use strict";

  const TAURI = window.__TAURI__;
  const IS_APP = Boolean(TAURI);
  const invoke = IS_APP ? TAURI.core.invoke : null;
  const I18N = window.OmniI18n;


  /* ==================== ОФОРМЛЕНИЕ (движок тем из OmniPanel) ====================
   * Пресеты повторяют палитру OmniPanel (ui/app.js → THEMES). Из четырёх цветов
   * (фон / панель / текст / акцент) выводятся все переменные интерфейса, поэтому
   * тема перекрашивает сайдбар, шапку, вкладки, модалки и консоль целиком.
   */
  const THEMES = {
    dark:     { label: "Тёмная",   bg: "#070708", panel: "#141417", text: "#ececee", accent: "#ffffff" },
    graphite: { label: "Графит",   bg: "#0f0f10", panel: "#19191b", text: "#ededed", accent: "#c9c9cf" },
    contrast: { label: "Контраст", bg: "#000000", panel: "#131313", text: "#ffffff", accent: "#ffffff" },
    gray:     { label: "Серая",    bg: "#22262b", panel: "#31373e", text: "#dfe3e8", accent: "#ffffff" },
    navy:     { label: "Ночь",     bg: "#0a0d14", panel: "#121722", text: "#e6ebf5", accent: "#6ea8fe" },
    ocean:    { label: "Океан",    bg: "#08100f", panel: "#111c1b", text: "#e3f1ef", accent: "#4fc3b5" },
    forest:   { label: "Лес",      bg: "#0b110d", panel: "#131b15", text: "#e6efe8", accent: "#63c98a" },
    amethyst: { label: "Аметист",  bg: "#0d0a14", panel: "#171225", text: "#ece9f6", accent: "#a78bfa" },
    sunset:   { label: "Закат",    bg: "#120c10", panel: "#1d1419", text: "#f4e9ee", accent: "#f08a6c" },
    ember:    { label: "Уголь",    bg: "#0d0c0a", panel: "#171614", text: "#f0efe9", accent: "#d9a13b" },
    steel:    { label: "Сталь",    bg: "#0c1013", panel: "#151b20", text: "#e4edf2", accent: "#8fb8cc" },
    light:    { label: "Светлая",  bg: "#f4f5f7", panel: "#ffffff", text: "#1a1c20", accent: "#111111" },
    paper:    { label: "Бумага",   bg: "#f6f4ef", panel: "#ffffff", text: "#1b1a17", accent: "#111111" },
    snow:     { label: "Снег",     bg: "#eef2f7", panel: "#ffffff", text: "#141a22", accent: "#1f6feb" },
    mint:     { label: "Мята",     bg: "#eef5f1", panel: "#ffffff", text: "#12211a", accent: "#12855b" },
    sand:     { label: "Песок",    bg: "#f5f1e8", panel: "#fffdf8", text: "#211d16", accent: "#a9743a" }
  };
  /* Своя тема («кастом»): пользователь задаёт три цвета, остальные поверхности
   * движок выводит сам — ровно как для пресетов. */
  const CUSTOM_THEME_DEFAULT = { bg: "#0b0d12", accent: "#7aa2f7", text: "#e6e9ef" };
  const FX_STYLES = { wave: "Волна", dot: "Точка", ring: "Кольцо", cross: "Крест", off: "Выкл" };

  /** Фоновая анимация: звёздочки, пыль, палочки, снег. */
  const AMBIENT_STYLES = { stars: "Звёзды", dust: "Пыль", sticks: "Палочки", snow: "Снег", flakes: "Снежинки", leaves: "Листья", petals: "Лепестки", butterflies: "Бабочки", hearts: "Сердечки", off: "Выкл" };

  function rgbOf(hex) {
    const clean = String(hex || "#000").replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
  }
  function rgbaOf(hex, alpha) {
    const [r, g, b] = rgbOf(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  function toHex(values) {
    return "#" + values.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  }
  /** Смешать два цвета: t=0 → a, t=1 → b. */
  function mix(a, b, t) {
    const ca = rgbOf(a), cb = rgbOf(b);
    return toHex(ca.map((v, i) => v + (cb[i] - v) * t));
  }
  /** Насколько цвет светлый (0..1) — чтобы понять, тёмная тема или светлая. */
  function luminance(hex) {
    const [r, g, b] = rgbOf(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Поставить тему: все переменные выводятся из пресета.
   *  Градиентов нет — только плоские поверхности; поверхности строятся
   *  шагами от --bg к --bg-5, чтобы «толщина» панелей была одинаковой
   *  во всех темах. */
  /** Тема по id: пресет из THEMES или собранный вручную «кастом». */
  function themeOf(name) {
    if (name === "custom") {
      const own = state.customTheme || {};
      return {
        label: "Кастом",
        bg: own.bg || CUSTOM_THEME_DEFAULT.bg,
        accent: own.accent || CUSTOM_THEME_DEFAULT.accent,
        text: own.text || CUSTOM_THEME_DEFAULT.text
      };
    }
    return THEMES[name] || THEMES.dark;
  }

  /** Сюда движок частиц кладёт пересчёт цвета (тема меняется раньше его создания). */
  let ambientInkRefresh = null;

  /** Последние применённые переменные темы — чтобы не писать одно и то же. */
  let lastThemeVars = null;

  /** Живое обновление во время перетаскивания в пикере/ползунке:
   *  полный пересчёт стилей приложения стоит ~30 мс, поэтому не чаще
   *  раза в 40 мс (~25 fps) — превью всё равно плавное, а пролагов нет. */
  function liveThrottle(fn) {
    let queued = false;
    let last = 0;
    const run = () => {
      queued = false;
      const now = performance.now();
      if (now - last < 40) {
        queued = true;
        requestAnimationFrame(run);
        return;
      }
      last = now;
      fn();
    };
    return () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(run);
      }
    };
  }

  /** live=true — живое обновление во время перетаскивания в пикере:
   *  без перерисовки слоя и перечитывания чернил частиц (getComputedStyle
   *  на каждый тик — главный источник лагов). */
  function applyTheme(name, live) {
    const theme = themeOf(name);
    const dark = luminance(theme.bg) < 0.4;
    const step = dark ? theme.text : "#000000";
    const vars = {
      "--bg": theme.bg,
      "--bg-2": mix(theme.bg, step, dark ? 0.035 : 0.03),
      "--bg-3": mix(theme.bg, step, dark ? 0.07 : 0.055),
      "--bg-4": mix(theme.bg, step, dark ? 0.11 : 0.085),
      "--bg-5": mix(theme.bg, step, dark ? 0.16 : 0.12),
      "--line": mix(theme.bg, step, dark ? 0.13 : 0.12),
      "--line-2": mix(theme.bg, step, dark ? 0.22 : 0.2),
      "--line-3": mix(theme.bg, step, dark ? 0.32 : 0.3),
      "--text": theme.text,
      "--dim": mix(theme.text, theme.bg, 0.42),
      "--dim-2": mix(theme.text, theme.bg, 0.58),
      "--accent": theme.accent,
      "--accent-2": mix(theme.accent, dark ? "#ffffff" : "#000000", 0.14),
      "--accent-fg": luminance(theme.accent) > 0.55 ? "#0a0a0c" : "#ffffff",
      "--accent-soft": dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.05)",
      "--green": dark ? "#7ee787" : "#157347",
      "--red": dark ? "#ff7b72" : "#b42318",
      "--yellow": dark ? "#e3b341" : "#a2680e",
      "--blue": dark ? "#79c0ff" : "#0a58ca",
      // Фирменные цвета источников остаются различимыми и на светлой теме.
      "--catalog-modrinth": dark ? "#1bd96a" : "#087b42",
      "--catalog-curseforge": dark ? "#ff805a" : "#bf3f19",
      "--console-bg": mix(theme.bg, dark ? "#000000" : step, dark ? 0.45 : 0.02)
    };
    // старые имена — просто перекрываем теми же значениями
    Object.assign(vars, {
      "--bg-elev": vars["--bg-2"],
      "--panel": vars["--bg-2"],
      "--panel-2": vars["--bg-3"],
      "--panel-3": vars["--bg-4"],
      "--border": vars["--line"],
      "--border-soft": vars["--line"],
      "--border-strong": vars["--line-2"],
      "--hover": vars["--line-3"],
      "--text-dim": vars["--dim"],
      "--muted": vars["--dim-2"]
    });
    // полупрозрачные поверхности — нужны, когда включены обои
    vars["--bg-1a"] = rgbaOf(vars["--bg-2"], 0.9);
    vars["--bg-2a"] = rgbaOf(vars["--bg-2"], 0.78);
    vars["--bg-3a"] = rgbaOf(vars["--bg-3"], 0.82);
    // Пишем только изменившиеся переменные и только на :root (все переменные
    // объявлены там же, --modal-solid считается от них же): лишние записи
    // дёргают пересчёт стилей всего приложения, а это ~30 мс на каждый тик пикера.
    for (const [key, value] of Object.entries(vars)) {
      if (lastThemeVars && lastThemeVars[key] === value) continue;
      document.documentElement.style.setProperty(key, value);
    }
    lastThemeVars = vars;
    const valid = name === "custom" || Boolean(THEMES[name]);
    document.body.dataset.theme = valid ? name : "dark";
    // подложка поверх обоев по умолчанию берёт цвет темы
    applyThemeTint();
    if (!live) {
      forceRepaint();
      // частицы фона подстраиваются под тему: тёмные на светлой, светлые на тёмной
      if (ambientInkRefresh) ambientInkRefresh();
      trailFx.refreshInk();
    }
    return valid ? name : "dark";
  }

  /* ==================== ОБОИ (фоны из OmniPanel) ==================== */
  const WALLS = [
    ["aurora", "Аврора"], ["waves", "Волны"], ["mountains", "Горы"], ["blobs", "Пятна"],
    ["stripes", "Полосы"], ["grid", "Сетка"], ["dots", "Точки"], ["noise", "Шум"]
  ];

  /* Форма элементов — как «ФОРМА ЭЛЕМЕНТОВ» в OmniPanel. */
  const SHAPES = [
    ["square", "Квадратные"],
    ["soft", "Мягкие"],
    ["rounded", "Закруглённые"],
    ["pill", "Таблетки"]
  ];

  const UI_SCALES = [80, 90, 100, 110, 125, 150];

  // Только встроенные картинки: выбранный id нельзя превратить в путь к файлу.
  const LAUNCHER_ICONS = [
    ["default", "Оригинал", "assets/logo.png"],
    ["ru", "Россия", "assets/launcher-icons/ru.png"],
    ["by", "Беларусь", "assets/launcher-icons/by.png"],
    ["kz", "Қазақстан", "assets/launcher-icons/kz.png"],
    ["ua", "Україна", "assets/launcher-icons/ua.png"],
    ["us", "USA", "assets/launcher-icons/us.png"],
    ["icon_star_boom", "Звездный взрыв", "assets/launcher-icons/icon_star_boom.png"],
    ["icon_star_eye", "Звезда", "assets/launcher-icons/icon_star_eye.png"]
  ];

  const INITIAL_TABS = [
    ["console", "Консоль", "i-terminal"], ["errors", "Ошибки", "i-alert"],
    ["files", "Файлы", "i-folder"], ["mods", "Моды", "i-mod"],
    ["resourcepacks", "Ресурспаки", "i-cube"], ["shaders", "Шейдеры", "i-star"],
    ["worlds", "Миры", "i-globe"], ["screenshots", "Скриншоты", "i-image"],
    ["download", "Загрузить", "i-download"], ["settings", "Сборка", "i-sliders"]
  ];

  /** Трейс при первом запуске: искры, тонкие, короткий хвост, почти прозрачные. */
  const TRAIL_DEFAULTS = { style: "sparks", size: 50, length: 20, opacity: 15 };

  /** Масштаб интерфейса как «размер интерфейса» в Minecraft / zoom в Discord. */
  function applyUiScale(value) {
    const scale = Math.min(150, Math.max(70, Number(value) || 100));
    state.uiScale = scale;
    const body = document.body;
    if (scale === 100) {
      body.style.zoom = "";
      body.style.width = "";
      body.style.height = "";
    } else {
      const factor = scale / 100;
      body.style.zoom = String(factor);
      // zoom не пересчитывает vh/vw — компенсируем, чтобы окно осталось ровно по размеру
      body.style.width = `calc(100vw / ${factor})`;
      body.style.height = `calc(100vh / ${factor})`;
    }
    document.documentElement.dataset.uiScale = String(scale);
    document.documentElement.style.setProperty("--ui-zoom", String(scale / 100));
    // Canvas и ограниченные экраном меню/окна должны узнать о новом масштабе.
    window.dispatchEvent(new Event("resize"));
    return scale;
  }

  /** Масштаб интерфейса: body { zoom }, поэтому координаты мыши надо приводить к нему. */
  function uiZoom() {
    const factor = (Number(state.uiScale) || 100) / 100;
    return factor > 0 ? factor : 1;
  }

  function applyShape(name) {
    const known = SHAPES.some(([id]) => id === name);
    state.shape = known ? name : "soft";
    document.body.dataset.shape = state.shape;
    return state.shape;
  }

  /** Звуки привязаны к реальным действиям интерфейса, в том числе к клавиатуре. */
  const SOUND_EVENTS = [
    ["click", "Нажатие кнопки"], ["toggle", "Переключатель"], ["tab", "Смена вкладки"],
    ["open", "Открытие окна"], ["close", "Закрытие окна"],
    ["success", "Успешное действие"], ["error", "Ошибка"]
  ];
  const SOUND_STYLES = {
    soft: "Мягкий",
    classic: "Классический",
    glass: "Стекло",
    wood: "Дерево",
    deep: "Глубокий",
    pixel: "Пиксель",
    bell: "Колокольчик",
    bubble: "Пузырёк",
    pluck: "Щипок",
    custom: "Кастом"
  };

  /* Короткие звуки интерфейса на WebAudio — без файлов и зависимостей. */
  const sfx = (() => {
    let ctx = null;

    // параметры под каждый стиль: частота, уход частоты, длина, громкость, форма волны
    const TONES = {
      soft: {
        click: { freq: 480, to: 420, dur: 0.1, gain: 0.028, type: "sine" },
        toggle: { freq: 620, to: 560, dur: 0.11, gain: 0.026, type: "sine" },
        open: { freq: 540, to: 660, dur: 0.13, gain: 0.024, type: "sine" },
        success: { freq: 520, to: 780, dur: 0.16, gain: 0.028, type: "sine" },
        error: { freq: 300, to: 220, dur: 0.18, gain: 0.034, type: "sine" }
      },
      classic: {
        click: { freq: 520, to: 520, dur: 0.045, gain: 0.05, type: "triangle" },
        toggle: { freq: 760, to: 700, dur: 0.05, gain: 0.045, type: "sine" },
        open: { freq: 640, to: 640, dur: 0.06, gain: 0.04, type: "sine" },
        success: { freq: 680, to: 900, dur: 0.09, gain: 0.045, type: "sine" },
        error: { freq: 240, to: 200, dur: 0.12, gain: 0.06, type: "sawtooth" }
      },
      glass: {
        click: { freq: 1180, to: 1320, dur: 0.07, gain: 0.022, type: "sine" },
        toggle: { freq: 1480, to: 1240, dur: 0.08, gain: 0.02, type: "sine" },
        open: { freq: 900, to: 1180, dur: 0.1, gain: 0.02, type: "sine" },
        success: { freq: 1040, to: 1560, dur: 0.14, gain: 0.022, type: "sine" },
        error: { freq: 420, to: 320, dur: 0.14, gain: 0.028, type: "triangle" }
      },
      wood: {
        click: { freq: 190, to: 150, dur: 0.06, gain: 0.05, type: "triangle" },
        toggle: { freq: 240, to: 190, dur: 0.07, gain: 0.045, type: "triangle" },
        open: { freq: 300, to: 240, dur: 0.08, gain: 0.04, type: "triangle" },
        success: { freq: 260, to: 380, dur: 0.12, gain: 0.045, type: "triangle" },
        error: { freq: 140, to: 110, dur: 0.16, gain: 0.05, type: "sawtooth" }
      },
      deep: {
        click: { freq: 140, to: 120, dur: 0.12, gain: 0.05, type: "sine" },
        toggle: { freq: 180, to: 150, dur: 0.13, gain: 0.045, type: "sine" },
        open: { freq: 220, to: 180, dur: 0.16, gain: 0.04, type: "sine" },
        success: { freq: 200, to: 300, dur: 0.2, gain: 0.045, type: "sine" },
        error: { freq: 110, to: 80, dur: 0.22, gain: 0.05, type: "triangle" }
      },
      pixel: {
        click: { freq: 640, to: 430, dur: .045, gain: .018, type: "square" },
        toggle: { freq: 760, to: 880, dur: .065, gain: .016, type: "square" },
        open: { freq: 420, to: 760, dur: .1, gain: .016, type: "square" },
        success: { freq: 620, to: 1100, dur: .14, gain: .017, type: "square" },
        error: { freq: 300, to: 140, dur: .16, gain: .018, type: "square" }
      },
      bell: {
        click: { freq: 890, to: 880, dur: .18, gain: .018, type: "sine" },
        toggle: { freq: 1100, to: 1060, dur: .2, gain: .016, type: "sine" },
        open: { freq: 780, to: 1100, dur: .2, gain: .016, type: "sine" },
        success: { freq: 950, to: 1420, dur: .24, gain: .018, type: "sine" },
        error: { freq: 460, to: 320, dur: .22, gain: .02, type: "triangle" }
      },
      bubble: {
        click: { freq: 400, to: 680, dur: .075, gain: .028, type: "sine" },
        toggle: { freq: 560, to: 820, dur: .085, gain: .025, type: "sine" },
        open: { freq: 360, to: 720, dur: .13, gain: .024, type: "sine" },
        success: { freq: 500, to: 1000, dur: .16, gain: .026, type: "sine" },
        error: { freq: 380, to: 180, dur: .16, gain: .03, type: "sine" }
      },
      pluck: {
        click: { freq: 330, to: 300, dur: .07, gain: .03, type: "triangle" },
        toggle: { freq: 440, to: 410, dur: .08, gain: .028, type: "triangle" },
        open: { freq: 410, to: 520, dur: .12, gain: .026, type: "triangle" },
        success: { freq: 520, to: 780, dur: .16, gain: .028, type: "triangle" },
        error: { freq: 220, to: 170, dur: .16, gain: .03, type: "triangle" }
      }
    };
    for (const preset of Object.values(TONES)) {
      preset.tab = { ...preset.toggle, freq: Math.round(preset.toggle.freq * .92) };
      preset.close = { ...preset.open, freq: preset.open.to, to: preset.open.freq };
    }
    const buffers = new Map();

    function ensure() {
      if (!state.sound || !state.sound.on) return null;
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        try { ctx = new Ctor(); } catch (_) { return null; }
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }

    function style() {
      const id = (state.sound && state.sound.style) || "soft";
      return id === "custom" || TONES[id] ? id : "soft";
    }
    const percent = (value, fallback) => Math.max(0, Math.min(200, Number.isFinite(Number(value)) ? Number(value) : fallback)) / 100;

    function customBuffer(audio, name, file) {
      const key = `${name}:${file}`;
      if (!buffers.has(key)) {
        // Старые копии звуков не держим в памяти после замены для этого события.
        for (const cached of buffers.keys()) if (cached.startsWith(`${name}:`) && cached !== key) buffers.delete(cached);
        const loading = api.customSoundData(name).then(async (url) => {
          if (!url || !url.startsWith("data:audio/") || !url.includes(",")) throw new Error("звуковой файл недоступен");
          const raw = atob(url.slice(url.indexOf(",") + 1));
          const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
          return audio.decodeAudioData(bytes.buffer);
        }).catch((error) => { buffers.delete(key); throw error; });
        buffers.set(key, loading);
      }
      return buffers.get(key);
    }

    /** Мягкий тон либо копия назначенного файла с общей и индивидуальной громкостью. */
    function play(name) {
      const audio = ensure();
      if (!audio) return;
      const volume = percent(state.sound.volume, 60);
      if (volume <= 0) return;
      if (style() === "custom") {
        const file = state.sound.custom?.[name]?.file;
        if (!file) return;
        customBuffer(audio, name, file).then((buffer) => {
          if (!state.sound.on || style() !== "custom" || state.sound.custom?.[name]?.file !== file) return;
          const source = audio.createBufferSource();
          const amp = audio.createGain();
          source.buffer = buffer;
          amp.gain.value = percent(state.sound.volume, 60) * percent(state.sound.custom?.[name]?.volume ?? 100, 100);
          source.connect(amp).connect(audio.destination);
          source.start();
        }).catch((error) => console.warn("Custom sound:", error));
        return;
      }
      const preset = TONES[style()][name] || TONES[style()].click;
      const now = audio.currentTime;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = preset.type;
      osc.frequency.setValueAtTime(preset.freq, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, preset.to), now + preset.dur);
      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, preset.gain * volume), now + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + preset.dur);
      osc.connect(amp).connect(audio.destination);
      osc.start(now);
      osc.stop(now + preset.dur + 0.02);
    }

    return {
      play,
      click: () => play("click"),
      toggle: () => play("toggle"),
      tab: () => play("tab"),
      open: () => play("open"),
      close: () => play("close"),
      success: () => play("success"),
      error: () => play("error"),
      prepare: (name) => {
        const audio = ensure(), file = state.sound.custom?.[name]?.file;
        return audio && file ? customBuffer(audio, name, file) : Promise.resolve(null);
      },
      demo: async () => {
        for (const [name] of SOUND_EVENTS) {
          play(name);
          await new Promise((resolve) => setTimeout(resolve, 260));
        }
      }
    };
  })();

  let pendingClickSound = 0;
  function semanticSound(name) {
    if (pendingClickSound) { clearTimeout(pendingClickSound); pendingClickSound = 0; }
    sfx.play(name);
  }
  function initSoundEvents() {
    document.addEventListener("click", (event) => {
      const control = event.target.closest?.("button, input[type=checkbox], .instance, .theme-chip, .wall-chip");
      if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return;
      if (control.matches("#set-sound, #sound-test, [data-sound-preview]")) return;
      if (control.matches(".switch, input[type=checkbox]")) { semanticSound("toggle"); return; }
      if (control.matches(".tab, .prefs-tab, .mtab, [data-dv-type], [data-dv-view], [data-dl-view]")) { semanticSound("tab"); return; }
      // Открытие/закрытие модального окна и мгновенное уведомление заменяют обычный клик.
      if (pendingClickSound) clearTimeout(pendingClickSound);
      pendingClickSound = setTimeout(() => { pendingClickSound = 0; sfx.click(); }, 35);
    }, true);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const modal = record.target;
        if (!modal.matches?.(".modal-backdrop") || (record.oldValue !== null) === modal.hidden) continue;
        semanticSound(modal.hidden ? "close" : "open");
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
  }

  /** Фоновые частицы на канвасе: без картинок и без градиентов. */
  const ambient = (() => {
    const canvas = () => $("#ambient");
    let ctx = null;
    let width = 0;
    let height = 0;
    let style = "stars";
    let ink = "#e8e8ee";
    // размер эффектов: настройка в процентах, влияет на все частицы
    let scale = 1;
    // плотность: сколько частиц на экране (0.3–2)
    let density = 1;
    // свой цвет частиц (null — как в теме) и прозрачность слоя
    let colorOverride = null;
    let layerOpacity = 0.8;
    let particles = [];
    let raf = 0;
    let last = 0;

    const rand = (min, max) => min + Math.random() * (max - min);

    function resize() {
      const el = canvas();
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // у канваса внутри body с масштабом интерфейса ширина в CSS-пикселях
      width = Math.max(1, Math.round(el.clientWidth || rect.width));
      height = Math.max(1, Math.round(el.clientHeight || rect.height));
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * uiZoom());
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx = el.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // цвет частиц: свой, если выбран, иначе из темы
      const textColor = getComputedStyle(document.body).getPropertyValue("--text").trim();
      ink = colorOverride || textColor || "#e8e8ee";
      el.style.opacity = String(layerOpacity);
    }

    function count() {
      const area = width * height;
      const mul = (value) => Math.max(4, Math.round(value * density));
      if (style === "flakes") return mul(Math.max(24, Math.min(110, Math.round(area / 19000))));
      if (style === "snow") return mul(Math.max(30, Math.min(140, Math.round(area / 15000))));
      if (style === "dust") return mul(Math.max(40, Math.min(180, Math.round(area / 11000))));
      if (style === "sticks") return mul(Math.max(16, Math.min(70, Math.round(area / 26000))));
      if (style === "leaves" || style === "petals") return mul(Math.max(20, Math.min(90, Math.round(area / 21000))));
      if (style === "hearts") return mul(Math.max(12, Math.min(50, Math.round(area / 32000))));
      if (style === "butterflies") return mul(Math.max(6, Math.min(26, Math.round(area / 52000))));
      return mul(Math.max(34, Math.min(170, Math.round(area / 12000))));
    }

    function spawn(anywhere = true) {
      const y = anywhere ? rand(0, height) : -rand(4, 40);
      const base = { x: rand(0, width), y, alpha: rand(0.25, 0.8), phase: rand(0, Math.PI * 2) };
      if (style === "flakes") {
        // снежинка: шесть лучей с «сучками», медленно кружится и падает
        return { ...base, r: rand(3.2, 7.5) * scale, vy: rand(9, 24), drift: rand(-9, 9), spin: rand(-0.9, 0.9), rot: rand(0, Math.PI), sway: rand(0.3, 1.1), kind: "flake" };
      }
      if (style === "dust") {
        return { ...base, y: anywhere ? rand(0, height) : height + rand(2, 30), r: rand(0.6, 1.7) * scale, vy: -rand(6, 22), drift: rand(-6, 6), kind: "dot" };
      }
      if (style === "sticks") {
        return { ...base, r: rand(0.6, 1.1) * scale, h: rand(7, 16) * scale, vy: rand(14, 34), spin: rand(-1.4, 1.4), rot: rand(0, Math.PI), drift: rand(-8, 8), kind: "stick" };
      }
      if (style === "snow") {
        return { ...base, r: rand(0.9, 2.3) * scale, vy: rand(7, 20), drift: rand(-10, 10), sway: rand(0.4, 1.4), kind: "dot" };
      }
      if (style === "leaves") {
        // лист: падает, качается и крутится
        return { ...base, s: rand(4, 8) * scale, vy: rand(12, 30), drift: rand(-8, 8), spin: rand(-1.2, 1.2), rot: rand(0, Math.PI), sway: rand(0.5, 1.3), kind: "leaf" };
      }
      if (style === "petals") {
        // лепесток: круглее листа, без черенка
        return { ...base, s: rand(3.5, 7) * scale, vy: rand(10, 26), drift: rand(-8, 8), spin: rand(-1, 1), rot: rand(0, Math.PI), sway: rand(0.5, 1.3), kind: "petal" };
      }
      if (style === "hearts") {
        return { ...base, s: rand(3.5, 6.5) * scale, vy: rand(8, 20), drift: rand(-7, 7), spin: rand(-0.7, 0.7), rot: rand(0, Math.PI), sway: rand(0.4, 1.1), kind: "heart" };
      }
      if (style === "butterflies") {
        // бабочка: волнистый полёт, крылья машут
        return { ...base, s: rand(5, 9) * scale, vy: rand(6, 16), wander: rand(0.5, 1.2), flap: rand(9, 15), kind: "butterfly" };
      }
      // звёзды: часть — четырёхлучевые искры, остальные — точки
      return { ...base, r: rand(0.6, 1.9) * scale, vy: rand(5, 18), drift: rand(-6, 6), spark: Math.random() < 0.12, kind: "star" };
    }

    function build() {
      particles = Array.from({ length: count() }, () => spawn(true));
    }

    /** При изменении окна сохраняем координаты и скорости видимых частиц.
     * Полная пересборка на каждом событии resize выглядела как бешеное движение. */
    function fitParticles() {
      particles = particles.filter((p) => p.x >= -60 && p.x <= width + 60 && p.y >= -40 && p.y <= height + 40);
      const target = count();
      if (particles.length > target) particles.length = target;
      while (particles.length < target) particles.push(spawn(true));
    }

    function drawStar(p, time) {
      const twinkle = 0.6 + 0.4 * Math.sin(time * 1.7 + p.phase);
      ctx.globalAlpha = p.alpha * twinkle;
      ctx.fillStyle = ink;
      if (p.spark) {
        // четырёхлучевая звёздочка: два тонких луча и светлое ядро
        const arm = p.r * 2.6;
        ctx.globalAlpha = p.alpha * twinkle * 0.7;
        ctx.fillRect(p.x - 0.4, p.y - arm, 0.8, arm * 2);
        ctx.fillRect(p.x - arm, p.y - 0.4, arm * 2, 0.8);
        ctx.globalAlpha = p.alpha * twinkle;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 0.85, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawDot(p) {
      ctx.globalAlpha = p.alpha * 0.8;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawFlake(p) {
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.9;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(0.7, p.r * 0.14);
      ctx.lineCap = "round";
      for (let i = 0; i < 6; i += 1) {
        ctx.rotate(Math.PI / 3);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -p.r);
        ctx.moveTo(0, -p.r * 0.62);
        ctx.lineTo(p.r * 0.28, -p.r * 0.82);
        ctx.moveTo(0, -p.r * 0.62);
        ctx.lineTo(-p.r * 0.28, -p.r * 0.82);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawLeaf(p) {
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.9;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(0, -p.s);
      ctx.quadraticCurveTo(p.s * 0.85, -p.s * 0.05, 0, p.s);
      ctx.quadraticCurveTo(-p.s * 0.85, -p.s * 0.05, 0, -p.s);
      ctx.closePath();
      ctx.fill();
      // черенок
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(0.7, p.s * 0.12);
      ctx.beginPath();
      ctx.moveTo(0, p.s * 0.85);
      ctx.lineTo(0, p.s * 1.3);
      ctx.stroke();
      ctx.restore();
    }

    function drawPetal(p) {
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.85;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(0, -p.s);
      ctx.quadraticCurveTo(p.s * 1.05, -p.s * 0.1, 0, p.s);
      ctx.quadraticCurveTo(-p.s * 1.05, -p.s * 0.1, 0, -p.s);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawHeart(p) {
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.9;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = ink;
      const s = p.s;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.95);
      ctx.bezierCurveTo(-s * 1.5, s * 0.15, -s * 0.95, -s * 0.95, 0, -s * 0.3);
      ctx.bezierCurveTo(s * 0.95, -s * 0.95, s * 1.5, s * 0.15, 0, s * 0.95);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawButterfly(p, time) {
      // крылья машут: ширина крыльев качается от нуля до полного размаха
      const flap = Math.abs(Math.sin(time * p.flap + p.phase));
      const wing = p.s * (0.3 + 0.7 * flap);
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = ink;
      // верхние крылья
      ctx.beginPath();
      ctx.ellipse(-wing * 0.75, -p.s * 0.3, wing, p.s * 0.62, -0.45, 0, Math.PI * 2);
      ctx.ellipse(wing * 0.75, -p.s * 0.3, wing, p.s * 0.62, 0.45, 0, Math.PI * 2);
      ctx.fill();
      // нижние крылья
      ctx.beginPath();
      ctx.ellipse(-wing * 0.6, p.s * 0.38, wing * 0.72, p.s * 0.42, 0.35, 0, Math.PI * 2);
      ctx.ellipse(wing * 0.6, p.s * 0.38, wing * 0.72, p.s * 0.42, -0.35, 0, Math.PI * 2);
      ctx.fill();
      // тельце
      ctx.fillRect(-p.s * 0.13, -p.s * 0.75, p.s * 0.26, p.s * 1.5);
      ctx.restore();
    }

    function drawStick(p) {
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.7;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = ink;
      ctx.fillRect(-p.r / 2, -p.h / 2, p.r, p.h);
      ctx.restore();
    }

    function step(now) {
      if (!ctx) { raf = 0; return; }
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      ctx.clearRect(0, 0, width, height);
      const time = now / 1000;
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        p.y += p.vy * dt;
        p.x += (p.drift || 0) * dt;
        if (p.kind === "stick" || p.kind === "flake" || p.kind === "leaf" || p.kind === "petal" || p.kind === "heart") p.rot += p.spin * dt;
        if ((p.kind === "dot" || p.kind === "flake" || p.kind === "leaf" || p.kind === "petal" || p.kind === "heart") && p.sway) p.x += Math.sin(time * p.sway + p.phase) * 6 * dt;
        if (p.kind === "butterfly") {
          // волнистый полёт: виляет из стороны в сторону и кренится на поворотах
          p.x += Math.sin(time * p.wander + p.phase) * 34 * dt;
          p.rot = Math.cos(time * p.wander + p.phase) * 0.55;
        }
        const gone = p.vy > 0 ? p.y > height + 40 : p.y < -40;
        if (gone || p.x < -60 || p.x > width + 60) { particles[i] = spawn(false); continue; }
        if (p.kind === "star") drawStar(p, time);
        else if (p.kind === "stick") drawStick(p);
        else if (p.kind === "flake") drawFlake(p);
        else if (p.kind === "leaf") drawLeaf(p);
        else if (p.kind === "petal") drawPetal(p);
        else if (p.kind === "heart") drawHeart(p);
        else if (p.kind === "butterfly") drawButterfly(p, time);
        else drawDot(p);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(step);
    }

    function start() {
      const el = canvas();
      if (!el) return;
      if (style === "off") { stop(); return; }
      // системную настройку «меньше анимации» не слушаем: эффекты включаются
      // только вручную в настройках, и если включены — они должны быть видны
      el.hidden = false;
      resize();
      build();
      if (!raf) { last = 0; raf = requestAnimationFrame(step); }
    }

    function stop() {
      const el = canvas();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      if (ctx) ctx.clearRect(0, 0, width, height);
      if (el) el.hidden = true;
    }

    window.addEventListener("resize", () => {
      if (style === "off" || !raf) return;
      resize();
      fitParticles();
    });

    ambientInkRefresh = () => {
      const textColor = getComputedStyle(document.body).getPropertyValue("--text").trim();
      ink = colorOverride || textColor || "#e8e8ee";
    };

    return {
      /** Размер частиц в процентах: 10–220. */
      size: (percent) => {
        const clean = Math.max(10, Math.min(220, Number(percent) || 100));
        scale = clean / 100;
        if (style !== "off" && raf) build();
        return clean;
      },
      /** Плотность частиц в процентах: 10–200. */
      density: (percent) => {
        const clean = Math.max(10, Math.min(300, Number(percent) || 100));
        density = clean / 100;
        if (style !== "off" && raf) build();
        return clean;
      },
      /** Свой цвет частиц: hex или null — «как в теме». */
      color: (hex) => {
        colorOverride = /^#[0-9a-f]{6}$/i.test(String(hex || "")) ? String(hex).toLowerCase() : null;
        ink = colorOverride || getComputedStyle(document.body).getPropertyValue("--text").trim() || "#e8e8ee";
        return colorOverride;
      },
      /** Прозрачность слоя частиц в процентах: 5–100. */
      opacity: (percent) => {
        const clean = Math.max(5, Math.min(100, Number(percent) || 80));
        layerOpacity = clean / 100;
        const el = canvas();
        if (el) el.style.opacity = String(layerOpacity);
        return clean;
      },
      refreshInk: () => ambientInkRefresh && ambientInkRefresh(),
      // Тихий режим сворачивания останавливает только WebView-анимацию.
      pause: stop,
      resume: () => { if (style !== "off") start(); },
      apply: (name) => {
        style = AMBIENT_STYLES[name] ? name : "stars";
        document.body.dataset.ambient = style;
        if (style === "off") stop();
        else start();
        return style;
      },
      current: () => style,
      // Снимок для автоматической проверки плавности resize; исходные объекты не отдаём.
      snapshot: () => ({ width, height, particles: particles.map((p) => ({ ...p })) })
    };
  })();

  /** Варианты трейса за курсором. */
  const TRAIL_STYLES = {
    line: "Линия",
    brush: "Кисть",
    glow: "Свечение",
    sparks: "Искры"
  };

  /** Трейс за курсором: один канвас, четыре варианта, общий размер и длина следа. */
  const trailFx = (() => {
    const canvas = () => $("#trail");
    const MAX_POINTS = 140;
    // базовая жизнь точки в секундах; «длина следа» её умножает
    const LIFE = 0.5;
    let ctx = null;
    let width = 0;
    let height = 0;
    let points = [];
    let raf = 0;
    let last = 0;
    let lastMove = 0;
    let scale = 1;
    let length = 1;
    let style = "line";
    let enabled = true;
    let ink = "#e8e8ee";
    let accent = "#ffffff";
    // своя палитра (null — как в теме) и прозрачность следа
    let colorOverride = null;
    let opacity = 1;

    function resize() {
      const el = canvas();
      if (!el) return;
      width = Math.max(1, el.clientWidth || window.innerWidth);
      height = Math.max(1, el.clientHeight || window.innerHeight);
      // при zoom интерфейса пикселей в канвасе больше — иначе трейс мылит
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * uiZoom());
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx = el.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readInk();
    }

    function readInk() {
      const css = getComputedStyle(document.body);
      ink = colorOverride || css.getPropertyValue("--text").trim() || "#e8e8ee";
      accent = colorOverride || css.getPropertyValue("--accent").trim() || "#ffffff";
    }

    /** Толщина в пикселях при 100 % — у каждого варианта своя. */
    function baseWidth() {
      const base = style === "brush" ? 13 : style === "glow" ? 8 : style === "sparks" ? 3.5 : 4.5;
      return base * scale;
    }

    /** Один гладкий путь по всем точкам: линия без разрывов и стыков. */
    function tracePath(list) {
      ctx.beginPath();
      ctx.moveTo(list[0].x, list[0].y);
      for (let i = 1; i < list.length; i += 1) {
        const cur = list[i];
        if (i < list.length - 1) {
          const next = list[i + 1];
          ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
        } else {
          ctx.lineTo(cur.x, cur.y);
        }
      }
    }

    function step(now) {
      const el = canvas();
      if (!ctx || !el) { raf = 0; return; }
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      ctx.clearRect(0, 0, width, height);

      const life = LIFE * length;
      for (const point of points) point.age += dt;
      points = points.filter((point) => point.age < life);

      if (points.length > 1) {
        const base = baseWidth();
        // хвост гаснет целиком, а не по кусочкам — поэтому линия сплошная
        const sinceMove = Math.max(0, (now - lastMove) / 1000);
        const fade = Math.max(0, Math.min(1, 1 - sinceMove / (life * 1.8))) * opacity;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (style === "brush") {
          // кисть: толщина сужается к хвосту, прозрачность одинаковая
          ctx.strokeStyle = ink;
          for (let i = 1; i < points.length; i += 1) {
            const prev = points[i - 1];
            const cur = points[i];
            const k = i / (points.length - 1);
            ctx.globalAlpha = 0.9 * fade;
            ctx.lineWidth = Math.max(0.8, base * Math.pow(k, 1.2));
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(cur.x, cur.y);
            ctx.stroke();
          }
        } else if (style === "glow") {
          const passes = [
            { width: base * 3.2, alpha: 0.16 },
            { width: base * 2.0, alpha: 0.3 },
            { width: base * 0.7, alpha: 0.95 }
          ];
          tracePath(points);
          passes.forEach((pass, index) => {
            ctx.strokeStyle = index === passes.length - 1 ? ink : accent;
            ctx.globalAlpha = pass.alpha * fade;
            ctx.lineWidth = Math.max(1, pass.width);
            ctx.stroke();
          });
        } else if (style === "sparks") {
          ctx.strokeStyle = ink;
          ctx.globalAlpha = 0.5 * fade;
          ctx.lineWidth = Math.max(0.8, base);
          tracePath(points);
          ctx.stroke();
          // искры вдоль линии
          ctx.fillStyle = accent;
          for (let i = 0; i < points.length; i += 5) {
            const point = points[i];
            const k = i / (points.length - 1);
            ctx.globalAlpha = (0.25 + 0.65 * k) * fade;
            ctx.beginPath();
            ctx.arc(point.x, point.y, Math.max(0.8, base * (0.5 + 0.8 * k)), 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // «Линия»: одна сплошная тонкая линия, без ступенек по толщине
          ctx.strokeStyle = ink;
          ctx.globalAlpha = 0.85 * fade;
          ctx.lineWidth = Math.max(1, base);
          tracePath(points);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      if (!points.length) { el.hidden = true; raf = 0; return; }
      raf = requestAnimationFrame(step);
    }

    function start() {
      const el = canvas();
      if (!el || raf) return;
      el.hidden = false;
      resize();
      last = 0;
      raf = requestAnimationFrame(step);
    }

    function stop() {
      const el = canvas();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      points = [];
      if (ctx) ctx.clearRect(0, 0, width, height);
      if (el) el.hidden = true;
    }

    function push(event) {
      if (!enabled) return;
      // clientX/Y — в пикселях окна, а канвас живёт внутри body с zoom
      const x = event.clientX / uiZoom();
      const y = event.clientY / uiZoom();
      const previous = points[points.length - 1];
      if (previous) {
        const dx = x - previous.x;
        const dy = y - previous.y;
        if (dx * dx + dy * dy < 2.25) return;
      }
      points.push({ x, y, age: 0 });
      if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
      lastMove = performance.now();
      start();
    }

    window.addEventListener("mousemove", push, { passive: true });
    window.addEventListener("pointermove", push, { passive: true });
    window.addEventListener("resize", () => { if (enabled && canvas()) resize(); });

    return {
      enable: (on) => {
        enabled = Boolean(on);
        document.body.dataset.trail = enabled ? "on" : "off";
        if (!enabled) stop();
        return enabled;
      },
      isOn: () => enabled,
      /** Вариант трейса: line | brush | glow | sparks. */
      style: (name) => {
        style = TRAIL_STYLES[name] ? name : "line";
        return style;
      },
      /** Толщина кисти в процентах: 10–300. */
      size: (percent) => {
        const clean = Math.max(10, Math.min(300, Number(percent) || 100));
        scale = clean / 100;
        return clean;
      },
      /** Длина следа в процентах: 10–300. */
      length: (percent) => {
        const clean = Math.max(10, Math.min(300, Number(percent) || 100));
        length = clean / 100;
        return clean;
      },
      /** Свой цвет трейса: hex или null — «как в теме». */
      color: (hex) => {
        colorOverride = /^#[0-9a-f]{6}$/i.test(String(hex || "")) ? String(hex).toLowerCase() : null;
        readInk();
        return colorOverride;
      },
      /** Прозрачность следа в процентах: 5–100. */
      opacity: (percent) => {
        const clean = Math.max(5, Math.min(100, Number(percent) || 100));
        opacity = clean / 100;
        return clean;
      },
      // Тихий режим не очищает RPC/состояние — только прекращает отрисовку следа.
      pause: stop,
      resume: () => { if (enabled && points.length) start(); },
      refreshInk: readInk
    };
  })();

  /** Включение/выключение фоновой анимации из настроек. */
  function applyAmbient(name) {
    state.ambient = ambient.apply(name);
    return state.ambient;
  }

  /** Размер частиц фона в процентах. */
  function applyEffectSize(percent) {
    const clean = ambient.size(percent);
    state.effectSize = clean;
    return clean;
  }

  /** Размер кисти трейса в процентах — своя настройка, отдельно от эффектов. */
  function applyTrailSize(percent) {
    const clean = trailFx.size(percent);
    state.trailSize = clean;
    return clean;
  }

  /** Длина следа трейса в процентах. */
  function applyTrailLength(percent) {
    const clean = trailFx.length(percent);
    state.trailLength = clean;
    return clean;
  }

  /** Вариант трейса: линия, кисть, свечение, искры. */
  function applyTrailStyle(name) {
    state.trailStyle = trailFx.style(name);
    return state.trailStyle;
  }

  /** Свой цвет трейса (null — как в теме). */
  function applyTrailColor(hex) {
    state.trailColor = trailFx.color(hex);
    return state.trailColor;
  }

  /** Прозрачность трейса в процентах. */
  function applyTrailOpacity(percent) {
    const clean = trailFx.opacity(percent);
    state.trailOpacity = clean;
    return clean;
  }

  /** Свой цвет частиц на экране (null — как в теме). */
  function applyAmbientColor(hex) {
    state.ambientColor = ambient.color(hex);
    return state.ambientColor;
  }

  /** Прозрачность частиц на экране в процентах. */
  function applyAmbientOpacity(percent) {
    const clean = ambient.opacity(percent);
    state.ambientOpacity = clean;
    return clean;
  }

  /** Трейс за курсором: вкл/выкл. */
  function applyTrail(on) {
    state.trail = trailFx.enable(on);
    return state.trail;
  }

  function wallUrl(name) {
    return name === "noise" ? "assets/wallpapers/noise.jpg" : `assets/wallpapers/${name}.png`;
  }

  function loadWallImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("фон не открылся"));
      image.src = src;
    });
  }

  /**
   * Готовим фон один раз в canvas: масштаб под окно, размытие и размер по вкусу.
   * Слой получается обычной картинкой (JPEG), а не гигантским PNG в background-image:
   * так WebView2 рисует его одинаково на любой видеокарте и не чернит панели сверху.
   */
  const wallLayerCache = new Map();

  async function prepareWallLayer(src, fit, blur) {
    const vw = Math.max(640, Math.round(window.innerWidth || 1280));
    const vh = Math.max(420, Math.round(window.innerHeight || 720));
    const scale = Math.min(1, 1920 / vw);
    const width = Math.round(vw * scale);
    const height = Math.round(vh * scale);
    const key = `${fit}|${blur}|${width}x${height}|${src.length}|${src.slice(-48)}`;
    if (wallLayerCache.has(key)) return wallLayerCache.get(key);
    let url = null;
    try {
      const image = await loadWallImage(src);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // подложка темы — чтобы у прозрачных картинок не было чёрных полей
      ctx.fillStyle = themeTintColor();
      ctx.fillRect(0, 0, width, height);
      if (blur > 0) ctx.filter = `blur(${Math.max(1, Math.round(blur * 1.6))}px)`;
      const pad = blur > 0 ? 1.08 : 1;
      const iw = image.naturalWidth || image.width;
      const ih = image.naturalHeight || image.height;
      if (fit === "tile") {
        const pattern = ctx.createPattern(image, "repeat");
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, width, height);
        }
      } else if (fit === "fill") {
        ctx.drawImage(image, 0, 0, width, height);
      } else {
        const cover = fit !== "contain";
        const factor = cover ? Math.max(width / iw, height / ih) : Math.min(width / iw, height / ih);
        const dw = iw * factor * (cover ? pad : 1);
        const dh = ih * factor * (cover ? pad : 1);
        ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
      }
      url = canvas.toDataURL("image/jpeg", 0.92);
    } catch (error) {
      url = null;
    }
    if (wallLayerCache.size > 6) wallLayerCache.clear();
    wallLayerCache.set(key, url);
    return url;
  }

  /** Доступ к локальному медиа даётся только Rust-командой для конкретного файла. */
  const wallSourceRevision = { custom: 0 };
  async function loadWallpaperSource(source) {
    if (source !== "custom") return null;
    const revision = ++wallSourceRevision.custom;
    const media = await api.wallpaperSource(source);
    if (revision !== wallSourceRevision.custom) return null;
    if (!media) { state.customWall = null; return null; }
    const src = media.src || (TAURI?.core?.convertFileSrc ? TAURI.core.convertFileSrc(media.path) : media.path);
    state.customWall = { ...media, src };
    return state.customWall;
  }

  let wallApplyRevision = 0;
  function playWallpaperVideo(video) {
    if (!video || video.hidden || document.hidden || !video.dataset.wallSrc) return;
    video.muted = true;
    video.loop = true;
    video.play().catch(() => {});
  }

  /** GIF и видео не проходят через canvas: иначе анимация превратилась бы в один кадр. */
  async function applyWallpaper(overrides = {}) {
    const revision = ++wallApplyRevision;
    const settings = state.settings || {};
    const layer = $("#wall");
    const video = $("#wall-video");
    if (!layer) return;
    const name = overrides.wallpaper !== undefined ? overrides.wallpaper : settings.wallpaper;
    const fit = overrides.fit || settings.wallpaper_fit || "cover";
    const blur = Math.max(0, Math.min(20, Number(overrides.blur ?? settings.wallpaper_blur ?? 0) || 0));
    const dim = Number(overrides.dim ?? settings.wallpaper_dim ?? 40);
    const media = name === "custom" ? state.customWall
      : name && WALLS.some(([id]) => id === name) ? { src: wallUrl(name), kind: "image" } : null;
    if (!media || !media.src) {
      if (video && !video.hidden) { video.pause(); video.removeAttribute("src"); video.dataset.wallSrc = ""; video.load(); video.hidden = true; }
      layer.hidden = true;
      layer.style.backgroundImage = "";
      document.body.classList.remove("has-wall");
      return;
    }
    const { src, kind } = media;
    layer.hidden = false;
    document.body.classList.add("has-wall");
    layer.style.setProperty("--wall-dim", String(Math.min(100, Math.max(0, dim)) / 100));
    if (kind === "video" && video) {
      layer.style.backgroundImage = "";
      layer.style.filter = "";
      layer.style.transform = "";
      video.hidden = false;
      // Локальные видеообои всегда зациклены и беззвучны.
      video.muted = true;
      video.loop = true;
      video.style.objectFit = fit === "fill" ? "fill" : fit === "contain" ? "contain" : "cover";
      video.style.filter = blur ? `blur(${blur}px)` : "";
      video.style.transform = blur ? "scale(1.05)" : "";
      if (video.dataset.wallSrc !== src) {
        video.dataset.wallSrc = src;
        video.onerror = () => toast("Не удалось воспроизвести видео: проверь файл и видеокодек системы", "err");
        video.src = src;
      }
      if (!document.hidden) playWallpaperVideo(video);
      layer.dataset.prepared = "";
      return;
    }
    if (video && !video.hidden) {
      video.pause(); video.removeAttribute("src"); video.dataset.wallSrc = ""; video.load(); video.hidden = true;
    }
    // Статичные картинки по-прежнему запекаем для совместимости с WebView2.
    // GIF рисуется напрямую, и все кадры продолжают меняться.
    const prepared = kind === "gif" ? null : await prepareWallLayer(src, fit, blur);
    if (revision !== wallApplyRevision) return;
    if (prepared) {
      layer.style.filter = "";
      layer.style.transform = "";
      layer.style.backgroundSize = "cover";
      layer.style.backgroundRepeat = "no-repeat";
      layer.style.backgroundImage = `url("${prepared}")`;
      layer.dataset.prepared = "1";
      forceRepaint();
      return;
    }
    layer.style.backgroundImage = `url("${src}")`;
    layer.style.backgroundSize = fit === "fill" ? "100% 100%" : fit === "contain" ? "contain" : fit === "tile" ? "auto" : "cover";
    layer.style.backgroundRepeat = fit === "tile" ? "repeat" : "no-repeat";
    layer.style.filter = blur ? `blur(${blur}px)` : "";
    layer.style.transform = blur ? "scale(1.05)" : "";
    layer.dataset.prepared = "";
  }

  document.addEventListener("visibilitychange", () => {
    const video = $("#wall-video");
    if (!video || video.hidden) return;
    if (document.hidden) video.pause();
    else playWallpaperVideo(video);
  });

  /* размер окна изменился — пересобираем слой фона под новый размер */
  let wallResizeTimer = 0;
  window.addEventListener("resize", () => {
    if (!document.body.classList.contains("has-wall")) return;
    clearTimeout(wallResizeTimer);
    wallResizeTimer = setTimeout(() => { applyWallpaper(); }, 350);
  });

  /**
   * Базовый цвет фона: он ложится поверх обоев. По умолчанию — цвет темы
   * (в светлой это белая подложка), но в настройках его можно подобрать вручную.
   */
  function themeTintColor() {
    const settings = state.settings || {};
    const own = String(settings.theme_tint || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(own)) return own.toLowerCase();
    const name = document.body.dataset.theme || settings.theme || "dark";
    return themeOf(name).bg;
  }

  function applyThemeTint() {
    document.body.style.setProperty("--wall-tint", themeTintColor());
  }

  /**
   * Просьба перерисовать слои: WebView2 иногда оставляет панели чёрными, пока
   * не тронешь композитинг. Один кадр с отдельным слоем — и картинка обновляется.
   */
  function forceRepaint() {
    const app = $(".app");
    if (!app) return;
    app.style.transform = "translateZ(0)";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { app.style.transform = ""; });
    });
  }

  /** Свои цвета сохраняем сразу — тема не теряется при перезапуске. */
  function saveCustomTheme() {
    state.settings = {
      ...(state.settings || {}),
      theme: "custom",
      theme_bg: state.customTheme.bg,
      theme_accent: state.customTheme.accent,
      theme_text: state.customTheme.text
    };
    api.saveSettings(state.settings).catch(() => {});
  }

  let saveThemeTimer = null;
  /** Отложенная запись своей темы: во время перетаскивания в пикере
   *  не пишем файл на каждый тик мыши. */
  function saveCustomThemeSoon() {
    if (saveThemeTimer) return;
    saveThemeTimer = setTimeout(() => { saveThemeTimer = null; saveCustomTheme(); }, 600);
  }

  let saveSettingsTimer = null;
  /** Отложенная запись настроек (тинт и т.п.) — то же самое. */
  function saveSettingsSoon() {
    if (saveSettingsTimer) return;
    saveSettingsTimer = setTimeout(() => { saveSettingsTimer = null; api.saveSettings(state.settings).catch(() => {}); }, 600);
  }

  /* ==================== ЦВЕТА ИЗ ФОНА ==================== */
  /** Картинка текущих обоев (свой фон — data-URL, штатный — файл из assets). */
  function wallpaperSrc() {
    const wallpaper = state.wall && state.wall.wallpaper;
    const media = wallpaper === "custom" ? state.customWall : null;
    if (media) return ["video", "scene"].includes(media.kind) ? null : media.src;
    if (wallpaper && WALLS.some(([id]) => id === wallpaper)) return wallUrl(wallpaper);
    return null;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("картинка не открылась"));
      image.src = src;
    });
  }

  let paletteCache = { src: "", palette: null };

  /** Палитра обоев: фон = затемнённый средний цвет, акцент = самый насыщенный. */
  async function wallpaperPalette() {
    const src = wallpaperSrc();
    if (!src) return null;
    if (paletteCache.src === src && paletteCache.palette) return paletteCache.palette;
    let image;
    try {
      image = await loadImage(src);
    } catch (error) {
      return null;
    }
    const palette = paletteFromImage(image);
    if (palette) paletteCache = { src, palette };
    return palette;
  }

  /** Из готовой картинки — три цвета темы (подбор «под фон»). */
  function paletteFromImage(image) {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = Math.round(size * 0.62);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (error) {
      return null; // канвас «испачкан» чужим доменом — берём обычную пипетку
    }
    let rs = 0;
    let gs = 0;
    let bs = 0;
    let count = 0;
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      rs += r; gs += g; bs += b; count += 1;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const score = saturation * (0.4 + Math.min(light, 0.85));
      if (score > bestScore) { bestScore = score; best = [r, g, b]; }
    }
    if (!count) return null;
    const average = toHex([rs / count, gs / count, bs / count]);
    const dark = luminance(average) < 0.42;
    const bg = dark ? mix(average, "#070709", 0.72) : mix(average, "#ffffff", 0.78);
    // серый «самый насыщенный» — плохой акцент: подмешиваем цвет обоев
    const boost = (hex, amount) => {
      const [r, g, b] = rgbOf(hex);
      const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return toHex([r, g, b].map((value) => value + (value - grey) * amount));
    };
    let accent = best ? toHex(best) : average;
    const [ar, ag, ab] = rgbOf(accent);
    const accentMax = Math.max(ar, ag, ab);
    const accentSat = accentMax === 0 ? 0 : (accentMax - Math.min(ar, ag, ab)) / accentMax;
    if (accentSat < 0.3) accent = boost(average, 1.8);
    if (Math.abs(luminance(accent) - luminance(bg)) < 0.22) {
      accent = mix(accent, dark ? "#ffffff" : "#000000", 0.45);
    }
    const text = mix(dark ? "#f2f2f5" : "#0e0e11", average, 0.1);
    return { bg, accent, text };
  }

  /* Иконки сборок: встроенный набор + своя картинка (если в icon лежит путь). */
  const INSTANCE_ICONS = [
    "i-cube", "i-star", "i-heart", "i-flame", "i-bolt", "i-gem", "i-shield", "i-leaf",
    "i-crown", "i-house", "i-globe", "i-grid", "i-mod", "i-terminal", "i-folder", "i-download"
  ];

  function isImageIcon(icon) {
    return Boolean(icon) && String(icon).includes(".") && /\.(png|jpe?g|webp|gif)$/i.test(String(icon));
  }

  function instanceIconHtml(meta) {
    const icon = isServer(meta) ? "server-icon.png" : (meta && meta.icon);
    if (isImageIcon(icon)) {
      // кэша нет (файл ещё не прочитан) — показываем букву, а не пустую рамку
      const data = state.iconCache[meta.id];
      return data
        ? `<img src="${esc(data)}" alt="" onerror="this.remove()">`
        : esc(String((meta && meta.name) || "?").trim().charAt(0).toUpperCase());
    }
    if (icon && INSTANCE_ICONS.includes(icon)) return `<svg class="ic"><use href="#${icon}"/></svg>`;
    return esc(String((meta && meta.name) || "?").trim().charAt(0).toUpperCase());
  }

  /** Иконка в шапке сборки берётся у самой сборки, а не у лаунчера. */
  function renderBuildIcon(meta) {
    const box = $("#tb-icon");
    if (!box) return;
    if (!meta) {
      box.classList.remove("is-letter");
      box.innerHTML = `<img src="assets/logo.png" alt="" draggable="false">`;
      return;
    }
    const html = instanceIconHtml(meta);
    const imageIcon = isImageIcon(isServer(meta) ? "server-icon.png" : meta.icon);
    const letter = !imageIcon && !(meta.icon && INSTANCE_ICONS.includes(meta.icon));
    box.classList.toggle("is-letter", letter);
    box.innerHTML = letter ? `<span class="tb-letter" translate="no">${esc(html)}</span>` : html;
  }

  /** Подтянуть картинки-иконки сборок (webview не читает локальные пути). */
  async function loadInstanceIcons() {
    const customs = state.instances.filter((item) => isImageIcon(item.icon) || isServer(item));
    await Promise.all(customs.map(async (item) => {
      try {
        const data = await api.instanceIcon(item.id);
        if (data) state.iconCache[item.id] = data;
      } catch (error) { /* иконка не критична */ }
    }));
  }

  /* ==================== КОНТЕКСТНОЕ МЕНЮ ==================== */
  function closeCtxMenu() {
    const el = $("#ctx-menu");
    if (el) el.hidden = true;
  }

  /** Скопировать текст в буфер обмена (с понятным тостом). */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Ссылка скопирована", "ok");
    } catch (err) {
      toast(text, "info");
    }
  }

  /** Координаты события и getBoundingClientRect — в пикселях окна, а меню
   * живёт внутри body с zoom. Длинное меню ограничиваем высотой и прокручиваем. */
  function positionCtxMenu(el, x, y) {
    const zoom = uiZoom();
    const width = window.innerWidth / zoom;
    const height = window.innerHeight / zoom;
    const margin = Math.min(8, width / 4, height / 4);
    const maxWidth = Math.max(1, width - margin * 2);
    const maxHeight = Math.max(1, height - margin * 2);
    el.style.minWidth = `${Math.min(214, maxWidth)}px`;
    el.style.maxWidth = `${maxWidth}px`;
    el.style.maxHeight = `${maxHeight}px`;
    el.style.left = "0px";
    el.style.top = "0px";
    el.scrollTop = 0;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(margin, Math.min(x / zoom, width - rect.width / zoom - margin))}px`;
    el.style.top = `${Math.max(margin, Math.min(y / zoom, height - rect.height / zoom - margin))}px`;
  }

  /** Общее контекстное меню: html + обработчик по data-act. */
  function fillCtxMenu(x, y, html, handler) {
    const el = $("#ctx-menu");
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    positionCtxMenu(el, x, y);
    $$(".ctx-item", el).forEach((btn) => btn.addEventListener("click", () => {
      closeCtxMenu();
      handler(btn.dataset.act);
    }));
  }

  function openInstanceMenu(x, y, meta) {
    const el = $("#ctx-menu");
    if (!el) return;
    const running = state.running.has(meta.id);
    el.innerHTML = `
      <div class="ctx-caption" translate="no">${esc(meta.name)} · MC ${esc(meta.mc_version)}</div>
      <button class="ctx-item${running ? " danger" : ""}" data-act="play"><svg class="ic"><use href="#${running ? "i-stop" : "i-play"}"/></svg>${running ? "Остановить сборку" : "Играть"}</button>
      <button class="ctx-item" data-act="dup"><svg class="ic"><use href="#i-copy"/></svg>Запустить дубликат…</button>
      <button class="ctx-item" data-act="duplicate"><svg class="ic"><use href="#i-copy"/></svg>Дублировать сборку</button>
      <button class="ctx-item" data-act="settings"><svg class="ic"><use href="#i-sliders"/></svg>Настройки сборки</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="icon"><svg class="ic"><use href="#i-image"/></svg>Иконка из картинки…</button>
      ${isImageIcon(meta.icon) ? `<button class="ctx-item" data-act="icon-reset"><svg class="ic"><use href="#i-close"/></svg>Вернуть обычную иконку</button>` : ""}
      <button class="ctx-item" data-act="rename"><svg class="ic"><use href="#i-pencil"/></svg>Переименовать</button>
      ${categoriesOf().length ? `<div class="ctx-sep"></div>
      <div class="ctx-caption">Переместить в</div>
      ${categoriesOf().map((category) => `<button class="ctx-item" data-act="move:${esc(category.id)}">
        <svg class="ic"><use href="#${meta.category === category.id ? "i-check" : "i-folder"}"/></svg><span translate="no">${esc(category.name)}</span></button>`).join("")}
      <button class="ctx-item" data-act="move:" ${meta.category ? "" : "disabled"}><svg class="ic"><use href="#i-close"/></svg>Без категории</button>` : ""}
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="folder"><svg class="ic"><use href="#i-folder"/></svg>Открыть папку сборки</button>
      <button class="ctx-item" data-act="refresh"><svg class="ic"><use href="#i-download"/></svg>Обновить файлы игры</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Удалить сборку</button>`;
    el.hidden = false;
    positionCtxMenu(el, x, y);
    $$(".ctx-item", el).forEach((btn) => btn.addEventListener("click", () => {
      closeCtxMenu();
      runInstanceAction(btn.dataset.act, meta);
    }));
  }

  async function runInstanceAction(action, meta) {
    const fresh = state.instances.find((item) => item.id === meta.id) || meta;
    if (action.startsWith("move:")) {
      const target = action.slice(5) || null;
      await moveInstanceToCategory(fresh.id, target);
      return;
    }
    if (action === "play") {
      // ПКМ может быть открыт по другой сборке: переключаем не только id,
      // но и заголовок/вкладку, чтобы не показывать содержимое старой сборки.
      if (state.selectedId !== fresh.id) openInstance(fresh.id);
      if (state.running.has(fresh.id)) await stopGame();
      else play();
      return;
    }
    if (action === "dup") {
      openDupLaunch(fresh);
      return;
    }
    if (action === "duplicate") {
      try {
        const copy = await api.duplicateInstance(fresh.id);
        await refreshInstances();
        toast(`Сборка «${copy.name}» создана`, "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (action === "settings") {
      selectInstance(fresh.id);
      state.tab = "settings";
      renderTab();
      return;
    }
    if (action === "icon") {
      const path = await api.pickFile("Иконка сборки", ["png", "jpg", "jpeg", "webp", "gif"]).catch(() => null);
      if (path) await setIconFromFile(fresh, path);
      return;
    }
    if (action === "icon-reset") {
      invalidatePresenceIcon();
      try {
        await api.updateInstance({ ...fresh, icon: null });
        delete state.iconCache[fresh.id];
        await refreshInstances();
        toast("Иконка сброшена", "ok");
      } catch (err) { syncPresence(); toast(String(err), "err"); }
      return;
    }
    if (action === "rename") {
      const name = await promptModal({ title: "Переименовать сборку", label: "Название", value: fresh.name });
      if (name === null || !name.trim() || name.trim() === fresh.name) return;
      try {
        await api.updateInstance({ ...fresh, name: name.trim() });
        await refreshInstances();
        toast("Переименовано", "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (action === "folder") {
      api.openPath(`/instances/${fresh.id}/minecraft`).catch((err) => toast(String(err), "err"));
      return;
    }
    if (action === "refresh") {
      try {
        toast("Проверяем и докачиваем файлы…");
        await api.installInstance(fresh.id);
        toast("Файлы игры готовы", "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (action === "delete") {
      const okDelete = await askConfirm({
        title: "Удалить сборку",
        text: `Сборка «${fresh.name}» будет удалена вместе с модами и мирами. Файлы игры останутся в кэше.`,
        ok: "Удалить"
      });
      if (!okDelete) return;
      try {
        await api.deleteInstance(fresh.id);
        diagnostics.forget(fresh.id);
        if (state.selectedId === fresh.id) state.selectedId = null;
        await refreshInstances();
        renderTab();
        toast("Сборка удалена", "ok");
      } catch (err) { toast(String(err), "err"); }
    }
  }

  /** Дубликат запущенной сборки: второе окно игры с другим аккаунтом. */
  function openDupLaunch(meta) {
    const modal = $("#modal-dup");
    if (!modal) return;
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || null;
    $("#dup-title").textContent = `Дубликат «${meta.name}»`;
    const body = $("#dup-body");
    if (!accounts.length) {
      body.innerHTML = `<div class="proj-empty">Нет аккаунтов — добавь второй аккаунт, чтобы запустить дубликат.</div>`;
    } else {
      body.innerHTML = `<div class="dup-list">${accounts.map((account) => `
        <button class="dup-row ${account.uuid === activeId ? "is-active" : ""}" data-uuid="${esc(account.uuid)}">
          ${avatarHtml(account)}
          <span class="acc-main">
            <span class="acc-name" translate="no">${esc(account.username)}</span>
            <span class="acc-kind">${account.kind === "microsoft" ? "лицензия" : account.kind === "elyby" ? "Ely.by" : "пиратка"}${account.uuid === activeId ? " · выбран сейчас" : ""}</span>
          </span>
          <svg class="ic"><use href="#i-play"/></svg>
        </button>`).join("")}</div>`;
      $$(".dup-row", body).forEach((row) => row.addEventListener("click", async () => {
        modal.hidden = true;
        await launchDuplicate(meta, row.dataset.uuid);
      }));
    }
    modal.hidden = false;
    $$("[data-close-dup]").forEach((el) => { el.onclick = () => { modal.hidden = true; }; });
  }

  async function launchDuplicate(meta, accountUuid) {
    const attemptId = nextAttemptId();
    diagnostics.begin(meta.id, attemptId, diagnosticLaunchContext(meta));
    changePreparing(meta.id, 1);
    syncPresence("launching");
    pushLog(meta.id, "[omnispec] Подготовка дубликата сборки", "dim");
    try {
      const plan = await api.launch(meta.id, accountUuid, attemptId);
      finishLaunchProgress(attemptId, "done");
      const run = diagnostics.started(meta.id, attemptId, plan && plan.run_id, plan && plan.account);
      // game-exit может прийти раньше ответа команды: не возвращаем мёртвое окно в список.
      if (run && run.status === "running") {
        addSession(meta.id, plan && plan.run_id, plan && plan.account, plan && plan.started_at);
        const who = (plan && plan.account) ? ` · ${plan.account}` : "";
        toast(`Дубликат запущен${who}`, "ok");
        pushLog(meta.id, `[omnispec] дубликат запущен${who}`, "dim");
      }
      renderSidebar();
      updateStatus();
      syncPresence();
    } catch (err) {
      const failed = diagnostics.fail(meta.id, attemptId, err);
      const cancelled = failed && failed.status === "cancelled";
      finishLaunchProgress(attemptId, cancelled ? "cancelled" : "error");
      pushLog(meta.id, `[omnispec] ${cancelled ? "Подготовка дубликата отменена" : "Ошибка запуска дубликата"}: ${err}`, cancelled ? "dim" : "err");
      if (cancelled) toast("Подготовка дубликата отменена", "info");
      else toast(`Не удалось запустить дубликат. Подробности — во вкладке «Ошибки»: ${err}`, "err");
      syncPresence();
    } finally {
      changePreparing(meta.id, -1);
    }
  }

  /** Своя иконка сборки из файла-картинки. */
  async function setIconFromFile(meta, path) {
    invalidatePresenceIcon();
    try {
      await api.setInstanceIconFile(meta.id, path);
      const data = await api.instanceIcon(meta.id).catch(() => null);
      if (data) state.iconCache[meta.id] = data;
      await refreshInstances();
      toast("Иконка обновлена", "ok");
      if (state.tab === "settings") renderSettings();
    } catch (err) { syncPresence(); toast(String(err), "err"); }
  }

  /* ==================== ОКНО «ВСЕ СБОРКИ» (сетка иконок по категориям) ==================== */
  function allBuildsHtml() {
    const instances = state.instances || [];
    const cats = (state.settings && state.settings.categories) || [];
    const groups = [];
    const uncategorized = instances.filter((item) => !item.category || !cats.some((cat) => cat.id === item.category));
    const running = instances.filter((item) => state.running.has(item.id));
    const ordered = [
      { id: "__running", name: "ЗАПУЩЕННЫЕ", items: running },
      ...cats.map((cat) => ({ id: cat.id, name: cat.name, items: instances.filter((item) => item.category === cat.id) })),
      { id: "", name: "Без категории", items: uncategorized }
    ].filter((group) => group.items.length);
    if (!ordered.length) {
      return `<div class="builds-empty">Сборок пока нет.</div>`;
    }
    for (const group of ordered) {
      groups.push(`
        <section class="builds-group">
          <div class="builds-group-head">
            <span class="builds-group-name" translate="no">${esc(group.name)}</span>
            <span class="builds-group-count mono">${group.items.length}</span>
          </div>
          <div class="builds-grid">
            ${group.items.map((item) => buildTileHtml(item)).join("")}
          </div>
        </section>`);
    }
    return groups.join("");
  }

  function buildTileHtml(item) {
    const running = state.running.has(item.id);
    const sessions = sessionsOf(item.id);
    const letter = esc(String(item.name || "?").trim().charAt(0).toUpperCase());
    const iconPath = isServer(item) ? "server-icon.png" : item.icon;
    const cached = isImageIcon(iconPath) ? state.iconCache[item.id] : "";
    const icon = cached
      ? `<img class="build-tile-icon" src="${cached}" alt="">`
      : isImageIcon(iconPath)
        ? `<img class="build-tile-icon" data-tile-icon="${esc(item.id)}" alt=""><span class="build-tile-icon is-letter" hidden>${letter}</span>`
        : item.icon && INSTANCE_ICONS.includes(item.icon)
          ? `<span class="build-tile-icon is-symbol"><svg class="ic"><use href="#${item.icon}"/></svg></span>`
          : `<span class="build-tile-icon is-letter">${letter}</span>`;
    const version = isServer(item) ? serverLabel(item) : [item.mc_version, loaderLabel(item.loader)].filter(Boolean).join(" · ");
    return `
      <button class="build-tile ${running ? "is-running" : ""}" data-build-tile="${esc(item.id)}" title="${esc(item.name)}">
        <span class="build-tile-shot">${icon}</span>
        <span class="build-tile-name" translate="no">${esc(item.name)}</span>
        <span class="build-tile-sub mono">${esc(version || "—")}</span>
        ${running ? `<span class="build-tile-flag">${sessions > 1 ? `${sessions} окна` : "запущена"}</span>` : ""}
      </button>`;
  }

  function binderAllBuilds() {
    const modal = $("#modal-builds");
    if (!modal) return;
    const open = async () => {
      modal.hidden = false;
      $("#builds-body").innerHTML = `<div class="builds-empty">Загружаю сборки…</div>`;
      await loadInstanceIcons();
      $("#builds-body").innerHTML = allBuildsHtml();
      // если иконка не нашлась — остаётся буква, «битых» картинок нет
      $$("#builds-body img[data-tile-icon]").forEach((img) => {
        img.addEventListener("error", () => img.remove());
        const id = img.dataset.tileIcon;
        if (!img.getAttribute("src") && !state.iconCache[id]) img.remove();
      });
    };
    const btn = $("#btn-grid");
    if (btn) btn.addEventListener("click", open);
    const close = () => { modal.hidden = true; };
    $$("[data-close-builds]", modal).forEach((el) => el.addEventListener("click", close));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) close();
    });
    modal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-builds") close(); });
    $("#builds-body").addEventListener("click", (event) => {
      const tile = event.target.closest("[data-build-tile]");
      if (!tile) return;
      close();
      openInstance(tile.dataset.buildTile);
    });
    $("#builds-body").addEventListener("contextmenu", (event) => {
      const tile = event.target.closest("[data-build-tile]");
      if (!tile) return;
      event.preventDefault();
      const meta = state.instances.find((item) => item.id === tile.dataset.buildTile);
      if (!meta) return;
      close();
      openInstance(meta.id);
      openInstanceMenu(event.clientX, event.clientY, meta);
    });
  }

  /* ==================== ОКНО ПОДТВЕРЖДЕНИЯ ==================== */
  /** confirm в стиле лаунчера: без системного «Сообщение с tauri.localhost». */
  function askConfirm({ title = "Подтверждение", text = "", ok = "Удалить", danger = true } = {}) {
    return new Promise((resolve) => {
      const modal = $("#modal-confirm");
      if (!modal) { resolve(window.confirm(text)); return; }
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      const okBtn = $("#confirm-ok");
      okBtn.textContent = ok;
      okBtn.className = `btn confirm-ok ${danger ? "btn-danger" : "btn-primary"}`;
      modal.hidden = false;
      setTimeout(() => okBtn.focus(), 30);
      const finish = (result) => {
        modal.hidden = true;
        okBtn.onclick = null;
        $("#confirm-cancel").onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(result);
      };
      const onKey = (event) => {
        if (event.key === "Escape") finish(false);
        if (event.key === "Enter") finish(true);
      };
      document.addEventListener("keydown", onKey);
      okBtn.onclick = () => finish(true);
      $("#confirm-cancel").onclick = () => finish(false);
      $$("[data-close-confirm]", modal).forEach((btn) => { btn.onclick = () => finish(false); });
      modal.onmousedown = (event) => { if (event.target.id === "modal-confirm") finish(false); };
    });
  }

  /* ==================== ОКНО ВВОДА ==================== */
  function promptModal({ title, label, value = "" }) {
    return new Promise((resolve) => {
      const modal = $("#modal-prompt");
      if (!modal) { resolve(null); return; }
      $("#prompt-title").textContent = title || "Ввод";
      $("#prompt-label").textContent = label || "Значение";
      const input = $("#prompt-input");
      input.value = value;
      modal.hidden = false;
      setTimeout(() => { input.focus(); input.select(); }, 30);
      const finish = (result) => {
        modal.hidden = true;
        $("#prompt-ok").onclick = null;
        input.onkeydown = null;
        resolve(result);
      };
      $("#prompt-ok").onclick = () => finish(input.value.trim());
      input.onkeydown = (event) => {
        if (event.key === "Enter") finish(input.value.trim());
        if (event.key === "Escape") finish(null);
      };
      $$("[data-close-prompt]", modal).forEach((btn) => { btn.onclick = () => finish(null); });
    });
  }

  /* ==================== ФАЙЛЫ: ПЕРЕТАСКИВАНИЕ И .MRPACK ==================== */
  async function installMrpackPath(path, categoryId = null) {
    const file = String(path).split(/[\\/]/).pop() || String(path);
    try {
      // показываем, что идёт импорт: строка на главной + полоса снизу
      state.home = state.home || { query: "", results: [], view: "grid", extSelected: new Set() };
      state.home.busy = true;
      state.home.status = `копируем «${file}» в лаунчер…`;
      if (state.tab === "discover") renderDiscover();
      toast(`Импортируем «${file}»…`);
      const meta = await withInstallProgress("modpack", "modpack", (op) => api.installModpack(path, op));
      if (categoryId) await moveInstanceToCategory(meta.id, categoryId);
      await refreshInstances();
      openInstance(meta.id);
      toast(`Ваша сборка «${meta.name}» установлена`, "ok");
    } catch (err) {
      toast(String(err), "err");
    } finally {
      state.home.busy = false;
      state.home.status = "";
      setProgress(null);
      if (state.tab === "discover") renderDiscover();
    }
  }

  async function handleDroppedFiles(paths) {
    if (!paths || !paths.length) return;
    for (const raw of paths) {
      const path = String(raw);
      const name = path.split(/[\\/]/).pop() || path;
      const lower = name.toLowerCase();
      // Без выбранной сборки zip — это модпак: показываем его в панели импорта.
      if (lower.endsWith(".zip") && !selected()) {
        state.home.zipPath = path;
        state.home.versions = [];
        state.home.zipMc = "";
        state.home.zipLoader = "vanilla";
        state.home.zipLoaderVersion = "";
        state.home.zipLoaderVersions = [];
        if (state.tab !== "discover") { state.tab = "discover"; renderTab(); }
        else renderDiscover();
        api.versions(false).then((versions) => {
          state.home.versions = versions || [];
          if (!state.home.zipMc) state.home.zipMc = (state.home.versions[0] || {}).id || "";
          if (state.tab === "discover") renderDiscover();
        }).catch(() => {});
        continue;
      }
      if (lower.endsWith(".mrpack")) { await installMrpackPath(path); continue; }
      const meta = selected();
      if (!meta) { toast("Сначала выбери сборку слева", "err"); continue; }
      if (/\.(png|jpe?g|webp|gif)$/.test(lower)) { await setIconFromFile(meta, path); continue; }
      if (lower.endsWith(".jar") || lower.endsWith(".zip")) {
        const sub = lower.endsWith(".zip") ? "resourcepacks" : "mods";
        try {
          const saved = await api.copyInstanceFile(meta.id, path, sub);
          toast(`${sub === "mods" ? "Мод" : "Ресурспак"} «${saved}» добавлен в сборку`, "ok");
          if (["mods", "resourcepacks", "files"].includes(state.tab)) renderTab();
        } catch (err) { toast(String(err), "err"); }
        continue;
      }
      toast(`Файл «${name}» не подходит: нужен .mrpack, .jar, .zip или картинка (PNG/JPG/WebP/GIF)`, "err");
    }
  }

  function bindFileDrop() {
    if (!IS_APP) return;
    const zone = $("#drop-zone");
    try {
      TAURI.event.listen("tauri://drag-enter", () => { if (zone) zone.hidden = false; });
      TAURI.event.listen("tauri://drag-over", () => { if (zone) zone.hidden = false; });
      TAURI.event.listen("tauri://drag-leave", () => { if (zone) zone.hidden = true; });
      TAURI.event.listen("tauri://drag-drop", (event) => {
        if (zone) zone.hidden = true;
        const payload = event && event.payload ? event.payload : {};
        handleDroppedFiles(payload.paths || []);
      });
    } catch (error) { /* старые версии webview без drag-событий */ }
  }

  /* эффект от клика мышью — как в OmniPanel */
  function applyClickFx(style) {
    document.body.dataset.fx = FX_STYLES[style] ? style : "wave";
    document.body.classList.toggle("no-fx", (FX_STYLES[style] ? style : "wave") === "off");
  }
  function initClickFx() {
    const layer = $("#fx-layer");
    if (!layer) return;
    window.addEventListener("pointerdown", (event) => {
      const style = document.body.dataset.fx || "wave";
      if (style === "off" || document.body.classList.contains("no-fx")) return;
      const effect = document.createElement("span");
      effect.className = `cfx cfx-${style}`;
      effect.style.left = `${event.clientX / uiZoom()}px`;
      effect.style.top = `${event.clientY / uiZoom()}px`;
      layer.appendChild(effect);
      setTimeout(() => effect.remove(), 700);
    }, true);
  }

  /* ==================== ДЕМО-ДАННЫЕ ==================== */
  const now = Math.floor(Date.now() / 1000);
  /** Демо-сведения о проекте: скриншоты — плоские SVG-заглушки. */
  function demoProject(projectId) {
    const shot = (caption, color) => ({
      url: `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${color}"/><rect x="0" y="120" width="320" height="60" fill="#000000" opacity="0.35"/><text x="18" y="150" font-family="monospace" font-size="15" fill="#ffffff">${caption}</text></svg>`
      )}`,
      featured: true,
      title: caption
    });
    const titles = {
      pack: ["Готовые сборки", "All the Mods 10", "Fabulously Optimized"],
      mod: ["Моды", "Sodium", "Iris Shaders"],
      shader: ["Шейдеры", "BSL Shaders", "Complementary"],
      resourcepack: ["Ресурспаки", "Stay True", "Fresh Animations"]
    };
    const colors = ["#1f3b57", "#2f5d3a", "#5b3a5c"];
    return {
      id: projectId,
      slug: String(projectId).replace(/^demo-\d+-/, ""),
      title: "Проект с Modrinth",
      description: "Сборка для демонстрации окна сведений",
      body: "## Что внутри\n\n- оптимизация рендера и загрузки чанков\n- набор шейдеров и ресурспаков\n- готовые настройки графики\n\n![скриншот](demo.png)\n\nПодходит для слабых и средних ПК: FPS растёт, картинка не страдает.",
      project_type: "modpack",
      categories: ["optimization", "adventure", "fabric"],
      downloads: 1245321,
      icon_url: null,
      gallery: [
        shot(titles.pack[1], colors[0]),
        shot(titles.pack[2], colors[1]),
        shot(titles.pack[0], colors[2])
      ],
      license: { id: "mit", name: "MIT License" },
      source_url: null
    };
  }

  /** Демо-режим в браузере: скин 64×64 рисуется на канвасе (в exe приходит из Rust). */
  let demoSkinCache = null;
  function demoSkinDataUrl() {
    if (demoSkinCache) return demoSkinCache;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const paint = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    paint(0, 0, 64, 64, "#00000000");
    paint(0, 0, 64, 16, "#e8b98f");   // голова
    paint(8, 0, 16, 8, "#3b2a20");    // волосы
    paint(0, 16, 64, 16, "#4a7ec8");  // тело
    paint(0, 32, 64, 32, "#2f3d55");  // ноги
    demoSkinCache = canvas.toDataURL("image/png");
    return demoSkinCache;
  }

  /** Демо-плащ 64×32: та же раскладка, что у настоящей текстуры (спина — 1..11 × 1..17). */
  function demoCapeDataUrl(kind = "migrator") {
    const palette = {
      migrator: ["#c8c8d0", "#8d8d99", "#e04b4b"],
      vanilla: ["#6f6f78", "#4b4b52", "#9a9aa2"],
      founders: ["#d8b25a", "#8a6a22", "#f0d68a"]
    }[kind] || ["#c8c8d0", "#8d8d99", "#e04b4b"];
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    const paint = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    paint(0, 0, 64, 32, palette[0]);
    paint(1, 1, 10, 16, palette[0]);
    paint(12, 1, 10, 16, palette[1]);
    paint(1, 1, 10, 3, palette[2]);
    paint(3, 6, 6, 4, palette[1]);
    paint(1, 13, 10, 1, palette[2]);
    return canvas.toDataURL("image/png");
  }

  /** Демо-прогресс: событие за событием, чтобы полоса процессов была видна. */
  let demoProgressCb = null;
  async function demoProgress(stage, detail, op = "") {
    const total = 4;
    for (let done = 0; done <= total; done += 1) {
      if (demoProgressCb) demoProgressCb({ stage, done, total, detail, op });
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    if (demoProgressCb) demoProgressCb({ stage, done: total, total, detail, state: "done", op });
  }

  /** Демо-содержимое: ресурспаки и шейдеры «как будто лежат в сборке». */
  const DEMO_ASSETS = {
    resourcepacks: [
      { name: "Stay_True_1.21.zip", size: 4_204_800, enabled: true },
      { name: "FreshAnimations_v1.9.zip", size: 1_986_560, enabled: true }
    ],
    shaderpacks: [
      { name: "ComplementaryReimagined_r5.3.zip", size: 3_112_960, enabled: true },
      { name: "BSL_v8.2.04.zip", size: 2_781_184, enabled: true }
    ]
  };

  /** Демо-обновления: по одному «новому» файлу на вид содержимого. */
  const demoUpdates = (kind) => {
    if (kind === "mod") {
      return [{
        filename: "sodium-fabric-0.6.13+mc1.21.4.jar", kind: "mod", enabled: true,
        title: "Sodium", page_url: "https://modrinth.com/mod/sodium", project_id: "AANobbMI",
        version_id: "demo-sodium-2", current: "0.6.13", latest: "0.6.15",
        download_url: "https://example.invalid/sodium.jar",
        new_filename: "sodium-fabric-0.6.15+mc1.21.4.jar", size: 1_310_720
      }];
    }
    return [];
  };

  /** Демо-файловая система сборки: список, тексты, картинки и архивы в памяти. */
  function demoFilesSeed() {
    DEMO.files = DEMO.files || { tree: {}, text: {}, images: {}, archives: {} };
    if (DEMO.files.ready) return DEMO.files;
    DEMO.files.ready = true;
    const file = (path, size) => ({ name: path.split("/").pop(), is_dir: false, size, path, modified: Math.floor(Date.now() / 1000) - 7200 });
    const dir = (path) => ({ name: path.split("/").pop(), is_dir: true, size: 0, path });
    DEMO.files.tree = {
      "": [dir("mods"), dir("config"), dir("saves"), dir("resourcepacks"), dir("shaderpacks"), dir("logs"), file("options.txt", 2048), file("servers.dat", 1420), file("usercache.json", 512)],
      mods: [file("mods/sodium-fabric-0.6.13.jar", 1102848), file("mods/iris-fabric-1.8.1.jar", 2487168), file("mods/lithium-fabric-0.15.3.jar", 620544)],
      config: [dir("config/fabric"), file("config/sodium-options.json", 3480)],
      "config/fabric": [file("config/fabric/indigo-renderer.properties", 320)],
      logs: [file("logs/latest.log", 184320), file("logs/debug.log", 917504)],
      resourcepacks: [file("resourcepacks/Stay_True_1.21.zip", 4204800), file("resourcepacks/FreshAnimations_v1.9.zip", 1986560)],
      shaderpacks: [file("shaderpacks/ComplementaryReimagined_r5.3.zip", 3112960), file("shaderpacks/BSL_v8.2.04.zip", 2781184)],
      saves: [dir("saves/Мир выживания"), dir("saves/Тест редстоуна")],
      "saves/Мир выживания": [file("saves/Мир выживания/level.dat", 81920), file("saves/Мир выживания/icon.png", 4096)]
    };
    DEMO.files.text = {
      "options.txt": "fov:0.0\nlang:ru_ru\nrenderDistance:12\nnarrator:0\nguiScale:3\n",
      "servers.dat": "",
      "config/sodium-options.json": "{\n  \"quality\": {\n    \"weather_quality\": \"FANCY\"\n  }\n}\n"
    };
    DEMO.files.archives = {
      "resourcepacks/Stay_True_1.21.zip": [
        { name: "pack.mcmeta", size: 148, packed: 120, is_dir: false },
        { name: "pack.png", size: 8124, packed: 7420, is_dir: false },
        { name: "assets/", size: 0, packed: 0, is_dir: true },
        { name: "assets/minecraft/", size: 0, packed: 0, is_dir: true },
        { name: "assets/minecraft/textures/", size: 0, packed: 0, is_dir: true },
        { name: "assets/minecraft/textures/block/dirt.png", size: 512, packed: 420, is_dir: false },
        { name: "assets/minecraft/textures/block/grass_block_top.png", size: 640, packed: 512, is_dir: false },
        { name: "assets/minecraft/textures/item/diamond.png", size: 512, packed: 430, is_dir: false },
        { name: "assets/minecraft/sounds.json", size: 2400, packed: 1100, is_dir: false }
      ],
      "resourcepacks/FreshAnimations_v1.9.zip": [
        { name: "pack.mcmeta", size: 160, packed: 130, is_dir: false },
        { name: "assets/", size: 0, packed: 0, is_dir: true },
        { name: "assets/minecraft/sounds.json", size: 1800, packed: 900, is_dir: false }
      ]
    };
    return DEMO.files;
  }

  /** Крошечная картинка для демо-просмотра (шахматка 32×32). */
  function demoPixelImage() {
    demoFilesSeed();
    if (DEMO.files.pixel) return DEMO.files.pixel;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const on = (x >> 3) % 2 === (y >> 3) % 2;
        ctx.fillStyle = on ? "#8b6f47" : "#c8b18a";
        ctx.fillRect(x, y, 1, 1);
      }
    }
    DEMO.files.pixel = canvas.toDataURL("image/png");
    return DEMO.files.pixel;
  }

  function demoFileRemove(path) {
    const parent = String(path).split("/").slice(0, -1).join("/");
    const list = DEMO.files.tree[parent] || [];
    DEMO.files.tree[parent] = list.filter((entry) => entry.path !== path);
  }

  function demoFileDelete(path) {
    demoFilesSeed();
    const prefix = `${path}/`;
    Object.keys(DEMO.files.tree).forEach((key) => {
      if (key === path || key.startsWith(prefix)) delete DEMO.files.tree[key];
    });
    demoFileRemove(path);
  }

  function demoFileWrite(path, entry) {
    demoFilesSeed();
    const parent = String(path).split("/").slice(0, -1).join("/");
    if (!DEMO.files.tree[parent]) DEMO.files.tree[parent] = [];
    if (typeof entry.is_dir !== "boolean") entry.is_dir = false;
    DEMO.files.tree[parent] = DEMO.files.tree[parent].filter((item) => item.path !== path);
    DEMO.files.tree[parent].push(entry);
    if (entry.is_dir && !DEMO.files.tree[path]) DEMO.files.tree[path] = [];
  }

  function demoFileMove(paths, dir, renameTo) {
    demoFilesSeed();
    const target = dir || "";
    let moved = 0;
    (paths || []).forEach((path) => {
      const parent = String(path).split("/").slice(0, -1).join("/");
      const list = DEMO.files.tree[parent] || [];
      const found = list.find((entry) => entry.path === path);
      if (!found || parent === target) return;
      const name = renameTo ? String(renameTo).split("/").pop() : found.name;
      const nextPath = target ? `${target}/${name}` : name;
      DEMO.files.tree[parent] = list.filter((entry) => entry.path !== path);
      if (!DEMO.files.tree[target]) DEMO.files.tree[target] = [];
      DEMO.files.tree[target].push({ ...found, name, path: nextPath });
      Object.keys(DEMO.files.tree).forEach((key) => {
        if (key.startsWith(`${path}/`)) {
          const inner = key.slice(path.length);
          DEMO.files.tree[`${nextPath}${inner}`] = DEMO.files.tree[key].map((entry) => ({
            ...entry,
            path: `${nextPath}${inner}/${entry.name}`
          }));
          delete DEMO.files.tree[key];
        }
      });
      moved += 1;
    });
    return moved;
  }

  const DEMO = {
    instances: [
      { id: "fabulously-optimized", name: "Fabulously Optimized", category: "cat-perf", mc_version: "1.21.4", loader: { type: "fabric", version: "0.16.9" }, icon: null, created: now - 86400 * 9, last_played: now - 3600, playtime_secs: 7200, memory_mb: null, java_path: null, jvm_args: null, notes: "", source: "modrinth", source_url: null, version_override: null },
      { id: "atm10", name: "All the Mods 10", category: "cat-mods", mc_version: "1.21.1", loader: { type: "neoforge", version: "21.1.72" }, icon: null, created: now - 86400 * 20, last_played: now - 86400 * 2, playtime_secs: 32000, memory_mb: 8192, java_path: null, jvm_args: null, notes: "", source: "modrinth", source_url: null, version_override: null },
      { id: "vanya-vanilla", name: "Ванилла 1.20.1", mc_version: "1.20.1", loader: { type: "vanilla" }, icon: null, created: now - 86400 * 3, last_played: null, playtime_secs: 0, memory_mb: null, java_path: null, jvm_args: null, notes: "", source: "manual", source_url: null, version_override: null },
      { id: "cobblemon", name: "Cobblemon", category: "cat-mods", mc_version: "1.21.1", loader: { type: "fabric", version: "0.16.5" }, icon: null, created: now - 86400 * 40, last_played: now - 86400 * 5, playtime_secs: 5400, memory_mb: null, java_path: null, jvm_args: null, notes: "", source: "modrinth", source_url: null, version_override: null }
    ],
    accounts: [
      { username: "Steve", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", kind: "microsoft", access_token: "demo", expires_at: 0 },
      { username: "Vanya_2012", uuid: "5627dd98-1f5e-3f4e-9c1a-2b3c4d5e6f70", kind: "offline", access_token: "" }
    ],
    active: "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    settings: { categories: [{ id: "cat-mods", name: "Моды", collapsed: false }, { id: "cat-perf", name: "Производительность", collapsed: false }], username: "Player", java_path: null, memory_mb: 4096, jvm_args: "-XX:+UseG1GC", game_args: "", auto_java: true, show_snapshots: false, verify_hashes: false, language: "ru", keep_console_open: false, enable_modrinth: true, hide_on_launch: false, minimize_to_tray: false, last_instance: null, update_repo: "Shokydo/OmniSpec", update_enabled: true, update_token: null, update_prerelease: false, theme: "dark", click_fx: "wave", discord_rpc: true, cape_view: "list" },
    versions: ["1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.18.2", "1.16.5", "1.12.2", "1.8.9"].map((id) => ({ id, type: "release", url: "", release_time: null })),
    demoLogs: [
      "[12:01:14] [main/INFO]: OmniSpec 0.1.0 — лаунчер готов к работе",
      "[12:01:14] [main/INFO]: Аккаунт: Player (offline, UUID 5627dd98-...)",
      "[12:01:15] [main/INFO]: Java 21.0.7 (Mojang runtime) — /java/java-runtime-delta/21.0.7",
      "[12:01:15] [main/INFO]: Загрузчик: Fabric 0.16.9 для Minecraft 1.21.4",
      "[12:01:16] [main/INFO]: Проверка файлов: 79 библиотек, 4041 ресурс — всё на месте",
      "[12:01:16] [Render thread/INFO]: Setting user: Player",
      "[12:01:17] [Render thread/INFO]: Backend library: LWJGL version 3.3.3",
      ""
    ]
  };

  /* ==================== API ==================== */
  // Все изменения настроек отправляем по порядку: быстрая смена галочек,
  // особенно разрешения на публикацию, не должна откатываться старой записью.
  let settingsSaveQueue = Promise.resolve();
  function saveSettingsInOrder(settings) {
    const snapshot = JSON.parse(JSON.stringify(settings));
    const next = settingsSaveQueue.catch(() => {}).then(() => invoke("save_settings", { settings: snapshot }));
    settingsSaveQueue = next;
    return next;
  }
  const realApi = {
    appInfo: () => invoke("app_info"),
    systemMemory: () => invoke("system_memory"),
    settings: () => invoke("get_settings"),
    saveSettings: saveSettingsInOrder,
    setLauncherIcon: (icon) => invoke("set_launcher_icon", { icon }),
    setLanguage: (language) => invoke("set_language", { language }),
    setCustomSound: (event, path) => invoke("set_custom_sound", { event, path }),
    customSoundData: (event) => invoke("custom_sound_data", { event }),
    instances: () => invoke("list_instances"),
    acknowledgeInstanceRenames: (acknowledgements) => invoke("acknowledge_instance_renames", { acknowledgements }),
    createInstance: (req) => invoke("create_instance", { req }),
    createInstanceForMod: (req, source, projectId, versionId, opId = null) => invoke("create_instance_for_mod", { req, source, projectId, versionId, opId }),
    deleteInstance: (id) => invoke("delete_instance", { instanceId: id }),
    updateInstance: (meta) => invoke("update_instance", { meta }),
    versions: (snapshots) => invoke("minecraft_versions", { snapshots }),
    loaderVersions: (kind, mc) => invoke("loader_versions", { kind, mcVersion: mc }),
    installInstance: (id) => invoke("install_instance", { instanceId: id }),
    launch: (id, accountUuid = null, attemptId = null) => invoke("launch_instance", { instanceId: id, accountUuid, attemptId }),
    stop: (id, runId) => invoke("stop_instance", { instanceId: id, runId: runId || null }),
    running: () => invoke("running_instances"),
    runningSessions: () => invoke("running_sessions"),
    serverKernels: () => invoke("server_kernels"),
    serverKernelVersions: (kernel) => invoke("server_kernel_versions", { kernel }),
    serverCreate: (req) => invoke("server_create", { req }),
    serverGet: (instanceId) => invoke("server_get", { instanceId }),
    serverSave: (instanceId, config) => invoke("server_save", { instanceId, config }),
    serverSetEula: (instanceId, accepted) => invoke("server_set_eula", { instanceId, accepted }),
    serverWriteIcon: (instanceId, path) => invoke("server_write_icon", { instanceId, path }),
    serverStart: (instanceId) => invoke("server_start", { instanceId }),
    serverStop: (instanceId) => invoke("server_stop", { instanceId }),
    serverKill: (instanceId) => invoke("server_kill", { instanceId }),
    serverCommand: (instanceId, command) => invoke("server_command", { instanceId, command }),
    serverSnapshot: (instanceId) => invoke("server_snapshot", { instanceId }),
    serverFiles: (instanceId, sub = null) => invoke("server_files", { instanceId, sub }),
    serverPlayers: (instanceId) => invoke("server_players", { instanceId }),
    serverAddons: (instanceId) => invoke("server_addons", { instanceId }),
    serverToggleAddon: (instanceId, path) => invoke("server_toggle_addon", { instanceId, path }),
    serverDeleteAddon: (instanceId, path) => invoke("server_delete_addon", { instanceId, path }),
    serverSearchAddons: (query, projectType, mcVersion, loader) => invoke("server_search_addons", { query, projectType, mcVersion, loader }),
    serverAddonVersions: (projectId, mcVersion, loader) => invoke("server_addon_versions", { projectId, mcVersion, loader }),
    serverInstallCatalogAddon: (instanceId, req) => invoke("server_install_catalog_addon", { instanceId, req }),
    serverInstallAddon: (instanceId, url, kind = null) => invoke("server_install_addon", { instanceId, url, kind }),
    serverBackupList: (instanceId) => invoke("server_backup_list", { instanceId }),
    serverBackupCreate: (instanceId, label, lean = true) => invoke("server_backup_create", { instanceId, label, lean }),
    serverBackupDelete: (instanceId, name) => invoke("server_backup_delete", { instanceId, name }),
    serverBackupRestore: (instanceId, name) => invoke("server_backup_restore", { instanceId, name }),
    serverSync: (instanceId, destination, direction = "push") => invoke("server_sync", { instanceId, destination, direction }),
    serverScan: (roots = []) => invoke("server_scan", { roots }),
    search: (q) => invoke("search_modrinth", q),
    modrinthVersions: (projectId, mc, loader) => invoke("modrinth_versions", { projectId, mcVersion: mc, loader }),
    installMod: (instanceId, projectId, opId = null) => invoke("install_mod", { instanceId, projectId, opId }),
    installDiagnosticMod: (instanceId, attemptId, request) => invoke("install_diagnostic_mod", { instanceId, attemptId, request }),
    installModVersion: (instanceId, versionId, opId = null, projectId = null) => invoke("install_mod_version", { instanceId, versionId, opId, projectId }),
    installModpack: (versionId, opId = null) => invoke("install_modpack", { versionId, opId }),
    cancelDownload: () => invoke("cancel_download"),
    listDir: (instanceId, sub) => invoke("list_dir", { instanceId, sub }),
    readFile: (instanceId, path) => invoke("read_text_file", { instanceId, path }),
    deleteFile: (instanceId, path) => invoke("delete_file", { instanceId, path }),
    fmCreateDir: (instanceId, path) => invoke("fm_create_dir", { instanceId, path }),
    fmRename: (instanceId, path, name) => invoke("fm_rename", { instanceId, path, name }),
    fmMove: (instanceId, paths, dir) => invoke("fm_move", { instanceId, paths, dir }),
    fmReadImage: (instanceId, path) => invoke("fm_read_image", { instanceId, path }),
    archiveList: (instanceId, path) => invoke("archive_list", { instanceId, path }),
    archiveRead: (instanceId, path, entry) => invoke("archive_read", { instanceId, path, entry }),
    mods: (instanceId) => invoke("list_mods", { instanceId }),
    modIcons: (instanceId) => invoke("mod_icons", { instanceId }),
    worldIcons: (instanceId) => invoke("world_icons", { instanceId }),
    listScreenshots: (instanceId) => invoke("list_screenshots", { instanceId }),
    screenshotThumb: (instanceId, name) => invoke("screenshot_thumb", { instanceId, name }),
    screenshotFull: (instanceId, name) => invoke("screenshot_full", { instanceId, name }),
    // содержимое сборки: моды, ресурспаки, шейдеры
    catalogInstalledMods: (instanceId, source) => invoke("catalog_installed_mods", { instanceId, source }),
    contentList: (instanceId, kind) => invoke("content_list", { instanceId, kind }),
    contentToggle: (instanceId, kind, name) => invoke("content_toggle", { instanceId, kind, name }),
    contentDelete: (instanceId, kind, name) => invoke("content_delete", { instanceId, kind, name }),
    contentUpdates: (instanceId, kind, target = null, opId = null) => invoke("content_updates", {
      instanceId,
      kind,
      mcVersion: target?.mcVersion || null,
      loader: target?.loader || null,
      opId
    }),
    contentCompatibility: (instanceId, kind, target = null, opId = null) => invoke("content_compatibility", {
      instanceId,
      kind,
      mcVersion: target?.mcVersion || null,
      loader: target?.loader || null,
      opId
    }),
    contentUpdate: (instanceId, kind, name, update, opId = null) => invoke("content_update", {
      instanceId, kind, name, update: update || null, opId
    }),
    replaceModVersion: (instanceId, kind, name, versionId, opId = null) => invoke("content_replace_version", { instanceId, kind, name, versionId, opId }),
    ensureDependencies: (instanceId, opId = null) => invoke("mods_ensure_dependencies", { instanceId, opId }),
    scanExternal: () => invoke("scan_external_launchers"),
    importExternal: (payload) => invoke("import_external", payload),
    exportInstance: (instanceId, path, format, include) => invoke("export_instance", { instanceId, path, format, include }),
    setPresence: (mode, details, stateText, startedAt, smallImage) => invoke("set_presence", { mode, details, stateText, startedAt, smallImage: smallImage || null }),
    resolvePresenceIcon: (instanceId) => invoke("resolve_presence_icon", { instanceId }),
    duplicateInstance: (instanceId) => invoke("duplicate_instance", { instanceId }),
    installZip: (payload) => invoke("import_zip", payload),
    toggleMod: (instanceId, name) => invoke("toggle_mod", { instanceId, name }),
    javas: () => invoke("list_java"),
    openPath: (path) => invoke("open_path", { path }),
    window: (action) => invoke("window_action", { action }),
    onWindowVisibility: (cb) => TAURI.event.listen("window-visibility", (e) => cb(e.payload)),
    onProgress: (cb) => TAURI.event.listen("progress", (e) => cb(e.payload)),
    onLog: (cb) => TAURI.event.listen("game-log", (e) => cb(e.payload)),
    onExit: (cb) => TAURI.event.listen("game-exit", (e) => cb(e.payload)),
    onToast: (cb) => TAURI.event.listen("toast", (e) => cb(e.payload)),
    versionInfo: () => invoke("version_info"),
    checkUpdate: () => invoke("check_update"),
    installUpdate: () => invoke("install_update"),
    netCheck: () => invoke("net_check"),
    accounts: () => invoke("accounts_info"),
    accountAddOffline: (username) => invoke("account_add_offline", { username }),
    accountSetActive: (uuid) => invoke("account_set_active", { uuid }),
    accountRename: (uuid, username) => invoke("account_rename", { uuid, username }),
    accountRemove: (uuid) => invoke("account_remove", { uuid }),
    msStart: () => invoke("ms_login_start"),
    msPoll: (deviceCode) => invoke("ms_login_poll", { deviceCode }),
    pickFile: (title, extensions) => invoke("pick_file", { title: I18N.translate(title), extensions }),
    pickFiles: (title, extensions) => invoke("pick_files", { title: I18N.translate(title), extensions }),
    pickDir: (title) => invoke("pick_dir", { title: I18N.translate(title) }),
    pickSave: (title, fileName, extensions) => invoke("pick_save_path", { title: I18N.translate(title), fileName, extensions }),
    setInstanceIconFile: (instanceId, path) => invoke("set_instance_icon_file", { instanceId, path }),
    instanceIcon: (instanceId) => invoke("instance_icon", { instanceId }),
    copyInstanceFile: (instanceId, path, sub) => invoke("copy_instance_file", { instanceId, path, sub }),
    startupFile: () => invoke("startup_file"),
    setCustomWallpaper: (path) => invoke("set_custom_wallpaper", { path }),
    downloadWallpaper: (url) => invoke("download_custom_wallpaper", { url }),
    selectWallpaperHistory: (name) => invoke("select_wallpaper_history", { name }),
    wallpaperHistoryPreview: (name) => invoke("wallpaper_history_preview", { name }),
    wallpaperSource: (source) => invoke("wallpaper_source", { source }),
    modrinthProject: (projectId) => invoke("modrinth_project", { projectId }),
    searchCurseforge: (q) => invoke("search_curseforge", q),
    installCurseforgeModpack: (projectId, fileId, opId = null) => invoke("install_curseforge_modpack", { projectId, fileId: fileId || null, opId }),
    curseforgeVersions: (projectId, mc, loader) => invoke("curseforge_versions", { projectId, mcVersion: mc, loader }),
    curseforgeCompatibilityVersions: (projectId) => invoke("curseforge_compatibility_versions", { projectId }),
    curseforgeProject: (projectId) => invoke("curseforge_project", { projectId }),
    curseforgeReady: () => invoke("curseforge_ready"),
    installCurseforge: (instanceId, projectId, fileId, opId = null) => invoke("install_curseforge", { instanceId, projectId, fileId: fileId || null, opId }),
    accountSkin: (accountUuid) => invoke("account_skin", { accountUuid: accountUuid || null }),
    accountCapes: (accountUuid) => invoke("account_capes", { accountUuid: accountUuid || null }),
    setCape: (capeId, accountUuid) => invoke("set_cape", { capeId, accountUuid: accountUuid || null }),
    applySkin: (path, variant, accountUuid) => invoke("apply_skin", { path, variant, accountUuid: accountUuid || null }),
    saveSkinPng: (dataUrl, name) => invoke("save_skin_png", { dataUrl, name }),
    imageDataUrl: (path) => invoke("image_data_url", { path }),
    importSkin: (path) => invoke("import_skin", { path }),
    instancePath: (instanceId) => invoke("instance_path", { instanceId }),
    openUrl: (url) => invoke("open_url", { url })
  };

  /** Заглушка обновления для демо-режима (чтобы можно было посмотреть окно). */
  const DEMO_UPDATE = {
    version: "0.2.0",
    current_version: "0.1.0",
    notes: "Что нового в 0.2.0:\n\n• Автообновление через GitHub Releases\n• Кнопка «Обновить и перезапустить» прямо в лаунчере\n• Исправлена установка модов с обязательными зависимостями\n• Ускорена проверка файлов после первого запуска",
    changelog: [
      { version: "0.1.1", notes: "Исправлена установка модов с обязательными зависимостями", published_at: new Date().toISOString() },
      { version: "0.1.2", notes: "Ускорена проверка файлов после первого запуска", published_at: new Date().toISOString() },
      { version: "0.2.0", notes: "Автообновление через GitHub Releases\nКнопка «Обновить и перезапустить» прямо в лаунчере", published_at: new Date().toISOString() }
    ],
    published_at: new Date().toISOString(),
    page_url: "https://github.com/Shokydo/OmniSpec/releases",
    asset_name: "OmniSpec.exe",
    asset_url: "https://github.com/Shokydo/OmniSpec/releases/latest",
    asset_size: 12582912,
    asset_digest: null
  };

  const demoMods = [
    { name: "sodium-fabric-0.6.13+mc1.21.4.jar", size: 1306799, enabled: true, project_id: "AANobbjH", version_id: "demo-sodium-1" },
    { name: "lithium-fabric-0.14.3+mc1.21.4.jar", size: 645120, enabled: true, project_id: "GVmQuU3P", version_id: "demo-lithium-1" },
    { name: "iris-fabric-1.8.8+mc1.21.4.jar", size: 9175040, enabled: true, project_id: "2DkA2pB4", version_id: "demo-iris-1" },
    { name: "modmenu-11.0.4.jar", size: 706560, enabled: false, project_id: "mOgUt4GM", version_id: "demo-modmenu-1" }
  ];

  const demoSearch = (q) => ({
    hits: [
      { project_id: "rp-complementary", title: "Complementary Reimagined", description: "Сочный ресурспак с мягким светом и чистыми текстурами.", icon_url: null, categories: ["16x", "realistic"], downloads: 15420000, author: "EminGT", project_type: "resourcepack", slug: "complementary-reimagined" },
      { project_id: "rp-fresh", title: "Fresh Animations", description: "Живые анимации мобов без потери ванильного стиля.", icon_url: null, categories: ["16x", "tweaks"], downloads: 9120000, author: "FreshLX", project_type: "resourcepack", slug: "fresh-animations" },
      { project_id: "sh-bsl", title: "BSL Shaders", description: "Мягкие тени, объёмный свет и красивое небо для слабых ПК.", icon_url: null, categories: ["shaders", "atmosphere"], downloads: 20100000, author: "capttatsu", project_type: "shader", slug: "bsl-shaders" },
      { project_id: "sh-complementary", title: "Complementary Shaders", description: "Сбалансированные шейдеры: вода, тени и свечение.", icon_url: null, categories: ["shaders", "fantasy"], downloads: 18300000, author: "EminGT", project_type: "shader", slug: "complementary-shaders" },
      { project_id: "AANobbMI", title: "Sodium", description: "Современный движок рендера: больше FPS, меньше фризов.", icon_url: null, categories: ["fabric", "optimization"], downloads: 252141115, author: "jellysquid3", project_type: "mod", slug: "sodium" },
      { project_id: "gvQqBUqZ", title: "Lithium", description: "Оптимизация игровой логики без изменения поведения игры.", icon_url: null, categories: ["fabric", "optimization"], downloads: 106922325, author: "jellysquid3", project_type: "mod", slug: "lithium" },
      { project_id: "YL57xq9U", title: "Iris Shaders", description: "Шейдеры для Fabric с поддержкой OptiFine-паков.", icon_url: null, categories: ["fabric", "shaders"], downloads: 88568147, author: "coderbot", project_type: "mod", slug: "iris" },
      { project_id: "mOgUt4GM", title: "Mod Menu", description: "Список модов и настройки прямо в игре.", icon_url: null, categories: ["fabric", "utility"], downloads: 60000000, author: "Prospector", project_type: "mod", slug: "modmenu" }
    ].filter((hit) => !q || hit.title.toLowerCase().includes(String(q.query || "").toLowerCase()))
      .filter((hit) => !q || !q.projectType || hit.project_type === q.projectType),
    total_hits: 8, offset: 0, limit: 20
  });

  const demoApi = {
    appInfo: async () => ({ home: "C:\\Users\\Player\\AppData\\Roaming\\OmniSpec", version: "0.1.0 (демо-режим)", demo: true }),
    systemMemory: async () => null, // браузер не раскрывает точный объём ОЗУ
    settings: async () => ({ ...DEMO.settings }),
    saveSettings: async (s) => { DEMO.settings = { ...s, launcher_icon: DEMO.settings.launcher_icon || "default", language: DEMO.settings.language || "ru" }; return null; },
    setLanguage: async (language) => { DEMO.settings = { ...DEMO.settings, language }; return null; },
    setCustomSound: async (event, path) => {
      const sound_custom = { ...(DEMO.settings.sound_custom || {}) };
      sound_custom[event] = { volume: 100, ...(sound_custom[event] || {}), path, file: path || null };
      DEMO.settings = { ...DEMO.settings, sound_custom };
      return { ...DEMO.settings };
    },
    customSoundData: async () => null,
    setLauncherIcon: async (icon) => { DEMO.settings = { ...DEMO.settings, launcher_icon: icon }; return null; },
    instances: async () => DEMO.instances.map((i) => ({ ...i })),
    acknowledgeInstanceRenames: async () => null,
    createInstance: async (req) => {
      const meta = { ...DEMO.instances[0], id: "demo-" + Date.now(), name: req.name, mc_version: req.mc_version, loader: req.loader || { type: "vanilla" }, last_played: null };
      DEMO.instances.unshift(meta);
      return meta;
    },
    createInstanceForMod: async (req, _source, _projectId, versionId) => {
      const meta = { ...(DEMO.instances[0] || {}), id: `demo-${Date.now()}`, name: req.name, mc_version: req.mc_version, loader: req.loader, last_played: null };
      DEMO.instances.unshift(meta);
      return { instance: meta, outcome: { installed: [`${versionId}.jar`], skipped: [] }, install_error: null, profile_warning: null };
    },
    deleteInstance: async (id) => { DEMO.instances = DEMO.instances.filter((i) => i.id !== id); return null; },
    updateInstance: async (meta) => { const i = DEMO.instances.findIndex((x) => x.id === meta.id); if (i >= 0) DEMO.instances[i] = meta; return null; },
    modrinthProject: async (projectId) => demoProject(projectId),
    curseforgeReady: async () => true,
    curseforgeProject: async (projectId) => ({
      id: projectId, slug: "create", title: "Create", project_type: "mod",
      description: "Механизмы, шестерни и автоматизация на паровой тяге.",
      body: "Create — большой технический мод: вращение, шестерни, конвейеры, поезда и сотни декоративных блоков. Всё собирается в игре и показывается в «Пончике» — встроенном справочнике.",
      categories: ["technology", "neoforge", "fabric"], downloads: 221384500, followers: 0,
      icon_url: null, source_url: null, issues_url: null, wiki_url: null, discord_url: null,
      game_versions: ["1.21.1", "1.20.1"], loaders: ["neoforge", "fabric"], gallery: [], license: null
    }),
    searchCurseforge: async (q) => {
      const SEED = [
        ["Create", "Механизмы, шестерни и автоматизация на паровой тяге."],
        ["Just Enough Items", "Все рецепты и предметы в одном окне."],
        ["JourneyMap", "Карта мира в реальном времени с миникартой."],
        ["Better Combat", "Плавные анимации боя и стойки оружия."],
        ["Farmer's Delight", "Новая еда, готовка на костре и ножи."],
        ["Alex's Mobs", "Больше 90 мобов со своим поведением."],
        ["Terralith", "Переработанная генерация мира без новых блоков."],
        ["Supplementaries", "Полезные мелочи: верёвки, знамёна, таблички."],
        ["Applied Energistics 2", "Цифровое хранилище предметов и авто-крафт."],
        ["Mekanism", "Технологии: руды, энергия, телепорты."],
        ["Twilight Forest", "Целое измерение с боссами и прогрессией."],
        ["Biomes O' Plenty", "Десятки новых биомов и деревьев."],
        ["Storage Drawers", "Ящики с отображением предметов."],
        ["Refined Storage", "Сетевое хранилище на дисках."],
        ["Botania", "Магия на цветах и мане."],
        ["Immersive Engineering", "Мультиблочные механизмы и провода."],
        ["Macaw's Bridges", "Мосты и переходы из любого материала."],
        ["Chipped", "Сотни декоративных вариантов блоков."],
        ["Structory", "Новые структуры в ванильном стиле."],
        ["Waystones", "Телепорт между деревнями и башнями."],
        ["Simply Swords", "Оружие в стиле RPG с эффектами."],
        ["Farmers Respite", "Чай, кофе и новые напитки."],
        ["Entity Culling", "Не рисует то, что не видно за стенами."],
        ["Clumps", "Склеивает сферы опыта в одну."]
      ];
      const type = (q && q.projectType) || "mod";
      const PACKS = [
        ["All the Mods 10", "300+ модов на NeoForge: технологии, магия, квесты."],
        ["Better MC", "Классическая сборка для игры с друзьями."],
        ["Cobblemon", "Покемоны в Minecraft: ловля, бои, разведение."],
        ["Fabulously Optimized", "Максимум FPS на Fabric без лишних модов."],
        ["Create: Astral", "Сборка вокруг Create и космоса."],
        ["DawnCraft", "RPG-сборка с боссами и прогрессией."],
        ["Prominence II", "Приключения, магия и технологии в одном."],
        ["RLCraft", "Хардкорная выживалка с суровыми мобами."],
        ["Vault Hunters", "Подземелья, лут и прокачка навыков."],
        ["All of Fabric 7", "Технологии и магия на Fabric."],
        ["Deceased Craft", "Зомби-апокалипсис и крафт."],
        ["Medieval MC", "Средневековый мир, замки и рыцари."],
        ["Better Adventures+", "Лёгкая приключенческая сборка."],
        ["Craft to Exile 2", "RPG с деревом навыков."],
        ["Integrated Minecraft", "Сборка вокруг Integrated Dynamics."],
        ["Monifactory", "Грегори-технологии и автоматизация."],
        ["FTB Skies 2", "Небесные острова и прогрессия."],
        ["Ars Nouveau: New Age", "Магия и заклинания."],
        ["Steam Powered", "Пар, шестерни и механизмы."],
        ["Pixelmon Modpack", "Покемоны и открытый мир."],
        ["Fear Nightfall", "Хоррор-сборка с тьмой и монстрами."],
        ["Techopolis 2", "Город технологий и логистика."],
        ["Create: Above and Beyond", "Классика Create с квестами."],
        ["Encrypted", "Сюжетная сборка с загадками."]
      ];
      const LIST = type === "modpack" ? PACKS : SEED;
      DEMO.cfPacks = DEMO.cfPacks || {};
      LIST.forEach(([name], index) => { DEMO.cfPacks[`cf-0-${index}`] = name; DEMO.cfPacks[`cf-1-${index}`] = `${name} 2`; });
      const all = [];
      for (let page = 0; page < 2; page += 1) {
        LIST.forEach(([name, description], index) => {
          all.push({
            project_id: `cf-${page}-${index}`,
            project_type: type,
            slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            author: "curseforge",
            title: page ? `${name} ${page + 1}` : name,
            description,
            categories: ["technology", "neoforge"],
            versions: ["1.21.1"],
            downloads: 221384500 - index * 3141592 - page * 777777,
            follows: 0,
            icon_url: null
          });
        });
      }
      const offset = (q && q.offset) || 0;
      const limit = (q && q.limit) || 24;
      return { hits: all.slice(offset, offset + limit), offset, limit, total_hits: all.length };
    },
    curseforgeVersions: async (projectId) => ([
      { id: "cf-file-1", project_id: projectId, name: "create-1.21.1-6.0.4.jar", version_number: "create-1.21.1-6.0.4.jar", version_type: "release", game_versions: ["1.21.1"], loaders: ["neoforge"], date_published: "2026-10-02T12:00:00Z", files: [], dependencies: [] },
      { id: "cf-file-2", project_id: projectId, name: "create-1.21.1-6.0.2.jar", version_number: "create-1.21.1-6.0.2.jar", version_type: "release", game_versions: ["1.21.1"], loaders: ["neoforge"], date_published: "2026-08-19T12:00:00Z", files: [], dependencies: [] },
      { id: "cf-file-3", project_id: projectId, name: "create-1.20.1-0.5.1.f.jar", version_number: "create-1.20.1-0.5.1.f.jar", version_type: "beta", game_versions: ["1.20.1"], loaders: ["forge"], date_published: "2025-11-05T12:00:00Z", files: [], dependencies: [] }
    ]),
    curseforgeCompatibilityVersions: async (projectId) => demoApi.curseforgeVersions(projectId, null, null),
    installCurseforge: async (_i, projectId, fileId) => ({ installed: [`${fileId || projectId}.jar`], skipped: [] }),
    installCurseforgeModpack: async (projectId, fileId) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const name = (DEMO.cfPacks && DEMO.cfPacks[projectId]) || `Модпак ${projectId}`;
      const created = { id: `cfpack-${Date.now()}`, name, mc_version: "1.21.1", loader: { type: "neoforge", version: "21.1.80" }, icon: null, last_played: Date.now() };
      DEMO.instances = [created, ...(DEMO.instances || [])];
      return created;
    },
    accountSkin: async () => {
      const active = DEMO.accounts.find((a) => a.uuid === DEMO.active);
      return { licensed: Boolean(active && active.kind === "microsoft"), variant: "classic", data_url: demoSkinDataUrl() };
    },
    accountCapes: async () => {
      const active = DEMO.accounts.find((a) => a.uuid === DEMO.active);
      const licensed = Boolean(active && active.kind === "microsoft");
      if (!licensed) return { licensed: false, capes: [] };
      const list = DEMO.capes || (DEMO.capes = [
        { id: "demo-cape-migrator", alias: "Migrator", active: true, data_url: demoCapeDataUrl("migrator") },
        { id: "demo-cape-vanilla", alias: "Vanilla", active: false, data_url: demoCapeDataUrl("vanilla") },
        { id: "demo-cape-founders", alias: "Founder's Cape", active: false, data_url: demoCapeDataUrl("founders") }
      ]);
      return { licensed: true, capes: list.map((cape) => ({ ...cape })) };
    },
    setCape: async (capeId) => {
      (DEMO.capes || []).forEach((cape) => { cape.active = capeId ? cape.id === capeId : false; });
      return { ok: true };
    },
    applySkin: async () => ({ ok: true }),
    saveSkinPng: async () => "demo/skins/preset.png",
    imageDataUrl: async () => demoSkinDataUrl(),
    importSkin: async (path) => ({
      path,
      name: String(path).split(/[\\/]/).pop().replace(/\.[^.]+$/, "") || "skin",
      data_url: demoSkinDataUrl()
    }),
    versions: async () => DEMO.versions,
    loaderVersions: async (kind) => (kind === "vanilla" ? [] : [{ version: "0.16.9", stable: true }, { version: "0.16.5", stable: true }, { version: "0.15.11", stable: false }]),
    installInstance: async () => null,
    launch: async (id, accountUuid) => {
      const account = DEMO.accounts.find((item) => item.uuid === accountUuid)
        || DEMO.accounts.find((item) => item.uuid === DEMO.active)
        || DEMO.accounts[0];
      return {
        version_id: "demo", java: "java", memory_mb: 4096, args: [], instance_id: id || "demo",
        game_dir: "", natives_dir: "", classpath_entries: 0,
        run_id: `${id || "demo"}#${Math.random().toString(36).slice(2, 6)}`,
        account: account ? account.username : ""
      };
    },
    stop: async () => null,
    running: async () => [],
    runningSessions: async () => null,
    serverKernels: async () => [
      { id: "paper", label: "Paper", group: "Bukkit-плагины", supports_plugins: true, supports_mods: false },
      { id: "purpur", label: "Purpur", group: "Bukkit-плагины", supports_plugins: true, supports_mods: false },
      { id: "fabric", label: "Fabric", group: "Модовые", supports_plugins: false, supports_mods: true },
      { id: "forge", label: "Forge", group: "Модовые", supports_plugins: false, supports_mods: true },
      { id: "neoforge", label: "NeoForge", group: "Модовые", supports_plugins: false, supports_mods: true },
      { id: "vanilla", label: "Vanilla", group: "Официальные", supports_plugins: false, supports_mods: false },
      { id: "velocity", label: "Velocity", group: "Прокси", supports_plugins: true, supports_mods: false },
      { id: "custom", label: "Другое / свой jar", group: "Другое", supports_plugins: true, supports_mods: true }
    ],
    serverKernelVersions: async () => DEMO.versions.map((item) => ({ id: item.id, label: item.id })),
    serverCreate: async (req) => ({ id: `server-${Date.now()}`, name: req.name, mc_version: req.mc_version || "", loader: { type: "vanilla" }, category: null, is_server: true, kind: "server", server: { kernel: req.kernel || "paper", mc_version: req.mc_version || "", memory_mb: req.memory_mb || 4096, port: req.port || 25565 } }),
    serverGet: async () => ({ kernel: "paper", mc_version: "1.21.4", kernel_version: "1.21.4", memory_mb: 4096, port: 25565, stop_command: "stop", jar: "server.jar" }),
    serverSave: async (_, config) => config,
    serverSetEula: async () => null,
    serverWriteIcon: async () => null,
    serverStart: async (id) => ({ instance_id: id, run_id: `${id}#server`, pid: 0, started_at: Math.floor(Date.now() / 1000) }),
    serverStop: async () => null,
    serverKill: async () => null,
    serverCommand: async () => null,
    serverSnapshot: async (id) => ({ id, config: await DEMO.settings, root: "demo/server", eula_accepted: true, running: false, metrics: { pid: null, memory_bytes: 0, cpu_percent: 0, uptime_secs: 0, tps: null }, players: [], files: [], log_tail: [] }),
    serverFiles: async () => [],
    serverPlayers: async () => [],
    serverAddons: async () => [],
    serverToggleAddon: async () => null,
    serverDeleteAddon: async () => null,
    serverSearchAddons: async () => ({ hits: [] }),
    serverAddonVersions: async () => [],
    serverInstallCatalogAddon: async () => null,
    serverInstallAddon: async () => null,
    serverBackupList: async () => [],
    serverBackupCreate: async () => null,
    serverBackupDelete: async () => null,
    serverBackupRestore: async () => null,
    serverSync: async () => null,
    serverScan: async () => [],
    search: async (q) => {
      const type = (q && q.projectType) || "mod";
      // демо-выдача никогда не смешивает типы: ресурспаки отдельно, шейдеры отдельно
      const base = demoSearch({ query: q && q.query, projectType: type }).hits;
      const SEEDS = {
        modpack: ["Fabulously Optimized", "All the Mods 10", "Cobblemon", "Better MC", "Create: Astral", "DawnCraft", "Prominence II", "RLCraft", "Vault Hunters", "All of Fabric 7", "Deceased Craft", "Medieval MC", "Better Adventures+", "Craft to Exile 2", "Integrated Minecraft", "Monifactory", "FTB Skies 2", "Ars Nouveau: New Age", "Steam Powered", "Pixelmon Modpack", "Fear Nightfall", "Techopolis 2", "Create: Above and Beyond", "Encrypted"],
        mod: ["Sodium", "Lithium", "Iris Shaders", "Mod Menu", "Fabric API", "Cloth Config", "Indium", "FerriteCore", "Krypton", "LazyDFU", "Starlight", "C2ME", "Entity Culling", "Dynamic FPS", "Reese's Sodium Options", "Zoomify", "AppleSkin", "Jade", "Roughly Enough Items", "Continuity", "Controlling", "BetterF3", "ImmediatelyFast", "No Chat Reports"],
        resourcepack: ["Complementary Reimagined", "Fresh Animations", "Stay True", "Sodium Reforged", "Better Leaves", "Visual Waxed", "Bushy Leaves", "Motschen's Better Leaves"],
        shader: ["BSL Shaders", "Complementary Shaders", "MakeUp Ultra Fast", "Sildur's Vibrant", "Rethinking Voxels", "Nostalgia Shaders", "Aurora's Shaders", "Photon Shaders"]
      };
      const seed = SEEDS[type] || SEEDS.mod;
      const all = [];
      for (let page = 0; page < 3; page += 1) {
        seed.forEach((name, index) => {
          const copy = { ...base[index % base.length] };
          copy.title = page ? `${name} ${page + 1}` : name;
          copy.project_id = `demo-${page}-${index}`;
          copy.slug = copy.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          copy.downloads = Math.max(1000, (copy.downloads || 100000) - index * 1234 - page * 5000);
          all.push(copy);
        });
      }
      const offset = (q && q.offset) || 0;
      const limit = (q && q.limit) || 24;
      return { hits: all.slice(offset, offset + limit), offset, limit, total_hits: all.length };
    },
    modrinthVersions: async () => ([
      { id: "v1", name: "Sodium 0.6.13", version_number: "0.6.13", game_versions: ["1.21.4"], loaders: ["fabric"], date_published: "2025-06-01T10:00:00Z", files: [], dependencies: [] },
      { id: "v2", name: "Sodium 0.6.9", version_number: "0.6.9", game_versions: ["1.21.2", "1.21.3"], loaders: ["fabric"], date_published: "2025-03-11T10:00:00Z", files: [], dependencies: [] },
      { id: "v3", name: "Sodium 0.5.11", version_number: "0.5.11", game_versions: ["1.20.6", "1.20.4"], loaders: ["fabric", "quilt"], date_published: "2024-11-02T10:00:00Z", files: [], dependencies: [] },
      { id: "v4", name: "Sodium 0.4.10", version_number: "0.4.10", game_versions: ["1.20.1"], loaders: ["fabric"], date_published: "2023-08-19T10:00:00Z", files: [], dependencies: [] }
    ]),
    installMod: async (_i, projectId) => ({ installed: [`${projectId}-1.0.0.jar`], skipped: [] }),
    installDiagnosticMod: async () => { throw new Error("в демо-режиме файлы модов не скачиваются"); },
    installModVersion: async () => ({ installed: ["mod.jar"], skipped: [] }),
    installModpack: async (_versionId, op) => {
      await demoProgress("modpack", "читаем манифест модпака", op);
      await demoProgress("mods", "скачиваем моды", op);
      return DEMO.instances[0];
    },
    listDir: async (_id, sub) => {
      demoFilesSeed();
      const key = sub || "";
      const list = DEMO.files.tree[key] || [];
      return list.map((entry) => ({ ...entry }));
    },
    readFile: async (_id, path) => DEMO.files.text[path] || "fov:0.0\nlang:ru_ru\nrenderDistance:12\nnarrator:0\n",
    deleteFile: async (_id, path) => { demoFileDelete(path); return null; },
    fmCreateDir: async (_id, path) => { demoFileWrite(path, { name: path.split("/").pop(), is_dir: true, size: 0, path }); return null; },
    fmRename: async (_id, path, name) => {
      const parent = path.split("/").slice(0, -1).join("/");
      const next = parent ? `${parent}/${name}` : name;
      demoFileMove([path], parent, next);
      return next;
    },
    fmMove: async (_id, paths, dir) => demoFileMove(paths, dir),
    fmReadImage: async (_id, path) => DEMO.files.images[path] || demoPixelImage(),
    archiveList: async (_id, path) => {
      const list = DEMO.files.archives[path];
      if (!list) throw new Error("в демо-режиме этот архив пуст");
      return list;
    },
    archiveRead: async (_id, path, entry) => {
      const list = DEMO.files.archives[path] || [];
      const found = list.find((item) => item.name === entry);
      if (!found) throw new Error(`в архиве нет файла «${entry}»`);
      if (/\.(png|jpg|jpeg|gif|webp)$/i.test(entry)) return { kind: "image", size: found.size, data_url: demoPixelImage(), text: null };
      return { kind: "text", size: found.size, data_url: null, text: `# ${entry}\n# демо-содержимое внутри архива\n` };
    },
    mods: async () => demoMods.map((m) => ({ ...m })),
    // В демо-режиме пример статусов, без обращения к сети и локальным файлам.
    catalogInstalledMods: async (_id, source) => source === "modrinth" ? demoMods.map((mod) => mod.project_id).filter(Boolean) : [],
    // содержимое сборки в демо-режиме
    contentList: async (_id, kind) => (kind === "mod"
      ? demoMods.map((mod) => {
        const version = /(\d+\.\d+(?:\.\d+)?)/.exec(mod.name);
        const pretty = String(mod.name).split("-")[0];
        return {
          name: mod.name,
          filename: mod.name,
          enabled: mod.enabled,
          size: mod.size,
          project_id: mod.project_id || null,
          source: mod.project_id ? "modrinth" : null,
          version_id: mod.version_id || null,
          version_number: version ? version[1] : null,
          title: pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : null
        };
      })
      : ((DEMO_ASSETS[kind === "shader" ? "shaderpacks" : "resourcepacks"] || []).map((item) => ({
        name: item.name,
        filename: item.name,
        enabled: item.enabled !== false,
        size: item.size,
        project_id: null,
        version_id: null,
        version_number: null,
        title: null
      })))),
    contentToggle: async (_id, kind, name) => {
      if (kind === "mod") {
        const mod = demoMods.find((item) => item.name === name);
        if (mod) mod.enabled = !mod.enabled;
        return name;
      }
      const list = DEMO_ASSETS[kind === "shader" ? "shaderpacks" : "resourcepacks"] || [];
      const item = list.find((entry) => entry.name === name);
      if (item) item.enabled = !(item.enabled !== false);
      return name;
    },
    contentDelete: async (_id, kind, name) => {
      if (kind === "mod") {
        const index = demoMods.findIndex((item) => item.name === name);
        if (index >= 0) demoMods.splice(index, 1);
      } else {
        const key = kind === "shader" ? "shaderpacks" : "resourcepacks";
        DEMO_ASSETS[key] = (DEMO_ASSETS[key] || []).filter((item) => item.name !== name);
      }
      return null;
    },
    contentUpdates: async (_id, kind) => demoUpdates(kind),
    contentCompatibility: async (_id, kind) => ({
      checked: kind === "mod" ? demoMods.length : 0,
      compatible: kind === "mod" ? demoMods.length : 0,
      incompatible: [],
      updates: demoUpdates(kind)
    }),
    replaceModVersion: async () => ({ installed: ["mod.jar"], skipped: [] }),
    contentUpdate: async (_id, kind, name, passed) => {
      const update = passed || demoUpdates(kind).find((item) => item.filename === name);
      if (!update) throw new Error("обновлений нет");
      if (kind === "mod") {
        const mod = demoMods.find((item) => item.name === name);
        if (mod) mod.name = update.new_filename;
      }
      return update;
    },
    ensureDependencies: async () => ({ installed: [], skipped: [] }),
    // Иконки модов в демо-режиме — те же картинки, что отдал бы Modrinth.
    worldIcons: async () => ({}),
    listScreenshots: async () => ([
      { name: "2026-11-17_12.01.14.png", size: 2845120, modified: 1763380000, path: "C:\\Users\\Player\\AppData\\Roaming\\OmniSpec\\instances\\demo\\minecraft\\screenshots\\2026-11-17_12.01.14.png" },
      { name: "2026-11-16_21.44.02.png", size: 1932288, modified: 1763290000, path: "C:\\Users\\Player\\AppData\\Roaming\\OmniSpec\\instances\\demo\\minecraft\\screenshots\\2026-11-16_21.44.02.png" },
      { name: "2026-11-15_09.12.55.png", size: 3411960, modified: 1763200000, path: "C:\\Users\\Player\\AppData\\Roaming\\OmniSpec\\instances\\demo\\minecraft\\screenshots\\2026-11-15_09.12.55.png" }
    ]),
    screenshotThumb: async () => demoPixelImage(),
    screenshotFull: async () => demoPixelImage(),
    modIcons: async () => {
      const map = {};
      demoMods.forEach((mod, index) => {
        if (index % 4 === 3) return;
        map[mod.name] = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a2a31"/><text x="32" y="41" font-family="monospace" font-size="26" fill="#7ee787" text-anchor="middle">${(mod.name || "M").slice(0, 1).toUpperCase()}</text></svg>`)}`;
      });
      return map;
    },
    scanExternal: async () => ([
      { launcher: "prism", name: "Fabulously Optimized", path: "C:\\Users\\Vanya\\AppData\\Roaming\\PrismLauncher\\instances\\fabulously-optimized\\.minecraft", mc_version: "1.21.4", loader: "fabric", loader_version: "0.16.9", icon: null },
      { launcher: "prism", name: "Create: Astral", path: "C:\\Users\\Vanya\\AppData\\Roaming\\PrismLauncher\\instances\\create-astral\\.minecraft", mc_version: "1.18.2", loader: "forge", loader_version: "40.2.10", icon: null },
      { launcher: "multimc", name: "Vanilla 1.20.1", path: "C:\\Users\\Vanya\\AppData\\Roaming\\MultiMC\\instances\\vanilla120\\.minecraft", mc_version: "1.20.1", loader: "vanilla", loader_version: "", icon: null },
      { launcher: "modrinth", name: "Cobblemon Official", path: "C:\\Users\\Vanya\\AppData\\Roaming\\ModrinthApp\\profiles\\cobblemon", mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.5", icon: null },
      { launcher: "astralrinth", name: "Astral Realms", path: "C:\\Users\\Vanya\\AppData\\Roaming\\AstralRinthApp\\profiles\\astral-realms", mc_version: "1.21.4", loader: "neoforge", loader_version: "21.4.100", icon: null },
      { launcher: "atlauncher", name: "RLCraft", path: "C:\\Users\\Vanya\\AppData\\Roaming\\ATLauncher\\Instances\\rlcraft", mc_version: "1.12.2", loader: "forge", loader_version: "14.23.5.2860", icon: null },
      { launcher: "curseforge", name: "FTB Skies", path: "C:\\Users\\Vanya\\AppData\\Roaming\\CurseForge\\Minecraft\\Instances\\FTB Skies", mc_version: "1.20.1", loader: "forge", loader_version: "47.2.0", icon: null },
      { launcher: "gdlauncher", name: "SevTech Ages", path: "C:\\Users\\Vanya\\AppData\\Roaming\\gdlauncher_next\\instances\\SevTech Ages", mc_version: "1.12.2", loader: "forge", loader_version: "14.23.5.2855", icon: null },
      { launcher: "polymc", name: "Better MC", path: "C:\\Users\\Vanya\\AppData\\Roaming\\PolyMC\\instances\\better-mc\\.minecraft", mc_version: "1.20.1", loader: "fabric", loader_version: "stable", icon: null }
    ]),
    importExternal: async (payload) => {
      const meta = { ...DEMO.instances[0], id: "demo-" + Date.now(), name: payload.name || "Imported", mc_version: payload.mcVersion, loader: payload.loader ? { type: payload.loader, version: payload.loaderVersion } : { type: "vanilla" } };
      DEMO.instances.unshift(meta);
      return meta;
    },
    exportInstance: async (_id, path) => path,
    setPresence: async () => null,
    resolvePresenceIcon: async () => null,
    duplicateInstance: async (instanceId) => {
      const meta = DEMO.instances.find((item) => item.id === instanceId);
      const copy = meta ? { ...meta, id: meta.id + "-copy", name: meta.name + " (копия)" } : { id: "copy", name: "Копия" };
      DEMO.instances.unshift(copy);
      return copy;
    },
    installZip: async (payload) => {
      await demoProgress("unzip", "распаковка архива сборки");
      await demoProgress("copy", "перенос модов и конфигов");
      const meta = { ...DEMO.instances[0], id: "demo-" + Date.now(), name: "Zip сборка", mc_version: payload.mcVersion, loader: { type: "vanilla" } };
      DEMO.instances.unshift(meta);
      return meta;
    },
    pickSave: async (_title, fileName) => `C:\\Users\\Vanya\\Downloads\\${fileName || "build.mrpack"}`,
    toggleMod: async (_i, name) => (name.endsWith(".disabled") ? name.slice(0, -9) : name + ".disabled"),
    javas: async () => ([
      { path: "C:\\OmniSpec\\java\\java-runtime-delta\\21.0.7\\bin\\javaw.exe", major: 21, vendor: "Mojang", source: "mojang" },
      { path: "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9\\bin\\javaw.exe", major: 17, vendor: "Eclipse Temurin", source: "system" }
    ]),
    openPath: async () => null,
    window: async () => null,
    onWindowVisibility: async () => () => {},
    versionInfo: async () => ({ version: "0.1.0 (демо)", repo: "Shokydo/OmniSpec", enabled: true, platform: "windows / x86_64" }),
    checkUpdate: async () => DEMO_UPDATE,
    installUpdate: async () => { await new Promise((r) => setTimeout(r, 1500)); return DEMO_UPDATE; },
    netCheck: async () => "демо-режим: связь не проверяется",
    accounts: async () => ({ accounts: DEMO.accounts.map((a) => ({ ...a })), active: DEMO.active }),
    accountAddOffline: async (username) => {
      const uuid = "demo-" + username.toLowerCase();
      DEMO.accounts.push({ username, uuid, kind: "offline", access_token: "" });
      DEMO.active = uuid;
      return { accounts: DEMO.accounts.map((a) => ({ ...a })), active: DEMO.active };
    },
    accountSetActive: async (uuid) => { DEMO.active = uuid; return { accounts: DEMO.accounts.map((a) => ({ ...a })), active: DEMO.active }; },
    accountRename: async (uuid, username) => {
      const acc = DEMO.accounts.find((a) => a.uuid === uuid);
      if (acc) acc.username = username;
      return { accounts: DEMO.accounts.map((a) => ({ ...a })), active: DEMO.active };
    },
    accountRemove: async (uuid) => {
      DEMO.accounts = DEMO.accounts.filter((a) => a.uuid !== uuid);
      if (DEMO.active === uuid) DEMO.active = DEMO.accounts[0] ? DEMO.accounts[0].uuid : null;
      return { accounts: DEMO.accounts.map((a) => ({ ...a })), active: DEMO.active };
    },
    msStart: async () => ({ user_code: "K7QP2X4MB", device_code: "demo", verification_uri: "https://www.microsoft.com/link", expires_in: 900, interval: 5 }),
    msPoll: async () => null,
    pickFile: async () => "C:\\Users\\Vanya\\Downloads\\pack.mrpack",
    pickFiles: async () => ["demo/skins/skin-a.png", "demo/skins/skin-b.png"],
    pickDir: async () => "C:\\OmniSpec",
    setInstanceIconFile: async (instanceId) => {
      const meta = DEMO.instances.find((item) => item.id === instanceId);
      if (meta) meta.icon = "icon.png";
      return meta || null;
    },
    instanceIcon: async () => null,
    copyInstanceFile: async (_id, path) => String(path).split(/[\\/]/).pop(),
    startupFile: async () => null,
    setCustomWallpaper: async () => ({ ...DEMO.settings, wallpaper: "custom" }),
    downloadWallpaper: async () => ({ ...DEMO.settings, wallpaper: "custom" }),
    selectWallpaperHistory: async (name) => { DEMO.settings = { ...DEMO.settings, wallpaper: "custom", custom_wallpaper: name }; return { ...DEMO.settings }; },
    wallpaperHistoryPreview: async () => null,
    wallpaperSource: async () => null,
    instancePath: async (id) => `demo/instances/${id}`,
    openUrl: async (url) => { window.open(url, "_blank"); return null; },
    onProgress: (cb) => { demoProgressCb = cb; return Promise.resolve(); },
    onLog: () => Promise.resolve(),
    onExit: () => Promise.resolve(),
    onToast: () => Promise.resolve()
  };

  const api = IS_APP ? realApi : demoApi;

  /* ==================== СОСТОЯНИЕ ==================== */
  const state = {
    instances: [],
    selectedId: null,
    settings: null,
    systemMemory: null,
    accounts: { accounts: [], active: null },
    tab: "console",
    running: new Set(),
    runningRevision: 0,
    sessions: new Map(),
    preparing: new Map(),
    diagnosticInstalls: new Map(),
    liveLogAvailable: !IS_APP,
    // Нативный tray скрывает всё окно, но не останавливает RPC и процессы.
    windowHidden: false,
    quiet: false,
    uiRefreshPending: false,
    compact: false,
    logs: {},
    files: { path: "", entries: [], selected: null },
    mods: [],
    modIcons: {},
    contentUpdates: {},
    contentQuery: {},
    // Проверка и массовая установка обновлений взаимно блокируются: одна
    // операция должна завершиться целиком, прежде чем пользователь запустит
    // следующую.
    contentTask: null,
    mcver: null,
    external: { list: null, loading: false, error: null },
    iconCache: {},
    modsSource: "modrinth",
    modsView: "list",
    capeView: "list",
    modsQuery: "",
    dlRoot: null,
    modrinth: {
      query: "", type: "mod", mc: "", loader: "",
      categories: { mod: "", resourcepack: "", shader: "" },
      results: [], total: 0, loading: false, loadingMore: false,
      error: null, tried: false
    },
    curseforge: {
      query: "", type: "mod", mc: "", loader: "", sort: "downloads",
      categories: { mod: "", modpack: "", resourcepack: "", shader: "" },
      results: [], total: 0, loading: false, loadingMore: false,
      error: null, tried: false
    },
    discover: {
      query: "", type: "modpack", mc: "", loader: "", categories: {
        modrinth: { modpack: "", mod: "" }, curseforge: { modpack: "", mod: "" }
      },
      versions: [], versionsLoading: false, versionsLoaded: false,
      results: [], total: 0, loading: false, loadingMore: false, error: null, moreError: null,
      retrySeconds: 0, tried: false, view: "grid", source: "modrinth", filtersCollapsed: true
    },
    wall: { wallpaper: null, fit: "cover", blur: 0, dim: 40 },
    downloads: { active: false, title: "", done: 0, total: 0, files: new Map(), state: "active", op: "", collapsed: false, timer: null },
    installedProjects: new Set(),
    // Счётчики позволяют одной из параллельных установок завершиться раньше другой.
    downloadingProjects: new Map(),
    update: { info: null, version: "0.1.0", repo: null, enabled: true, checking: false, installing: false },
    theme: "dark",
    customTheme: { ...CUSTOM_THEME_DEFAULT },
    fx: "wave",
    shape: "soft",
    customWall: null,
    wallLink: { value: "", busy: false },
    sound: { on: true, volume: 60 },
    home: {
      extOpen: false, external: null, extLoading: false, extSelected: new Set(),
      zipPath: "", versions: [], zipMc: "", zipLoader: "vanilla",
      zipLoaderVersion: "", zipLoaderVersions: [], url: "", busy: false, status: "", open: false
    },
    create: null
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Тихий режим tray: WebView перестаёт перерисовывать эффекты, логи и
   * страницы, но native RPC worker и процессы игры/сервера продолжают жить.
   */
  function setQuietMode(hidden) {
    const next = Boolean(hidden);
    if (state.windowHidden === next) return;
    state.windowHidden = next;
    state.quiet = next;
    state.uiRefreshPending = next;
    if (document.body) document.body.dataset.windowHidden = next ? "true" : "false";

    if (next) {
      ambient.pause();
      trailFx.pause();
      const wallVideo = $("#wall-video");
      if (wallVideo && !wallVideo.hidden) wallVideo.pause();
      if (logFlushRaf) {
        cancelAnimationFrame(logFlushRaf);
        logFlushRaf = 0;
      }
      if (diagnosticsRenderTimer) {
        clearTimeout(diagnosticsRenderTimer);
        diagnosticsRenderTimer = 0;
      }
      return;
    }

    ambient.resume();
    trailFx.resume();
    const wallVideo = $("#wall-video");
    if (wallVideo && !wallVideo.hidden) playWallpaperVideo(wallVideo);
    if (logPending.length && !logFlushRaf) logFlushRaf = requestAnimationFrame(flushLog);
    // Один полный снимок после показа заменяет частые обновления, пропущенные
    // в свёрнутом состоянии; присутствие в Discord синхронизируем отдельно.
    state.uiRefreshPending = false;
    renderSidebar();
    updateStatus();
    renderTab();
    refreshInstances().catch(() => {});
    syncPresence();
  }

  /** Небольшой вход только при смене страницы, а не при обновлении её данных. */
  function animateView(element) {
    if (!element) return;
    element.classList.remove("view-enter");
    void element.offsetWidth;
    element.classList.add("view-enter");
  }

  /** Общая подложка движется к активной вкладке, не меняя доступный фокус. */
  function refreshActiveIndicators() {
    if (state.windowHidden) return;
    $$(".tabs, .home-catalog-tabs, .mr-view, .modal-tabs, .prefs-nav").forEach((group) => {
      const active = group.matches(".home-catalog-tabs") ? $("[data-dv-type].is-active", group) : $(".is-active", group);
      if (!active || !active.offsetWidth || !active.offsetHeight) return;
      group.style.setProperty("--active-x", `${active.offsetLeft}px`);
      group.style.setProperty("--active-y", `${active.offsetTop}px`);
      group.style.setProperty("--active-w", `${active.offsetWidth}px`);
      group.style.setProperty("--active-h", `${active.offsetHeight}px`);
      if (!group.classList.contains("moving-indicator")) {
        group.classList.add("moving-indicator");
        requestAnimationFrame(() => { if (group.isConnected) group.classList.add("moving-animate"); });
      }
    });
  }

  /** Плавное колесо для ближайшей прокручиваемой области, с передачей на родителя у края. */
  function initSmoothScroll() {
    const animations = new WeakMap();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    window.addEventListener("wheel", (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || reduced?.matches || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      let element = event.target instanceof Element ? event.target : event.target?.parentElement;
      while (element && element !== document.documentElement) {
        const css = getComputedStyle(element);
        const max = element.scrollHeight - element.clientHeight;
        const running = animations.get(element);
        const from = running ? running.target : element.scrollTop;
        if (max > 1 && /^(auto|scroll|overlay)$/.test(css.overflowY) && ((event.deltaY > 0 && from < max - 0.5) || (event.deltaY < 0 && from > 0.5))) {
          const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
          const target = Math.max(0, Math.min(max, from + delta));
          event.preventDefault();
          if (running) { running.target = target; return; }
          const motion = { target, last: 0 };
          animations.set(element, motion);
          const step = (time) => {
            if (!element.isConnected || reduced?.matches) { animations.delete(element); return; }
            const elapsed = motion.last ? Math.min(40, time - motion.last) : 16;
            motion.last = time;
            const remaining = motion.target - element.scrollTop;
            if (Math.abs(remaining) < 4) { element.scrollTop = motion.target; animations.delete(element); return; }
            element.scrollTop += remaining * (1 - Math.exp(-elapsed / 65));
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          return;
        }
        element = element.parentElement;
      }
    }, { passive: false });
  }

  // Все ползунки памяти учитывают одну и ту же физическую ОЗУ и ограничение
  // ядра. При сбое определения честно показываем, что максимум приблизительный.
  const MEMORY_MIN = 512;
  const MEMORY_STEP = 256;
  const MEMORY_ENGINE_MAX = 65536;
  const MEMORY_UNKNOWN_MAX = 32768;
  function memoryLimits() {
    const detected = Number(state.systemMemory?.total_mb);
    const total = Number.isFinite(detected) && detected > 0 ? Math.floor(detected) : null;
    const max = total === null ? MEMORY_UNKNOWN_MAX
      : Math.max(MEMORY_MIN, Math.min(MEMORY_ENGINE_MAX, Math.floor(total / MEMORY_STEP) * MEMORY_STEP));
    return { total, max };
  }
  function memoryValue(value) {
    const n = Number(value);
    // Даже значение вне диапазона показываем как сохранённое, не переписывая его.
    return value != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : 4096;
  }
  function memoryHint(value) {
    const { total, max } = memoryLimits();
    let system;
    if (total === null) {
      system = "Не удалось определить ОЗУ компьютера; проверь объём вручную и оставь запас системе.";
    } else if (total < MEMORY_MIN) {
      system = `ОЗУ, доступная системе: ${total} МБ. Лаунчеру нужно не менее ${MEMORY_MIN} МБ для игры; ползунок недоступен.`;
    } else {
      const reserve = total >= 32768 ? 4096 : total >= 8192 ? 2048 : 1024;
      const recommended = Math.min(max, Math.floor((total - reserve) / MEMORY_STEP) * MEMORY_STEP);
      const limit = total > MEMORY_ENGINE_MAX ? ` Предел лаунчера: ${MEMORY_ENGINE_MAX} МБ.` : "";
      const guidance = recommended >= MEMORY_MIN
        ? ` Ориентир для игры — не более ${recommended} МБ: оставь хотя бы ${reserve} МБ системе и другим программам.`
          + (Number(value) > recommended ? " Сейчас запас меньше рекомендуемого." : "")
        : ` Даже минимальные ${MEMORY_MIN} МБ могут не оставить достаточно памяти системе.`;
      system = `ОЗУ, доступная системе: ${total} МБ.${limit}${guidance}`;
    }
    const saved = Number(value) > max
      ? ` Сохранено ${value} МБ — выше предела ползунка. Значение не изменится, пока ты сам не передвинешь ползунок.`
      : Number(value) < MEMORY_MIN
        ? ` Сохранено ${value} МБ — ниже минимума; при запуске применяется ${MEMORY_MIN} МБ. Значение останется прежним, пока ты не передвинешь ползунок.`
        : "";
    return system + saved;
  }
  function memoryRangeHtml(id, value, label) {
    const saved = memoryValue(value);
    const { total, max } = memoryLimits();
    const disabled = total !== null && total < MEMORY_MIN;
    return `<div class="range">
      <input type="range" id="${id}" min="${MEMORY_MIN}" max="${max}" step="${MEMORY_STEP}" value="${Math.min(saved, max)}" data-memory-dirty="false" aria-label="${esc(label)}"${disabled ? " disabled" : ""}>
      <span class="tag" id="${id}-value">${saved} МБ</span>
    </div><div class="hint memory-hint" id="${id}-hint">${esc(memoryHint(saved))}</div>`;
  }
  function updateMemoryRange(input) {
    input.dataset.memoryDirty = "true";
    const value = Number(input.value);
    const label = $(`#${input.id}-value`);
    const hint = $(`#${input.id}-hint`);
    if (label) label.textContent = `${value} МБ`;
    if (hint) hint.textContent = memoryHint(value);
  }

  // Анализирует только новые строки. Храним результаты отдельных попыток в
  // памяти текущего сеанса; сеть и файлы сборки диагностика не трогает.
  const diagnostics = new window.OmniDiagnostics.DiagnosticsStore({ onChange: diagnosticsChanged });
  let diagnosticsRenderTimer = 0;
  let attemptSerial = 0;
  function nextAttemptId() {
    return `${Date.now().toString(36)}-${(++attemptSerial).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  function diagnosticLaunchContext(meta) {
    return { mcVersion: meta.mc_version || "", loader: (meta.loader && meta.loader.type) || "vanilla",
      loaderVersion: (meta.loader && meta.loader.version) || "" };
  }
  function changePreparing(instanceId, delta) {
    const count = (state.preparing.get(instanceId) || 0) + delta;
    if (count > 0) state.preparing.set(instanceId, count);
    else state.preparing.delete(instanceId);
    updateStatus();
    diagnosticsChanged(instanceId);
  }
  function finishDemoStops(instanceId, marked) {
    if (IS_APP) return;
    for (const run of diagnostics.list(instanceId)) {
      if (marked.includes(run.id)) diagnostics.exit({ instance: instanceId, attempt_id: run.id, run_id: run.runId, code: 0 });
    }
  }

  const LOADER_NAMES = { vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };

  function loaderLabel(loader) {
    if (!loader || loader.type === "vanilla") return "Vanilla";
    return `${LOADER_NAMES[loader.type] || loader.type} ${loader.version || ""}`.trim();
  }

  function isServer(meta) {
    return Boolean(meta && (meta.is_server === true || meta.kind === "server" || meta.server));
  }

  function serverLabel(meta) {
    const config = meta && meta.server;
    if (!config) return "Сервер";
    return `${config.kernel || "Сервер"}${config.mc_version ? ` · MC ${config.mc_version}` : ""}`;
  }

  function humanSize(bytes) {
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let size = Number(bytes) || 0;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return unit === 0 ? `${size} ${units[unit]}` : `${size.toFixed(1)} ${units[unit]}`;
  }

  function toast(message, kind = "") {
    if (state.windowHidden) return;
    if (kind === "ok") semanticSound("success");
    else if (kind === "err") semanticSound("error");
    const box = document.createElement("div");
    box.className = `toast ${kind}`;
    box.textContent = message;
    $("#toasts").appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; box.style.transition = "opacity .3s"; }, 3600);
    setTimeout(() => box.remove(), 4000);
  }

  // Адресная транзакция языка не перезаписывает другие пользовательские данные.
  // Последовательная очередь и ревизия защищают быстрые переключения/ошибки.
  const LANGUAGES = [["ru", "Русский"], ["be", "Беларуская"], ["kk", "Қазақша"], ["uk", "Українська"], ["en", "English"]];
  let displayedLanguage = "ru";
  let confirmedLanguage = "ru";
  let languageGeneration = 0;
  let languageQueue = Promise.resolve();
  async function chooseLanguage(language) {
    if (!LANGUAGES.some(([code]) => code === language)) return;
    const generation = ++languageGeneration;
    displayedLanguage = language;
    state.settings = { ...(state.settings || {}), language };
    I18N.setLanguage(language);
    refreshLocalizedDerivedLabels();
    syncPresence();
    const operation = languageQueue.catch(() => {}).then(async () => {
      await api.setLanguage(language);
      confirmedLanguage = language;
    });
    languageQueue = operation;
    try { await operation; }
    catch (error) {
      if (generation !== languageGeneration) return;
      displayedLanguage = confirmedLanguage;
      state.settings = { ...(state.settings || {}), language: confirmedLanguage };
      I18N.setLanguage(confirmedLanguage);
      refreshLocalizedDerivedLabels();
      const select = $("#prefs-language");
      if (select) select.value = confirmedLanguage;
      syncPresence();
      toast(`Не удалось сохранить язык: ${error}`, "err");
    }
  }

  function localizedReleaseDate(value) {
    return new Date(value).toLocaleDateString(I18N.locale(), { day: "numeric", month: "long", year: "numeric" });
  }

  function refreshLocalizedDerivedLabels() {
    $$("[data-locale-date]").forEach((element) => {
      element.textContent = localizedReleaseDate(element.dataset.localeDate);
    });
    $$("[data-fm-modified]").forEach((element) => {
      element.textContent = fmDate(Number(element.dataset.fmModified));
    });
    $$("[data-empty-update-notes]").forEach((element) => {
      element.textContent = I18N.translate("Описание изменений не указано.");
    });
    const runSelect = $("#errors-run");
    if (runSelect && state.selectedId) {
      const runs = diagnostics.list(state.selectedId);
      for (const option of runSelect.options) {
        const run = runs.find((item) => item.id === option.value);
        if (run) option.textContent = errorsRunLabel(run);
      }
    }
    const image = projectImages[projectImageIndex];
    if (image && !image.title) {
      const caption = I18N.translate(`Изображение ${projectImageIndex + 1}`);
      $("#project-image-title").textContent = caption;
      $("#project-image-full").alt = caption;
    }
  }

  // Иконка сохраняется отдельной командой: общие снимки настроек не могут её
  // откатить. Очередь и номер выбора защищают быстрые клики и ошибки записи.
  let displayedLauncherIcon = "default";
  let confirmedLauncherIcon = "default";
  let launcherIconGeneration = 0;
  let launcherIconQueue = Promise.resolve();

  function launcherIconOption(id) {
    return LAUNCHER_ICONS.find(([value]) => value === id) || LAUNCHER_ICONS[0];
  }

  function paintLauncherIcon(id) {
    const [value, , src] = launcherIconOption(id);
    const logo = $(".tb-logo img");
    if (logo) { logo.setAttribute("src", src); logo.dataset.launcherIcon = value; }
    $$("#launcher-icon-grid input[name='launcher-icon']").forEach((radio) => { radio.checked = radio.value === value; });
  }

  async function chooseLauncherIcon(id) {
    if (!LAUNCHER_ICONS.some(([value]) => value === id)) return;
    const generation = ++launcherIconGeneration;
    displayedLauncherIcon = id;
    state.settings = { ...(state.settings || {}), launcher_icon: id };
    paintLauncherIcon(id);
    const operation = launcherIconQueue.catch(() => {}).then(async () => {
      await api.setLauncherIcon(id);
      confirmedLauncherIcon = id;
    });
    launcherIconQueue = operation;
    try {
      await operation;
      if (generation === launcherIconGeneration) {
        state.settings = { ...(state.settings || {}), launcher_icon: displayedLauncherIcon };
      }
    } catch (error) {
      if (generation === launcherIconGeneration) {
        displayedLauncherIcon = confirmedLauncherIcon;
        state.settings = { ...(state.settings || {}), launcher_icon: displayedLauncherIcon };
        paintLauncherIcon(displayedLauncherIcon);
      }
      toast(`Не удалось сохранить иконку лаунчера: ${error}`, "err");
    }
  }

  const selected = () => state.instances.find((item) => item.id === state.selectedId) || null;

  /* ==================== ЛОГИ ==================== */
  /** В DOM держим только хвост лога: вся консоль не грузится, прокрутка не лагает. */
  const LOG_TAIL = 300;
  const LOG_TAIL_STEP = 300;
  const LOG_SEARCH_LIMIT = 400;

  /** Сколько строк сейчас в DOM: считаем сами, querySelectorAll на каждой строке — тормоза. */
  let logDrawnLines = 0;

  function logTailSize(instanceId) {
    if (!state.logTails) state.logTails = new Map();
    return state.logTails.get(instanceId) || LOG_TAIL;
  }

  function setLogTailSize(instanceId, size) {
    if (!state.logTails) state.logTails = new Map();
    state.logTails.set(instanceId, Math.max(LOG_TAIL, Math.round(size)));
  }

  function logAtBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function logLineNode(index, entry) {
    const line = document.createElement("div");
    line.className = "log-line";
    line.dataset.index = String(index);
    line.innerHTML = `<span class="log-num">${index + 1}</span><span class="log-text ${entry.kind}">${esc(entry.line)}</span>`;
    return line;
  }

  /** Кнопка «показать ещё» над хвостом: подгружает по 300 строк, без перерисовки всего лога. */
  function syncLogMore(instanceId) {
    const consoleEl = $("#console-out");
    if (!consoleEl) return;
    let more = consoleEl.querySelector(".log-more");
    const first = consoleEl.querySelector(".log-line");
    const hidden = first ? Number(first.dataset.index) || 0 : 0;
    if (!hidden) {
      if (more) more.remove();
      return;
    }
    if (!more) {
      more = document.createElement("button");
      more.className = "log-more";
      more.addEventListener("click", () => {
        setLogTailSize(instanceId, logTailSize(instanceId) + LOG_TAIL_STEP);
        renderLogs(instanceId, { keepScroll: true });
      });
      const before = consoleEl.scrollHeight;
      consoleEl.prepend(more);
      consoleEl.scrollTop += consoleEl.scrollHeight - before;
    }
    more.textContent = `Показать ещё ${Math.min(LOG_TAIL_STEP, hidden)} строк · выше ещё ${hidden}`;
  }

  /** Новые строки копим и вставляем раз в кадр: без layout на каждую строку. */
  let logPending = [];
  let logFlushRaf = 0;

  function flushLog() {
    logFlushRaf = 0;
    if (state.windowHidden) return;
    const consoleEl = $("#console-out");
    const instanceId = state.selectedId;
    if (!consoleEl || !logPending.length) {
      logPending = [];
      return;
    }
    const list = state.logs[instanceId] || [];
    const stick = logAtBottom(consoleEl);
    const tail = logTailSize(instanceId);
    const incoming = logPending.length;
    const fragment = document.createDocumentFragment();
    logPending.forEach((index) => {
      const entry = list[index];
      if (entry) fragment.appendChild(logLineNode(index, entry));
    });
    logPending = [];
    const empty = consoleEl.querySelector(".empty-state");
    if (empty) empty.remove();
    const heightBefore = consoleEl.scrollHeight;
    consoleEl.appendChild(fragment);
    logDrawnLines += incoming;
    // в DOM держим ровно хвост: старое сверху срезаем
    let dropped = 0;
    if (logDrawnLines > tail) {
      dropped = logDrawnLines - tail;
      const nodes = consoleEl.querySelectorAll(".log-line");
      for (let i = 0; i < dropped && i < nodes.length; i += 1) nodes[i].remove();
      logDrawnLines -= dropped;
    }
    if (stick) {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    } else if (dropped) {
      // читают выше — компенсируем сдвиг, чтобы текст не прыгал
      consoleEl.scrollTop -= heightBefore - consoleEl.scrollHeight;
      syncLogMore(instanceId);
    }
    const count = $("#log-count");
    if (count) count.textContent = logDrawnLines < list.length ? `хвост ${logDrawnLines} из ${list.length} строк` : `${list.length} строк`;
  }

  function pushLog(instanceId, line, kind = "") {
    const list = state.logs[instanceId] || (state.logs[instanceId] = []);
    list.push({ line, kind });
    if (list.length > 4000) {
      list.splice(0, 500);
      if (!state.windowHidden && state.tab === "console" && state.selectedId === instanceId) {
        logPending = [];
        renderLogs(instanceId);
      }
      return;
    }
    if (state.windowHidden || state.tab !== "console" || state.selectedId !== instanceId || state.logQuery) return;
    logPending.push(list.length - 1);
    if (!logFlushRaf) logFlushRaf = requestAnimationFrame(flushLog);
  }

  /** Отрисовка консоли: хвост лога, поиск по всему логу, «показать ещё» сверху. */
  function renderLogs(instanceId, options = {}) {
    const consoleEl = $("#console-out");
    if (!consoleEl) return;
    const list = state.logs[instanceId] || [];
    const query = options.query !== undefined ? options.query : (state.logQuery || "");
    const term = String(query || "").trim().toLowerCase();
    const previousTop = consoleEl.scrollTop;
    const previousHeight = consoleEl.scrollHeight;
    consoleEl.innerHTML = "";

    logDrawnLines = 0;
    if (!list.length) {
      consoleEl.innerHTML = `<div class="empty-state">Лог пуст</div>`;
      return;
    }

    if (term) {
      const hits = [];
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].line.toLowerCase().includes(term)) {
          hits.push(i);
          if (hits.length >= LOG_SEARCH_LIMIT) break;
        }
      }
      const note = document.createElement("div");
      note.className = "log-note";
      note.textContent = !hits.length
        ? "Ничего не найдено"
        : (hits.length >= LOG_SEARCH_LIMIT
          ? `Первые ${LOG_SEARCH_LIMIT} совпадений — уточни запрос`
          : `Совпадений: ${hits.length}`);
      consoleEl.appendChild(note);
      hits.forEach((index) => consoleEl.appendChild(logLineNode(index, list[index])));
      logDrawnLines = hits.length;
      consoleEl.scrollTop = 0;
      return;
    }

    const tail = logTailSize(instanceId);
    const from = Math.max(0, list.length - tail);
    for (let i = from; i < list.length; i += 1) consoleEl.appendChild(logLineNode(i, list[i]));
    logDrawnLines = list.length - from;
    syncLogMore(instanceId);
    if (options.keepScroll) {
      consoleEl.scrollTop = previousTop + (consoleEl.scrollHeight - previousHeight);
    } else {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
    const count = $("#log-count");
    if (count) {
      count.textContent = list.length > tail ? `хвост ${tail} из ${list.length} строк` : `${list.length} строк`;
    }
  }

  function classify(line) {
    const lower = line.toLowerCase();
    if (lower.includes("error") || lower.includes("exception") || lower.includes("fatal") || lower.includes("crash")) return "err";
    if (lower.includes("warn")) return "warn";
    if (lower.includes("готово") || lower.includes("успешно") || lower.includes("setting user")) return "ok";
    if (lower.startsWith("[cmd]") || lower.includes("omnispec")) return "dim";
    return "";
  }

  /* ==================== САЙДБАР ==================== */
  /** Сессии запуска: у сборки может работать несколько окон (дубликаты). */
  function addSession(instanceId, runId, account, startedAt) {
    if (!state.sessions) state.sessions = new Map();
    if (!state.sessions.has(instanceId)) state.sessions.set(instanceId, new Map());
    const key = runId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    state.sessions.get(instanceId).set(key, { account: account || "", runId: key, startedAt: Number(startedAt) || Math.floor(Date.now() / 1000) });
    state.running.add(instanceId);
    state.runningRevision += 1;
  }

  /** Сессии сборки: первая — обычный запуск, остальные — дубликаты. */
  function sessionsOf(instanceId) {
    const map = state.sessions && state.sessions.get(instanceId);
    return map ? Array.from(map.values()) : [];
  }

  function dropSession(instanceId, runId) {
    if (!state.sessions) state.sessions = new Map();
    const map = state.sessions.get(instanceId);
    if (map) {
      if (runId) map.delete(runId);
      else map.clear();
      if (!map.size) state.sessions.delete(instanceId);
    }
    if (!state.sessions.has(instanceId)) state.running.delete(instanceId);
    state.runningRevision += 1;
  }

  /** Категории сборок: из настроек + динамическая «Запущенные». */
  function categoriesOf() {
    const list = (state.settings && Array.isArray(state.settings.categories)) ? state.settings.categories : [];
    return list.filter((item) => item && item.id);
  }

  async function saveCategories(next) {
    state.settings = { ...(state.settings || {}), categories: next };
    try { await api.saveSettings(state.settings); } catch (error) { /* не критично */ }
  }

  function instanceRowHtml(item, options = {}) {
    const running = state.running.has(item.id);
    const sessions = running ? sessionsOf(item.id) : [];
    // первый запуск — сама сборка, остальные — дубликаты отдельными нодами
    const dups = options.dups ? sessions.slice(1) : [];
    const dupsHtml = dups.length
      ? `<div class="instance-dups">${dups.map((session) => `
          <div class="instance-dup" data-dup-of="${esc(item.id)}" data-run-id="${esc(session.runId || "")}" title="Дубликат сборки${session.account ? ` · ${esc(session.account)}` : ""} — ПКМ, чтобы выключить">
            <span class="dup-branch"></span>
            <span class="dup-name">дубликат</span>
            ${session.account ? `<span class="dup-sep">·</span><span class="dup-account" translate="no">${esc(session.account)}</span>` : ""}
          </div>`).join("")}</div>`
      : "";
    return `<div class="instance-wrap">
      <div class="instance ${item.id === state.selectedId ? "is-active" : ""}" data-id="${esc(item.id)}">
        <div class="instance-icon" translate="no">${instanceIconHtml(item)}</div>
        <div class="instance-body">
          <div class="instance-name" translate="no">${esc(item.name)}</div>
          <div class="instance-sub">${isServer(item) ? esc(serverLabel(item)) : `MC ${esc(item.mc_version)} · ${esc(loaderLabel(item.loader))}`}${sessions.length > 1 ? ` · <span class="dup-count">${sessions.length} окна</span>` : ""}</div>
        </div>
        <span class="instance-time" title="Время игры">${esc(playtimeLabel(item.playtime_secs))}</span>
        ${running ? '<div class="instance-running" title="Запущена"></div>' : ""}
      </div>
      ${dupsHtml}
    </div>`;
  }


  function catGroupHtml({ id, name, items, open, running }) {
    return `<div class="cat ${open ? "is-open" : ""} ${running ? "cat-running" : ""}" data-cat="${esc(id || "")}">
      <div class="cat-head ${running ? "cat-run" : ""}" data-cat-head="${esc(id || "")}">
        <svg class="ic cat-chev"><use href="#i-chev"/></svg>
        <span class="cat-name" ${id && id !== "__running" ? 'translate="no"' : ""}>${esc(name)}</span>
        <span class="cat-count">${items.length}</span>
        ${!id || id === "__running" ? "" : `<div class="spacer"></div>
        <button class="icon-btn cat-act" data-cat-new="${esc(id || "")}" title="Создать сборку в этой категории"><svg class="ic"><use href="#i-plus"/></svg></button>
        <button class="icon-btn cat-act" data-cat-import="${esc(id || "")}" title="Загрузить сборку сюда"><svg class="ic"><use href="#i-download"/></svg></button>`}
      </div>
      <div class="cat-items">${items.map((item) => instanceRowHtml(item, { dups: Boolean(running) })).join("")}</div>
    </div>`;
  }

  function renderSidebar() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    const list = $("#instance-list");
    const filter = ($("#instance-search").value || "").toLowerCase();
    const items = state.instances.filter((item) => item.name.toLowerCase().includes(filter));
    const count = $("#instances-count");
    if (count) count.textContent = String(state.instances.length);
    const activeCount = $("#active-count");
    if (activeCount) activeCount.textContent = `${state.running.size}/${state.instances.length}`;

    if (!items.length) {
      list.classList.add("is-empty");
      list.innerHTML = `<div class="list-empty">
        <div>${state.instances.length ? "Ничего не найдено" : "Сборок пока нет"}</div>
        <div class="muted">ПКМ по списку → создать или загрузить</div>
      </div>`;
      bindSidebarEvents();
      return;
    }
    list.classList.remove("is-empty");

    const categories = categoriesOf();
    const runningItems = items.filter((item) => state.running.has(item.id));
    const blocks = [];
    // динамическая категория сверху — только пока что-то запущено
    if (runningItems.length) {
      blocks.push(catGroupHtml({
        id: "__running",
        name: "ЗАПУЩЕННЫЕ",
        items: runningItems,
        open: true,
        running: true
      }));
    }
    const used = new Set();
    categories.forEach((category) => {
      const own = items.filter((item) => item.category === category.id);
      own.forEach((item) => used.add(item.id));
      blocks.push(catGroupHtml({
        id: category.id,
        name: category.name,
        items: own,
        open: !category.collapsed
      }));
    });
    const loose = items.filter((item) => !used.has(item.id));
    if (loose.length) {
      blocks.push(catGroupHtml({
        id: "",
        name: categories.length ? "БЕЗ КАТЕГОРИИ" : "ВСЕ СБОРКИ",
        items: loose,
        open: !looseCollapsed()
      }));
    }
    list.innerHTML = blocks.join("");
    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    const list = $("#instance-list");
    // пустое место списка: создать / загрузить сборку / создать категорию
    list.oncontextmenu = (event) => {
      const head = event.target.closest(".cat-head");
      if (event.target.closest(".instance")) return; // по строке работает своё меню
      event.preventDefault();
      if (head && head.dataset.catHead) openCategoryMenu(event.clientX, event.clientY, head.dataset.catHead);
      else openListMenu(event.clientX, event.clientY);
    };

    $$(".instance", list).forEach((el) => {
      el.addEventListener("click", () => {
        if (consumeDragClick()) return;
        openInstance(el.dataset.id);
      });
      // двойной клик по сборке — сразу запускаем игру
      el.addEventListener("dblclick", (event) => {
        event.preventDefault();
        launchFromList(el.dataset.id);
      });
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const meta = state.instances.find((item) => item.id === el.dataset.id);
        if (meta) openInstanceMenu(event.clientX, event.clientY, meta);
      });
      el.addEventListener("mousedown", (event) => beginInstanceDrag(event, el));
    });

    // кнопки в заголовке категории: создать / загрузить сборку сразу в эту папку
    $$(".cat-act", list).forEach((btn) => btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const catId = btn.dataset.catNew || btn.dataset.catImport || "";
      if (btn.dataset.catNew !== undefined) {
        openCreate({ category: catId || null });
        return;
      }
      await importFromExplorer(catId || null);
    }));

    $$(".instance-dup", list).forEach((el) => {
      el.addEventListener("click", () => {
        if (el.dataset.dupOf) openInstance(el.dataset.dupOf);
      });
      // ПКМ по самому дубликату — выключить именно это окно игры
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const session = sessionsOf(el.dataset.dupOf).find((item) => item.runId === el.dataset.runId);
        openDupMenu(event.clientX, event.clientY, el.dataset.dupOf, el.dataset.runId, session ? session.account : "");
      });
    });

    // папка-категория: клик по заголовку сворачивает, drag переносит сборку
    $$(".cat", list).forEach((group) => {
      const id = group.dataset.cat;
      const head = group.querySelector(".cat-head");
      if (!head || id === "__running") return;
      head.addEventListener("click", () => {
        if (consumeDragClick()) return;
        if (id) toggleCategory(id); else toggleLoose();
      });
      // перетаскивание самих категорий: меняем их порядок
      if (id) head.addEventListener("mousedown", (event) => beginCategoryDrag(event, id, group));
      head.dataset.dropCat = id;
      group.dataset.dropCat = id;
    });
    // сброс категории — перетащить на «Все сборки»/пустое место списка
    list.dataset.dropCat = "__none";
    if (!list.dataset.dragBound) {
      list.dataset.dragBound = "1";
      list.addEventListener("mousemove", () => {});
    }
  }

  /* ── перетаскивание сборок между категориями (свой drag: HTML5 DnD в WebView2 режется) ── */
  let dragState = null;
  let dragClickGuard = false;
  const consumeDragClick = () => {
    if (!dragClickGuard) return false;
    dragClickGuard = false;
    return true;
  };

  /** После переноса гасим один клик, но не дольше 300 мс: иначе съедался следующий. */
  function armDragClickGuard() {
    dragClickGuard = true;
    setTimeout(() => { dragClickGuard = false; }, 300);
  }

  function beginInstanceDrag(event, row) {
    if (event.button !== 0) return;
    if (event.target.closest(".instance-dup")) return;
    dragState = {
      id: row.dataset.id,
      row,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      ghost: null,
      target: null
    };
    window.addEventListener("mousemove", onInstanceDragMove);
    window.addEventListener("mouseup", onInstanceDragEnd);
  }

  function clearDropHighlight() {
    $$(".cat-head.is-drop, .instance-list.is-drop").forEach((el) => el.classList.remove("is-drop"));
  }

  function onInstanceDragMove(event) {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.active && Math.hypot(dx, dy) < 5) return;
    if (!dragState.active) {
      dragState.active = true;
      const meta = state.instances.find((item) => item.id === dragState.id);
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.innerHTML = `<span class="drag-ghost-name" translate="no">${esc(meta ? meta.name : "сборка")}</span>`;
      document.body.appendChild(ghost);
      dragState.ghost = ghost;
      dragState.row.classList.add("is-drag");
      document.body.classList.add("is-dragging");
    }
    dragState.ghost.style.left = `${event.clientX + 12}px`;
    dragState.ghost.style.top = `${event.clientY + 10}px`;

    const under = document.elementFromPoint(event.clientX, event.clientY);
    const group = under ? under.closest(".cat[data-drop-cat]") : null;
    const inList = under ? under.closest("#instance-list") : null;
    clearDropHighlight();
    if (group && group.dataset.dropCat !== "__running") {
      dragState.target = group.dataset.dropCat || null;
      const head = group.querySelector(".cat-head");
      if (head) head.classList.add("is-drop");
    } else if (inList) {
      dragState.target = "__none";
      $("#instance-list").classList.add("is-drop");
    } else {
      dragState.target = undefined;
    }
  }

  async function onInstanceDragEnd() {
    window.removeEventListener("mousemove", onInstanceDragMove);
    window.removeEventListener("mouseup", onInstanceDragEnd);
    if (!dragState) return;
    const drag = dragState;
    dragState = null;
    clearDropHighlight();
    document.body.classList.remove("is-dragging");
    if (drag.ghost) drag.ghost.remove();
    if (drag.row) drag.row.classList.remove("is-drag");
    if (!drag.active) return;
    armDragClickGuard();
    if (drag.target === undefined) return;
    await moveInstanceToCategory(drag.id, drag.target === "__none" ? null : drag.target);
  }

  /** «Без категории» сворачивается так же, как обычные категории. */
  function looseCollapsed() {
    return Boolean(state.settings && state.settings.loose_collapsed);
  }

  async function toggleLoose() {
    const next = !looseCollapsed();
    state.settings = { ...(state.settings || {}), loose_collapsed: next };
    renderSidebar();
    try { await api.saveSettings(state.settings); } catch (error) { /* не критично */ }
  }

  /* ── перетаскивание категорий: порядок в списке ── */
  let catDrag = null;

  function clearCatDrop() {
    $$(".cat.is-drop-before, .cat.is-drop-after").forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
  }

  function beginCategoryDrag(event, id, group) {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;   // кнопки в шапке категории не тащим
    catDrag = { id, group, startX: event.clientX, startY: event.clientY, active: false, ghost: null, target: null, after: false };
    window.addEventListener("mousemove", onCategoryDragMove);
    window.addEventListener("mouseup", onCategoryDragEnd);
  }

  function onCategoryDragMove(event) {
    const drag = catDrag;
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, dy) < 5) return;
    if (!drag.active) {
      drag.active = true;
      const category = categoriesOf().find((item) => item.id === drag.id);
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.innerHTML = `<span class="drag-ghost-name" translate="no">${esc(category ? category.name : "категория")}</span>`;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.group.classList.add("is-drag");
      document.body.classList.add("is-dragging");
    }
    drag.ghost.style.left = `${event.clientX + 12}px`;
    drag.ghost.style.top = `${event.clientY + 10}px`;
    clearCatDrop();
    drag.target = null;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const target = under ? under.closest(".cat[data-cat]") : null;
    if (!target) return;
    const targetId = target.dataset.cat;
    if (!targetId || targetId === "__running" || targetId === drag.id) return;
    const rect = target.querySelector(".cat-head").getBoundingClientRect();
    drag.target = targetId;
    drag.after = event.clientY > rect.top + rect.height / 2;
    target.classList.add(drag.after ? "is-drop-after" : "is-drop-before");
  }

  async function onCategoryDragEnd() {
    window.removeEventListener("mousemove", onCategoryDragMove);
    window.removeEventListener("mouseup", onCategoryDragEnd);
    const drag = catDrag;
    catDrag = null;
    if (!drag) return;
    clearCatDrop();
    document.body.classList.remove("is-dragging");
    if (drag.ghost) drag.ghost.remove();
    drag.group.classList.remove("is-drag");
    if (!drag.active) return;
    armDragClickGuard();
    if (!drag.target) return;
    await reorderCategories(drag.id, drag.target, drag.after);
  }

  /** Поставить категорию перед/после другой и сохранить порядок. */
  async function reorderCategories(fromId, toId, after) {
    const list = categoriesOf().slice();
    const fromIndex = list.findIndex((item) => item.id === fromId);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    let toIndex = list.findIndex((item) => item.id === toId);
    if (toIndex < 0) { renderSidebar(); return; }
    if (after) toIndex += 1;
    list.splice(toIndex, 0, moved);
    state.settings = { ...(state.settings || {}), categories: list };
    renderSidebar();
    await saveCategories(list);
  }

  async function toggleCategory(id) {
    const categories = categoriesOf().map((category) =>
      category.id === id ? { ...category, collapsed: !category.collapsed } : category);
    // сначала фиксируем новое состояние, иначе список рисуется по старому и «прыгает»
    state.settings = { ...(state.settings || {}), categories };
    renderSidebar();
    await saveCategories(categories);
  }

  async function moveInstanceToCategory(instanceId, categoryId) {
    const meta = state.instances.find((item) => item.id === instanceId);
    if (!meta) return;
    if ((meta.category || null) === (categoryId || null)) return;
    try {
      await api.updateInstance({ ...meta, category: categoryId || null });
      meta.category = categoryId || null;
      renderSidebar();
      const name = categoryId ? (categoriesOf().find((c) => c.id === categoryId) || {}).name : "";
      toast(categoryId ? `Перенесено в «${name}»` : "Убрано из категории", "ok");
    } catch (err) { toast(String(err), "err"); }
  }

  /** ПКМ по ноде дубликата: выключить именно это окно игры. */
  function openDupMenu(x, y, instanceId, runId, account) {
    const meta = state.instances.find((item) => item.id === instanceId);
    fillCtxMenu(x, y, `
      <div class="ctx-caption">Дубликат${account ? ` · ${esc(account)}` : ""}</div>
      <button class="ctx-item" data-act="focus"><svg class="ic"><use href="#i-house"/></svg>Открыть сборку</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="stop-dup"><svg class="ic"><use href="#i-close"/></svg>Выключить дубликат</button>`, async (act) => {
      if (act === "focus" && meta) { openInstance(meta.id); return; }
      if (act !== "stop-dup") return;
      const marked = diagnostics.requestStop(instanceId, runId);
      try {
        await api.stop(instanceId, runId);
        finishDemoStops(instanceId, marked);
        dropSession(instanceId, runId);
        renderSidebar();
        renderTab();
        updateStatus();
        toast("Дубликат выключен", "ok");
      } catch (error) {
        diagnostics.undoStop(instanceId, marked);
        const text = String(error);
        // окно могло закрыться само — тогда просто убираем ноду из списка
        if (text.includes("не запущена")) {
          dropSession(instanceId, runId);
          renderSidebar();
          renderTab();
          updateStatus();
          toast("Дубликат уже закрыт", "");
          return;
        }
        toast(`Не удалось выключить дубликат: ${text}`, "err");
      }
    });
  }

  /** ПКМ по пустому месту списка сборок. */
  function openListMenu(x, y) {
    fillCtxMenu(x, y, `
      <div class="ctx-caption">Сборки</div>
      <button class="ctx-item" data-act="create"><svg class="ic"><use href="#i-plus"/></svg>Создать</button>
      <button class="ctx-item" data-act="import"><svg class="ic"><use href="#i-download"/></svg>Загрузить сборку</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="category"><svg class="ic"><use href="#i-folder"/></svg>Создать категорию</button>`, (act) => {
      if (act === "create") openCreate();
      if (act === "import") importFromExplorer();
      if (act === "category") createCategoryPrompt();
    });
  }

  /** ПКМ по названию категории. */
  function openCategoryMenu(x, y, id) {
    const category = categoriesOf().find((item) => item.id === id);
    if (!category) return openListMenu(x, y);
    fillCtxMenu(x, y, `
      <div class="ctx-caption" translate="no">${esc(category.name)}</div>
      <button class="ctx-item" data-act="rename"><svg class="ic"><use href="#i-pencil"/></svg>Переименовать</button>
      <button class="ctx-item" data-act="collapse"><svg class="ic"><use href="#i-chev"/></svg>${category.collapsed ? "Раскрыть" : "Свернуть"}</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Удалить категорию</button>`, async (act) => {
      if (act === "rename") {
        const name = await promptModal({ title: "Категория", label: "Название", value: category.name });
        if (!name) return;
        await saveCategories(categoriesOf().map((item) => item.id === id ? { ...item, name } : item));
        renderSidebar();
      }
      if (act === "collapse") await toggleCategory(id);
      if (act === "delete") {
        const okCategory = await askConfirm({
          title: "Удалить категорию",
          text: `Категория «${category.name}» будет удалена. Сборки останутся в списке.`,
          ok: "Удалить"
        });
        if (!okCategory) return;
        const own = state.instances.filter((item) => item.category === id);
        for (const item of own) {
          try {
            await api.updateInstance({ ...item, category: null });
            item.category = null;
          } catch (error) { /* пропускаем */ }
        }
        await saveCategories(categoriesOf().filter((item) => item.id !== id));
        renderSidebar();
        toast("Категория удалена", "ok");
      }
    });
  }

  async function createCategoryPrompt() {
    const name = await promptModal({ title: "Новая категория", label: "Название", value: "" });
    if (!name) return;
    const id = `cat-${Date.now().toString(36)}`;
    await saveCategories([...categoriesOf(), { id, name, collapsed: false }]);
    renderSidebar();
    toast(`Категория «${name}» создана`, "ok");
  }

  /** Загрузка готовой сборки из проводника (.mrpack / .zip). */
  async function importFromExplorer(categoryId = null) {
    const path = await api.pickFile("Загрузить сборку", ["mrpack", "zip"]).catch(() => null);
    if (!path) return;
    await installMrpackPath(path, categoryId);
  }

  /* ==================== DISCORD RICH PRESENCE ==================== */
  const APP_STARTED_AT = Math.floor(Date.now() / 1000);
  const RPC_ASSET_ROOT = "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/apps/omnispec-app/ui/assets/rpc";
  const RPC_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ?";
  let presenceStartedAt = null;
  let presenceSequence = 0;
  let presenceSendQueue = Promise.resolve();
  let presenceIconEpoch = 0;
  const presenceIconCache = new Map();
  const presenceIconPending = new Map();

  function invalidatePresenceIcon() {
    presenceIconEpoch += 1;
    presenceSequence += 1; // незавершённые ответы относятся к прежней иконке
    presenceIconCache.clear();
  }

  /** Встроенные иконки и буквы уже опубликованы вместе с лаунчером. */
  function presenceFallbackIcon(meta) {
    if (meta.icon && INSTANCE_ICONS.includes(meta.icon)) return `${RPC_ASSET_ROOT}/${meta.icon}.png`;
    let first = Array.from(String(meta.name || "").trim())[0] || "?";
    first = Array.from(first.toUpperCase())[0] || "?";
    if (!RPC_LETTERS.includes(first)) first = "?";
    return `${RPC_ASSET_ROOT}/letter-${first.codePointAt(0).toString(16).padStart(4, "0")}.png`;
  }

  /** Статус Discord: большой логотип и, по настройке, иконка сборки. */
  function syncPresence(forceMode) {
    if (!IS_APP) return;
    const sequence = ++presenceSequence;
    const selectedMeta = selected();
    // Локальные Minecraft-серверы не публикуем в Discord RPC: даже если
    // сервер запущен, он не должен вытеснять обычную игровую сборку из статуса.
    // `account: "server"` — дополнительная защита для старого бэкенда, который
    // ещё мог не добавить is_server в список сборок.
    const isServerActivity = (item) => isServer(item)
      || sessionsOf(item.id).some((session) => String(session.account || "").toLowerCase() === "server");
    // При нескольких окнах предпочитаем выбранную запущенную игру, затем
    // первую подтверждённую игровую сессию.
    const selectedGame = selectedMeta && !isServerActivity(selectedMeta) ? selectedMeta : null;
    const playingMeta = selectedGame && state.running.has(selectedGame.id) ? selectedGame
      : state.instances.find((item) => !isServerActivity(item) && state.running.has(item.id));
    const meta = forceMode === "launching" ? selectedGame : (playingMeta || selectedGame);
    const mode = forceMode === "launching" && selectedGame ? "launching" : (playingMeta ? "playing" : "idle");
    if (mode === "idle") presenceStartedAt = null;
    else if (mode === "playing" && meta && sessionsOf(meta.id).length) {
      presenceStartedAt = sessionsOf(meta.id)[0].startedAt || Math.floor(Date.now() / 1000);
    } else if (!presenceStartedAt) presenceStartedAt = Math.floor(Date.now() / 1000);
    const details = meta ? meta.name : "OmniSpec";
    const variant = meta ? `MC ${meta.mc_version} · ${loaderLabel(meta.loader)}` : "";
    const stateText = mode === "playing" ? variant : I18N.translate(mode === "launching" ? "Запускает" : "В ожидании");
    const startedAt = mode === "idle" ? APP_STARTED_AT : presenceStartedAt;
    const settings = state.settings || {};
    const showIcon = settings.discord_rpc !== false && settings.discord_instance_icon !== false && Boolean(meta);
    const fallback = showIcon ? presenceFallbackIcon(meta) : null;
    const send = (image) => {
      // Вызовы Tauri могут завершаться не по порядку. Сериализуем запись,
      // а ещё не начавшиеся устаревшие вызовы пропускаем.
      if (sequence !== presenceSequence) return;
      presenceSendQueue = presenceSendQueue.catch(() => {}).then(() => {
        if (sequence !== presenceSequence) return;
        return api.setPresence(mode, details, stateText, startedAt, image);
      }).catch(() => {});
    };
    if (!showIcon || !isImageIcon(meta.icon)) { send(fallback); return; }

    const key = JSON.stringify([presenceIconEpoch, meta.id, meta.icon, meta.source_url || "", settings.discord_upload_local_icon === true]);
    let cached = presenceIconCache.get(key);
    if (cached && cached.expiresAt <= Date.now()) { presenceIconCache.delete(key); cached = null; }
    if (cached) { send(cached.url || fallback); return; }
    send(fallback); // статус не ждёт сетевого запроса и остаётся работоспособным
    let pending = presenceIconPending.get(key);
    if (!pending) {
      pending = api.resolvePresenceIcon(meta.id).then((url) => {
        const lifetime = url ? 6 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
        presenceIconCache.set(key, { url: url || null, expiresAt: Date.now() + lifetime });
        return url;
      }).catch((error) => {
        // Временный сбой не закрепляем надолго; показ статуса не прерываем.
        presenceIconCache.set(key, { url: null, expiresAt: Date.now() + 60 * 1000 });
        if (sequence === presenceSequence && settings.discord_upload_local_icon === true) {
          toast(`Не удалось подготовить иконку для Discord: ${error}`, "err");
        }
        return null;
      }).finally(() => presenceIconPending.delete(key));
      presenceIconPending.set(key, pending);
    }
    pending.then((url) => send(url || fallback));
  }

  // Временные публичные ссылки нужно обновлять и при очень долгой работе окна.
  setInterval(() => { if (IS_APP && selected()) syncPresence(); }, 60 * 60 * 1000);

  /** Настройка относится к явному открытию сборки, не к обновлению метаданных. */
  function initialTab() {
    const id = state.settings?.initial_tab;
    return INITIAL_TABS.some(([tab]) => tab === id) ? id : "console";
  }

  function openInstance(id) {
    const meta = id && state.instances.find((item) => item.id === id);
    if (meta) state.tab = isServer(meta) ? "server" : initialTab();
    selectInstance(id);
  }

  function selectInstance(id) {
    closeAccountPopover();
    state.selectedId = id;
    const meta = selected();
    refreshInstalledProjects();
    renderSidebar();
    $("#tb-name").textContent = meta ? meta.name : "OmniSpec";
    // версия видна текстом; менять её — на странице сборки
    const versionLabel = $("#tb-version");
    const versionSep = $("#tb-version-sep");
    if (versionLabel) {
      versionLabel.textContent = meta ? (isServer(meta) ? serverLabel(meta) : `MC ${meta.mc_version} · ${loaderLabel(meta.loader)}`) : "";
      versionLabel.hidden = !meta;
    }
    if (versionSep) versionSep.hidden = !meta;
    const menu = $("#btn-build-menu");
    if (menu) menu.hidden = !meta;
    renderBuildIcon(meta);
    const pathbar = $("#build-path");
    if (pathbar) {
      pathbar.hidden = !meta;
      if (meta) {
        api.instancePath(meta.id)
          .then((path) => {
            if (state.selectedId !== meta.id) return;
            const span = pathbar.querySelector("span");
            span.setAttribute("translate", "no");
            span.textContent = path;
          })
          .catch(() => {
            if (state.selectedId !== meta.id) return;
            const span = pathbar.querySelector("span");
            span.removeAttribute("translate");
            span.textContent = "папка сборки";
          });
      }
    }
    updateStatus();
    renderTab();
    syncPresence();
  }

  function updateStatus() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    const meta = selected();
    const toolbar = document.querySelector(".toolbar");
    if (toolbar) toolbar.classList.toggle("is-idle", !meta);
    const running = meta && state.running.has(meta.id);
    const preparing = meta && state.preparing.has(meta.id);
    const status = running ? (isServer(meta) ? "сервер запущен" : "запущена") : preparing ? "подготавливается" : (meta && isServer(meta) ? "сервер остановлен" : "остановлена");
    $("#tb-dot").className = `dot ${running ? "on" : ""}`;
    $("#tb-status").textContent = meta ? status : "сборка не выбрана";
    $("#tb-center").textContent = meta ? `${meta.name} — ${status}` : "OmniSpec — лаунчер Minecraft";
    const playButton = $("#btn-play");
    playButton.querySelector("span").textContent = isServer(meta) ? (running ? "Перезапустить сервер" : "Запустить сервер") : (running ? "Играть снова" : "Играть");
    playButton.disabled = Boolean(preparing);
  }

  /* ==================== ПРОГРЕСС ==================== */
  const PROGRESS_STAGES = {
    version: "версия", libraries: "библиотеки", assets: "ресурсы", java: "Java",
    mods: "моды", modpack: "модпак", loader: "загрузчик", launch: "запуск", check: "проверка",
    unzip: "распаковка", copy: "копирование", import: "импорт"
  };

  function progressInfo(payload) {
    const total = Number(payload.total || 0);
    const done = Number(payload.done || 0);
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    const stage = PROGRESS_STAGES[payload.stage] || payload.stage || "импорт";
    const detail = `${stage}: ${payload.detail || "…"}`.slice(0, 80);
    return { percent, total, text: detail };
  }

  /** Живая полоса импорта: обновляем текст и процент без полной перерисовки. */
  function updateImportLive() {
    const payload = state.progress;
    const stage = payload ? String(payload.stage || "") : "";
    const importing = Boolean(state.home && state.home.busy) || Boolean(payload && IMPORT_STAGES.includes(stage));
    const live = $("#imp-live");
    if (!importing) {
      if (live) live.remove();
      return;
    }
    if (!live) {
      if (state.tab === "discover" && !state.modalOpen) renderDiscover();
      return;
    }
    const info = payload ? progressInfo(payload) : null;
    const title = $("#imp-live-title");
    if (title) title.textContent = importTitle(stage);
    const text = $("#imp-live-text");
    if (text && info) text.textContent = info.text;
    const fill = $("#imp-live-fill");
    if (fill && info && info.total) {
      fill.classList.remove("is-idle");
      fill.style.width = `${info.percent}%`;
    }
    const percent = $("#imp-live-percent");
    if (percent) {
      const hasTotal = Boolean(info && info.total);
      percent.textContent = hasTotal ? `${info.percent}%` : "…";
      percent.classList.toggle("is-wait", !hasTotal);
    }
    const liveBox = $("#imp-live");
    if (liveBox) liveBox.classList.toggle("is-idle", !(info && info.total));
  }

  /** Полоса процессов на главной: видна всё время импорта/распаковки. */
  function renderImpProgress() {
    updateImportLive();
    const box = $("#imp-progress");
    if (!box) return;
    const payload = state.progress;
    if (!payload) { box.hidden = true; return; }
    box.hidden = false;
    const info = progressInfo(payload);
    const fill = $("#imp-progress-fill");
    if (fill) fill.style.width = `${info.percent}%`;
    const text = $("#imp-progress-text");
    if (text) text.textContent = info.text;
  }

  // Запоздавший прогресс уже завершённой подготовки не должен снова
  // показывать панель «Ресурсы игры» как активную.
  const finishedLaunchProgress = new Set();
  const finishedContentProgress = new Set();
  // Самая поздняя незавершённая установка отображается первой. Поздние события
  // более старой операции не должны скрыть панель новой.
  const activeContentProgress = new Map();
  function latestContentProgress() {
    let latest = null;
    for (const entry of activeContentProgress.values()) latest = entry;
    return latest;
  }
  function setProgress(payload) {
    if (payload && payload.op && (finishedLaunchProgress.has(payload.op) || finishedContentProgress.has(payload.op))) return;
    if (payload && activeContentProgress.has(payload.op)) {
      // Даже явное «done» от ядра может прийти до ответа команды. Закрываем
      // панель только после окончательного результата установки с зависимостями.
      payload = { ...payload, state: "active" };
      activeContentProgress.set(payload.op, payload);
      if (latestContentProgress().op !== payload.op) return;
    }
    state.progress = payload || null;
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    renderImpProgress();
    const box = $("#progress");
    if (!payload) { box.hidden = true; return; }
    box.hidden = false;
    const percent = payload.total > 0 ? Math.min(100, Math.round((payload.done / payload.total) * 100)) : 0;
    $("#progress-fill").style.width = `${percent}%`;
    const stageNames = {
      version: "версия", libraries: "библиотеки", assets: "ресурсы", java: "Java",
      mods: "моды", modpack: "модпак", loader: "загрузчик", launch: "запуск", check: "проверка",
      import: "импорт", copy: "копирование", unzip: "распаковка"
    };
    const importStage = ["import", "copy", "unzip", "modpack"].includes(payload.stage);
    const prefix = importStage ? "Импорт сборки" : (stageNames[payload.stage] || payload.stage);
    $("#progress-text").textContent = `${prefix}: ${payload.detail || ""}`.slice(0, 74);
    if (payload.stage === "update") {
      const modal = $("#modal-update");
      if (modal && !modal.hidden) {
        $("#upd-progress").hidden = false;
        $("#upd-fill").style.width = `${percent}%`;
        $("#upd-progress-text").textContent = payload.detail || "";
      }
    }
    if (payload.stage === "launch" && payload.done >= payload.total) {
      setTimeout(() => { if (state.progress === payload) setProgress(null); }, 2500);
    }
    updateDownloads(payload);
  }

  /* ==================== ПАНЕЛЬ ЗАГРУЗОК ==================== */
  const DL_STAGE_TITLES = {
    modpack: "Установка сборки", mods: "Установка модов", update: "Обновление модов",
    libraries: "Библиотеки игры", assets: "Ресурсы игры",
    version: "Версия игры", java: "Java", loader: "Загрузчик", check: "Проверяем…",
    import: "Импорт", unzip: "Распаковка", copy: "Копирование"
  };

  function fmtBytes(n) {
    n = Number(n || 0);
    if (n <= 0) return "";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  /** Обновить состояние панели загрузок по событию прогресса. */
  function updateDownloads(payload) {
    const dl = state.downloads;
    if (!payload) return;
    const stage = String(payload.stage || "");
    const isDownloadStage = ["modpack", "mods", "update", "check", "libraries", "assets", "version", "java", "loader", "import"].includes(stage);
    if (!isDownloadStage) return;
    // Глобальная панель показывает последний пришедший этап; op позволяет не
    // завершить чужую загрузку ответом параллельной попытки запуска.
    const op = String(payload.op || "");

    // Не смешиваем файлы двух операций, даже если их этапы совпадают.
    if (!dl.active || dl.stage !== stage || dl.op !== op) {
      dl.active = true;
      dl.stage = stage;
      dl.title = DL_STAGE_TITLES[stage] || "Загрузка";
      dl.done = 0; dl.total = 0;
      dl.files = new Map();
      dl.state = "active";
      dl.collapsed = false;
      if (dl.timer) { clearTimeout(dl.timer); dl.timer = null; }
    }
    dl.op = op;

    // Общий прогресс по файлам.
    const total = Number(payload.total || 0);
    const done = Number(payload.done || 0);
    if (total > 0) { dl.total = total; dl.done = done; }

    // Построчный байтовый прогресс.
    if (payload.file && Number(payload.bytes_total || 0) > 0) {
      dl.files.set(payload.file, {
        done: Number(payload.bytes_done || 0),
        total: Number(payload.bytes_total || 0),
        complete: false
      });
    }
    // Файл завершён (событие без байтов, но с именем файла).
    if (payload.file && !Number(payload.bytes_total || 0)) {
      const entry = dl.files.get(payload.file);
      if (entry) entry.complete = true;
    }

    // 100% отдельного файла ещё не означает завершение установки: после него
    // могут скачиваться зависимости или распаковываться архив. Для отслеживаемых
    // операций ждём ответа команды; остальные этапы используют свои события.
    if (payload.state === "cancelled" || payload.state === "error") {
      dl.state = payload.state;
      scheduleDlHide();
    } else if (payload.state === "done" || (!activeContentProgress.has(op) && stage !== "mods" && !payload.file && total > 0 && done >= total)) {
      dl.state = "done";
      dl.files.forEach((entry) => { entry.complete = true; entry.done = entry.total; });
      scheduleDlHide();
    } else {
      // идёт активная загрузка — отложенное скрытие отменяется
      if (dl.timer) { clearTimeout(dl.timer); dl.timer = null; }
      dl.state = "active";
    }

    renderDownloads();
  }

  function scheduleDlHide() {
    const dl = state.downloads;
    if (dl.timer) clearTimeout(dl.timer);
    dl.timer = setTimeout(() => {
      dl.timer = null;
      dl.active = false;
      renderDownloads();
    }, 3000);
  }

  /** Ответ команды завершает только собственную установку, даже при ошибке. */
  function finishContentProgress(op, outcome) {
    if (!op) return;
    activeContentProgress.delete(op);
    finishedContentProgress.add(op);
    while (finishedContentProgress.size > 100) finishedContentProgress.delete(finishedContentProgress.values().next().value);
    const dl = state.downloads;
    if (dl.active && dl.op === op) {
      const other = latestContentProgress();
      if (other) {
        setProgress(other); // ещё одна установка продолжается
      } else {
        dl.state = outcome;
        if (outcome === "done") {
          if (dl.total > 0) dl.done = dl.total;
          dl.files.forEach((entry) => { entry.complete = true; entry.done = entry.total; });
        }
        scheduleDlHide();
        renderDownloads();
      }
    }
    if (state.progress && state.progress.op === op) setProgress(null);
  }

  /** Завершаем только прогресс этой попытки; параллельную операцию не скрываем. */
  function finishLaunchProgress(attemptId, outcome) {
    const op = `launch:${attemptId}`;
    finishedLaunchProgress.add(op);
    while (finishedLaunchProgress.size > 100) finishedLaunchProgress.delete(finishedLaunchProgress.values().next().value);
    const dl = state.downloads;
    if (dl.active && dl.op === op && dl.state === "active") {
      dl.state = outcome;
      if (outcome === "done") {
        if (dl.total > 0) dl.done = dl.total;
        dl.files.forEach((entry) => { entry.complete = true; entry.done = entry.total; });
      }
      scheduleDlHide();
      renderDownloads();
    }
    if (state.progress && state.progress.op === op) setProgress(null);
  }

  function renderDownloads() {
    const dl = state.downloads;
    const panel = $("#dl-panel");
    if (!panel) return;
    if (!dl.active) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.classList.toggle("is-collapsed", dl.collapsed);
    panel.classList.toggle("is-done", dl.state === "done");
    panel.classList.toggle("is-cancelled", dl.state === "cancelled" || dl.state === "error");

    const title = $("#dl-title");
    if (title) {
      title.textContent = dl.state === "done" ? `${dl.title} — готово`
        : dl.state === "cancelled" ? `${dl.title} — отменено`
        : dl.state === "error" ? `${dl.title} — ошибка`
        : dl.title;
    }

    // Общий прогресс.
    const percent = dl.total > 0 ? Math.min(100, Math.round((dl.done / dl.total) * 100)) : 0;
    const pctEl = $("#dl-percent");
    if (pctEl) pctEl.textContent = dl.total > 0 ? `${percent}%` : "";
    const fill = $("#dl-total-fill");
    if (fill) fill.style.width = `${percent}%`;
    const totalText = $("#dl-total-text");
    if (totalText) totalText.textContent = dl.total > 0 ? `${dl.done}/${dl.total} файлов` : "";

    // Построчные полосы.
    const filesEl = $("#dl-files");
    if (filesEl) {
      const entries = [...dl.files.entries()].slice(-12);
      filesEl.innerHTML = entries.map(([name, info]) => {
        const p = info.total > 0 ? Math.min(100, Math.round((info.done / info.total) * 100)) : (info.complete ? 100 : 0);
        const size = info.total > 0 ? `${fmtBytes(info.done)} / ${fmtBytes(info.total)}` : (info.complete ? "готово" : "…");
        return `<div class="dl-file${info.complete ? " is-done" : ""}">
          <div class="dl-file-top">
            <span class="dl-file-name" translate="no" title="${esc(name)}">${esc(name)}</span>
            <span class="dl-file-size">${size}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${p}%"></div></div>
        </div>`;
      }).join("");
    }

    // Кнопка отмены видна только во время активной загрузки.
    const cancelBtn = $("#dl-cancel");
    if (cancelBtn) cancelBtn.style.display = dl.state === "active" ? "" : "none";
  }

  function initDownloadsPanel() {
    const head = $("#dl-head");
    if (head) head.addEventListener("click", (e) => {
      if (e.target.closest("#dl-cancel")) return;
      state.downloads.collapsed = !state.downloads.collapsed;
      renderDownloads();
    });
    const cancelBtn = $("#dl-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await api.cancelDownload(); } catch (_) { /* noop */ }
      toast("Загрузка отменена", "info");
    });
  }

  /* ==================== ПРИЗНАКИ УСТАНОВЛЕННЫХ МОДОВ ==================== */
  let installedProjectsInstance = null;
  let installedProjectsSource = null;
  let installedProjectsGeneration = 0;
  let installedProjectsMessage = "";
  let contentOperationSerial = 0;

  function installedMessage(text) {
    installedProjectsMessage = text;
    const label = $("#dl-installed-check");
    if (label) {
      label.textContent = text;
      label.hidden = !text;
    }
  }

  function projectKey(source, projectId) {
    return JSON.stringify([source, String(projectId)]);
  }

  function downloadingProjectKey(instanceId, source, projectId) {
    return JSON.stringify([instanceId, source, String(projectId)]);
  }

  function projectInstalled(projectId, source, type) {
    return Boolean(projectId && type === "mod" && state.selectedId
      && installedProjectsInstance === state.selectedId && state.installedProjects.has(projectKey(source, projectId)));
  }

  function projectStatus(projectId, source, type) {
    if (!projectId || !state.selectedId || type === "modpack") return "";
    if (state.downloadingProjects.has(downloadingProjectKey(state.selectedId, source, projectId))) return "downloading";
    return projectInstalled(projectId, source, type) ? "installed" : "";
  }

  function projectLabel(title, projectId, source, type) {
    const parts = [title || "Проект"];
    if (projectInstalled(projectId, source, type)) parts.push("установлен в этой сборке");
    if (projectStatus(projectId, source, type) === "downloading") parts.push("скачивается");
    return parts.join(" — ");
  }

  /** Бейдж и дополнительная обводка используют один и тот же проверенный id. */
  function projectBadge(projectId, source, type) {
    const status = projectStatus(projectId, source, type);
    if (status === "downloading") return `<span class="tag tag-downloading" data-project-status="downloading">скачивается…</span>`;
    if (status === "installed") return `<span class="tag tag-installed" data-project-status="installed">установлен</span>`;
    return "";
  }

  /** Обновляем только статусы существующих карточек, не пересоздавая список. */
  function updateCatalogProjectStates() {
    $$("#mr-results, #cf-results").forEach((results) => {
      const top = results.scrollTop;
      const left = results.scrollLeft;
      $$(".card[data-project], .card[data-cf-project]", results).forEach((card) => {
        const source = card.dataset.cfProject ? "curseforge" : "modrinth";
        const projectId = card.dataset.cfProject || card.dataset.project;
        const title = card.dataset.cfTitle || card.dataset.title || "Проект";
        const type = card.dataset.projectType || "mod";
        const status = projectStatus(projectId, source, type);
        card.classList.toggle("is-installed", projectInstalled(projectId, source, type));
        card.classList.toggle("is-downloading", status === "downloading");
        card.setAttribute("aria-label", projectLabel(title, projectId, source, type));
        const meta = $(".card-meta", card);
        const old = meta && $("[data-project-status]", meta);
        if (meta && (old?.dataset.projectStatus || "") !== status) {
          if (old) old.remove();
          if (status) meta.insertAdjacentHTML("afterbegin", projectBadge(projectId, source, type));
        }
      });
      // Не позволяем обновлению статусов сдвинуть пользователя при переносе меток.
      results.scrollTop = top;
      results.scrollLeft = left;
    });
  }

  /** Запрос относится к сборке И источнику; опоздавший ответ нельзя применить к другому. */
  async function refreshInstalledProjects() {
    const generation = ++installedProjectsGeneration;
    const instanceId = selected()?.id || null;
    const source = state.modsSource === "curseforge" ? "curseforge" : "modrinth";
    installedProjectsInstance = instanceId;
    installedProjectsSource = source;
    // Старые результаты нельзя выдавать за актуальные после удаления или изменения файла.
    state.installedProjects = new Set();
    updateCatalogProjectStates();
    installedMessage("");
    if (!instanceId || state.tab !== "download") return;
    try {
      const ids = await api.catalogInstalledMods(instanceId, source);
      if (generation !== installedProjectsGeneration || state.selectedId !== instanceId
          || installedProjectsSource !== source || state.modsSource !== source) return;
      state.installedProjects = new Set((ids || []).filter(Boolean).map((id) => projectKey(source, id)));
      installedMessage("");
      updateCatalogProjectStates();
    } catch (_) {
      if (generation !== installedProjectsGeneration || state.selectedId !== instanceId
          || installedProjectsSource !== source || state.modsSource !== source) return;
      installedMessage("Не удалось проверить установленные версии. Вернись в каталог или проверь соединение.");
    }
  }

  /** Показываем операцию от её начала до ответа команды, включая зависимости. */
  async function withInstallProgress(instanceId, stage, fn, options = {}) {
    const prefix = options.opPrefix || "install:";
    const op = `${prefix}${Date.now().toString(36)}-${(++contentOperationSerial).toString(36)}`;
    // Запрос метаданных тоже часть операции: старый таймер не должен закрыть
    // панель, пока первый сетевой ответ ещё не получен.
    const start = {
      instance: instanceId,
      stage,
      done: 0,
      total: 0,
      detail: options.detail || "подготавливаем установку",
      state: "active",
      op
    };
    activeContentProgress.set(op, start);
    setProgress(start);
    let outcome = "error";
    try {
      const result = await fn(op);
      outcome = "done";
      return result;
    } catch (error) {
      if (/отмен|cancel/i.test(String(error?.message || error))) outcome = "cancelled";
      throw error;
    } finally {
      finishContentProgress(op, outcome);
    }
  }

  /** Пометить проект на время установки, не меняя текущую позицию пользователя. */
  async function withDownloading(projectId, fn, options = {}) {
    const instanceId = options.instanceId || state.selectedId;
    const source = options.source || (state.modsSource === "curseforge" ? "curseforge" : "modrinth");
    const key = projectId && instanceId ? downloadingProjectKey(instanceId, source, projectId) : null;
    if (key) state.downloadingProjects.set(key, (state.downloadingProjects.get(key) || 0) + 1);
    updateCatalogProjectStates();
    try {
      return await withInstallProgress(instanceId, "mods", fn);
    } finally {
      if (key) {
        const remaining = (state.downloadingProjects.get(key) || 1) - 1;
        if (remaining > 0) state.downloadingProjects.set(key, remaining);
        else state.downloadingProjects.delete(key);
      }
      updateCatalogProjectStates();
      if (state.selectedId === instanceId) await refreshInstalledProjects();
    }
  }

  /* ==================== ВКЛАДКИ ==================== */
  /** Какие вкладки показывать: без сборки — только лента, со сборкой — всё остальное. */
  function applyTabs(meta) {
    const server = isServer(meta);
    const serverOnlyTabs = new Set(["server", "players", "metrics", "backups"]);
    const serverAllowed = new Set(["server", "console", "files", "players", "metrics", "backups", "download", "settings"]);
    $$(".tab").forEach((tab) => {
      const id = tab.dataset.tab;
      if (!meta) tab.hidden = !["discover", "servers"].includes(id);
      else if (server) tab.hidden = !serverAllowed.has(id);
      else tab.hidden = id === "discover" || serverOnlyTabs.has(id) || id === "servers";
    });
  }

  function serverUptime(seconds) {
    const value = Number(seconds) || 0;
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = value % 60;
    return h ? `${h} ч ${m} мин` : m ? `${m} мин ${s} с` : `${s} с`;
  }

  const SERVER_ACTIONS = {
    start: { label: "Запуск", icon: "i-play", title: "Запустить сервер" },
    restart: { label: "Перезапуск", icon: "i-restart", title: "Перезапустить сервер" },
    stop: { label: "Стоп", icon: "i-stop", title: "Остановить сервер штатно" },
    kill: { label: "Килл", icon: "i-close", title: "Немедленно завершить процесс" }
  };

  function serverControlsHtml(instanceId, running) {
    return `<div class="server-controls" data-server-controls="${esc(instanceId)}">${Object.entries(SERVER_ACTIONS).map(([action, info]) => {
      const disabled = action === "start" ? running : !running;
      const danger = action === "kill" ? " btn-danger" : "";
      return `<button type="button" class="btn btn-small server-action${danger}" data-server-action="${action}" title="${info.title}"${disabled ? " disabled" : ""}><svg class="ic"><use href="#${info.icon}"/></svg><span>${info.label}</span></button>`;
    }).join("")}</div>`;
  }

  async function waitServerStopped(instanceId, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (state.running.has(instanceId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await refreshInstances();
    }
    return !state.running.has(instanceId);
  }

  async function performServerAction(instanceId, action) {
    const meta = state.instances.find((item) => item.id === instanceId);
    if (!meta || !isServer(meta)) return;
    if (action === "kill" && !window.confirm("Немедленно завершить процесс сервера? Несохранённые данные могут потеряться.")) return;
    try {
      if (action === "start") {
        await api.serverStart(instanceId);
        toast("Сервер запускается", "ok");
      } else if (action === "stop") {
        await api.serverStop(instanceId);
        toast("Сервер останавливается");
      } else if (action === "kill") {
        await api.serverKill(instanceId);
        toast("Процесс сервера завершён", "ok");
      } else if (action === "restart") {
        if (state.running.has(instanceId)) {
          await api.serverStop(instanceId);
          if (!await waitServerStopped(instanceId)) {
            throw new Error("сервер не завершился вовремя; используй «Килл»");
          }
        }
        await api.serverStart(instanceId);
        toast("Сервер перезапускается", "ok");
      }
      await refreshInstances();
      renderSidebar();
      if (state.selectedId === instanceId) renderTab();
      else if (state.tab === "servers") renderServerList();
    } catch (error) {
      toast(String(error), "err");
    }
  }

  function bindServerControls(root = document) {
    $$('[data-server-action]', root).forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const controls = button.closest("[data-server-controls]");
      performServerAction(controls?.dataset.serverControls, button.dataset.serverAction);
    }));
  }

  function renderServerList() {
    const body = $("#tab-body");
    const servers = state.instances.filter(isServer);
    body.innerHTML = `
      <section class="discover-wrap server-list-view">
        <div class="discover-head"><div><div class="eyebrow">ОМНИПАНЕЛЬ</div><h1>Сервера</h1><p class="muted">Иконка, информация о сборке и управление локальным процессом в одной карточке.</p></div>
          <button class="btn btn-primary" id="server-new"><svg class="ic"><use href="#i-plus"/></svg>Создать сервер</button></div>
        <div class="server-card-grid">
          ${servers.length ? servers.map((item) => {
            const running = state.running.has(item.id);
            return `<article class="server-card ${running ? "is-running" : ""}">
              <button type="button" class="server-card-main" data-server-open="${esc(item.id)}">
                <span class="server-card-icon">${instanceIconHtml(item)}</span>
                <span class="server-card-info"><span class="server-card-status"><span class="dot ${running ? "on" : ""}"></span>${running ? "Запущен" : "Остановлен"}</span><strong translate="no">${esc(item.name)}</strong><span>${esc(serverLabel(item))} · порт ${esc(item.server?.port || 25565)}</span><small>Ядро ${esc(item.server?.kernel || "custom")} · ${esc(item.server?.kernel_version || item.server?.mc_version || "версия не указана")}</small></span>
                <span class="server-card-arrow">›</span>
              </button>
              ${serverControlsHtml(item.id, running)}
            </article>`;
          }).join("") : `<div class="empty-state">Серверов пока нет.<br><span class="muted">Создай новый сервер или импортируй готовую папку.</span></div>`}
        </div>
        <div class="server-list-actions"><button class="btn" id="server-scan"><svg class="ic"><use href="#i-search"/></svg>Сканировать папки</button><span class="muted">Найденные серверы можно импортировать без потери ядра, модов и плагинов.</span></div>
        <div id="server-scan-result"></div>
      </section>`;
    $("#server-new")?.addEventListener("click", () => openCreate({ mode: "server" }));
    $$('[data-server-open]').forEach((item) => item.addEventListener("click", () => openInstance(item.dataset.serverOpen)));
    bindServerControls(body);
    $("#server-scan")?.addEventListener("click", async () => {
      const result = $("#server-scan-result");
      result.innerHTML = `<div class="loading-line">Ищем серверные папки…</div>`;
      try {
        const roots = await api.pickDir("Где искать серверы").catch(() => null);
        if (!roots) { result.innerHTML = ""; return; }
        const found = await api.serverScan([roots]);
        result.innerHTML = found.length ? `<div class="server-scan-list">${found.map((item) => `<button class="server-scan-item" data-import-server="${esc(item.path)}"><strong>${esc(item.name)}</strong><span>${esc(item.kernel)} ${esc(item.mc_version || "")} · ${esc(item.path)}</span><em>${item.has_icon ? "server-icon.png найден" : ""}</em></button>`).join("")}</div>` : `<div class="empty-state">Похожие папки не найдены.</div>`;
        $$('[data-import-server]').forEach((button) => button.addEventListener("click", () => openCreate({ mode: "server", importPath: button.dataset.importServer })));
      } catch (error) { result.innerHTML = `<div class="error-text">${esc(String(error))}</div>`; }
    });
  }

  async function renderServerOverview() {
    const meta = selected();
    if (!meta) return;
    const body = $("#tab-body");
    body.innerHTML = `<section class="server-view"><div class="loading-line">Загружаем состояние сервера…</div></section>`;
    const snapshot = await api.serverSnapshot(meta.id).catch((error) => ({ error: String(error) }));
    if (state.windowHidden || selected()?.id !== meta.id || state.tab !== "server") {
      state.uiRefreshPending = true;
      return;
    }
    state.serverSnapshot = snapshot;
    if (snapshot.error) { body.innerHTML = `<section class="server-view"><div class="error-text">${esc(snapshot.error)}</div></section>`; return; }
    const running = state.running.has(meta.id) || snapshot.running;
    const config = snapshot.config || meta.server || {};
    const addons = await api.serverAddons(meta.id).catch(() => []);
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    body.innerHTML = `<section class="server-view">
      <div class="server-overview-hero">
        <div class="server-overview-identity"><div class="server-overview-icon">${instanceIconHtml(meta)}</div><div><div class="eyebrow">ЛОКАЛЬНЫЙ СЕРВЕР</div><h1 translate="no">${esc(meta.name)}</h1><p class="muted">${esc(serverLabel(meta))} · ${esc(snapshot.root || "")}</p></div></div>
        <div class="server-overview-controls">${serverControlsHtml(meta.id, running)}<div class="server-secondary-actions"><button class="btn btn-small" id="server-settings">Настройки</button><button class="btn btn-small" id="server-icon-pick">Иконка</button><button class="btn btn-small" id="server-sync">Синхронизация</button><button class="btn btn-small" id="server-folder">Папка</button></div></div>
      </div>
      ${snapshot.eula_accepted === false ? `<div class="server-eula"><strong>Нужно принять EULA</strong><span>Для запуска Minecraft-сервера подтверди лицензионное соглашение Mojang в этом интерфейсе.</span><button class="btn btn-small btn-primary" id="server-eula">Принять EULA</button></div>` : ""}
      <div class="server-info-grid"><div class="stat-card"><span>Состояние</span><strong>${running ? "Работает" : "Остановлен"}</strong></div><div class="stat-card"><span>Сборка / ядро</span><strong>${esc(config.kernel || "custom")}</strong></div><div class="stat-card"><span>Minecraft</span><strong>${esc(config.mc_version || meta.server?.mc_version || "—")}</strong></div><div class="stat-card"><span>Порт</span><strong>${esc(config.port || 25565)}</strong></div><div class="stat-card"><span>Игроки</span><strong>${(snapshot.players || []).filter((item) => item.online).length}</strong></div><div class="stat-card"><span>Память</span><strong>${esc(config.memory_mb || 4096)} МБ</strong></div></div>
      <div class="server-command"><input class="input grow" id="server-command-input" placeholder="Команда без /, например say Привет" ${running ? "" : "disabled"}><button class="btn" id="server-command-send" ${running ? "" : "disabled"}>Отправить</button></div>
      <div class="server-columns"><div class="panel"><div class="panel-head"><strong>Аддоны сервера</strong><div class="flex-row"><button class="btn btn-small btn-primary" id="server-addon-download"><svg class="ic"><use href="#i-download"/></svg>Загрузить</button><button class="btn btn-small" id="server-addon-url">Установить по URL</button></div></div><div class="server-addon-list">${addons.length ? addons.map((item) => `<div class="server-addon"><span>${esc(item.name)}</span><small>${esc(item.kind)} · ${humanSize(item.size)}</small><button class="icon-btn" data-addon-toggle="${esc(item.path)}" title="Включить/выключить">${item.enabled ? "✓" : "○"}</button><button class="icon-btn danger" data-addon-delete="${esc(item.path)}" title="Удалить">×</button></div>`).join("") : `<div class="empty-state">Плагинов и модов пока нет. Открой «Загрузить», чтобы найти плагин на Modrinth.</div>`}</div></div><div class="panel"><div class="panel-head"><strong>Последние строки</strong><button class="btn btn-small" id="server-refresh">Обновить</button></div><div class="server-log-preview">${(snapshot.log_tail || []).slice(-80).map((line) => `<div>${esc(line)}</div>`).join("") || `<span class="muted">Лог появится после запуска.</span>`}</div></div></div>
    </section>`;
    bindServerControls(body);
    $("#server-settings")?.addEventListener("click", async () => {
      try {
        const config = await api.serverGet(meta.id);
        const port = window.prompt("Порт сервера", String(config.port || 25565));
        if (port == null) return;
        const memory = window.prompt("ОЗУ сервера, МБ", String(config.memory_mb || 4096));
        if (memory == null) return;
        await api.serverSave(meta.id, { ...config, port: Number(port) || 25565, memory_mb: Number(memory) || 4096 });
        toast("Настройки сервера сохранены", "ok"); renderServerOverview();
      } catch (error) { toast(String(error), "err"); }
    });
    $("#server-icon-pick")?.addEventListener("click", async () => {
      const path = await api.pickFile("Выбери иконку сервера", ["png", "jpg", "jpeg", "webp"]).catch(() => null);
      if (!path) return;
      try {
        await api.serverWriteIcon(meta.id, path);
        await refreshInstances();
        toast("server-icon.png записан (64×64)", "ok");
        renderServerOverview();
      } catch (error) { toast(String(error), "err"); }
    });
    $("#server-sync")?.addEventListener("click", async () => {
      const destination = await api.pickDir("Папка синхронизации").catch(() => null);
      if (!destination) return;
      const direction = String(window.prompt("Направление: push — из сервера в папку, pull — из папки в сервер", "push") || "push").toLowerCase();
      if (!["push", "pull"].includes(direction)) return toast("Нужно указать push или pull", "err");
      if (!window.confirm(`${direction === "push" ? "Скопировать файлы сервера в выбранную папку" : "Скопировать файлы выбранной папки в сервер"}?`)) return;
      try { await api.serverSync(meta.id, destination, direction); toast("Синхронизация завершена", "ok"); renderServerOverview(); }
      catch (error) { toast(String(error), "err"); }
    });
    $("#server-eula")?.addEventListener("click", async () => {
      if (!window.confirm("Я принимаю EULA Minecraft и разрешаю запуск этого сервера.")) return;
      try { await api.serverSetEula(meta.id, true); toast("EULA принята", "ok"); renderServerOverview(); }
      catch (error) { toast(String(error), "err"); }
    });
    $("#server-folder")?.addEventListener("click", () => api.openPath(snapshot.root).catch((error) => toast(String(error), "err")));
    $("#server-refresh")?.addEventListener("click", () => renderServerOverview());
    $("#server-command-send")?.addEventListener("click", async () => { const input = $("#server-command-input"); try { await api.serverCommand(meta.id, input.value); input.value = ""; toast("Команда отправлена", "ok"); } catch (error) { toast(String(error), "err"); } });
    $("#server-command-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") $("#server-command-send")?.click(); });
    $("#server-addon-download")?.addEventListener("click", () => { state.tab = "download"; renderTab(); });
    $("#server-addon-url")?.addEventListener("click", async () => { const url = window.prompt("Прямая ссылка на .jar аддона"); if (!url) return; try { await api.serverInstallAddon(meta.id, url, null); toast("Аддон установлен", "ok"); renderServerOverview(); } catch (error) { toast(String(error), "err"); } });
    $$('[data-addon-toggle]').forEach((button) => button.addEventListener("click", async () => { try { await api.serverToggleAddon(meta.id, button.dataset.addonToggle); renderServerOverview(); } catch (error) { toast(String(error), "err"); } }));
    $$('[data-addon-delete]').forEach((button) => button.addEventListener("click", async () => { if (!window.confirm("Удалить аддон?")) return; try { await api.serverDeleteAddon(meta.id, button.dataset.addonDelete); renderServerOverview(); } catch (error) { toast(String(error), "err"); } }));
  }

  async function renderServerDownloads() {
    const meta = selected();
    if (!meta) return;
    const mcVersion = meta.server?.mc_version || meta.mc_version || "";
    const body = $("#tab-body");
    body.innerHTML = `<section class="server-view server-download-view"><div class="server-download-head"><div><div class="eyebrow"><svg class="ic"><use href="#i-modrinth"/></svg>MODRINTH</div><h1>Загрузить</h1><p class="muted">Плагины для ${esc(meta.name)} · Minecraft ${esc(mcVersion || "версия не указана")}. Скачивание проходит через проверку проекта, версии, размера и SHA-1.</p></div><button class="btn" id="server-download-back">Сервер</button></div><div class="server-download-search"><svg class="ic"><use href="#i-search"/></svg><input class="input grow" id="server-download-query" placeholder="Найти плагин на Modrinth" spellcheck="false"><button class="btn btn-primary" id="server-download-search"><svg class="ic"><use href="#i-search"/></svg>Найти плагины</button></div><div class="server-download-hint">Ищутся только проекты типа <strong>plugin</strong>, совместимые с версией этого сервера.</div><div id="server-download-results" class="server-addon-card-grid"><div class="empty-state">Введи название плагина и нажми «Найти плагины».</div></div></section>`;
    const input = $("#server-download-query");
    const results = $("#server-download-results");
    const search = async () => {
      const query = input?.value.trim();
      if (!query) { toast("Введи название плагина", "err"); input?.focus(); return; }
      results.innerHTML = `<div class="loading-line">Ищем плагины на Modrinth…</div>`;
      try {
        const response = await api.serverSearchAddons(query, "plugin", mcVersion, null);
        const hits = (response?.hits || []).slice(0, 12);
        results.innerHTML = hits.length ? hits.map((item) => `<article class="server-addon-card server-download-card" data-server-download-project="${esc(item.project_id)}"><div class="server-download-card-title"><strong>${esc(item.title)}</strong><span class="server-source-badge">Modrinth</span></div><span>${esc(item.description || "Описание не указано")}</span><small>${Number(item.downloads || 0).toLocaleString()} загрузок · ${esc(item.project_id)}</small><button class="btn btn-small" data-server-download-load>Показать версии</button><div class="server-download-versions" data-server-download-versions hidden></div></article>`).join("") : `<div class="empty-state">Плагины не найдены.</div>`;
      } catch (error) {
        results.innerHTML = `<div class="error-text">${esc(String(error))}</div>`;
      }
    };
    $("#server-download-search")?.addEventListener("click", search);
    input?.addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
    $("#server-download-back")?.addEventListener("click", () => { state.tab = "server"; renderTab(); });
    results.addEventListener("click", async (event) => {
      const loadButton = event.target.closest("[data-server-download-load]");
      if (loadButton) {
        const card = loadButton.closest(".server-download-card");
        const box = $("[data-server-download-versions]", card);
        loadButton.disabled = true;
        try {
          const versions = await api.serverAddonVersions(card.dataset.serverDownloadProject, mcVersion, null);
          const compatible = versions.filter((version) => version.game_versions?.includes(mcVersion) && version.files?.some((file) => file.url && file.filename?.toLowerCase().endsWith(".jar") && file.size > 0 && file.hashes?.sha1));
          card._serverDownloadVersions = compatible;
          box.hidden = false;
          box.innerHTML = compatible.length ? `<select class="input" data-server-download-version>${compatible.map((version, index) => `<option value="${index}">${esc(version.name || version.version_number || version.id)} · ${esc(version.files?.find((file) => file.primary && file.filename?.toLowerCase().endsWith(".jar"))?.filename || version.files?.[0]?.filename || "JAR")}</option>`).join("")}</select><button class="btn btn-small btn-primary" data-server-download-install><svg class="ic"><use href="#i-download"/></svg>Установить</button>` : `<span class="muted">Нет проверенного JAR для Minecraft ${esc(mcVersion)}.</span>`;
        } catch (error) {
          box.hidden = false;
          box.innerHTML = `<span class="error-text">${esc(String(error))}</span>`;
        } finally {
          loadButton.disabled = false;
        }
        return;
      }
      const installButton = event.target.closest("[data-server-download-install]");
      if (!installButton) return;
      const card = installButton.closest(".server-download-card");
      const versions = card?._serverDownloadVersions || [];
      const index = Number($("[data-server-download-version]", card)?.value || 0);
      const version = versions[index];
      const file = version?.files?.find((item) => item.primary && item.filename?.toLowerCase().endsWith(".jar") && item.hashes?.sha1) || version?.files?.find((item) => item.filename?.toLowerCase().endsWith(".jar") && item.hashes?.sha1);
      if (!version || !file) { toast("Выбери проверенную версию JAR", "err"); return; }
      installButton.disabled = true;
      try {
        await api.serverInstallCatalogAddon(meta.id, { source: "modrinth", project_id: card.dataset.serverDownloadProject, version_id: version.id, project_type: "plugin", mc_version: mcVersion, loader: null, url: file.url, filename: file.filename, size: file.size, sha1: file.hashes.sha1 });
        installButton.textContent = "Установлено";
        toast(`${$("strong", card)?.textContent || "Плагин"} установлен`, "ok");
      } catch (error) {
        installButton.disabled = false;
        toast(String(error), "err");
      }
    });
  }

  async function renderServerPlayers() {
    const meta = selected(); if (!meta) return;
    const players = await api.serverPlayers(meta.id).catch(() => []);
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    $("#tab-body").innerHTML = `<section class="server-view"><div class="server-head"><div><div class="eyebrow">ОНЛАЙН</div><h1>Игроки</h1><p class="muted">Состояние определяется по журналу сервера.</p></div><button class="btn" id="players-refresh">Обновить</button></div><div class="player-list">${players.length ? players.map((item) => `<div class="player-row"><span class="dot ${item.online ? "on" : ""}"></span><strong translate="no">${esc(item.name)}</strong><span class="muted">${item.online ? "онлайн" : "последний вход в логе"}</span></div>`).join("") : `<div class="empty-state">Игроки пока не обнаружены.</div>`}</div></section>`;
    $("#players-refresh")?.addEventListener("click", renderServerPlayers);
  }

  async function renderServerMetrics() {
    const meta = selected(); if (!meta) return;
    const snapshot = await api.serverSnapshot(meta.id).catch(() => null);
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    const metrics = snapshot?.metrics || {};
    $("#tab-body").innerHTML = `<section class="server-view"><div class="server-head"><div><div class="eyebrow">НАБЛЮДЕНИЕ</div><h1>Метрики</h1><p class="muted">Оперативные показатели процесса и последние данные TPS.</p></div><button class="btn" id="metrics-refresh">Обновить</button></div><div class="server-stat-grid"><div class="stat-card"><span>PID</span><strong>${metrics.pid || "—"}</strong></div><div class="stat-card"><span>CPU</span><strong>${Number(metrics.cpu_percent || 0).toFixed(1)}%</strong></div><div class="stat-card"><span>Память</span><strong>${humanSize(metrics.memory_bytes || 0)}</strong></div><div class="stat-card"><span>Аптайм</span><strong>${serverUptime(metrics.uptime_secs)}</strong></div><div class="stat-card"><span>TPS</span><strong>${metrics.tps == null ? "—" : Number(metrics.tps).toFixed(1)}</strong></div></div><p class="muted">Для Paper/Spigot TPS обновляется после команды и появления ответа в логе; системные метрики читаются без доступа к игровым данным.</p></section>`;
    $("#metrics-refresh")?.addEventListener("click", renderServerMetrics);
  }

  async function renderServerBackups() {
    const meta = selected(); if (!meta) return;
    const backups = await api.serverBackupList(meta.id).catch(() => []);
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    $("#tab-body").innerHTML = `<section class="server-view"><div class="server-head"><div><div class="eyebrow">ДАННЫЕ</div><h1>Бэкапы</h1><p class="muted">Архивируются ядро, конфиги, плагины, моды и миры. Логи и кэши исключаются из лёгкого бэкапа.</p></div><button class="btn btn-primary" id="backup-create">Создать бэкап</button></div><div class="backup-list">${backups.length ? backups.map((item) => `<div class="backup-row"><div><strong>${esc(item.name)}</strong><span>${humanSize(item.size)} · ${new Date(Number(item.created) * 1000).toLocaleString()}</span></div><button class="btn btn-small" data-backup-restore="${esc(item.name)}">Восстановить</button><button class="icon-btn danger" data-backup-delete="${esc(item.name)}">×</button></div>`).join("") : `<div class="empty-state">Бэкапов пока нет.</div>`}</div></section>`;
    $("#backup-create")?.addEventListener("click", async () => { try { await api.serverBackupCreate(meta.id, "manual", true); toast("Бэкап создан", "ok"); renderServerBackups(); } catch (error) { toast(String(error), "err"); } });
    $$('[data-backup-restore]').forEach((button) => button.addEventListener("click", async () => { if (!window.confirm("Восстановить архив поверх файлов сервера?")) return; try { await api.serverBackupRestore(meta.id, button.dataset.backupRestore); toast("Сервер восстановлен", "ok"); } catch (error) { toast(String(error), "err"); } }));
    $$('[data-backup-delete]').forEach((button) => button.addEventListener("click", async () => { if (!window.confirm("Удалить бэкап?")) return; try { await api.serverBackupDelete(meta.id, button.dataset.backupDelete); renderServerBackups(); } catch (error) { toast(String(error), "err"); } }));
  }

  let tabRenderGeneration = 0;
  function renderTab() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    tabRenderGeneration += 1;
    const body = $("#tab-body");
    const meta = selected();
    applyTabs(meta);
    updateErrorsBadge();
    // Без выбранной записи остаются главная и отдельная вкладка серверов.
    // Серверы получают собственный набор разделов и не наследуют ресурсные
    // вкладки Minecraft-сборки.
    if (!meta && !["discover", "servers"].includes(state.tab)) state.tab = "discover";
    else if (meta && state.tab === "discover") state.tab = isServer(meta) ? "server" : "console";
    else if (meta && isServer(meta) && !["server", "console", "files", "players", "metrics", "backups", "download", "settings"].includes(state.tab)) state.tab = "server";
    else if (meta && !isServer(meta) && ["server", "players", "metrics", "backups", "servers"].includes(state.tab)) state.tab = "console";
    $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.tab));
    const viewKey = `${state.selectedId || "home"}:${state.tab}`;
    if (body.dataset.activeView !== viewKey) { body.dataset.activeView = viewKey; animateView(body); }
    refreshActiveIndicators();

    if (!meta) {
      // Сборка не выбрана — в главном окне лента готовых сборок или каталог
      // серверов. Серверный каталог не подменяет список сборок слева.
      if (state.tab === "servers") return renderServerList();
      return renderDiscover();
    }

    switch (state.tab) {
      case "server": return renderServerOverview();
      case "players": return renderServerPlayers();
      case "metrics": return renderServerMetrics();
      case "backups": return renderServerBackups();
      case "discover": return renderDiscover();
      case "console": return renderConsole();
      case "errors": return renderErrors();
      case "files": return renderFiles();
      case "mods": return renderContent("mod");
      case "resourcepacks": return renderContent("resourcepack");
      case "shaders": return renderContent("shader");
      case "worlds": return renderWorlds();
      case "screenshots": return renderScreenshots();
      case "download": return isServer(meta) ? renderServerDownloads() : renderDownload();
      case "settings": return renderSettings();
    }
  }

  /* ---------- локальная помощь с ошибками ---------- */
  function updateErrorsBadge() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    const badge = $("#badge-errors");
    if (!badge) return;
    const run = state.selectedId && diagnostics.latest(state.selectedId);
    const count = run ? run.findings.size : 0;
    const failed = run && (run.status === "failed" || (run.status === "exited" && run.code !== 0));
    badge.hidden = !count && !failed;
    badge.textContent = count ? (count > 9 ? "9+" : String(count)) : "!";
    badge.title = count ? `В последнем запуске найдено признаков: ${count}` : "Последний запуск завершился с ошибкой";
  }

  /** Вызывается только при смене состояния или новой сигнатуре, не на каждую строку. */
  function diagnosticsChanged(instanceId) {
    if (instanceId !== state.selectedId) return;
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    updateErrorsBadge();
    if (state.tab !== "errors" || diagnosticsRenderTimer) return;
    diagnosticsRenderTimer = setTimeout(() => {
      diagnosticsRenderTimer = 0;
      if (state.tab === "errors" && $("#errors-dynamic")) renderErrorsContent();
    }, 120);
  }

  function errorsRunLabel(run) {
    const time = new Date(run.startedAt).toLocaleString(I18N.locale(), {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const kind = run.status === "preparing" ? "подготовка" : run.status === "running" ? "работает"
      : run.status === "stopped" ? "остановлен" : run.status === "cancelled" ? "отменён"
      : run.status === "failed" ? "ошибка подготовки" : run.code == null ? "код неизвестен" : `код ${run.code}`;
    const number = run.runId && run.runId.includes("#") ? ` #${run.runId.slice(run.runId.lastIndexOf("#") + 1)}` : "";
    return `${time}${number}${run.account ? ` · ${run.account}` : ""} · ${I18N.translate(kind)}`;
  }

  function errorsStatus(run) {
    if (!run && !state.liveLogAvailable) return {
      style: "warning", icon: "i-alert", title: "Живой лог недоступен",
      text: "Не удалось подписаться на сообщения игры. Автоматическая проверка лога работать не будет; проверь лог в папке сборки."
    };
    if (!run) return {
      style: "neutral", icon: "i-terminal", title: "Пока нет данных",
      text: "Запусти эту сборку: здесь появятся подсказки, если в выводе найдутся известные признаки проблем."
    };
    const found = run.findings.size > 0;
    if (run.status === "preparing") return {
      style: "neutral", icon: "i-terminal", title: "Подготавливаем запуск",
      text: "Проверяем ошибки подготовки и будем разбирать новые строки лога по мере их появления."
    };
    if (run.status === "running" && !state.liveLogAvailable) return {
      style: "warning", icon: "i-alert", title: "Живой лог недоступен",
      text: "Не удалось подписаться на сообщения игры. Автоматическая проверка и состояние завершения могут быть неполными; проверь лог в папке сборки."
    };
    if (run.status === "running") return found ? {
      style: "warning", icon: "i-alert", title: "Есть сигналы в логе",
      text: "Игра ещё работает. Эти сообщения не обязательно означают, что запуск завершится с ошибкой."
    } : {
      style: "neutral", icon: "i-terminal", title: "Пока ничего подозрительного",
      text: "Процесс запущен. Продолжаем проверять новые строки; не все проблемы можно определить автоматически."
    };
    if (run.status === "cancelled") return {
      style: "neutral", icon: "i-stop", title: "Подготовка отменена",
      text: "Загрузка была отменена пользователем. Можно запустить сборку снова."
    };
    if (run.status === "stopped") return {
      style: "neutral", icon: "i-stop", title: "Игра остановлена пользователем",
      text: found ? "До остановки в логе встретились сообщения ниже; они не обязательно означают сбой." : "Ручная остановка не считается ошибкой запуска."
    };
    if (run.status === "failed") return {
      style: "error", icon: "i-alert", title: "Не удалось подготовить запуск",
      text: found ? "Ниже — подсказки по распознанным сообщениям. Проверь полную ошибку, если они не помогут." : "Известную причину определить не удалось. Посмотри сообщение запуска и приложи его к обращению."
    };
    if (run.code === 0) return found ? {
      style: "warning", icon: "i-alert", title: "Игра завершилась с кодом 0",
      text: "В логе были сообщения ниже. Они могут быть предупреждениями и не обязательно указывают на сбой."
    } : {
      style: "ok", icon: "i-check", title: "Известные ошибки не найдены",
      text: "Игра завершилась с кодом 0. Это не гарантирует, что другие проблемы отсутствуют."
    };
    const code = run.code == null ? "Код завершения недоступен." : `Код завершения: ${run.code}.`;
    return found ? {
      style: "error", icon: "i-alert", title: "Игра завершилась с ошибкой",
      text: `${code} Сам по себе код не объясняет причину; ниже — признаки, найденные в логе.`
    } : {
      style: "error", icon: "i-alert", title: "Причину определить не удалось",
      text: `${code} Сам по себе код не объясняет причину. Понадобится полный лог или краш-отчёт.`
    };
  }

  function renderErrors() {
    const meta = selected();
    if (!meta) return;
    const body = $("#tab-body");
    body.innerHTML = `
      <div class="errors-view">
        <div class="errors-shell">
          <header class="errors-head">
            <div class="errors-head-copy">
              <div class="errors-eyebrow"><svg class="ic"><use href="#i-alert"/></svg>Помощь при запуске</div>
              <h1>Ошибки сборки</h1>
              <p>Разбираем известные проблемы локально. Файлы не меняются без твоего действия; для установки подходящей версии используется каталог Modrinth.</p>
            </div>
            <div class="errors-head-actions"><button class="btn" data-errors-action="console"><svg class="ic"><use href="#i-terminal"/></svg>Открыть консоль</button></div>
          </header>
          <div id="errors-dynamic"></div>
        </div>
      </div>`;
    const view = $(".errors-view", body);
    view.addEventListener("click", handleErrorsClick);
    view.addEventListener("change", handleErrorsChange);
    renderErrorsContent();
  }

  function fabricDependency(item) {
    if (item && item.fabricApi) return { id: "fabric-api", name: "Fabric API", ...item.fabricApi };
    return item && item.fabricDependency || null;
  }

  /** Конкретная инструкция относится к настройкам именно последней попытки. */
  function contextualErrorFinding(item, meta, run) {
    const dependency = fabricDependency(item);
    if (!dependency) return item;
    const current = diagnosticLaunchContext(meta);
    const original = run && run.context;
    const changed = original && (original.mcVersion !== current.mcVersion
      || original.loader !== current.loader || original.loaderVersion !== current.loaderVersion);
    const formatContext = (context) => `Minecraft ${context.mcVersion || "?"} / ${LOADER_NAMES[context.loader] || context.loader || "?"}${context.loaderVersion ? ` ${context.loaderVersion}` : ""}`;
    if (changed) return { ...item, fabricActions: false,
      steps: [`Настройки изменились после этого запуска: тогда ${formatContext(original)}, сейчас ${formatContext(current)}.`,
        "Запусти сборку снова и проверь новую диагностику: старое требование может больше не относиться к ней.",
        "Не заменяй и не удаляй файлы по старой ошибке; при необходимости проверь полный лог."] };
    if (!original || diagnostics.latest(meta.id) !== run) return { ...item, fabricActions: false,
      steps: ["Это не последняя попытка или её настройки неизвестны. Запусти сборку снова и проверь новую диагностику."] };
    if (run.installApplied) return { ...item, fabricActions: false,
      steps: ["Состав модов уже изменён. Запусти сборку снова и проверь актуальные сообщения перед следующей установкой."] };
    if (current.loader !== "fabric" || !current.mcVersion || !current.loaderVersion) return { ...item, fabricActions: false,
      steps: [`Сейчас выбрано ${formatContext(current)}. Сообщение относится к зависимости Fabric; не устанавливай её вслепую.`,
        "Проверь, что выбрана нужная сборка и загрузчик, затем снова запусти игру и изучи полный лог."] };
    if (dependency.uncertain) return { ...item, fabricActions: false,
      steps: ["В логе встретились несколько требований к версии, которые нельзя надёжно сравнить автоматически.",
        "Проверь полный лог и подбери версию во встроенном разделе «Моды», не заменяя файлы вслепую."] };
    const minimum = dependency.minimum;
    return { ...item, description: item.description + ` Настройки этой попытки: ${formatContext(current)}.`, fabricActions: true,
      steps: ["Останови все окна этой сборки и сохрани резервную копию важных миров и модов.",
        "Нажми кнопку установки: лаунчер сначала проверит существующие .jar и выключенные файлы .disabled. Не добавляй вторую копию.",
        `Лаунчер подберёт файл для Minecraft ${current.mcVersion} и Fabric${minimum ? `, версия не ниже ${minimum}` : ""}; проверит требования fabric.mod.json к Fabric Loader и Java последнего запуска, а также SHA-512.`,
        "Если найденный файл нужно заменить, сначала появится подтверждение; старая версия сохранится в резервной копии.",
        "Запусти сборку снова. Могут потребоваться и другие зависимости: их нужно проверить по новому логу."] };
  }

  function diagnosticInstallKey(instanceId, attemptId, findingId) {
    return JSON.stringify([instanceId, attemptId, findingId]);
  }

  function refreshDiagnosticInstall(instanceId, attemptId) {
    if (state.tab === "errors" && state.selectedId === instanceId
      && diagnostics.selected(instanceId)?.id === attemptId && $("#errors-dynamic")) renderErrorsContent();
  }

  async function installDiagnosticDependency(meta, run, item) {
    const dependency = fabricDependency(item);
    const key = diagnosticInstallKey(meta.id, run.id, item.id);
    if (!dependency || state.diagnosticInstalls.get(key)?.busy || state.diagnosticInstalls.get(key)?.done) return;
    const stillCurrent = () => {
      const currentMeta = selected(), currentItem = run.findings.get(item.id);
      const currentDep = fabricDependency(currentItem);
      return currentMeta?.id === meta.id && diagnostics.selected(meta.id) === run && diagnostics.latest(meta.id) === run
        && currentDep && currentDep.id === dependency.id && currentDep.minimum === dependency.minimum && !currentDep.uncertain
        && contextualErrorFinding(currentItem, currentMeta, run).fabricActions
        && !state.running.has(meta.id) && !state.preparing.has(meta.id) && !["preparing", "running"].includes(run.status);
    };
    if (!stillCurrent()) { toast("Останови игру и проверь актуальную попытку запуска", "err"); return; }
    const operation = { busy: true, done: false, kind: "info", message: "Проверяем файлы и подбираем совместимую версию…" };
    state.diagnosticInstalls.set(key, operation);
    const update = () => refreshDiagnosticInstall(meta.id, run.id);
    update();
    const request = {
      mod_id: dependency.id, minimum: dependency.minimum || null,
      mc_version: run.context.mcVersion, loader_version: run.context.loaderVersion,
      java_major: null, replace_file: null, enable_file: null, expected_sha256: null
    };
    try {
      let result = await api.installDiagnosticMod(meta.id, run.id, request);
      if (result && result.status === "existing") {
        const found = Array.isArray(result.existing) ? result.existing : [];
        if (found.length !== 1 || found[0].nested) {
          const names = found.slice(0, 8).map((entry) => `${entry.name}${entry.disabled ? " (выключен)" : ""}${entry.nested ? " (встроен в другой мод)" : ""}`).join(", ");
          operation.kind = "warning";
          operation.message = `Найдены существующие файлы: ${names || "не удалось определить"}. Вторую копию не добавляли; проверь их во вкладке «Моды».`;
          return;
        }
        const existing = found[0];
        if (!existing.disabled && existing.compatible) {
          operation.kind = "warning";
          operation.message = `Уже установлен и включён ${existing.name} (${existing.version}). Вторую копию не добавляли; проверь новый лог и остальные зависимости.`;
          return;
        }
        if (!stillCurrent()) throw new Error("настройки или выбранная попытка изменились; повтори запуск");
        const enable = existing.disabled && existing.compatible;
        const question = enable
          ? `Найден выключенный совместимый файл «${existing.name}» (версия ${existing.version}). Включить его вместо скачивания второй копии?`
          : `Найден ${existing.disabled ? "выключенный" : "установленный"} файл «${existing.name}» (версия ${existing.version}). ${existing.compatibility_reason || "Его совместимость не подтверждена."}\n\nПодобрать другую версию? Перед заменой будет сохранена резервная копия.`;
        operation.message = "Ожидаем подтверждение изменения найденного файла.";
        update();
        const confirmed = await askConfirm({ title: enable ? "Включить найденный мод?" : "Заменить найденный мод?", text: question,
          ok: enable ? "Включить" : "Сохранить копию и заменить", danger: false });
        if (!confirmed) { operation.kind = "warning"; operation.message = "Изменения отменены, существующий файл сохранён."; return; }
        if (!stillCurrent()) throw new Error("настройки или выбранная попытка изменились; повтори запуск");
        if (enable) request.enable_file = existing.name;
        else request.replace_file = existing.name;
        request.expected_sha256 = existing.sha256;
        operation.message = enable ? "Включаем проверенный файл…" : "Подбираем версию и сохраняем резервную копию…";
        update();
        result = await api.installDiagnosticMod(meta.id, run.id, request);
      }
      if (!result || !["installed", "enabled"].includes(result.status)) throw new Error("лаунчер не подтвердил результат установки");
      operation.done = true;
      run.installApplied = true; // прежний лог больше не описывает текущий состав mods
      operation.kind = "ok";
      operation.message = `${result.status === "enabled" ? "Включён" : "Установлен"} ${result.filename || dependency.name}${result.version ? ` · ${result.version}` : ""}.`
        + (result.backup ? ` Прежний файл сохранён: ${result.backup}.` : "")
        + (result.has_other_dependencies ? " У мода могут быть дополнительные зависимости." : "")
        + (result.status === "installed" && !result.record_saved ? " Файл установлен, но запись для проверки обновлений не сохранена." : "")
        + " Запусти сборку снова и проверь результат.";
      toast(`${dependency.name}: ${result.status === "enabled" ? "включён" : "установлен"}`, "ok");
    } catch (error) {
      operation.kind = "error";
      operation.message = `Не удалось установить ${dependency.name}: ${String(error && error.message || error)}. Файлы, не относящиеся к подтверждённой замене, не изменялись.`;
      toast(`Установка ${dependency.name}: ${String(error && error.message || error)}`, "err");
    } finally {
      operation.busy = false;
      update();
    }
  }

  // Делегирование на контейнере вкладки: при обновлении карточек слушатели не размножаются.
  function handleErrorsClick(event) {
    const body = $("#tab-body");
    if (state.tab !== "errors" || !$("#errors-dynamic")) return;
    const button = event.target.closest("[data-errors-action]");
    if (!button || !body.contains(button)) return;
    const action = button.dataset.errorsAction;
    if (action === "console" || action === "settings" || action === "mods") {
      state.tab = action;
      renderTab();
      return;
    }
    if (action === "folder") {
      const meta = selected();
      if (meta) api.openPath(`/instances/${meta.id}/minecraft`).catch((error) => toast(`Не удалось открыть папку: ${error}`, "err"));
      return;
    }
    if (action === "java") { openPrefs("game"); return; }
    if (action === "install-dependency" || action === "dependency-folder") {
      const meta = selected();
      const run = meta && diagnostics.selected(meta.id);
      const findingId = button.closest("[data-diagnostic]")?.dataset.diagnostic;
      const item = run && run.findings.get(findingId);
      // Проверяем повторно при клике: сборка и настройки могли измениться.
      if (!item || !fabricDependency(item) || !contextualErrorFinding(item, meta, run).fabricActions) {
        toast("Настройки сборки изменились: запусти её снова и проверь новую ошибку", "err");
        renderErrorsContent();
        return;
      }
      if (action === "install-dependency") installDiagnosticDependency(meta, run, item);
      else api.openPath(`/instances/${meta.id}/minecraft/mods`)
        .catch((error) => toast(`Не удалось открыть папку mods: ${error}`, "err"));
      return;
    }
    if (action === "copy") copyErrorsAdvice();
  }

  function handleErrorsChange(event) {
    if (state.tab !== "errors" || !$("#errors-dynamic")) return;
    if (event.target.id === "errors-run") diagnostics.select(state.selectedId, event.target.value);
  }

  function renderErrorsContent() {
    const box = $("#errors-dynamic");
    const meta = selected();
    if (!box || !meta) return;
    const run = diagnostics.selected(meta.id);
    const status = errorsStatus(run);
    const sameRun = box.dataset.run === (run && run.id);
    const openDetails = sameRun ? new Set($$("details[open][data-evidence]", box).map((el) => el.dataset.evidence)) : new Set();
    const runs = diagnostics.list(meta.id);
    const choices = runs.length > 1 ? `
      <div class="errors-run-row"><label for="errors-run">Попытка запуска</label>
        <select class="select" id="errors-run">${runs.map((item) => `<option value="${esc(item.id)}" translate="no" ${item.id === run.id ? "selected" : ""}>${esc(errorsRunLabel(item))}</option>`).join("")}</select>
      </div>` : "";
    const list = run ? Array.from(run.findings.values()).sort((a, b) => b.priority - a.priority)
      .map((item) => contextualErrorFinding(item, meta, run)) : [];
    const showMods = list.some((item) => fabricDependency(item) || ["java-modules", "duplicate-mods", "mod-dependencies", "mixin"].includes(item.id));
    const showJava = list.some((item) => ["java-version", "java-missing", "memory-heap", "memory-reserve", "jvm"].includes(item.id));
    const cards = list.map((item) => {
      const dependency = fabricDependency(item);
      const operation = run && state.diagnosticInstalls.get(diagnosticInstallKey(meta.id, run.id, item.id));
      const busy = operation?.busy || operation?.done || state.running.has(meta.id) || state.preparing.has(meta.id)
        || run && ["preparing", "running"].includes(run.status);
      const label = operation?.busy ? "Проверяем…" : operation?.done ? "Готово"
        : dependency?.source === "replace" ? "Подобрать и установить версию" : `Установить ${dependency?.name || "мод"}`;
      return `
      <article class="errors-card" data-diagnostic="${esc(item.id)}">
        <div class="errors-card-head">
          <span class="errors-card-mark"><svg class="ic"><use href="#i-alert"/></svg></span>
          <div><h3>${esc(item.title)}</h3><p>${esc(item.description)}</p></div>
        </div>
        <ol class="errors-steps">${item.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>
        ${item.fabricActions ? `<div class="errors-card-actions">
          <button class="btn btn-small btn-primary" data-errors-action="install-dependency" ${busy ? "disabled" : ""}><svg class="ic"><use href="#i-download"/></svg>${esc(label)}</button>
          <button class="btn btn-small" data-errors-action="dependency-folder"><svg class="ic"><use href="#i-folder"/></svg>Открыть mods</button>
        </div>` : ""}
        ${operation?.message ? `<div class="errors-install-note is-${esc(operation.kind)}" role="status" aria-live="polite">${esc(operation.message)}</div>` : ""}
        <details class="errors-evidence" data-evidence="${esc(item.id)}" ${openDetails.has(item.id) ? "open" : ""}>
          <summary>Показать строку из лога</summary><pre>${esc(item.evidence)}</pre>
        </details>
      </article>`;
    }).join("");
    const raw = run && run.error ? `<details class="errors-evidence" data-evidence="preparation" ${openDetails.has("preparation") ? "open" : ""}>
      <summary>Показать сообщение запуска</summary><pre>${esc(run.error)}</pre></details>` : "";
    const unknown = run && !list.length && (run.status === "failed" || (run.status === "exited" && run.code !== 0));
    box.dataset.run = run ? run.id : "";
    box.innerHTML = `${choices}
      <section class="errors-status is-${esc(status.style)}" role="status" aria-live="polite">
        <span class="errors-status-icon"><svg class="ic"><use href="#${esc(status.icon)}"/></svg></span>
        <div class="errors-status-copy"><div class="errors-status-title">${esc(status.title)}</div><div class="errors-status-text">${esc(status.text)}</div>${raw}</div>
      </section>
      ${list.length ? `<div class="errors-section-title">На что обратить внимание</div><div class="errors-list">${cards}</div>` : ""}
      ${run && run.findingsLimited ? `<p class="errors-privacy">Показаны не все сигналы. Остальные сообщения можно посмотреть в консоли.</p>` : ""}
      ${unknown ? `<div class="errors-section-title">Что можно сделать</div>
        <article class="errors-card"><div class="errors-card-head"><span class="errors-card-mark"><svg class="ic"><use href="#i-file"/></svg></span><div><h3>Нужны подробности</h3><p>Без текста ошибки нельзя надёжно выбрать исправление.</p></div></div>
          <ol class="errors-steps"><li>Открой консоль и посмотри строки перед завершением.</li><li>В папке сборки найди <code>logs/latest.log</code> и, если есть, файл в <code>crash-reports</code>.</li><li>Передай полный лог или краш-отчёт автору сборки либо в поддержку.</li></ol>
        </article>` : ""}
      <aside class="errors-support">
        <div class="errors-support-copy"><strong>${run ? "Нужна дополнительная помощь?" : "Где искать полный лог"}</strong>
          <p>Открой папку сборки: обычно лог находится в <code>logs/latest.log</code>, а отчёты — в <code>crash-reports</code>. Файлов может не быть, а latest.log может перезаписаться другим запуском.</p>
        </div>
        <div class="errors-support-actions">
          <button class="btn btn-small" data-errors-action="folder"><svg class="ic"><use href="#i-folder"/></svg>Папка сборки</button>
          <button class="btn btn-small" data-errors-action="settings">Настройки сборки</button>
          ${showMods ? `<button class="btn btn-small" data-errors-action="mods">Моды</button>` : ""}
          ${showJava ? `<button class="btn btn-small" data-errors-action="java">Общие настройки Java</button>` : ""}
          ${list.length ? `<button class="btn btn-small" data-errors-action="copy"><svg class="ic"><use href="#i-copy"/></svg>Скопировать подсказки</button>` : ""}
        </div>
      </aside>
      <p class="errors-privacy">Результаты хранятся в памяти только во время текущего сеанса OmniSpec. Перед отправкой логов проверь, нет ли в них личных путей, ников и токенов; автоматически они никуда не отправляются.</p>`;
  }

  async function copyErrorsAdvice() {
    const meta = selected();
    const run = meta && diagnostics.selected(meta.id);
    if (!run) return;
    const list = Array.from(run.findings.values()).sort((a, b) => b.priority - a.priority)
      .map((item) => contextualErrorFinding(item, meta, run));
    const text = [`OmniSpec · ${meta.name} · MC ${meta.mc_version} · ${loaderLabel(meta.loader)}`,
      errorsStatus(run).title, ...list.map((item) => `\n${item.title}\n${item.description}\n${item.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`)].join("\n");
    try { await navigator.clipboard.writeText(text); toast("Подсказки скопированы (без лога)", "ok"); }
    catch { toast("Не удалось скопировать подсказки", "err"); }
  }

  /* ---------- консоль ---------- */
  /** Сколько строк всего и сколько показано: видно, что консоль грузит хвост. */
  function updateLogCount() {
    const box = $("#log-count");
    if (!box) return;
    const total = (state.logs[state.selectedId] || []).length;
    box.textContent = total ? (logDrawnLines < total ? `хвост ${logDrawnLines} из ${total} строк` : `${total} строк`) : "";
  }

  function renderConsole() {
    const meta = selected();
    $("#tab-body").innerHTML = `
      <div class="console-wrap">
        <div class="console-bar">
          <input class="input" id="log-search" placeholder="Найти..." spellcheck="false">
          <button class="btn btn-small" id="log-clear">Очистить</button>
          <button class="btn btn-small" id="log-copy">Скопировать</button>
          <div class="spacer"></div>
          <span class="muted" id="log-count" style="font-size:11px"></span>
          <span class="muted" style="font-size:11px" translate="no">${meta ? esc(meta.name) : ""}</span>
        </div>
        <div class="console" id="console-out"></div>
      </div>`;
    state.logQuery = "";
    logPending = [];
    renderLogs(state.selectedId);
    updateLogCount();
    $("#log-clear").addEventListener("click", () => {
      state.logs[state.selectedId] = [];
      logPending = [];
      renderLogs(state.selectedId);
      updateLogCount();
    });
    $("#log-copy").addEventListener("click", async () => {
      const text = (state.logs[state.selectedId] || []).map((entry) => entry.line).join("\n");
      try { await navigator.clipboard.writeText(text); toast("Лог скопирован", "ok"); }
      catch { toast("Не удалось скопировать", "err"); }
    });
    let searchTimer = 0;
    $("#log-search").addEventListener("input", (event) => {
      state.logQuery = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderLogs(state.selectedId, { query: state.logQuery }), 140);
    });
  }

  /* ---------- файлы: менеджер в духе OmniPanel ----------
   * Слева — дерево папки сборки: показываем и папки, и файлы с размерами.
   * Справа — хлебные крошки, список с колонками, превью и статус-бар.
   * Архивы (.zip/.jar/.mrpack/.rar) открываются как папка, картинки — в просмотрщике с зумом.
   */
  const FM_ARCHIVES = ["zip", "rar", "jar", "mrpack"];
  const FM_IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"];

  const fm = {
    revision: 0,
    path: "",
    entries: [],
    cache: new Map(),      // путь -> список того, что внутри
    expanded: new Set(),
    selected: null,
    preview: null,         // { kind: "text"|"image", text?, src?, name, error }
    query: "",
    archive: null,         // { path, entries, dir }
    drag: null,
    image: { zoom: 1, x: 0, y: 0 }
  };

  function fmExt(name) {
    const dot = String(name).lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function fmIsArchive(name) { return FM_ARCHIVES.includes(fmExt(name)); }
  function fmIsImage(name) { return FM_IMAGES.includes(fmExt(name)); }

  function fmKind(name) {
    const ext = fmExt(name);
    if (!ext) return "файл";
    const groups = {
      конфиг: ["json", "json5", "toml", "yaml", "yml", "properties", "cfg", "conf", "ini", "txt", "mcmeta", "snbt"],
      код: ["js", "ts", "rs", "py", "sh", "bat", "cmd", "lua", "java"],
      архив: FM_ARCHIVES,
      картинка: FM_IMAGES,
      лог: ["log", "txt"]
    };
    for (const [kind, list] of Object.entries(groups)) if (list.includes(ext)) return kind;
    return ext;
  }

  function fmIcon(name, isDir) {
    if (isDir) return "i-folder";
    if (fmIsArchive(name)) return "i-mod";
    if (fmIsImage(name)) return "i-grid";
    return "i-file";
  }

  function fmDate(seconds) {
    if (!seconds) return "—";
    const date = new Date(seconds * 1000);
    if (I18N.language() !== "ru") {
      return date.toLocaleString(I18N.locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** Содержимое папки с кэшем: дерево не дёргает диск на каждую перерисовку. */
  async function fmList(path) {
    const key = path || "";
    const instanceId = state.selectedId;
    const revision = fm.revision;
    if (fm.cache.has(key)) return fm.cache.get(key);
    const meta = selected();
    const entries = (isServer(meta)
      ? api.serverFiles(instanceId, key || null).then((items) => (items || []).map((item) => ({
          name: item.name, path: item.path, size: item.size || 0, modified: item.modified || null,
          is_dir: item.kind === "directory"
        })))
      : api.listDir(instanceId, key)
    ).catch((error) => { if (state.tab === "files" && state.selectedId === instanceId && fm.revision === revision) toast(String(error), "err"); return []; });
    const result = await entries;
    if (state.tab !== "files" || state.selectedId !== instanceId || fm.revision !== revision) return [];
    const sorted = result.slice().sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "ru"));
    fm.cache.set(key, sorted);
    return sorted;
  }

  function fmDropCache() { fm.cache.clear(); }

  /* ── дерево слева: папки и файлы с размерами ── */
  async function fmTreeHtml(path, depth) {
    const entries = await fmList(path);
    const term = fm.query.trim().toLowerCase();
    const dirs = entries.filter((entry) => entry.is_dir);
    const files = entries.filter((entry) => !entry.is_dir);
    let html = "";
    for (const dir of dirs) {
      const open = fm.expanded.has(dir.path);
      const active = fm.path === dir.path;
      html += `<div class="fm-row${open ? " open" : ""}${active ? " active" : ""}" data-dir="${esc(dir.path)}" data-drop="1" style="padding-left:${6 + depth * 12}px">
        <span class="arrow" data-toggle="${esc(dir.path)}">▸</span>
        <span class="ico"><svg class="ic" width="13" height="13"><use href="#i-folder"/></svg></span>
        <span class="nm">${esc(dir.name)}</span>
      </div>`;
      if (open) html += await fmTreeHtml(dir.path, depth + 1);
    }
    for (const file of files) {
      if (term && !file.name.toLowerCase().includes(term)) continue;
      const active = fm.selected === file.path;
      html += `<div class="fm-row is-file${active ? " active" : ""}" data-file="${esc(file.path)}" data-drag="${esc(file.path)}" style="padding-left:${6 + depth * 12}px">
        <span class="arrow is-leaf"></span>
        <span class="ico"><svg class="ic" width="13" height="13"><use href="#${fmIcon(file.name, false)}"/></svg></span>
        <span class="nm">${esc(file.name)}</span>
        <span class="sz">${humanSize(file.size)}</span>
      </div>`;
    }
    return html;
  }

  async function fmRenderTree() {
    const box = $("#fm-tree");
    if (!box) return;
    const instanceId = state.selectedId;
    const revision = fm.revision;
    const html = await fmTreeHtml("", 0);
    if (!box.isConnected || state.tab !== "files" || state.selectedId !== instanceId || fm.revision !== revision) return;
    box.innerHTML = html || `<div class="fm-empty">${fm.query ? "Ничего не найдено" : "Папка пуста"}</div>`;
    $$(".fm-row", box).forEach((row) => {
      const path = row.dataset.dir;
      const file = row.dataset.file;
      const arrow = $(".arrow", row);
      if (path !== undefined && arrow) {
        arrow.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (fm.expanded.has(path)) fm.expanded.delete(path); else fm.expanded.add(path);
          await fmRenderTree();
        });
      }
      if (path !== undefined) {
        row.addEventListener("click", () => { if (consumeDragClick()) return; fmOpen(path); });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          fmOpenMenu(event.clientX, event.clientY, { path, name: path.split("/").pop(), is_dir: true, size: 0 });
        });
        row.addEventListener("mousedown", (event) => fmBeginDrag(event, path, true));
      }
      if (file !== undefined) {
        row.addEventListener("click", () => { if (consumeDragClick()) return; fmPreviewFile(file); });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const entry = fm.entries.find((item) => item.path === file);
          fmOpenMenu(event.clientX, event.clientY, { path: file, name: file.split("/").pop(), is_dir: false, size: entry ? entry.size : 0 });
        });
        row.addEventListener("mousedown", (event) => fmBeginDrag(event, file, false));
      }
    });
  }

  /* ── хлебные крошки: папка сборки или путь внутри архива ── */
  function fmRenderCrumb() {
    const box = $("#fm-crumb");
    if (!box) return;
    const meta = selected();
    const chips = [];
    if (fm.archive) {
      const parts = String(fm.archive.dir || "").split("/").filter(Boolean);
      chips.push(`<span class="c archive" title="Выйти из архива"><span translate="no">${esc(String(fm.archive.path).split("/").pop())}</span></span>`);
      parts.forEach((part, index) => {
        const path = parts.slice(0, index + 1).join("/");
        chips.push(`<span class="s">/</span><span class="c${index === parts.length - 1 ? " last" : ""}" data-arc="${esc(path)}" translate="no">${esc(part)}</span>`);
      });
      box.innerHTML = chips.join("");
      const up = $(".c.archive", box);
      if (up) up.addEventListener("click", () => fmCloseArchive());
      $$(".c[data-arc]", box).forEach((chip) => chip.addEventListener("click", () => {
        fm.archive.dir = chip.dataset.arc;
        fmRenderList();
        fmRenderCrumb();
        fmRenderStatus();
      }));
      return;
    }
    const parts = fm.path ? fm.path.split("/").filter(Boolean) : [];
    chips.push(`<span class="c" data-crumb="" ${meta ? 'translate="no"' : ""}>${esc(meta ? meta.name : "сборка")}</span>`);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      chips.push(`<span class="s">/</span><span class="c${index === parts.length - 1 ? " last" : ""}" data-crumb="${esc(path)}" translate="no">${esc(part)}</span>`);
    });
    box.innerHTML = chips.join("");
    $$(".c", box).forEach((chip) => {
      chip.addEventListener("click", () => fmOpen(chip.dataset.crumb || ""));
      if (chip.dataset.crumb) chip.dataset.drop = chip.dataset.crumb;
    });
  }

  /* ── список: папка сборки или содержимое архива ── */
  function fmArchiveRows() {
    const arc = fm.archive;
    if (!arc) return { dirs: [], files: [] };
    const dir = arc.dir ? `${arc.dir.replace(/\/+$/, "")}/` : "";
    const dirs = new Set();
    const files = [];
    arc.entries.forEach((entry) => {
      const name = entry.name.replace(/\/+$/, "");
      if (!name || name === arc.dir) return;
      if (dir && !name.startsWith(dir)) return;
      const rest = dir ? name.slice(dir.length) : name;
      if (!rest) return;
      if (rest.includes("/")) {
        dirs.add(`${dir}${rest.split("/")[0]}`);
      } else if (!entry.is_dir) {
        files.push({ name: rest, path: name, size: entry.size, packed: entry.packed, is_dir: false });
      }
    });
    return {
      dirs: [...dirs].sort((a, b) => a.localeCompare(b, "ru")).map((path) => ({ name: path.split("/").pop(), path, is_dir: true, size: 0 })),
      files: files.sort((a, b) => a.name.localeCompare(b.name, "ru"))
    };
  }

  function fmRenderList() {
    const list = $("#fm-list");
    if (!list) return;
    const term = fm.query.trim().toLowerCase();
    let rows = [];
    if (fm.archive) {
      const { dirs, files } = fmArchiveRows();
      rows = [...dirs, ...files];
    } else {
      rows = fm.entries.slice();
    }
    if (term) rows = rows.filter((entry) => entry.name.toLowerCase().includes(term));
    const items = rows.map((entry) => {
      const sel = fm.selected === entry.path ? " active" : "";
      const extra = fm.archive ? "" : entry.is_dir
        ? `<span class="fdate">—</span>`
        : `<span class="fdate" translate="no" data-fm-modified="${Number(entry.modified) || 0}">${fmDate(entry.modified)}</span>`;
      const size = entry.is_dir ? "—" : humanSize(entry.size);
      return `<div class="fm-item${sel}" data-path="${esc(entry.path)}" data-dir="${entry.is_dir ? "true" : "false"}"${entry.is_dir && !fm.archive ? ' data-drop="1"' : ""}>
        <span class="fname">
          <span class="ico"><svg class="ic" width="13" height="13"><use href="#${fmIcon(entry.name, entry.is_dir)}"/></svg></span>
          <span class="nm">${esc(entry.name)}</span>
        </span>
        <span class="fsize">${size}</span>
        ${extra}
      </div>`;
    }).join("");
    const head = fm.archive
      ? `<div class="fm-head is-archive"><span>Имя в архиве</span><span>Размер</span></div>`
      : `<div class="fm-head"><span>Имя</span><span>Размер</span><span>Изменён</span></div>`;
    list.innerHTML = `${head}${items || `<div class="fm-empty">${fm.archive ? "В архиве пусто" : "Папка пуста"}</div>`}`;
    $$(".fm-item", list).forEach((row) => {
      const path = row.dataset.path;
      const isDir = row.dataset.dir === "true";
      row.addEventListener("click", () => {
        if (consumeDragClick()) return;
        if (fm.archive) {
          if (isDir) {
            fm.archive.dir = path;
            fmRenderList();
            fmRenderCrumb();
            fmRenderStatus();
          } else {
            fmPreviewEntry(path);
          }
          return;
        }
        if (isDir) fmOpen(path); else fmPreviewFile(path);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const entry = rows.find((item) => item.path === path) || { path, name: path.split("/").pop(), is_dir: isDir, size: 0 };
        fmOpenMenu(event.clientX, event.clientY, entry);
      });
      if (!fm.archive) row.addEventListener("mousedown", (event) => fmBeginDrag(event, path, isDir));
    });
  }

  /* ── просмотр: текст с номерами строк или картинка с зумом ── */
  function fmRenderView() {
    const view = $("#fm-view");
    if (!view) return;
    const preview = fm.preview;
    if (!preview) { view.hidden = true; view.classList.remove("is-image"); return; }
    view.hidden = false;
    view.classList.toggle("is-image", preview.kind === "image");
    if (preview.error) {
      view.innerHTML = `<div class="fm-empty">${esc(preview.error)}</div>`;
      return;
    }
    if (preview.kind === "image") {
      fm.image = { zoom: 1, x: 0, y: 0 };
      view.innerHTML = `
        <div class="fm-viewer">
          <div class="fm-viewer-bar">
            <span class="fm-viewer-name" translate="no" title="${esc(preview.name || "")}">${esc(preview.name || "картинка")}</span>
            <span class="spacer"></span>
            <button class="btn-mini" id="fm-zoom-out" title="Уменьшить">−</button>
            <span class="fm-zoom-val mono" id="fm-zoom-val">100%</span>
            <button class="btn-mini" id="fm-zoom-in" title="Увеличить">+</button>
            <button class="btn-mini" id="fm-zoom-fit" title="Вписать в окно">Вписать</button>
            <button class="btn-mini" id="fm-zoom-100" title="Натуральный размер">1:1</button>
          </div>
          <div class="fm-viewer-body" id="fm-viewer-body">
            <img class="fm-img" id="fm-img" src="${preview.src}" alt="" draggable="false">
          </div>
        </div>`;
      const body = $("#fm-viewer-body");
      const img = $("#fm-img");
      img.addEventListener("load", () => {
        // мелкие текстуры показываем пикселями, большие фото — сглаженно
        img.classList.toggle("is-pixel", img.naturalWidth <= 256);
        const fit = Math.min(1, Math.min(body.clientWidth / img.naturalWidth, body.clientHeight / img.naturalHeight));
        fm.image = { zoom: fit || 1, x: 0, y: 0 };
        fmImageApply();
      });
      $("#fm-zoom-in").addEventListener("click", () => fmZoom(1.25));
      $("#fm-zoom-out").addEventListener("click", () => fmZoom(1 / 1.25));
      $("#fm-zoom-100").addEventListener("click", () => { fm.image = { zoom: 1, x: 0, y: 0 }; fmImageApply(); });
      $("#fm-zoom-fit").addEventListener("click", () => {
        const fit = Math.min(1, Math.min(body.clientWidth / img.naturalWidth, body.clientHeight / img.naturalHeight));
        fm.image = { zoom: fit || 1, x: 0, y: 0 };
        fmImageApply();
      });
      body.addEventListener("wheel", (event) => {
        event.preventDefault();
        fmZoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
      // перетаскивание картинки: тянем за неё, когда увеличена
      let pan = null;
      body.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        pan = { x: event.clientX, y: event.clientY, ox: fm.image.x, oy: fm.image.y };
        body.classList.add("is-pan");
        event.preventDefault();
      });
      window.addEventListener("mousemove", (event) => {
        if (!pan || !$("#fm-viewer-body")) return;
        fm.image.x = pan.ox + (event.clientX - pan.x);
        fm.image.y = pan.oy + (event.clientY - pan.y);
        fmImageApply();
      });
      window.addEventListener("mouseup", () => { pan = null; body.classList.remove("is-pan"); });
      return;
    }
    const lines = String(preview.text || "").split("\n");
    const gutter = lines.map((_, index) => index + 1).join("\n");
    view.innerHTML = `<div class="fm-gutter">${gutter}</div><pre class="fm-pre">${esc(preview.text || "")}</pre>`;
  }

  function fmImageApply() {
    const img = $("#fm-img");
    if (!img) return;
    const { zoom, x, y } = fm.image;
    img.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const label = $("#fm-zoom-val");
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  }

  function fmZoom(multiplier) {
    const zoom = Math.min(8, Math.max(0.05, fm.image.zoom * multiplier));
    fm.image.zoom = zoom;
    fmImageApply();
  }

  function fmRenderStatus() {
    const meta = selected();
    const pathBox = $("#fm-path");
    if (!pathBox) return;
    const target = fm.selected || fm.path;
    if (fm.archive) {
      pathBox.textContent = `${fm.archive.path}${fm.archive.dir ? ` / ${fm.archive.dir}` : ""}`;
      $("#fm-kind").hidden = false;
      $("#fm-kind").textContent = "архив";
      $("#fm-size").textContent = `${fm.archive.entries.length} записей`;
      $("#fm-lines").textContent = fm.preview && fm.preview.kind === "text" ? `${String(fm.preview.text || "").split("\n").length} стр.` : "";
      return;
    }
    pathBox.textContent = target ? `${meta ? meta.name : "сборка"}/${target}` : `${meta ? meta.name : "сборка"}`;
    const entry = fm.entries.find((item) => item.path === fm.selected);
    $("#fm-kind").hidden = !entry;
    if (entry) $("#fm-kind").textContent = fmKind(entry.name);
    $("#fm-size").textContent = entry ? humanSize(entry.size) : `${fm.entries.length} объектов`;
    const lines = fm.preview && fm.preview.kind === "text" ? String(fm.preview.text || "").split("\n").length : 0;
    $("#fm-lines").textContent = lines ? `${lines} стр.` : "";
  }

  async function fmRefresh() {
    if (!$("#fm-tree")) return;
    const instanceId = state.selectedId;
    const revision = fm.revision;
    const path = fm.path;
    const valid = () => state.tab === "files" && state.selectedId === instanceId && fm.revision === revision && fm.path === path;
    const entries = await fmList(path);
    if (!valid()) return;
    fm.entries = entries;
    await fmRenderTree();
    if (!valid()) return;
    fmRenderList();
    fmRenderCrumb();
    fmRenderStatus();
  }

  async function fmOpen(path) {
    fm.path = path || "";
    fm.selected = null;
    fm.preview = null;
    fm.archive = null;
    fm.expanded.add(fm.path);
    $("#fm-list").hidden = false;
    const backButton = $("#fm-back");
    if (backButton) backButton.hidden = true;
    fmRenderView();
    await fmRefresh();
  }

  /* ── превью файла: картинка или текст ── */
  async function fmPreviewFile(path) {
    fm.selected = path;
    fmRenderList();
    fmRenderTree();
    const view = $("#fm-view");
    const list = $("#fm-list");
    if (view) { view.hidden = false; view.innerHTML = `<div class="fm-empty">Читаем файл…</div>`; }
    if (list) list.hidden = true;
    const back = $("#fm-back");
    if (back) back.hidden = false;
    const name = path.split("/").pop();
    try {
      if (fmIsImage(name)) {
        const src = await api.fmReadImage(state.selectedId, path);
        fm.preview = { kind: "image", src, name, error: null };
      } else if (fmIsArchive(name)) {
        // архив показываем как папку, а не текстом
        await fmOpenArchive(path);
        return;
      } else {
        const text = await api.readFile(state.selectedId, path);
        fm.preview = { kind: "text", text, name, error: null };
      }
    } catch (error) {
      fm.preview = { kind: "text", text: "", name, error: String(error) };
    }
    fmRenderView();
    fmRenderStatus();
  }

  /* ── архивы: показываем содержимое как папку ── */
  async function fmOpenArchive(path) {
    const view = $("#fm-view");
    const list = $("#fm-list");
    if (view) { view.hidden = false; view.innerHTML = `<div class="fm-empty">Читаем архив…</div>`; }
    if (list) list.hidden = true;
    try {
      const entries = await api.archiveList(state.selectedId, path);
      fm.archive = { path, entries, dir: "" };
      fm.preview = null;
      fm.selected = null;
      if (view) view.hidden = true;
      if (list) list.hidden = false;
      const back = $("#fm-back");
      if (back) back.hidden = false;
      fmRenderList();
      fmRenderCrumb();
      fmRenderStatus();
    } catch (error) {
      fm.preview = { kind: "text", text: "", name: path, error: String(error) };
      fmRenderView();
      fmRenderStatus();
    }
  }

  function fmCloseArchive() {
    fm.archive = null;
    fm.preview = null;
    fm.selected = null;
    const view = $("#fm-view");
    const list = $("#fm-list");
    if (view) { view.hidden = true; view.classList.remove("is-image"); }
    if (list) list.hidden = false;
    const back = $("#fm-back");
    if (back) back.hidden = true;
    fmRenderList();
    fmRenderCrumb();
    fmRenderStatus();
  }

  async function fmPreviewEntry(entry) {
    const view = $("#fm-view");
    const list = $("#fm-list");
    if (view) { view.hidden = false; view.innerHTML = `<div class="fm-empty">Читаем файл из архива…</div>`; }
    if (list) list.hidden = true;
    const back = $("#fm-back");
    if (back) back.hidden = false;
    const name = String(entry).split("/").pop();
    try {
      const result = await api.archiveRead(state.selectedId, fm.archive.path, entry);
      if (result.kind === "image") {
        fm.preview = { kind: "image", src: result.data_url, name, error: null };
      } else {
        fm.preview = { kind: "text", text: result.text || "", name, error: null };
      }
    } catch (error) {
      fm.preview = { kind: "text", text: "", name, error: String(error) };
    }
    fmRenderView();
    fmRenderStatus();
  }

  /** «Назад»: из файла — к списку, из архива — на уровень выше. */
  function fmBack() {
    if (fm.preview) {
      fm.preview = null;
      fmShowList();
      fmRenderList();
      fmRenderCrumb();
      fmRenderStatus();
      return;
    }
    if (fm.archive && fm.archive.dir) {
      const parts = fm.archive.dir.split("/").filter(Boolean);
      parts.pop();
      fm.archive.dir = parts.join("/");
      fmShowList();
      fmRenderList();
      fmRenderCrumb();
      fmRenderStatus();
      return;
    }
    if (fm.archive) { fmCloseArchive(); return; }
    fm.selected = null;
    fmShowList();
    fmRenderList();
    fmRenderStatus();
  }

  function fmShowList() {
    const view = $("#fm-view");
    const list = $("#fm-list");
    if (view) { view.hidden = true; view.classList.remove("is-image"); }
    if (list) list.hidden = false;
    const back = $("#fm-back");
    if (back) back.hidden = !(fm.archive && fm.archive.dir);
  }

  /* ── ПКМ по файлу или папке ── */
  function fmOpenMenu(x, y, entry) {
    if (!entry) return;
    const isDir = Boolean(entry.is_dir);
    const name = entry.name || String(entry.path).split("/").pop();
    const archive = !isDir && fmIsArchive(name);
    const dirOf = (path) => String(path).split("/").slice(0, -1).join("/");
    if (fm.archive) {
      fillCtxMenu(x, y, `
        <div class="ctx-caption" translate="no">${esc(name)}</div>
        ${isDir ? `<button class="ctx-item" data-act="open"><svg class="ic"><use href="#i-folder"/></svg>Открыть папку</button>` : `<button class="ctx-item" data-act="open"><svg class="ic"><use href="#i-base"/></svg>Открыть в просмотре</button>`}
        <div class="ctx-sep"></div>
        <button class="ctx-item" data-act="up"><svg class="ic"><use href="#i-chev"/></svg>Выйти из архива</button>`, (act) => {
        if (act === "open") {
          if (isDir) {
            fm.archive.dir = entry.path;
            fmRenderList(); fmRenderCrumb(); fmRenderStatus();
          } else {
            fmPreviewEntry(entry.path);
          }
        }
        if (act === "up") fmCloseArchive();
      });
      return;
    }
    fillCtxMenu(x, y, `
      <div class="ctx-caption" translate="no" title="${esc(entry.path)}">${esc(name)}</div>
      ${isDir
        ? `<button class="ctx-item" data-act="open"><svg class="ic"><use href="#i-folder"/></svg>Открыть</button>`
        : archive
          ? `<button class="ctx-item" data-act="archive"><svg class="ic"><use href="#i-mod"/></svg>Открыть архив</button>
             <button class="ctx-item" data-act="open"><svg class="ic"><use href="#i-base"/></svg>Открыть в просмотре</button>`
          : `<button class="ctx-item" data-act="open"><svg class="ic"><use href="#i-base"/></svg>Открыть в просмотре</button>`}
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="rename"><svg class="ic"><use href="#i-pencil"/></svg>Переименовать</button>
      <button class="ctx-item" data-act="mkdir"><svg class="ic"><use href="#i-plus"/></svg>Новая папка${isDir ? " внутри" : ""}</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="reveal"><svg class="ic"><use href="#i-folder"/></svg>Показать в проводнике</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Удалить</button>`, async (act) => {
      if (act === "open") {
        if (isDir) await fmOpen(entry.path);
        else await fmPreviewFile(entry.path);
      }
      if (act === "archive") await fmOpenArchive(entry.path);
      if (act === "rename") {
        const next = await promptModal({ title: "Переименовать", label: "Новое имя", value: name });
        if (!next || next === name) return;
        try {
          await api.fmRename(state.selectedId, entry.path, next);
          fmDropCache();
          await fmRefresh();
          toast("Переименовано", "ok");
        } catch (error) { toast(String(error), "err"); }
      }
      if (act === "mkdir") {
        const base = isDir ? entry.path : dirOf(entry.path);
        const next = await promptModal({ title: "Новая папка", label: "Название", value: "" });
        if (!next) return;
        try {
          await api.fmCreateDir(state.selectedId, base ? `${base}/${next}` : next);
          fm.expanded.add(base || "");
          fmDropCache();
          await fmRefresh();
          toast(`Папка «${next}» создана`, "ok");
        } catch (error) { toast(String(error), "err"); }
      }
      if (act === "reveal") {
        const meta = selected();
        if (!meta) return;
        const dir = isDir ? entry.path : dirOf(entry.path);
        api.openPath(`/instances/${meta.id}/minecraft${dir ? `/${dir}` : ""}`).catch((error) => toast(String(error), "err"));
      }
      if (act === "delete") {
        const okDelete = await askConfirm({
          title: "Удалить",
          text: isDir ? `Папка «${name}» будет удалена вместе с содержимым.` : `Файл «${name}» будет удалён.`,
          ok: "Удалить"
        });
        if (!okDelete) return;
        try {
          await api.deleteFile(state.selectedId, entry.path);
          if (fm.selected === entry.path) { fm.preview = null; fmRenderView(); }
          fm.selected = null;
          fmDropCache();
          await fmRefresh();
          toast("Удалено", "ok");
        } catch (error) { toast(String(error), "err"); }
      }
    });
  }

  /* ── перенос файлов мышью между папками ── */
  function fmClearDrop() {
    $$(".fm-item.is-drop, .fm-row.is-drop, .fm-crumb .c.is-drop").forEach((el) => el.classList.remove("is-drop"));
  }

  function fmBeginDrag(event, path, isDir) {
    if (event.button !== 0) return;
    fm.drag = { path, isDir, startX: event.clientX, startY: event.clientY, active: false, ghost: null, target: null };
    window.addEventListener("mousemove", fmDragMove);
    window.addEventListener("mouseup", fmDragEnd);
  }

  function fmDragMove(event) {
    const drag = fm.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active && Math.hypot(dx, dy) < 5) return;
    if (!drag.active) {
      drag.active = true;
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.innerHTML = `<span class="drag-ghost-name" translate="no">${esc(String(drag.path).split("/").pop())}</span>`;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      document.body.classList.add("is-dragging");
    }
    drag.ghost.style.left = `${event.clientX + 12}px`;
    drag.ghost.style.top = `${event.clientY + 10}px`;
    fmClearDrop();
    drag.target = null;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (!under) return;
    const folder = under.closest('.fm-item[data-drop="1"], .fm-row[data-drop="1"], .fm-crumb .c[data-drop]');
    if (folder) {
      folder.classList.add("is-drop");
      // у строки списка путь в data-path, у папки в дереве — в data-dir, у крошки — в data-drop
      drag.target = folder.dataset.path !== undefined
        ? folder.dataset.path
        : folder.dataset.dir !== undefined
          ? folder.dataset.dir
          : folder.dataset.drop;
    } else if (under.closest("#fm-list, #fm-tree")) {
      drag.target = fm.path;   // бросок в пустое место — в текущую папку
    }
  }

  async function fmDragEnd() {
    window.removeEventListener("mousemove", fmDragMove);
    window.removeEventListener("mouseup", fmDragEnd);
    const drag = fm.drag;
    fm.drag = null;
    if (!drag) return;
    fmClearDrop();
    document.body.classList.remove("is-dragging");
    if (drag.ghost) drag.ghost.remove();
    if (!drag.active) return;
    armDragClickGuard();
    if (drag.target === null) return;
    const from = String(drag.path);
    const to = String(drag.target || "");
    const fromDir = from.split("/").slice(0, -1).join("/");
    if (fromDir === to) return;
    try {
      const moved = await api.fmMove(state.selectedId, [from], to);
      if (!moved) return;
      fm.expanded.add(to);
      fmDropCache();
      await fmRefresh();
      await fmRenderTree();
      toast(`Перенесено в «${to || "корень сборки"}»`, "ok");
    } catch (error) {
      toast(String(error), "err");
    }
  }

  async function renderFiles() {
    fm.revision += 1;
    fm.path = "";
    fm.entries = [];
    fm.cache.clear();
    fm.expanded.clear();
    fm.selected = null;
    fm.preview = null;
    fm.query = "";
    fm.archive = null;
    $("#tab-body").innerHTML = `
      <div class="fm">
        <aside class="fm-side">
          <div class="fm-side-head">
            <input class="filter" id="fm-search" placeholder="найти файл…" spellcheck="false">
            <button class="btn-mini" id="fm-refresh" title="Обновить дерево">⟳</button>
            <button class="btn-mini" id="fm-mkdir" title="Новая папка">+ папка</button>
          </div>
          <div class="fm-tree" id="fm-tree"><div class="fm-empty">Загрузка…</div></div>
        </aside>
        <div class="fm-main">
          <div class="fm-bar">
            <div class="fm-crumb" id="fm-crumb"></div>
            <div class="right">
              <button class="btn btn-small" id="fm-back" hidden>← Назад</button>
              <button class="btn btn-small" id="fm-mkdir-top">+ папка</button>
              <button class="btn btn-small" id="fm-open-ext">Открыть папку</button>
              <button class="btn btn-small" id="fm-reload">Обновить</button>
            </div>
          </div>
          <div class="fm-list" id="fm-list"></div>
          <div class="fm-view" id="fm-view" hidden></div>
          <div class="fm-status">
            <span id="fm-path" translate="no">—</span>
            <span class="spacer"></span>
            <span id="fm-lines"></span>
            <span class="fm-badge" id="fm-kind" hidden>—</span>
            <span id="fm-size"></span>
          </div>
        </div>
      </div>`;

    $("#fm-search").addEventListener("input", (event) => {
      fm.query = event.target.value;
      fmRenderTree();
      fmRenderList();
    });
    $("#fm-refresh").addEventListener("click", async () => { fmDropCache(); await fmRenderTree(); });
    $("#fm-back").addEventListener("click", fmBack);
    $("#fm-reload").addEventListener("click", async () => { fmDropCache(); await fmRefresh(); });
    const mkdirHere = async () => {
      const next = await promptModal({ title: "Новая папка", label: "Название", value: "" });
      if (!next) return;
      try {
        await api.fmCreateDir(state.selectedId, fm.path ? `${fm.path}/${next}` : next);
        fm.expanded.add(fm.path);
        fmDropCache();
        await fmRefresh();
        toast(`Папка «${next}» создана`, "ok");
      } catch (error) { toast(String(error), "err"); }
    };
    $("#fm-list").addEventListener("contextmenu", (event) => {
      if (event.target.closest(".fm-item")) return;
      event.preventDefault();
      fillCtxMenu(event.clientX, event.clientY, `
        <div class="ctx-caption" ${!fm.archive && fm.path ? 'translate="no"' : ""}>${esc(fm.archive ? "Архив" : fm.path || "сборка")}</div>
        ${fm.archive
          ? `<button class="ctx-item" data-act="up"><svg class="ic"><use href="#i-chev"/></svg>Выйти из архива</button>`
          : `<button class="ctx-item" data-act="mkdir"><svg class="ic"><use href="#i-plus"/></svg>Новая папка</button>
             <button class="ctx-item" data-act="reload"><svg class="ic"><use href="#i-refresh"/></svg>Обновить</button>`}`, async (act) => {
        if (act === "mkdir") await mkdirHere();
        if (act === "reload") { fmDropCache(); await fmRefresh(); }
        if (act === "up") fmCloseArchive();
      });
    });
    $("#fm-mkdir").addEventListener("click", mkdirHere);
    $("#fm-mkdir-top").addEventListener("click", mkdirHere);
    $("#fm-open-ext").addEventListener("click", () => {
      const meta = selected();
      if (!meta) return toast("Сборка не выбрана", "err");
      const suffix = fm.path ? `/${fm.path}` : "";
      api.openPath(`/instances/${meta.id}/minecraft${suffix}`).catch((error) => toast(String(error), "err"));
    });

    await fmRefresh();
  }

  /* ---------- моды / ресурспаки / шейдеры ---------- */
  /** Что за вид содержимого: папка, заголовки, тексты. */
  const CONTENT_KINDS = {
    mod: {
      folder: "mods",
      title: "Моды сборки",
      empty: "Модов нет",
      addLabel: "Добавить с Modrinth",
      search: "Найти мод",
      deps: true,
      menuTitle: "мода",
      pageLabel: "Перейти на страницу мода"
    },
    resourcepack: {
      folder: "resourcepacks",
      title: "Ресурспаки",
      empty: "Ресурспаков нет",
      addLabel: "Скачать с Modrinth",
      search: "Найти ресурспак",
      deps: false,
      menuTitle: "ресурспака",
      pageLabel: "Перейти на страницу ресурспака"
    },
    shader: {
      folder: "shaderpacks",
      title: "Шейдеры",
      empty: "Шейдеров нет",
      addLabel: "Скачать с Modrinth",
      search: "Найти шейдер",
      deps: false,
      menuTitle: "шейдера",
      pageLabel: "Перейти на страницу шейдера"
    }
  };

  /** Иконка мода: картинка с Modrinth, иначе нейтральный значок. */
  function modIconHtml(mod) {
    return contentIconHtml("mod", mod);
  }

  /** Иконка файла контента: картинка (мод/пак), иначе значок вида. */
  function contentIconHtml(kind, entry) {
    const url = state.modIcons[entry.filename || entry.name];
    if (url) return `<span class="mod-icon"><img src="${esc(url)}" alt="" loading="lazy"></span>`;
    const fallback = kind === "shader" ? "i-gem" : kind === "resourcepack" ? "i-base" : "i-mod";
    return `<span class="mod-icon"><svg class="ic"><use href="#${fallback}"/></svg></span>`;
  }

  /** Название файла без версии и расширения — для карточек без картотеки. */
  function contentTitle(entry) {
    return entry.title || entry.filename || entry.name;
  }

  function contentUpdates(kind) {
    return state.contentUpdates[kind] || [];
  }

  function updateOf(kind, entry) {
    return contentUpdates(kind).find((item) => item.filename === entry.filename);
  }

  let contentViewInstance = null;
  let contentRenderSerial = 0;
  async function renderContent(kind) {
    const cfg = CONTENT_KINDS[kind] || CONTENT_KINDS.mod;
    const meta = selected();
    const tabForKind = kind === "mod" ? "mods" : kind === "resourcepack" ? "resourcepacks" : "shaders";
    if (!meta || state.tab !== tabForKind) return;
    if (contentViewInstance !== meta.id) {
      // Иконки и найденные обновления относятся к конкретной сборке.
      contentViewInstance = meta.id;
      state.modIcons = {};
      state.contentUpdates = {};
    }
    const generation = tabRenderGeneration;
    const serial = ++contentRenderSerial;
    const entries = await api.contentList(meta.id, kind).catch(() => []);
    if (state.windowHidden || serial !== contentRenderSerial || generation !== tabRenderGeneration
        || state.tab !== tabForKind || state.selectedId !== meta.id) {
      state.uiRefreshPending = true;
      return;
    }
    if (kind === "mod") {
      state.mods = entries;
      $("#badge-mods").hidden = !entries.length;
      $("#badge-mods").textContent = String(entries.length);
    }
    // иконки подгружаются для модов, ресурспаков и шейдеров
    if (!Object.keys(state.modIcons).length) {
      api.modIcons(meta.id).then((map) => {
        if (state.windowHidden || !map || !Object.keys(map).length || generation !== tabRenderGeneration
            || state.selectedId !== meta.id || contentViewInstance !== meta.id) {
          if (state.windowHidden) state.uiRefreshPending = true;
          return;
        }
        state.modIcons = map;
        if (state.tab === "mods" || state.tab === "resourcepacks" || state.tab === "shaders") {
          renderContent(state.tab === "mods" ? "mod" : state.tab === "resourcepacks" ? "resourcepack" : "shader");
        }
      }).catch(() => {});
    }

    const query = (state.contentQuery[kind] || "").trim().toLowerCase();
    const visible = query
      ? entries.filter((entry) => contentTitle(entry).toLowerCase().includes(query)
        || String(entry.filename).toLowerCase().includes(query))
      : entries;
    const enabled = entries.filter((entry) => entry.enabled).length;
    const updates = contentUpdates(kind);
    const taskBusy = Boolean(state.contentTask?.busy);
    const checkLabel = state.contentTask?.type === "check" || state.contentTask?.type === "check-one"
      ? "Проверяем…" : "Проверить обновления";

    const rows = visible.map((entry) => {
      const update = updateOf(kind, entry);
      return `
        <div class="item-row content-row ${entry.enabled ? "" : "is-off"}" data-content="${esc(entry.filename)}">
          ${contentIconHtml(kind, entry)}
          <div class="item-main">
            <div class="item-title"><span translate="no">${esc(contentTitle(entry))}</span>${entry.enabled ? "" : ' <span class="tag">выключен</span>'}</div>
            <div class="item-sub">${entry.version_number ? `v${esc(entry.version_number)} · ` : ""}${humanSize(entry.size)}${update ? ` · <span class="content-update">есть ${esc(update.latest)}</span>` : ""}</div>
          </div>
          ${update ? `<button class="btn btn-small btn-primary" data-update-one="${esc(entry.filename)}">Обновить</button>` : ""}
          <button class="switch ${entry.enabled ? "on" : ""}" data-toggle="${esc(entry.filename)}" title="Включить/выключить"></button>
          <button class="icon-btn" data-delete="${esc(entry.filename)}" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
        </div>`;
    }).join("");

    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>${cfg.title}</strong>
            <span class="badge content-count" title="Включено файлов: ${enabled}">${enabled} вкл.</span>
            <div class="spacer"></div>
            <label class="search content-search">
              <svg class="ic"><use href="#i-search"/></svg>
              <input id="content-query" placeholder="${cfg.search}" spellcheck="false" autocomplete="off" value="${esc(state.contentQuery[kind] || "")}">
            </label>
            <button class="btn btn-small" id="content-check" title="Проверить обновления под эту версию игры и загрузчик" ${taskBusy ? "disabled" : ""}>
              <svg class="ic"><use href="#i-refresh"/></svg>${checkLabel}
            </button>
            ${cfg.deps ? `<button class="btn btn-small" id="content-deps" title="Докачать недостающие зависимости модов"><svg class="ic"><use href="#i-download"/></svg>Зависимости</button>` : ""}
            <button class="btn btn-small" id="content-open">Открыть папку</button>
            <button class="btn btn-small btn-primary" id="content-add">${cfg.addLabel}</button>
          </div>
          ${entries.length
            ? (rows || `<div class="item-row"><div class="item-main muted">Ничего не нашлось</div></div>`)
            : `<div class="item-row"><div class="item-main muted">${cfg.empty}</div></div>`}
          ${updates.length ? `<div class="panel-foot muted" id="content-hint">Найдено обновлений: ${updates.length} — «Проверить обновления» покажет список</div>` : ""}
        </div>
      </div>`;

    $("#content-add").addEventListener("click", () => {
      cancelDownloadSearchTimer();
      invalidateDownloadSearch("modrinth");
      setDownloadFilter("modrinth", "type", kind);
      state.modrinth.query = state.modsQuery;
      state.modsSource = "modrinth";
      state.tab = "download";
      refreshInstalledProjects();
      renderTab();
    });
    $("#content-open").addEventListener("click", () => api.openPath(`/instances/${meta.id}/minecraft/${cfg.folder}`).catch((err) => toast(String(err), "err")));
    const input = $("#content-query");
    input.addEventListener("input", () => {
      state.contentQuery[kind] = input.value;
      const caret = input.selectionStart;
      renderContent(kind).then(() => {
        const next = $("#content-query");
        if (!next) return;
        next.focus();
        try { next.setSelectionRange(caret, caret); } catch (error) { /* поле не в фокусе */ }
      });
    });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape") { input.value = ""; state.contentQuery[kind] = ""; renderContent(kind); } });

    $$("#tab-body [data-toggle]").forEach((el) => el.addEventListener("click", async () => {
      try { await api.contentToggle(meta.id, kind, el.dataset.toggle); renderContent(kind); }
      catch (err) { toast(String(err), "err"); }
    }));
    $$("#tab-body [data-delete]").forEach((el) => el.addEventListener("click", async () => {
      const name = el.dataset.delete;
      const ok = await askConfirm({
        title: "Удалить файл?",
        text: `«${name}» будет удалён из сборки.`,
        ok: "Удалить",
        danger: true
      });
      if (!ok) return;
      try { await api.contentDelete(meta.id, kind, name); renderContent(kind); toast("Удалено", "ok"); }
      catch (err) { toast(String(err), "err"); }
    }));
    $$("#tab-body [data-update-one]").forEach((el) => el.addEventListener("click", () => updateContentFile(kind, el.dataset.updateOne, el)));
    $$("#tab-body .content-row").forEach((row) => row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const entry = entries.find((item) => item.filename === row.dataset.content);
      if (entry) openContentMenu(event.clientX, event.clientY, kind, entry);
    }));

    $("#content-check").addEventListener("click", () => checkContentUpdates(kind));
    const deps = $("#content-deps");
    if (deps) deps.addEventListener("click", () => ensureDependencies());
  }

  /** ПКМ по файлу: обновления, страница проекта, вкл/выкл, папка, удаление. */
  function openContentMenu(x, y, kind, entry) {
    const cfg = CONTENT_KINDS[kind] || CONTENT_KINDS.mod;
    const meta = selected();
    const update = updateOf(kind, entry);
    const pageUrl = (update && update.page_url)
      || (entry.project_id ? `https://modrinth.com/${kind === "mod" ? "mod" : kind}/${entry.project_id}` : null);
    // смену версии умеем только для проектов Modrinth (у CurseForge id — чисто цифры)
    const canReplace = Boolean(entry.project_id) && !/^\d+$/.test(entry.project_id);
    const html = `
      <div class="ctx-caption" translate="no">${esc(contentTitle(entry))}${entry.version_number ? ` · v${esc(entry.version_number)}` : ""}</div>
      <button class="ctx-item" data-act="check"><svg class="ic"><use href="#i-refresh"/></svg>Проверить обновления под мою версию</button>
      ${update ? `<button class="ctx-item" data-act="update"><svg class="ic"><use href="#i-download"/></svg>Обновить до ${esc(update.latest)}</button>` : ""}
      ${canReplace ? `<button class="ctx-item" data-act="replace"><svg class="ic"><use href="#i-list"/></svg>Поменять версию…</button>` : ""}
      ${pageUrl ? `<button class="ctx-item" data-act="page"><svg class="ic"><use href="#i-link"/></svg>${cfg.pageLabel}</button>` : ""}
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="toggle"><svg class="ic"><use href="#i-${entry.enabled ? "close" : "check"}"/></svg>${entry.enabled ? "Отключить" : "Включить"}</button>
      <button class="ctx-item" data-act="folder"><svg class="ic"><use href="#i-folder"/></svg>Открыть папку ${cfg.folder}</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Удалить</button>`;
    fillCtxMenu(x, y, html, async (act) => {
      try {
        if (act === "check") await checkContentUpdates(kind, entry.filename);
        else if (act === "update") await updateContentFile(kind, entry.filename);
        else if (act === "replace") await openVersions(entry.project_id, kind, contentTitle(entry), entry);
        else if (act === "page") await api.openUrl(pageUrl);
        else if (act === "toggle") { await api.contentToggle(meta.id, kind, entry.name); renderContent(kind); }
        else if (act === "folder") await api.openPath(`/instances/${meta.id}/minecraft/${cfg.folder}`);
        else if (act === "delete") {
          const ok = await askConfirm({ title: "Удалить файл?", text: `«${entry.filename}» будет удалён из сборки.`, ok: "Удалить", danger: true });
          if (ok) { await api.contentDelete(meta.id, kind, entry.filename); renderContent(kind); toast("Удалено", "ok"); }
        }
      } catch (err) { toast(String(err), "err"); }
    });
  }

  function contentTarget(meta) {
    return {
      mcVersion: meta.mc_version,
      loader: meta.loader || { type: "vanilla" }
    };
  }

  function syncContentTaskControls() {
    const busy = Boolean(state.contentTask?.busy);
    const check = $("#content-check");
    if (check) {
      const checking = state.contentTask?.type === "check" || state.contentTask?.type === "check-one";
      check.disabled = busy;
      check.innerHTML = `<svg class="ic"><use href="#i-refresh"/></svg>${checking ? "Проверяем…" : "Проверить обновления"}`;
    }
    const all = $("#upd-list-all");
    if (all) {
      const hasRows = Boolean($("#upd-list-body")?.querySelector("[data-upd]"));
      all.disabled = busy || !hasRows;
      if (!busy) all.textContent = "Обновить всё";
    }
    $$("#upd-list-body [data-upd-one]").forEach((button) => {
      if (!busy && button.textContent !== "Обновить") button.textContent = "Обновить";
      button.disabled = busy;
    });
  }

  function beginContentTask(kind, type, instanceId) {
    if (state.contentTask?.busy) {
      toast("Дождись окончания текущей операции", "");
      return null;
    }
    const task = { kind, type, instanceId, busy: true };
    state.contentTask = task;
    syncContentTaskControls();
    return task;
  }

  function endContentTask(task) {
    if (state.contentTask === task) state.contentTask = null;
    syncContentTaskControls();
    const modal = $("#modal-updates-list");
    const body = $("#upd-list-body");
    if (modal && !modal.hidden && body && !body.querySelector("[data-upd]")) modal.hidden = true;
  }

  function contentTaskIsCurrent(task, meta) {
    return state.contentTask === task && task.busy
      && state.selectedId === meta.id && selected()?.id === meta.id;
  }

  function contentErrorText(error) {
    return String(error?.message || error || "неизвестная ошибка");
  }

  async function confirmContentUpdate(meta, kind, item, count = 1) {
    const target = `Minecraft ${meta.mc_version}${kind === "mod" ? ` · ${loaderLabel(meta.loader)}` : ""}`;
    return askConfirm({
      title: count > 1 ? "Обновить найденные файлы?" : "Поставить обновление?",
      text: count > 1
        ? `Будет обновлено файлов: ${count}.\nЦелевой профиль: ${target}.\nПользовательские данные, настройки и миры не удаляются.`
        : `${item.title}: ${item.current} → ${item.latest}.\nПоставить под ${target}?`,
      ok: count > 1 ? "Обновить всё" : "Обновить",
      danger: false
    });
  }

  /** Проверка обновлений: одного файла или всех сразу. */
  async function checkContentUpdates(kind, filename = null) {
    const meta = selected();
    if (!meta) return;
    const task = beginContentTask(kind, filename ? "check-one" : "check", meta.id);
    if (!task) return;
    const generation = tabRenderGeneration;
    const stillCurrent = () => generation === tabRenderGeneration && state.selectedId === meta.id;
    const body = kind === "mod" ? "моды сборки" : kind === "shader" ? "шейдеры сборки" : "ресурспаки сборки";
    toast(filename ? `Проверяем обновления «${filename}»…` : `Проверяем обновления (${body})…`);
    try {
      const report = await withInstallProgress(
        meta.id,
        "check",
        (op) => api.contentCompatibility(meta.id, kind, contentTarget(meta), op),
        { detail: "Проверяем…", opPrefix: "check:" }
      );
      if (!stillCurrent()) return;
      // Старые демо/плагины могли вернуть сам массив; принимаем оба формата,
      // но новое ядро возвращает ещё и список несовместимых файлов.
      const updates = Array.isArray(report) ? report : (report?.updates || []);
      state.contentUpdates[kind] = updates;
      if (filename) {
        const found = updates.find((item) => item.filename === filename);
        if (!found) { toast("Это последняя совместимая версия", "ok"); return; }
        const ok = await confirmContentUpdate(meta, kind, found);
        if (!stillCurrent()) return;
        if (ok) {
          // Проверка уже заняла task-lock; отпускаем его перед вложенной
          // установкой, которая создаст собственную операцию прогресса.
          task.busy = false;
          endContentTask(task);
          await updateContentFile(kind, filename, null, { confirmed: true });
        } else renderContent(kind);
        return;
      }
      renderContent(kind);
      const incompatible = Array.isArray(report?.incompatible) ? report.incompatible.length : 0;
      if (!updates.length) {
        if (incompatible) openUpdatesDialog(kind, updates, report);
        toast(incompatible
          ? `Совместимых обновлений нет; несовместимых файлов: ${incompatible}`
          : "Обновлений нет — все файлы актуальны", incompatible ? "" : "ok");
        return;
      }
      openUpdatesDialog(kind, updates, report);
    } catch (err) {
      if (stillCurrent()) toast(`Не удалось проверить обновления: ${contentErrorText(err)}`, "err");
    } finally {
      task.busy = false;
      endContentTask(task);
    }
  }

  /** Окно «Обновления»: список найденного и «Обновить всё». */
  function openUpdatesDialog(kind, updates, report = null) {
    const modal = $("#modal-updates-list");
    if (!modal) return;
    const cfg = CONTENT_KINDS[kind] || CONTENT_KINDS.mod;
    const list = Array.isArray(updates) ? updates.slice() : [];
    $("#upd-list-title").textContent = `Обновления: ${cfg.title.toLowerCase()}`;
    const incompatible = Array.isArray(report?.incompatible) ? report.incompatible : [];
    $("#upd-list-body").innerHTML = `${list.map((item) => `
      <div class="item-row upd-row" data-upd="${esc(item.filename)}">
        <div class="item-main">
          <div class="item-title" translate="no">${esc(item.title)}</div>
          <div class="item-sub">${esc(item.current)} → ${esc(item.latest)} · ${esc(item.new_filename)}</div>
          ${item.error ? `<div class="item-sub content-update-error" role="alert">Ошибка: ${esc(item.error)}</div>` : ""}
        </div>
        <button class="btn btn-small btn-primary" data-upd-one="${esc(item.filename)}">Обновить</button>
      </div>`).join("")}${incompatible.length ? `
      <div class="panel-foot muted" role="status">
        <div>Несовместимых файлов: ${incompatible.length}. Они сохранены без изменений.</div>
        ${incompatible.map((issue) => `<div class="content-update-error" translate="no">${esc(issue.filename)}: ${esc(issue.reason || "нет совместимой версии")}</div>`).join("")}
      </div>` : ""}`;
    $$("#upd-list-body [data-upd-one]").forEach((btn) => btn.addEventListener("click", () => updateContentFile(kind, btn.dataset.updOne, btn)));
    const all = $("#upd-list-all");
    all.disabled = !list.length || Boolean(state.contentTask?.busy);
    all.textContent = "Обновить всё";
    all.onclick = () => updateContentBatch(kind, list);
    modal.hidden = false;
  }

  /** Убрать строку из окна обновлений; пустое окно закрываем. */
  function removeUpdateRow(filename) {
    const row = $(`#upd-list-body [data-upd="${CSS.escape(filename)}"]`);
    if (row) row.remove();
    const body = $("#upd-list-body");
    if (body && !body.querySelector("[data-upd]") && !state.contentTask?.busy) {
      const modal = $("#modal-updates-list");
      if (modal) modal.hidden = true;
    }
  }

  /** Установить все найденные обновления последовательно и дождаться каждого.
   * Ошибка одного файла не прерывает остальные: успешные исчезают из списка,
   * а неудачные остаются для повторной попытки. */
  async function updateContentBatch(kind, updates, options = {}) {
    const meta = selected();
    if (!meta || !Array.isArray(updates) || !updates.length) return { succeeded: [], failed: [] };
    const task = beginContentTask(kind, "update-all", meta.id);
    if (!task) return { succeeded: [], failed: updates.slice() };
    const succeeded = [];
    const failed = [];
    let cancelled = false;
    try {
      let confirmed = Boolean(options.confirmed);
      if (!confirmed) {
        confirmed = await confirmContentUpdate(meta, kind, updates[0], updates.length);
        if (!confirmed) cancelled = true;
      }
      if (!cancelled) {
        try {
          await withInstallProgress(meta.id, "update", async (op) => {
            for (const item of updates.slice()) {
              if (!contentTaskIsCurrent(task, meta)) throw new Error("операция обновления отменена");
              try {
                await api.contentUpdate(meta.id, kind, item.filename, item, op);
                succeeded.push(item);
              } catch (error) {
                failed.push({ item, error: contentErrorText(error) });
              }
            }
            if (failed.length) {
              throw new Error(`не удалось обновить ${failed.length} из ${updates.length} файлов`);
            }
          }, { detail: "Обновляем…" });
        } catch (error) {
          // Ошибка одного файла уже учтена и не прерывает очередь. Сюда
          // попадают отмена и неожиданный сбой до обработки очереди.
          if (!failed.length && updates.length) {
            failed.push(...updates
              .filter((item) => !succeeded.some((done) => done.filename === item.filename))
              .map((item) => ({ item, error: contentErrorText(error) })));
          }
        }
      }
    } finally {
      task.busy = false;
      endContentTask(task);
    }

    if (cancelled) return { succeeded, failed };
    state.contentUpdates[kind] = (state.contentUpdates[kind] || []).filter(
      (item) => !succeeded.some((done) => done.filename === item.filename)
    );
    renderContent(kind);
    if (failed.length) {
      const failedItems = failed.map(({ item, error }) => ({ ...item, error }));
      if (options.openDialogOnFailure !== false) openUpdatesDialog(kind, failedItems);
      if (options.announce !== false) {
        toast(`Обновлено ${succeeded.length} из ${updates.length}; ошибок: ${failed.length}`, "err");
      }
    } else {
      if (options.closeModal !== false) $("#modal-updates-list").hidden = true;
      if (options.announce !== false) toast(`Обновлено модов: ${succeeded.length}`, "ok");
    }
    return { succeeded, failed };
  }

  /** Поставить обновление одного файла: прогресс — в панели загрузок. */
  async function updateContentFile(kind, filename, btn = null, options = {}) {
    const meta = selected();
    if (!meta) return;
    const task = beginContentTask(kind, "update-one", meta.id);
    if (!task) return;
    const item = (state.contentUpdates[kind] || []).find((entry) => entry.filename === filename) || null;
    if (!item) {
      endContentTask(task);
      toast("Обновление устарело — проверь список ещё раз", "err");
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Обновляем…"; }
    try {
      if (!options.confirmed && !(await confirmContentUpdate(meta, kind, item))) {
        if (btn) { btn.disabled = false; btn.textContent = "Обновить"; }
        return;
      }
      await withInstallProgress(meta.id, "update", (op) => api.contentUpdate(meta.id, kind, filename, item, op), { detail: "Обновляем…" });
      state.contentUpdates[kind] = (state.contentUpdates[kind] || []).filter((entry) => entry.filename !== filename);
      removeUpdateRow(filename);
      renderContent(kind);
      toast("Обновлено", "ok");
    } catch (err) {
      toast(`Не удалось обновить: ${contentErrorText(err)}`, "err");
      if (btn) { btn.disabled = false; btn.textContent = "Обновить"; }
    } finally {
      task.busy = false;
      endContentTask(task);
    }
  }

  /** Автодокачка зависимостей для уже установленных модов. */
  async function ensureDependencies() {
    const meta = selected();
    toast("Проверяем зависимости модов…");
    try {
      const result = await withDownloading(null, (op) => api.ensureDependencies(meta.id, op), { instanceId: meta.id, source: "modrinth" });
      const added = (result && result.installed) || [];
      renderContent("mod");
      toast(added.length ? `Докачано: ${added.join(", ")}` : "Все зависимости на месте", "ok");
    } catch (err) { toast(String(err), "err"); }
  }

  /* ---------- миры ---------- */
  async function renderWorlds() {
    const meta = selected();
    if (!meta) return;
    const generation = tabRenderGeneration;
    const entries = await api.listDir(meta.id, "saves").catch(() => []);
    const icons = await api.worldIcons(meta.id).catch(() => ({}));
    if (generation !== tabRenderGeneration || state.tab !== "worlds" || state.selectedId !== meta.id) return;
    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>Миры</strong>
            <span class="badge">${entries.length}</span>
            <div class="spacer"></div>
            <button class="btn btn-small" id="worlds-open">Открыть папку</button>
          </div>
          ${entries.length ? entries.map((entry) => {
            const icon = icons[entry.name];
            return `
            <div class="item-row">
              ${icon
                ? `<span class="mod-icon"><img src="${esc(icon)}" alt="" loading="lazy"></span>`
                : `<span class="mod-icon"><svg class="ic"><use href="#i-cube"/></svg></span>`}
              <div class="item-main"><div class="item-title" translate="no">${esc(entry.name)}</div><div class="item-sub">${humanSize(entry.size)}</div></div>
            </div>`;
          }).join("") : `<div class="item-row"><div class="item-main muted">Миров пока нет — создай их в игре</div></div>`}
        </div>
      </div>`;
    $("#worlds-open").addEventListener("click", () => api.openPath(`/instances/${meta.id}/minecraft/saves`).catch(() => {}));
  }

  /* ---------- Скриншоты ---------- */
  /* Скриншоты грузятся порциями: все картинки сразу роняли WebView по памяти. */
  const SHOT_PAGE = 30;
  let shotObserver = null;
  let shotInstanceId = null;

  async function renderScreenshots() {
    const meta = selected();
    if (!meta) return;
    const generation = tabRenderGeneration;
    const entries = await api.listScreenshots(meta.id).catch(() => []);
    if (generation !== tabRenderGeneration || state.tab !== "screenshots" || state.selectedId !== meta.id) return;
    shotInstanceId = meta.id;
    state.shots = { entries, shown: 0 };
    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>Скриншоты</strong>
            <span class="badge">${entries.length}</span>
            <div class="spacer"></div>
            <button class="btn btn-small" id="shots-open">Открыть папку</button>
          </div>
          ${entries.length ? `<div class="shots-grid" id="shots-grid"></div><div class="mr-sentinel" id="shots-sentinel"></div>`
          : `<div class="item-row"><div class="item-main muted">Скриншотов пока нет — нажми F2 в игре</div></div>`}
        </div>
      </div>`;
    $("#shots-open").addEventListener("click", () => api.openPath(`/instances/${meta.id}/minecraft/screenshots`).catch(() => {}));
    if (entries.length) {
      appendShotBatch();
      watchShotsMore();
    }
  }

  /** Добавить следующую порцию плиток; миниатюры подгружаются по мере прокрутки. */
  function appendShotBatch() {
    const st = state.shots;
    const grid = $("#shots-grid");
    if (!st || !grid) return;
    const slice = st.entries.slice(st.shown, st.shown + SHOT_PAGE);
    st.shown += slice.length;
    grid.insertAdjacentHTML("beforeend", slice.map((entry) => `
      <button class="shot-tile" data-shot-name="${esc(entry.name)}" title="${esc(entry.name)}">
        <span class="shot-img"><svg class="ic shot-placeholder"><use href="#i-image"/></svg></span>
        <span class="shot-name" translate="no">${esc(entry.name)}</span>
        <span class="shot-sub">${humanSize(entry.size)}${entry.modified ? ` · ${relativeWhen(entry.modified)}` : ""}</span>
      </button>`).join(""));
    const tiles = grid.querySelectorAll(".shot-tile:not([data-thumb])");
    const io = new IntersectionObserver((list) => {
      for (const item of list) {
        if (!item.isIntersecting) continue;
        const tile = item.target;
        io.unobserve(tile);
        tile.dataset.thumb = "1";
        api.screenshotThumb(shotInstanceId, tile.dataset.shotName).then((src) => {
          const box = tile.querySelector(".shot-img");
          if (src && box) box.innerHTML = `<img src="${esc(src)}" alt="" loading="lazy">`;
        }).catch(() => {});
      }
    }, { rootMargin: "200px" });
    tiles.forEach((tile) => io.observe(tile));
    grid.querySelectorAll(".shot-tile:not([data-bound])").forEach((tile) => {
      tile.dataset.bound = "1";
      const entry = st.entries.find((item) => item.name === tile.dataset.shotName);
      tile.addEventListener("click", () => { if (entry) openShot(entry); });
      tile.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (entry) openShotMenu(event.clientX, event.clientY, entry);
      });
    });
    updateShotsSentinel();
  }

  function watchShotsMore() {
    if (shotObserver) { shotObserver.disconnect(); shotObserver = null; }
    const sentinel = $("#shots-sentinel");
    if (!sentinel) return;
    shotObserver = new IntersectionObserver((list) => {
      if (list.some((item) => item.isIntersecting)) appendShotBatch();
    }, { rootMargin: "400px" });
    shotObserver.observe(sentinel);
  }

  function updateShotsSentinel() {
    const sentinel = $("#shots-sentinel");
    const st = state.shots;
    if (!sentinel || !st) return;
    sentinel.textContent = st.shown >= st.entries.length
      ? `Показано всё: ${st.entries.length}`
      : `Прокрути вниз — ещё ${st.entries.length - st.shown}`;
    if (st.shown >= st.entries.length && shotObserver) {
      shotObserver.disconnect();
      shotObserver = null;
    }
  }

  /** Просмотр скриншота на весь экран: полный файл грузится по одному. */
  let shotCurrent = null;
  let shotCurrentSrc = "";
  let shotLoadToken = 0;
  async function openShot(entry) {
    shotCurrent = entry;
    const token = ++shotLoadToken;
    $("#shot-title").textContent = entry.name;
    const img = $("#shot-img");
    img.removeAttribute("src");
    const metaText = `${humanSize(entry.size)}${entry.modified ? ` · ${relativeWhen(entry.modified)}` : ""}`;
    $("#shot-meta").textContent = `${metaText} · загрузка…`;
    $("#modal-shot").hidden = false;
    try {
      const src = await api.screenshotFull(shotInstanceId, entry.name);
      if (token !== shotLoadToken || $("#modal-shot").hidden) return;
      shotCurrentSrc = src || "";
      if (src) img.src = src;
      $("#shot-meta").textContent = metaText;
    } catch (err) {
      if (token !== shotLoadToken) return;
      $("#shot-meta").textContent = "Не удалось загрузить изображение";
    }
  }

  function closeShot() {
    shotLoadToken += 1;
    $("#modal-shot").hidden = true;
    $("#shot-img").src = "";
    shotCurrent = null;
    shotCurrentSrc = "";
  }

  /** Скопировать картинку скриншота в буфер обмена как изображение. */
  async function copyShotImage(entry) {
    try {
      const src = await api.screenshotFull(shotInstanceId, entry.name);
      if (!src) throw new Error("no image");
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      toast("Изображение скопировано", "ok");
    } catch (err) {
      toast("Не удалось скопировать изображение", "err");
    }
  }

  /** Контекстное меню скриншота (ПКМ по плитке и по картинке в просмотре). */
  function openShotMenu(x, y, entry) {
    fillCtxMenu(x, y, `
      <div class="ctx-caption" translate="no">${esc(entry.name)}</div>
      <button class="ctx-item" data-act="copy"><svg class="ic"><use href="#i-copy"/></svg>Копировать изображение</button>
      <button class="ctx-item" data-act="open"><svg class="ic"><use href="#i-image"/></svg>Открыть</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="file"><svg class="ic"><use href="#i-file"/></svg>Открыть файл</button>
      <button class="ctx-item" data-act="folder"><svg class="ic"><use href="#i-folder"/></svg>Открыть папку</button>`,
    (act) => {
      if (act === "copy") copyShotImage(entry);
      else if (act === "open") openShot(entry);
      else if (act === "file") api.openPath(entry.path).catch((error) => toast(String(error), "err"));
      else if (act === "folder") api.openPath(entry.path.replace(/\\[^\\/]*$/, "")).catch((error) => toast(String(error), "err"));
    });
  }

  /* ---------- Modrinth ---------- */
  const MR_PAGE = 24;
  const SEARCH_INPUT_DELAY_MS = 300;
  let mrObserver = null;
  let mrSearchGeneration = 0;
  let cfSearchGeneration = 0;
  let downloadSearchTimer = null;
  let downloadSearchInstance = null;
  /* лента готовых сборок в главном окне */
  const DV_PAGE = 24;
  let dvObserver = null;

  /** Общий размер плитки на странице «Загрузить»: 1 → 12, 2 → 9, 3 → 6 в ряд.
   *  Один на оба источника; старые ключи mr_grid/cf_grid — для миграции. */
  function modsGridLevel() {
    const s = state.settings || {};
    const level = Number(s.mods_grid ?? s.mr_grid ?? s.cf_grid);
    return level === 1 || level === 2 || level === 3 ? level : 2;
  }

  // Ползунок задаёт максимум, а не число, которое нужно принудительно
  // втиснуть в узкое окно. Вычитаем фактический padding и учитываем gap.
  function catalogColumns(level, width = 0, gap = 8) {
    const wanted = level === 1 ? 12 : level === 3 ? 6 : 9;
    if (width <= 0) return wanted;
    return Math.max(1, Math.min(wanted, Math.floor((width + gap) / (120 + gap))));
  }
  function modsColumns(level = modsGridLevel(), width = 0, gap = 8) {
    return catalogColumns(level, width, gap);
  }

  let catalogResizeObserver = null;
  let catalogResizeBound = false;
  function syncCatalogColumns() {
    const results = $("#dv-results, #mr-results, #cf-results");
    if (!results || !results.isConnected) return;
    const css = getComputedStyle(results);
    const width = results.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
    const gap = parseFloat(css.columnGap) || 0;
    const level = results.id === "dv-results" ? feedGridLevel() : modsGridLevel();
    const columns = String(catalogColumns(level, width, gap));
    if (results.style.getPropertyValue("--feed-cols") !== columns) results.style.setProperty("--feed-cols", columns);
  }
  function bindCatalogResize() {
    const results = $("#dv-results, #mr-results, #cf-results");
    if (catalogResizeObserver) catalogResizeObserver.disconnect();
    if (results && typeof ResizeObserver !== "undefined") {
      catalogResizeObserver ||= new ResizeObserver(() => syncCatalogColumns());
      catalogResizeObserver.observe(results);
    }
    if (!catalogResizeBound) {
      catalogResizeBound = true;
      window.addEventListener("resize", syncCatalogColumns);
    }
    syncCatalogColumns();
  }

  function mrGridLevel() { return modsGridLevel(); }
  function mrColumns(level = modsGridLevel()) { return modsColumns(level); }

  /** Один и тот же понятный переключатель источника для модов и готовых сборок. */
  function sourceButtonsHtml(scope, active) {
    return `<div class="catalog-sources" role="group" aria-label="Источник поиска">
      ${[["modrinth", "Modrinth"], ["curseforge", "CurseForge"]].map(([source, title]) => `
        <button type="button" id="${scope}-source-${source}" class="catalog-source${active === source ? " is-active" : ""}"
          data-${scope}-source="${source}" data-source="${source}" aria-label="Искать на ${title}"
          aria-pressed="${active === source}" title="${title}"><svg class="ic" aria-hidden="true"><use href="#i-${source}"/></svg></button>`).join("")}
    </div>`;
  }

  function updateSourceButtons(scope, active) {
    $$(`[data-${scope}-source]`).forEach((button) => {
      const selected = button.dataset.source === active;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  /** Не отправляем незавершённую IME-композицию даже в WebView без isComposing. */
  function bindLiveSearch(input, schedule, run) {
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("input", (event) => schedule(event.target.value, composing || event.isComposing));
    input.addEventListener("compositionend", (event) => { composing = false; schedule(event.target.value); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !composing && !event.isComposing) { event.preventDefault(); run(); }
    });
  }

  function catalogVisible(source) {
    return state.tab === "download" && state.modsSource === source && Boolean(state.dlRoot?.isConnected);
  }

  function cancelDownloadSearchTimer() {
    if (downloadSearchTimer) clearTimeout(downloadSearchTimer);
    downloadSearchTimer = null;
  }

  /** Отмена относится и к первой странице, и к параллельной догрузке. */
  function invalidateDownloadSearch(source) {
    if (source === "curseforge") cfSearchGeneration += 1;
    else mrSearchGeneration += 1;
    const cfg = source === "curseforge" ? state.curseforge : state.modrinth;
    cfg.loading = false;
    cfg.loadingMore = false;
    cfg.tried = false;
    cfg.error = null;
    cfg.results = [];
    cfg.total = 0;
  }

  function renderCatalogSource(source) {
    if (!catalogVisible(source)) return;
    if (source === "curseforge") renderCurseForge();
    else renderModrinth();
  }

  function scheduleDownloadSearch(value, composing = false) {
    const source = state.modsSource === "curseforge" ? "curseforge" : "modrinth";
    const cfg = source === "curseforge" ? state.curseforge : state.modrinth;
    state.modsQuery = value;
    cfg.query = value;
    cancelDownloadSearchTimer();
    // Инвалидируем сразу, а не после debounce: старый ответ не мигнёт во время ввода.
    invalidateDownloadSearch(source);
    cfg.loading = true;
    cfg.tried = true;
    renderCatalogSource(source);
    if (composing) return;
    downloadSearchTimer = setTimeout(() => {
      downloadSearchTimer = null;
      if (catalogVisible(source)) dlRunSearch();
      else { cfg.loading = false; cfg.tried = false; }
    }, SEARCH_INPUT_DELAY_MS);
  }

  /** Общие фильтры синхронизированы, но модпаки и сортировка CurseForge остаются его собственными. */
  function setDownloadFilter(source, field, value) {
    const current = source === "curseforge" ? state.curseforge : state.modrinth;
    const other = source === "curseforge" ? state.modrinth : state.curseforge;
    current[field] = value;
    // На странице Modrinth нет модпаков: не подменяем им последний общий тип.
    if (field !== "type" || ["mod", "resourcepack", "shader"].includes(value)) other[field] = value;
  }

  function selectDownloadSource(source) {
    if (source !== "modrinth" && source !== "curseforge") return;
    if (source === state.modsSource) {
      if (downloadSearchTimer) dlRunSearch();
      return;
    }
    cancelDownloadSearchTimer();
    invalidateDownloadSearch(state.modsSource);
    state.modsSource = source;
    const cfg = source === "curseforge" ? state.curseforge : state.modrinth;
    invalidateDownloadSearch(source);
    cfg.query = state.modsQuery;
    updateSourceButtons("dl", source);
    refreshInstalledProjects();
    dlRunSearch();
  }

  function setDownloadView(view) {
    if (view !== "list" && view !== "grid") return;
    state.modsView = view;
    $$("[data-dl-view]").forEach((button) => {
      const selected = button.dataset.dlView === view;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const results = $("#mr-results") || $("#cf-results");
    if (results) {
      results.classList.toggle("is-grid", view === "grid");
      results.classList.remove("feed-grid-1", "feed-grid-2", "feed-grid-3");
      if (view === "grid") results.classList.add(`feed-grid-${modsGridLevel()}`);
      syncCatalogColumns();
      // После смены раскладки конец списка может оказаться прямо на экране.
      if (state.modsSource === "curseforge") cfWatchMore();
      else watchMore();
    }
    state.settings = { ...(state.settings || {}), mods_view: view };
    api.saveSettings(state.settings).catch(() => {});
  }

  // Перерисовка фильтров/переключателей не должна выбрасывать фокус на BODY.
  // Не переносим фокус, если до замены он был вне контейнера.
  function replaceCatalogHtml(root, html) {
    const active = document.activeElement;
    const ownsFocus = active && root.contains(active);
    const id = ownsFocus && active.id;
    const dlView = ownsFocus && active.dataset.dlView;
    const dvView = ownsFocus && active.dataset.dvView;
    const dvType = ownsFocus && active.dataset.dvType;
    const dvSource = ownsFocus && active.dataset.dvSource;
    const homeScroll = root.querySelector("#home-scroll");
    const homeScrollTop = homeScroll?.scrollTop || 0;
    root.innerHTML = html;
    const nextHomeScroll = root.querySelector("#home-scroll");
    if (nextHomeScroll) nextHomeScroll.scrollTop = homeScrollTop;
    let replacement = id ? document.getElementById(id) : null;
    if (!replacement && dlView) replacement = $$("[data-dl-view]", root).find((el) => el.dataset.dlView === dlView);
    if (!replacement && dvView) replacement = $$("[data-dv-view]", root).find((el) => el.dataset.dvView === dvView);
    if (!replacement && dvType) replacement = $$("[data-dv-type]", root).find((el) => el.dataset.dvType === dvType);
    if (!replacement && dvSource) replacement = $$("[data-dv-source]", root).find((el) => el.dataset.dvSource === dvSource);
    if (replacement && root.contains(replacement) && document.activeElement === document.body) {
      replacement.focus({ preventScroll: true });
    }
  }

  function downloadVersionOptions(meta, cfg) {
    const ids = new Set();
    const add = (value) => {
      const id = typeof value === "string" ? value : value && value.id;
      if (id && /^[0-9][A-Za-z0-9._+-]*$/.test(String(id))) ids.add(String(id));
    };
    add(meta && meta.mc_version);
    (DEMO.versions || []).forEach(add);
    ((state.discover && state.discover.versions) || []).forEach(add);
    add(cfg && cfg.mc);
    return Array.from(ids).slice(0, 18);
  }

  function downloadFilterListboxHtml(source, field, label, value, options) {
    const prefix = source === "curseforge" ? "cf" : "mr";
    const id = `${prefix}-${field}`;
    const selected = options.find(([optionValue]) => optionValue === value) || options[0] || ["", ""];
    return `<div class="field catalog-filter-field">
      <label for="${id}">${esc(label)}</label>
      <div class="catalog-listbox" id="${id}-wrap">
        <button type="button" class="catalog-listbox-trigger" id="${id}"
          data-dl-filter-trigger data-dl-filter-source="${source}" data-dl-filter-field="${field}" data-dl-filter-value="${esc(value)}"
          aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-options">
          <span id="${id}-label"${field === "mc" ? " translate=\"no\"" : ""}>${esc(selected[1])}</span>
          <svg class="ic"><use href="#i-chev"/></svg>
        </button>
        <div class="catalog-listbox-menu" id="${id}-options" role="listbox" aria-label="${esc(label)}" data-trigger-id="${id}" hidden>
          ${options.map(([optionValue, optionLabel]) => `<button type="button" role="option" tabindex="-1"
            data-dl-filter-option data-dl-filter-source="${source}" data-dl-filter-field="${field}"
            data-dl-filter-value="${esc(optionValue)}" aria-selected="${optionValue === value}"
            class="catalog-listbox-option ${optionValue === value ? "is-active" : ""}">
            <span${field === "mc" ? " translate=\"no\"" : ""}>${esc(optionLabel)}</span><svg class="ic"><use href="#i-check"/></svg>
          </button>`).join("")}
        </div>
      </div>
    </div>`;
  }

  function downloadCategoryFilterHtml(source, cfg) {
    const type = cfg.type || "mod";
    const categories = downloadCategoryOptions(source, type);
    if (!categories.length) return "";
    const active = downloadCategoryValue(cfg);
    const title = type === "mod" ? "Категории модов"
      : type === "modpack" ? "Категории сборок"
        : type === "resourcepack" ? "Категории ресурспаков" : "Категории шейдеров";
    return `<details class="download-category-group" open>
      <summary>${title}<svg class="ic"><use href="#i-chev"/></svg></summary>
      <div class="download-category-list" role="group" aria-label="${title}">
        <button type="button" data-dl-category="" data-dl-category-source="${source}" data-dl-category-type="${type}"
          class="home-category ${!active ? "is-active" : ""}" aria-pressed="${!active}">
          <svg class="ic"><use href="#i-grid"/></svg>Все категории
        </button>
        ${categories.map(([id, label, icon]) => `<button type="button" data-dl-category="${esc(id)}" data-dl-category-source="${source}" data-dl-category-type="${type}"
          class="home-category ${active === id ? "is-active" : ""}" aria-pressed="${active === id}">
          <svg class="ic"><use href="#${icon}"/> </svg>${esc(label)}
        </button>`).join("")}
      </div>
    </details>`;
  }

  function downloadFilterPanelHtml(source, cfg, meta) {
    const typeOptions = source === "curseforge"
      ? [["mod", "Моды"], ["modpack", "Модпаки"], ["resourcepack", "Ресурспаки"], ["shader", "Шейдеры"]]
      : [["mod", "Моды"], ["resourcepack", "Ресурспаки"], ["shader", "Шейдеры"]];
    const mcOptions = [["", "Любая версия"], ...downloadVersionOptions(meta, cfg).map((version) => [version, version])];
    const loaderOptions = [["", "Любой загрузчик"], ...CATALOG_LOADERS.map((loader) => [loader, LOADER_NAMES[loader]])];
    const fields = [
      downloadFilterListboxHtml(source, "type", "Тип", cfg.type, typeOptions),
      downloadFilterListboxHtml(source, "mc", "Версия игры", cfg.mc, mcOptions)
    ];
    if (source === "modrinth" ? cfg.type === "mod" : ["mod", "modpack"].includes(cfg.type)) {
      fields.push(downloadFilterListboxHtml(source, "loader", "Загрузчик", cfg.loader, loaderOptions));
    }
    if (source === "curseforge") {
      fields.push(downloadFilterListboxHtml(source, "sort", "Сортировка", cfg.sort || "downloads", CF_SORTS));
    }
    return `<aside class="download-catalog-sidebar" id="${source}-download-filters" aria-label="Фильтры каталога">
      <div class="download-filter-head"><span>Фильтры</span><span class="download-filter-source">${source === "curseforge" ? "CurseForge" : "Modrinth"}</span></div>
      <div class="download-filter-fields">${fields.join("")}</div>
      ${downloadCategoryFilterHtml(source, cfg)}
    </aside>`;
  }

  function closeDownloadFilterMenu(menu, restoreFocus = false) {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const trigger = document.getElementById(menu.dataset.triggerId || "");
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    }
    menu.style.maxHeight = "";
    menu.classList.remove("is-up");
  }

  function closeDownloadFilterMenus(restoreFocus = false, exceptWrap = null) {
    $$(".catalog-listbox-menu").forEach((menu) => {
      if (exceptWrap && menu.closest(".catalog-listbox") === exceptWrap) return;
      closeDownloadFilterMenu(menu, restoreFocus);
    });
  }

  function openDownloadFilterMenu(trigger, menu, options, index) {
    closeHomeLoader();
    closeHomeVersion();
    closeDownloadFilterMenus(false, trigger.closest(".catalog-listbox"));
    menu.hidden = false;
    menu.classList.remove("is-up");
    menu.style.maxHeight = "";
    const area = trigger.closest(".download-catalog-layout")?.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const top = Math.max(0, area?.top || 0);
    const bottom = Math.min(window.innerHeight, area?.bottom || window.innerHeight);
    const spacing = 6 * uiZoom();
    const below = Math.max(0, bottom - triggerRect.bottom - spacing);
    const above = Math.max(0, triggerRect.top - top - spacing);
    const flip = menu.getBoundingClientRect().height > below && above > below;
    menu.classList.toggle("is-up", flip);
    menu.style.maxHeight = `${Math.max(0, (flip ? above : below) / uiZoom())}px`;
    trigger.setAttribute("aria-expanded", "true");
    (options[index] || options[0])?.focus();
  }

  function runDownloadFilterSearch(source) {
    if (source === "curseforge") cfRunSearch();
    else runSearch();
  }

  function bindDownloadFilterControls(source) {
    $$("[data-dl-filter-trigger]").forEach((trigger) => {
      const menu = document.getElementById(trigger.getAttribute("aria-controls"));
      const options = menu ? $$('[data-dl-filter-option]', menu) : [];
      if (!menu || !options.length) return;
      const currentIndex = () => Math.max(0, options.findIndex((option) => option.dataset.dlFilterValue === (source === "curseforge"
        ? state.curseforge[trigger.dataset.dlFilterField] : state.modrinth[trigger.dataset.dlFilterField])));
      const open = (index = currentIndex()) => openDownloadFilterMenu(trigger, menu, options, index);
      trigger.addEventListener("click", () => {
        if (!menu.hidden) return closeDownloadFilterMenu(menu);
        open();
      });
      trigger.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = currentIndex();
        open(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0));
      });
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeDownloadFilterMenu(menu, true); return; }
        if (event.key === "Tab") { closeDownloadFilterMenu(menu, true); return; }
        const index = options.indexOf(document.activeElement);
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : event.key === "ArrowDown" ? Math.min(Math.max(index, 0) + 1, options.length - 1) : Math.max(index - 1, 0);
        options[next].focus();
      });
      options.forEach((option) => option.addEventListener("click", () => {
        const field = trigger.dataset.dlFilterField;
        const value = option.dataset.dlFilterValue || "";
        const cfg = source === "curseforge" ? state.curseforge : state.modrinth;
        const changed = cfg[field] !== value;
        closeDownloadFilterMenu(menu, true);
        if (!changed) return;
        if (field === "sort") cfg.sort = value;
        else setDownloadFilter(source, field, value);
        runDownloadFilterSearch(source);
      }));
    });

    $$(`[data-dl-category-source="${source}"]`).forEach((button) => button.addEventListener("click", () => {
      const cfg = source === "curseforge" ? state.curseforge : state.modrinth;
      const type = cfg.type || "mod";
      const value = button.dataset.dlCategory || "";
      const categories = downloadCategoryState(cfg, type);
      if (categories[type] === value) return;
      categories[type] = value;
      $$(`[data-dl-category-source="${source}"]`).forEach((item) => {
        const active = (item.dataset.dlCategory || "") === value && (item.dataset.dlCategoryType || "") === type;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      runDownloadFilterSearch(source);
    }));
  }

  /** Страница «Загрузить»: одна строка поиска и один вид для обоих источников. */
  function renderDownload() {
    // Поиск учитывает версию и загрузчик сборки: ответ от прошлой сборки не подходит новой.
    if (downloadSearchInstance !== state.selectedId) {
      cancelDownloadSearchTimer();
      invalidateDownloadSearch("modrinth");
      invalidateDownloadSearch("curseforge");
      downloadSearchInstance = state.selectedId;
    }
    const source = state.modsSource === "curseforge" ? "curseforge" : "modrinth";
    const cfg = source === "curseforge" ? state.curseforge : state.modrinth;
    if (cfg.query !== state.modsQuery) {
      cancelDownloadSearchTimer();
      invalidateDownloadSearch(source);
      cfg.query = state.modsQuery;
    }
    const view = state.modsView;
    replaceCatalogHtml($("#tab-body"), `
      <div class="modrinth-wrap">
        <div class="modrinth-filters">
          <label class="search" style="flex:1;min-width:220px">
            <svg class="ic"><use href="#i-search"/></svg>
            <input id="dl-query" type="text" aria-label="Поиск в каталоге" placeholder="Найти мод…" spellcheck="false" value="${esc(state.modsQuery)}">
          </label>
          ${sourceButtonsHtml("dl", source)}
          <div class="mr-view" style="align-self:flex-end" role="group" aria-label="Вид каталога">
            <button type="button" class="${view === "list" ? "is-active" : ""}" data-dl-view="list" aria-pressed="${view === "list"}"><svg class="ic"><use href="#i-list"/></svg>Список</button>
            <button type="button" class="${view === "grid" ? "is-active" : ""}" data-dl-view="grid" aria-pressed="${view === "grid"}"><svg class="ic"><use href="#i-grid"/></svg>Плитка</button>
          </div>
          <label class="feed-size" style="align-self:flex-end" title="Размер плитки: 1 — 12 в ряд, 2 — 9 в ряд, 3 — 6 в ряд">
            <svg class="ic"><use href="#i-grid"/></svg>
            <input type="range" id="dl-size" min="1" max="3" step="1" value="${modsGridLevel()}" aria-label="Размер плитки">
            <span class="mono" id="dl-size-val">${modsGridLevel()}</span>
          </label>
        </div>
        <div class="hint" id="dl-installed-check" role="status"${installedProjectsMessage ? "" : " hidden"}>${esc(installedProjectsMessage)}</div>
        <div id="dl-source-body"></div>
      </div>`);

    bindLiveSearch($("#dl-query"), scheduleDownloadSearch, dlRunSearch);
    $$("#tab-body [data-dl-source]").forEach((button) => button.addEventListener("click", () => selectDownloadSource(button.dataset.dlSource)));
    $$("#tab-body [data-dl-view]").forEach((button) => button.addEventListener("click", () => setDownloadView(button.dataset.dlView)));
    const dlSize = $("#dl-size");
    if (dlSize) {
      dlSize.addEventListener("input", () => {
        const level = Number(dlSize.value) || 2;
        const label = $("#dl-size-val");
        if (label) label.textContent = String(level);
        const results = $("#mr-results") || $("#cf-results");
        if (results) {
          results.classList.remove("feed-grid-1", "feed-grid-2", "feed-grid-3");
          if (state.modsView === "grid") results.classList.add(`feed-grid-${level}`);
          if (state.modsSource === "curseforge") cfWatchMore();
          else watchMore();
        }
        state.settings = { ...(state.settings || {}), mods_grid: level };
        syncCatalogColumns();
        api.saveSettings(state.settings).catch(() => {});
      });
    }

    state.dlRoot = $("#dl-source-body");
    if (source === "curseforge") renderCurseForge(state.dlRoot);
    else renderModrinth(state.dlRoot);
  }

  /** Enter остаётся быстрым ручным запуском, но для поиска он не нужен. */
  function dlRunSearch() {
    cancelDownloadSearchTimer();
    const query = $("#dl-query") ? $("#dl-query").value : state.modsQuery;
    state.modsQuery = query;
    if (state.modsSource === "curseforge") {
      state.curseforge.query = query;
      cfRunSearch();
    } else {
      state.modrinth.query = query;
      runSearch();
    }
  }

  function renderModrinth(container) {
    const root = container || state.dlRoot || $("#tab-body");
    const meta = selected();
    const cfg = state.modrinth;
    const view = state.modsView;
    // Внутри сборки модпаки не нужны — они ставятся только при создании сборки.
    replaceCatalogHtml(root, `
      <div class="download-source-view">
        <div class="download-catalog-layout">
          ${downloadFilterPanelHtml("modrinth", cfg, meta)}
          <div class="modrinth-results ${view === "grid" ? `is-grid feed-grid-${modsGridLevel()}` : ""}" id="mr-results" style="--feed-cols:${modsColumns()}">
            ${resultsHtml()}
          </div>
        </div>
      </div>`);

    bindDownloadFilterControls("modrinth");
    bindResultEvents();
    const retry = $("#mr-retry");
    if (retry) retry.addEventListener("click", () => runSearch());
    bindCatalogResize();
    watchMore();
    if (!cfg.tried && !cfg.loading && !cfg.error) runSearch();
  }

  /* ---------- готовые сборки в главном окне ---------- */
  /**
   * Лента модпаков с Modrinth: те же карточки, что во вкладке Modrinth,
   * но без привязки к выбранной сборке и без единого автовыбора —
   * пока пользователь сам не нажмёт «Установить», ничего не происходит.
   */
  /** Главная страница: свои сборки + создание/импорт + лента готовых сборок. */
  /** Когда сборку запускали в последний раз — короткой фразой. */
  function relativeWhen(unix) {
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(unix || 0));
    if (diff < 3600) return "только что";
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
    const days = Math.floor(diff / 86400);
    if (days === 1) return "вчера";
    if (days < 30) return `${days} ${days < 5 ? "дня" : "дней"} назад`;
    return `${Math.floor(days / 30)} мес. назад`;
  }

  /** Время игры в часах: «0 мин», «45 мин», «3 ч», «12,5 ч». */
  function playtimeLabel(secs) {
    const total = Math.max(0, Math.round(Number(secs) || 0));
    if (total < 60) return "0 мин";
    if (total < 3600) return `${Math.round(total / 60)} мин`;
    const hours = total / 3600;
    const text = hours >= 10 ? String(Math.round(hours)) : String(Math.round(hours * 10) / 10);
    return `${text.replace(".", ",")} ч`;
  }

  function homeInstanceHtml(meta) {
    const running = state.running.has(meta.id);
    const icon = instanceIconHtml(meta);
    const letter = !isImageIcon(meta.icon) && !(meta.icon && INSTANCE_ICONS.includes(meta.icon));
    const detail = `MC ${meta.mc_version} · ${loaderLabel(meta.loader)}`;
    return `<button class="home-card ${meta.id === state.selectedId ? "is-active" : ""}" data-home-id="${esc(meta.id)}">
      <span class="home-card-icon ${letter ? "is-letter" : ""}">${letter ? `<span class="card-letter" translate="no">${esc(icon)}</span>` : icon}</span>
      <span class="home-card-body">
        <span class="home-card-top">
          <span class="home-card-name" translate="no" title="${esc(meta.name)}">${esc(meta.name)}</span>
          <span class="home-card-time" title="Время игры">${esc(playtimeLabel(meta.playtime_secs))}</span>
          ${running ? '<span class="home-card-dot" title="Запущена"></span>' : ""}
        </span>
        <span class="home-card-sub" title="${esc(detail)}">${esc(detail)}</span>
      </span>
    </button>`;
  }

  /** Панель импорта на главной: файл .mrpack/.zip, лаунчеры (с галочками), ссылка. */
  /** Этапы, во время которых сборка реально копируется в лаунчер. */
  const IMPORT_STAGES = ["import", "copy", "unzip", "modpack", "loader"];

  /** Заголовок живой строки: сборка копируется в лаунчер или уже ставится. */
  function importTitle(stage) {
    if (!stage || ["import", "copy", "unzip", "modpack"].includes(stage)) return "Сборка копируется в лаунчер";
    return "Идёт установка сборки";
  }

  /** Живая полоса импорта: спиннер + что сейчас делается + процент. */
  function importLiveHtml() {
    const cfg = state.home || {};
    const payload = state.progress;
    const stage = payload ? String(payload.stage || "") : "";
    const importing = Boolean(cfg.busy) || Boolean(payload && IMPORT_STAGES.includes(stage));
    if (!importing) return "";
    const info = payload ? progressInfo(payload) : null;
    const title = importTitle(stage);
    const text = (cfg.busy && cfg.status) || (info && info.text) || "копируем файлы в папку лаунчера…";
    const percent = info ? info.percent : 0;
    const hasTotal = Boolean(info && info.total);
    return `<div class="imp-live${hasTotal ? "" : " is-idle"}" id="imp-live">
      <span class="imp-spinner" aria-hidden="true"></span>
      <div class="imp-live-main">
        <div class="imp-live-row">
          <span class="imp-live-title" id="imp-live-title">${esc(title)}</span>
          <span class="imp-live-percent mono${hasTotal ? "" : " is-wait"}" id="imp-live-percent">${hasTotal ? `${percent}%` : "…"}</span>
        </div>
        <div class="imp-live-text mono" id="imp-live-text">${esc(text)}</div>
        <div class="imp-live-bar"><div class="imp-live-fill ${hasTotal ? "" : "is-idle"}" id="imp-live-fill" style="width:${hasTotal ? percent : 100}%"></div></div>
      </div>
    </div>`;
  }

  function homeImportHtml() {
    const cfg = state.home;
    const parts = [];
    parts.push(`<div class="imp-row">
      <button class="btn imp-big" id="imp-mrpack"><svg class="ic"><use href="#i-download"/></svg>Из .mrpack</button>
      <button class="btn imp-big" id="imp-zip"><svg class="ic"><use href="#i-download"/></svg>Zip</button>
      <button class="btn imp-big ${cfg.extOpen ? "is-pressed" : ""}" id="imp-ext"><svg class="ic"><use href="#i-grid"/></svg>Из лаунчера</button>
      <div class="imp-url">
        <input class="input grow" id="imp-url-input" placeholder="Ссылка на модпак Modrinth или .mrpack" spellcheck="false" value="${esc(cfg.url)}">
        <button class="btn" id="imp-url-go">Добавить</button>
      </div>
    </div>`);

    if (cfg.zipPath) {
      const zip = /\.zip$/i.test(cfg.zipPath);
      parts.push(`<div class="imp-block">
        <div class="imp-block-head">
          <span class="mono imp-path">${esc(cfg.zipPath)}</span>
          <div class="spacer"></div>
          <button class="btn btn-small" id="imp-cancel">Отмена</button>
        </div>
        ${zip ? `<div class="imp-fields">
          <div class="field">
            <label>Версия Minecraft</label>
            <select class="select" id="imp-zip-mc">
              ${cfg.versions.length ? cfg.versions.map((version) => `<option value="${esc(version.id)}" ${version.id === cfg.zipMc ? "selected" : ""}>${esc(version.id)}</option>`).join("") : `<option value="">загружаем…</option>`}
            </select>
          </div>
          <div class="field">
            <label>Загрузчик</label>
            <div class="chips" id="imp-zip-loaders">
              ${Object.entries(LOADER_NAMES).map(([value, label]) => `<button class="chip ${cfg.zipLoader === value ? "is-active" : ""}" data-zip-loader="${value}">${label}</button>`).join("")}
            </div>
          </div>
          ${cfg.zipLoader && cfg.zipLoader !== "vanilla" ? `<div class="field">
            <label>Версия загрузчика</label>
            <select class="select" id="imp-zip-loader-version">
              ${cfg.zipLoaderVersions.length ? cfg.zipLoaderVersions.map((option) => `<option value="${esc(option.version)}" ${option.version === cfg.zipLoaderVersion ? "selected" : ""}>${esc(option.version)}${recommendedLoader(cfg.zipLoaderVersions) && option.version === recommendedLoader(cfg.zipLoaderVersions).version ? " ★ рекомендуется" : ""}</option>`).join("") : `<option value="">загружаем…</option>`}
            </select>
          </div>` : ""}
        </div>` : `<div class="imp-note">Архив .mrpack — версия и загрузчик возьмутся из него.</div>`}
        <div class="imp-actions">
          <button class="btn btn-primary" id="imp-zip-go" ${zip && !cfg.zipMc ? "disabled" : ""}>Импортировать</button>
        </div>
      </div>`);
    }

    if (cfg.extOpen) {
      const list = cfg.external || [];
      const picked = cfg.extSelected;
      const launchers = { prism: "Prism", polymc: "PolyMC", multimc: "MultiMC", modrinth: "Modrinth App", astralrinth: "AstralRinth", atlauncher: "ATLauncher", curseforge: "CurseForge", gdlauncher: "GDLauncher" };
      parts.push(`<div class="imp-block">
        <div class="imp-block-head">
          <strong>Найдено сборок: ${list.length}</strong>
          <div class="spacer"></div>
          <button class="btn btn-small" id="imp-ext-all">Выбрать все</button>
          <button class="btn btn-small" id="imp-ext-rescan">Обновить</button>
          <button class="btn btn-small" id="imp-ext-close">Свернуть</button>
        </div>
        ${cfg.extLoading
          ? `<div class="add-empty">Смотрим Prism, MultiMC, PolyMC, Modrinth App, AstralRinth, ATLauncher, CurseForge и GDLauncher…</div>`
          : list.length
            ? `<div class="imp-list">${list.map((item) => `
                <label class="imp-item ${picked.has(item.path) ? "is-picked" : ""}">
                  <input type="checkbox" class="imp-check" data-ext="${esc(item.path)}" ${picked.has(item.path) ? "checked" : ""}>
                  <span class="ext-icon">${item.icon ? `<img src="file://${esc(item.icon)}" alt="">` : `<svg class="ic"><use href="#i-grid"/></svg>`}</span>
                  <span class="ext-main">
                    <span class="ext-name" translate="no">${esc(item.name)}</span>
                    <span class="ext-sub">${esc(launchers[item.launcher] || item.launcher)} · MC ${esc(item.mc_version)} · ${esc(item.loader)}</span>
                  </span>
                </label>`).join("")}</div>`
            : `<div class="add-empty">Сборок в других лаунчерах не нашлось.</div>`}
        <div class="imp-actions">
          <span class="imp-count">${picked.size ? `выбрано: ${picked.size}` : "отметь сборки галочками"}</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="imp-ext-go" ${picked.size ? "" : "disabled"}>Импортировать${picked.size ? ` (${picked.size})` : ""}</button>
        </div>
      </div>`);
    }

    const open = Boolean(cfg.open) || Boolean(cfg.zipPath) || Boolean(cfg.extOpen);
    return `<section class="home-import ${cfg.busy ? "is-busy" : ""} ${open || cfg.busy ? "is-open" : ""}">
      <button class="imp-head imp-toggle" id="imp-toggle" aria-expanded="${open || cfg.busy ? "true" : "false"}">
        <svg class="ic imp-chev"><use href="#i-chev"/></svg>
        <span class="home-title">Добавить сборку</span>
        <span class="home-sub">${esc(cfg.status || "файл модпака, другой лаунчер или ссылка")}</span>
      </button>
      ${importLiveHtml()}
      <div class="imp-body">${parts.join("")}</div>
    </section>`;
  }

  /** Размер плиток: не более 12, 9 или 6 колонок соответственно. */
  function feedGridLevel() {
    const level = Number(state.settings && state.settings.feed_grid);
    return level === 1 || level === 2 || level === 3 ? level : 2;
  }

  function feedColumns(level = feedGridLevel(), width = 0) {
    return catalogColumns(level, width);
  }

  function syncFeedColumns() { syncCatalogColumns(); }
  function bindFeedResize() { bindCatalogResize(); }

  /** «Недавнее» — максимум один ряд: сколько карточек влезет по ширине, столько и видно. */
  function syncRecentRow() {
    const grid = document.getElementById("home-grid");
    if (!grid) return;
    const cards = [...grid.querySelectorAll(".home-card")];
    if (!cards.length) return;
    // карточка минимум 232px + зазор 8px (см. .home-grid в styles.css)
    const cols = Math.max(1, Math.floor((grid.clientWidth + 8) / 240));
    cards.forEach((card, index) => {
      card.style.display = index < cols ? "" : "none";
    });
  }

  let recentResizeBound = false;
  function bindRecentResize() {
    if (recentResizeBound) return;
    recentResizeBound = true;
    window.addEventListener("resize", () => syncRecentRow());
  }

  function setFeedGridLevel(level) {
    const clean = level === 1 || level === 3 ? level : 2;
    state.settings = { ...(state.settings || {}), feed_grid: clean };
    api.saveSettings(state.settings).catch(() => {});
  }

  // Категории у источников разные: используем реальные фасеты Modrinth и
  // categoryId CurseForge, а не подменяем похожие категории друг другом.
  const PACK_CATEGORIES = {
    modrinth: [
      ["adventure", "Приключения", "i-globe"], ["challenging", "Испытания", "i-crown"],
      ["combat", "Бои", "i-shield"], ["kitchen-sink", "Всего понемногу", "i-cube"],
      ["lightweight", "Лёгкие", "i-leaf"], ["magic", "Магия", "i-gem"],
      ["multiplayer", "Мультиплеер", "i-user"], ["optimization", "Оптимизация", "i-bolt"],
      ["quests", "Квесты", "i-list"], ["technology", "Технологии", "i-settings"]
    ],
    curseforge: [
      ["4475", "Приключения и RPG", "i-globe"], ["4476", "Исследование", "i-globe"],
      ["4479", "Хардкор", "i-crown"], ["9243", "Для опытных", "i-crown"],
      ["4483", "Бои и PvP", "i-shield"], ["4481", "Лёгкие", "i-leaf"],
      ["4482", "Большие", "i-cube"], ["4473", "Магия", "i-gem"],
      ["4484", "Мультиплеер", "i-user"], ["4477", "Мини-игры", "i-star"],
      ["4478", "Квесты", "i-list"], ["4472", "Технологии", "i-settings"],
      ["4474", "Научная фантастика", "i-bolt"], ["4480", "На основе карты", "i-globe"],
      ["4736", "Skyblock", "i-cube"], ["5128", "Vanilla+", "i-leaf"],
      ["7418", "Хоррор", "i-flame"], ["4487", "FTB Official", "i-star"],
      ["10683", "RLCraft", "i-shield"]
    ]
  };
  // Это категории именно модов Modrinth из /v2/tag/category. На CurseForge
  // используются числовые categoryId из /v1/categories?gameId=432.
  const MOD_CATEGORIES = {
    modrinth: [
      ["adventure", "Приключения", "i-globe"], ["cursed", "Проклятые", "i-flame"],
      ["decoration", "Декорации", "i-house"], ["economy", "Экономика", "i-cube"],
      ["equipment", "Снаряжение", "i-shield"], ["food", "Еда", "i-leaf"],
      ["game-mechanics", "Игровые механики", "i-settings"], ["library", "Библиотеки", "i-file"],
      ["magic", "Магия", "i-gem"], ["management", "Управление", "i-sliders"],
      ["minigame", "Мини-игры", "i-star"], ["mobs", "Мобы", "i-user"],
      ["optimization", "Оптимизация", "i-bolt"], ["social", "Социальные", "i-user"],
      ["storage", "Хранилище", "i-folder"], ["technology", "Технологии", "i-settings"],
      ["transportation", "Транспорт", "i-globe"], ["utility", "Утилиты", "i-dots"],
      ["worldgen", "Генерация мира", "i-globe"]
    ],
    curseforge: [
      ["422", "Приключения и RPG", "i-globe"], ["421", "API и библиотеки", "i-file"],
      ["434", "Броня, инструменты и оружие", "i-shield"], ["6821", "Исправления", "i-settings"],
      ["424", "Косметика", "i-house"], ["436", "Еда", "i-leaf"],
      ["419", "Магия", "i-gem"], ["423", "Карта и информация", "i-globe"],
      ["425", "Разное", "i-cube"], ["406", "Генерация мира", "i-globe"],
      ["412", "Технологии", "i-settings"], ["420", "Хранилище", "i-folder"],
      ["6814", "Производительность", "i-bolt"], ["435", "Утилиты сервера", "i-terminal"],
      ["5191", "Утилиты и QoL", "i-dots"], ["4558", "Redstone", "i-bolt"],
      ["411", "Мобы", "i-user"], ["408", "Руды и ресурсы", "i-gem"],
      ["409", "Структуры", "i-cube"], ["410", "Измерения", "i-globe"]
    ]
  };
  const CATALOG_LOADERS = ["fabric", "quilt", "forge", "neoforge"];

  // Категории для вкладки «Загрузить». Для каждой площадки используются её
  // собственные идентификаторы: Modrinth принимает строковые теги, а
  // CurseForge — числовые categoryId. Состояние ниже хранится по типу проекта,
  // поэтому переход между модами, сборками и ресурспаками не смешивает выбор.
  const DOWNLOAD_RESOURCEPACK_CATEGORIES = {
    modrinth: [
      ["8x-", "8x и меньше", "i-grid"], ["16x", "16x", "i-grid"], ["32x", "32x", "i-grid"],
      ["64x", "64x", "i-grid"], ["128x", "128x", "i-grid"], ["256x", "256x", "i-grid"],
      ["512x+", "512x и выше", "i-grid"], ["combat", "Бои", "i-shield"],
      ["decoration", "Декорации", "i-house"], ["modded", "Для модов", "i-mod"],
      ["realistic", "Реалистичные", "i-image"], ["simplistic", "Простые", "i-grid"],
      ["themed", "Тематические", "i-gem"], ["tweaks", "Изменения", "i-sliders"],
      ["utility", "Утилиты", "i-dots"], ["vanilla-like", "Ванильные", "i-cube"]
    ],
    curseforge: [
      ["393", "16x", "i-grid"], ["394", "32x", "i-grid"], ["395", "64x", "i-grid"],
      ["396", "128x", "i-grid"], ["397", "256x", "i-grid"], ["398", "512x и выше", "i-grid"],
      ["399", "Стимпанк", "i-settings"], ["400", "Фотореализм", "i-image"],
      ["401", "Современные", "i-grid"], ["402", "Средневековые", "i-crown"],
      ["403", "Традиционные", "i-cube"], ["404", "Анимированные", "i-star"],
      ["4465", "Для модов", "i-mod"]
    ]
  };
  const DOWNLOAD_SHADER_CATEGORIES = {
    modrinth: [
      ["cartoon", "Мультяшные", "i-image"], ["cursed", "Проклятые", "i-flame"],
      ["fantasy", "Фэнтези", "i-gem"], ["realistic", "Реалистичные", "i-image"],
      ["semi-realistic", "Полуреалистичные", "i-grid"], ["vanilla-like", "Ванильные", "i-cube"]
    ],
    curseforge: [
      ["6553", "Реалистичные", "i-image"], ["6554", "Фэнтези", "i-gem"],
      ["6555", "Ванильные", "i-cube"]
    ]
  };

  function downloadCategoryOptions(source, type) {
    const sets = type === "mod" ? MOD_CATEGORIES
      : type === "modpack" ? PACK_CATEGORIES
        : type === "resourcepack" ? DOWNLOAD_RESOURCEPACK_CATEGORIES
          : type === "shader" ? DOWNLOAD_SHADER_CATEGORIES : null;
    return (sets && (sets[source] || sets.modrinth)) || [];
  }

  function downloadCategoryState(cfg, type = cfg.type || "mod") {
    if (!cfg.categories || typeof cfg.categories !== "object" || Array.isArray(cfg.categories)) cfg.categories = {};
    if (!(type in cfg.categories)) cfg.categories[type] = "";
    return cfg.categories;
  }

  function downloadCategoryValue(cfg) {
    const type = cfg.type || "mod";
    return downloadCategoryState(cfg, type)[type] || "";
  }

  function discoverCategoryState(cfg, source) {
    const current = cfg.categories && cfg.categories[source];
    if (current && typeof current === "object" && !Array.isArray(current)) return current;
    // Совместимость со старым состоянием: раньше здесь хранилась одна
    // категория источника, только для модпаков.
    const migrated = { modpack: typeof current === "string" ? current : "", mod: "" };
    cfg.categories = { ...(cfg.categories || {}), [source]: migrated };
    return migrated;
  }

  function discoverCategoryValue(cfg, source) {
    const type = cfg.type === "mod" ? "mod" : "modpack";
    return discoverCategoryState(cfg, source)[type] || "";
  }

  function discoverVersionOptions() {
    const cfg = state.discover || {};
    const ids = new Set();
    const add = (value) => {
      const id = typeof value === "string" ? value : value && value.id;
      // Поддерживаем и обычные релизы, и snapshot/pre-release IDs (25w14a, 1.21-pre1).
      if (id && /^[0-9][A-Za-z0-9._+-]*$/.test(String(id))) ids.add(String(id));
    };
    (cfg.versions || []).forEach(add);
    (state.instances || []).forEach((item) => add(item && item.mc_version));
    // Демо-режим не должен отличаться от настоящего каталога по набору версий.
    if (!IS_APP) (DEMO.versions || []).forEach(add);
    add(cfg.mc);
    return Array.from(ids);
  }

  function homeCatalogFiltersHtml(cfg, source) {
    const type = cfg.type === "mod" ? "mod" : "modpack";
    const categorySets = type === "mod" ? MOD_CATEGORIES : PACK_CATEGORIES;
    const categories = categorySets[source] || categorySets.modrinth;
    const active = discoverCategoryValue(cfg, source);
    const versions = discoverVersionOptions();
    const collapsed = Boolean(cfg.filtersCollapsed);
    return `<aside class="home-catalog-sidebar" id="home-catalog-filters" aria-label="Фильтры каталога"${collapsed ? " hidden" : ""}>
      <div class="home-filter-head"><label class="home-filter-label" for="dv-loader">Загрузчик</label></div>
      <div class="home-filter-group">
        <div class="home-loader" id="home-loader">
          <button type="button" class="home-loader-trigger" id="dv-loader" aria-haspopup="listbox" aria-expanded="false" aria-controls="dv-loader-options">
            <span id="dv-loader-label">${esc(LOADER_NAMES[cfg.loader] || "Любой загрузчик")}</span>
            <svg class="ic"><use href="#i-chev"/></svg>
          </button>
          <div class="home-loader-menu" id="dv-loader-options" role="listbox" aria-label="Загрузчик" hidden>
            ${[["", "Любой загрузчик"], ...CATALOG_LOADERS.map((loader) => [loader, LOADER_NAMES[loader]])].map(([value, label]) => `
              <button type="button" role="option" tabindex="-1" data-dv-loader="${value}" aria-selected="${cfg.loader === value}" class="home-loader-option ${cfg.loader === value ? "is-active" : ""}">
                <span>${esc(label)}</span><svg class="ic"><use href="#i-check"/></svg>
              </button>`).join("")}
          </div>
        </div>
      </div>
      <div class="home-filter-group home-version-filter">
        <label class="home-filter-label" for="dv-mc">Версия Minecraft</label>
        <div class="home-version-select" id="home-version-select">
          <button type="button" class="home-version-trigger" id="dv-mc" aria-haspopup="listbox" aria-expanded="false" aria-controls="dv-mc-options">
            <span id="dv-mc-label">${esc(cfg.mc || "Любая версия")}</span>
            <svg class="ic"><use href="#i-chev"/></svg>
          </button>
          <div class="home-version-menu" id="dv-mc-options" role="listbox" aria-label="Версия Minecraft" hidden>
            ${[["", "Любая версия"], ...versions.map((version) => [version, version])].map(([value, label]) => `
              <button type="button" role="option" tabindex="-1" data-dv-version="${esc(value)}" aria-selected="${cfg.mc === value}" class="home-version-option ${cfg.mc === value ? "is-active" : ""}">
                <span translate="no">${esc(label)}</span><svg class="ic"><use href="#i-check"/></svg>
              </button>`).join("")}
          </div>
        </div>
      </div>
      <details class="home-category-group" open>
        <summary>${type === "mod" ? "Категории модов" : "Категории сборок"}<svg class="ic"><use href="#i-chev"/></svg></summary>
        <div class="home-category-list" role="group" aria-label="${type === "mod" ? "Категории модов" : "Категории сборок"}">
          <button type="button" data-dv-category="" class="home-category ${!active ? "is-active" : ""}" aria-pressed="${!active}"><svg class="ic"><use href="#i-grid"/></svg>Все категории</button>
          ${categories.map(([id, label, icon]) => `<button type="button" data-dv-category="${id}" class="home-category ${active === id ? "is-active" : ""}" aria-pressed="${active === id}"><svg class="ic"><use href="#${icon}"/></svg>${esc(label)}</button>`).join("")}
        </div>
      </details>
    </aside>`;
  }

  let homeHeaderObserver = null;
  function bindHomeFilterToggle(cfg) {
    const toggle = $("#home-filters-toggle");
    if (!toggle) return;
    const head = $(".home-feed-head"), scroll = $("#home-scroll");
    const measureHead = () => { if (head && scroll) scroll.style.setProperty("--home-header-height", `${head.offsetHeight}px`); };
    if (homeHeaderObserver) homeHeaderObserver.disconnect();
    if (head && typeof ResizeObserver !== "undefined") {
      homeHeaderObserver = new ResizeObserver(measureHead);
      homeHeaderObserver.observe(head);
    }
    measureHead();
    toggle.addEventListener("click", () => {
      const collapsed = !cfg.filtersCollapsed;
      if (collapsed) { closeHomeLoader(); closeHomeVersion(); }
      cfg.filtersCollapsed = collapsed;
      // Панель заменяется при смене типа/источника, а кнопка в шапке остаётся.
      const panel = $("#home-catalog-filters");
      if (panel) {
        panel.hidden = collapsed;
        if (!collapsed) { panel.classList.remove("is-opening"); void panel.offsetWidth; panel.classList.add("is-opening"); }
      }
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.classList.toggle("is-open", !collapsed);
      syncFeedColumns();
    });
  }

  // Стилевой listbox заменяет системное меню, но остаётся управляемым клавиатурой.
  function closeHomeLoader(restoreFocus = false) {
    const trigger = $("#dv-loader"), menu = $("#dv-loader-options");
    if (!trigger || !menu || menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  function bindHomeLoaderFilter(cfg) {
    const trigger = $("#dv-loader"), menu = $("#dv-loader-options");
    const options = $$("[data-dv-loader]", menu);
    const open = (index) => {
      menu.hidden = false;
      menu.classList.remove("is-up");
      menu.style.maxHeight = "";
      // При большом масштабе и прокрутке снизу может не хватить места.
      // Открываем список вверх либо ограничиваем его собственную прокрутку.
      const scroll = $("#home-scroll")?.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const top = Math.max(0, scroll?.top || 0);
      const bottom = Math.min(window.innerHeight, scroll?.bottom || window.innerHeight);
      const spacing = 6 * uiZoom();
      const below = Math.max(0, bottom - triggerRect.bottom - spacing);
      const above = Math.max(0, triggerRect.top - top - spacing);
      const flip = menu.getBoundingClientRect().height > below && above > below;
      menu.classList.toggle("is-up", flip);
      const available = flip ? above : below;
      menu.style.maxHeight = `${Math.max(0, available / uiZoom())}px`;
      trigger.setAttribute("aria-expanded", "true");
      (options[index] || options[0]).focus();
    };
    trigger.addEventListener("click", () => {
      if (!menu.hidden) return closeHomeLoader();
      closeHomeVersion();
      open(Math.max(0, options.findIndex((option) => option.dataset.dvLoader === cfg.loader)));
    });
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = Math.max(0, options.findIndex((option) => option.dataset.dvLoader === cfg.loader));
      open(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : Math.max(0, current - 1));
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closeHomeLoader(true); return; }
      // Фокус сначала возвращаем на trigger: иначе скрытый option может
      // отправить Tab в начало страницы вместо следующего/предыдущего поля.
      if (event.key === "Tab") { closeHomeLoader(true); return; }
      const i = options.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : event.key === "ArrowDown" ? Math.min(i + 1, options.length - 1) : Math.max(i - 1, 0);
        options[next].focus();
      }
    });
    options.forEach((option) => option.addEventListener("click", () => {
      const value = option.dataset.dvLoader || "";
      const changed = cfg.loader !== value;
      cfg.loader = value;
      $("#dv-loader-label").textContent = LOADER_NAMES[value] || "Любой загрузчик";
      options.forEach((item) => {
        const selected = (item.dataset.dvLoader || "") === value;
        item.classList.toggle("is-active", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      closeHomeLoader(true);
      if (changed) dvReset();
    }));
  }
  // Версии оформлены тем же listbox, что и загрузчик: системное меню
  // select на Windows не наследует тему приложения и выглядит чужеродно.
  function closeHomeVersion(restoreFocus = false) {
    const trigger = $("#dv-mc"), menu = $("#dv-mc-options");
    if (!trigger || !menu || menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  function bindHomeVersionFilter(cfg) {
    const trigger = $("#dv-mc"), menu = $("#dv-mc-options");
    const options = $$("[data-dv-version]", menu);
    if (!trigger || !menu || !options.length) return;
    const open = (index) => {
      closeHomeLoader();
      menu.hidden = false;
      menu.classList.remove("is-up");
      menu.style.maxHeight = "";
      const scroll = $("#home-scroll")?.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const top = Math.max(0, scroll?.top || 0);
      const bottom = Math.min(window.innerHeight, scroll?.bottom || window.innerHeight);
      const spacing = 6 * uiZoom();
      const below = Math.max(0, bottom - triggerRect.bottom - spacing);
      const above = Math.max(0, triggerRect.top - top - spacing);
      const flip = menu.getBoundingClientRect().height > below && above > below;
      menu.classList.toggle("is-up", flip);
      const available = flip ? above : below;
      menu.style.maxHeight = `${Math.max(0, available / uiZoom())}px`;
      trigger.setAttribute("aria-expanded", "true");
      (options[index] || options[0]).focus();
    };
    trigger.addEventListener("click", () => {
      if (!menu.hidden) return closeHomeVersion();
      open(Math.max(0, options.findIndex((option) => option.dataset.dvVersion === cfg.mc)));
    });
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = Math.max(0, options.findIndex((option) => option.dataset.dvVersion === cfg.mc));
      open(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : Math.max(0, current - 1));
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closeHomeVersion(true); return; }
      if (event.key === "Tab") { closeHomeVersion(true); return; }
      const i = options.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : event.key === "ArrowDown" ? Math.min(Math.max(0, i) + 1, options.length - 1) : Math.max(i - 1, 0);
        options[next].focus();
      }
    });
    options.forEach((option) => option.addEventListener("click", () => {
      const value = option.dataset.dvVersion || "";
      const changed = cfg.mc !== value;
      cfg.mc = value;
      $("#dv-mc-label").textContent = value || "Любая версия";
      options.forEach((item) => {
        const selected = (item.dataset.dvVersion || "") === value;
        item.classList.toggle("is-active", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      closeHomeVersion(true);
      if (changed) dvReset();
    }));
  }
  document.addEventListener("pointerdown", (event) => {
    const loaderWrap = $("#home-loader");
    if (loaderWrap && !loaderWrap.contains(event.target)) closeHomeLoader();
    const versionWrap = $("#home-version-select");
    if (versionWrap && !versionWrap.contains(event.target)) closeHomeVersion();
    const downloadWrap = event.target.closest?.(".catalog-listbox") || null;
    closeDownloadFilterMenus(false, downloadWrap);
  });

  function bindHomeCatalogFilters(cfg) {
    bindHomeLoaderFilter(cfg);
    bindHomeVersionFilter(cfg);
    $$("#home-catalog-filters [data-dv-category]").forEach((button) => button.addEventListener("click", () => {
      const source = cfg.source || "modrinth";
      const category = button.dataset.dvCategory || "";
      const type = cfg.type === "mod" ? "mod" : "modpack";
      const categoryState = discoverCategoryState(cfg, source);
      if (categoryState[type] === category) return;
      categoryState[type] = category;
      $$("#home-catalog-filters [data-dv-category]").forEach((item) => {
        const active = (item.dataset.dvCategory || "") === category;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      dvReset();
    }));
  }

  // При смене типа/источника заменяем только боковой фильтр: сама строка,
  // поле поиска, фокус и контейнер прокрутки остаются теми же DOM-узлами.
  function updateHomeCatalogFilters(cfg) {
    const sidebar = $(".home-catalog-sidebar");
    if (!sidebar) return;
    sidebar.outerHTML = homeCatalogFiltersHtml(cfg, cfg.source || "modrinth");
    bindHomeCatalogFilters(cfg);
    syncFeedColumns();
  }

  let discoverVersionsRequest = null;
  async function ensureDiscoverVersions() {
    const cfg = state.discover;
    if (cfg.versionsLoaded || cfg.versionsLoading) return discoverVersionsRequest;
    cfg.versionsLoading = true;
    discoverVersionsRequest = api.versions((state.settings && state.settings.show_snapshots) || false)
      .then((versions) => { cfg.versions = Array.isArray(versions) ? versions : []; })
      .catch(() => { cfg.versions = []; })
      .finally(() => {
        cfg.versionsLoading = false;
        cfg.versionsLoaded = true;
        discoverVersionsRequest = null;
        if (!state.windowHidden && state.tab === "discover" && $("#home-catalog-filters")) updateHomeCatalogFilters(cfg);
      });
    return discoverVersionsRequest;
  }

  function renderDiscover() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    const cfg = state.discover;
    const view = cfg.view || "grid";
    if (!cfg.source) cfg.source = (state.settings && state.settings.feed_source) || "modrinth";
    const source = cfg.source;
    // «Недавнее» — сборки по времени последнего запуска
    const instances = (state.instances || []).slice().sort((a, b) => (b.last_played || b.created || 0) - (a.last_played || a.created || 0));
    replaceCatalogHtml($("#tab-body"), `
      <div class="home">
        <div class="home-scroll" id="home-scroll">
          ${instances.length ? `<div class="home-section-title">Недавнее</div><div class="home-grid" id="home-grid">${instances.map(homeInstanceHtml).join("")}</div>` : ""}
          ${homeImportHtml()}
          <div class="home-feed-head">
            <div class="home-catalog-tabs" role="group" aria-label="Что искать">
              <button type="button" class="home-filters-toggle${cfg.filtersCollapsed ? "" : " is-open"}" id="home-filters-toggle" aria-expanded="${!cfg.filtersCollapsed}" aria-controls="home-catalog-filters">Фильтры<svg class="ic" aria-hidden="true"><use href="#i-chev"/></svg></button>
              <button type="button" data-dv-type="modpack" class="${cfg.type === "modpack" ? "is-active" : ""}" aria-pressed="${cfg.type === "modpack"}">Готовые сборки</button>
              <button type="button" data-dv-type="mod" class="${cfg.type === "mod" ? "is-active" : ""}" aria-pressed="${cfg.type === "mod"}">Моды</button>
            </div>
            <label class="search home-search">
              <svg class="ic"><use href="#i-search"/></svg>
              <input id="dv-query" type="text" aria-label="${cfg.type === "mod" ? "Поиск модов" : "Поиск готовых сборок"}" placeholder="${cfg.type === "mod" ? "Найти мод" : "Найти сборку"}" spellcheck="false" value="${esc(cfg.query)}">
            </label>
            ${sourceButtonsHtml("dv", source)}
            <div class="home-tools">
              <div class="mr-view" role="group" aria-label="Вид каталога">
                <button type="button" class="${view === "list" ? "is-active" : ""}" data-dv-view="list" aria-pressed="${view === "list"}"><svg class="ic"><use href="#i-list"/></svg>Список</button>
                <button type="button" class="${view === "grid" ? "is-active" : ""}" data-dv-view="grid" aria-pressed="${view === "grid"}"><svg class="ic"><use href="#i-grid"/></svg>Плитка</button>
              </div>
              <label class="feed-size" title="Размер плиток: 1 — 12 в ряд, 2 — 9 в ряд, 3 — 6 в ряд">
                <svg class="ic"><use href="#i-grid"/></svg>
                <input type="range" id="feed-size" min="1" max="3" step="1" value="${feedGridLevel()}" aria-label="Размер плиток">
                <span class="mono" id="feed-size-val">${feedGridLevel()}</span>
              </label>
            </div>
          </div>
          <div class="home-catalog-layout">
            ${homeCatalogFiltersHtml(cfg, source)}
            <div class="modrinth-results ${view === "grid" ? `is-grid feed-grid-${feedGridLevel()}` : ""}" id="dv-results" style="--feed-cols:${feedColumns()}">${dvResultsHtml()}</div>
          </div>
        </div>
      </div>`);

    $$("#tab-body [data-home-id]").forEach((card) => card.addEventListener("click", () => {
      openInstance(card.dataset.homeId);
    }));
    // двойной клик по недавней сборке — сразу запускаем игру
    $$("#tab-body [data-home-id]").forEach((card) => card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      launchFromList(card.dataset.homeId);
    }));
    // ПКМ по недавней сборке — то же меню, что и в списке сборок
    $$("#tab-body [data-home-id]").forEach((card) => card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const meta = (state.instances || []).find((item) => item.id === card.dataset.homeId);
      if (meta) openInstanceMenu(event.clientX, event.clientY, meta);
    }));
    syncRecentRow();
    bindLiveSearch($("#dv-query"), scheduleDiscoverSearch, dvReset);
    bindHomeFilterToggle(cfg);
    $$("#tab-body [data-dv-type]").forEach((button) => button.addEventListener("click", () => {
      if (cfg.type === button.dataset.dvType) return;
      cfg.type = button.dataset.dvType;
      $$("#tab-body [data-dv-type]").forEach((item) => {
        const active = item.dataset.dvType === cfg.type;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      const search = $("#dv-query");
      search.placeholder = cfg.type === "mod" ? "Найти мод" : "Найти сборку";
      search.setAttribute("aria-label", cfg.type === "mod" ? "Поиск модов" : "Поиск готовых сборок");
      updateHomeCatalogFilters(cfg);
      dvReset();
    }));
    bindHomeCatalogFilters(cfg);
    ensureDiscoverVersions();
    $$("#tab-body [data-dv-source]").forEach((button) => button.addEventListener("click", () => {
      const source = button.dataset.dvSource;
      if (source === state.discover.source) {
        if (discoverSearchTimer) dvReset();
        return;
      }
      state.discover.source = source;
      state.settings = { ...(state.settings || {}), feed_source: source };
      api.saveSettings(state.settings).catch(() => {});
      updateSourceButtons("dv", source);
      updateHomeCatalogFilters(cfg);
      dvReset();
    }));
    $$("#tab-body [data-dv-view]").forEach((btn) => btn.addEventListener("click", () => {
      const view = btn.dataset.dvView;
      if (view !== "list" && view !== "grid") return;
      cfg.view = view;
      $$("#tab-body [data-dv-view]").forEach((item) => {
        const active = item.dataset.dvView === view;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      const results = $("#dv-results");
      if (results) {
        results.classList.toggle("is-grid", view === "grid");
        results.classList.remove("feed-grid-1", "feed-grid-2", "feed-grid-3");
        if (view === "grid") results.classList.add(`feed-grid-${feedGridLevel()}`);
        syncFeedColumns();
        dvWatch();
      }
    }));
    bindFeedResize();
    bindRecentResize();
    const feedSize = $("#feed-size");
    if (feedSize) {
      feedSize.addEventListener("input", () => {
        const level = Number(feedSize.value) || 2;
        const label = $("#feed-size-val");
        if (label) label.textContent = String(level);
        const results = $("#dv-results");
        if (results) {
          results.classList.remove("feed-grid-1", "feed-grid-2", "feed-grid-3");
          results.classList.add(`feed-grid-${level}`);
        }
        setFeedGridLevel(level);
        syncFeedColumns();
      });
    }
    bindHomeImport();
    const retry = $("#dv-retry");
    if (retry) retry.addEventListener("click", () => dvReset());
    bindResultEvents();
    bindCfEvents();
    // После перерисовки ленты снова привязываем кнопку повтора догрузки.
    dvUpdateSentinel();
    dvWatch();
    if (!cfg.tried && !cfg.loading && !cfg.error) dvReset();
    else if (cfg.error && !cfg.loading && !dvRetryTimer) {
      dvScheduleRetry("first");
      dvRenderResults();
    } else if (cfg.moreError && !cfg.loadingMore && !dvRetryTimer) {
      dvScheduleRetry("more");
      dvUpdateSentinel();
    }
  }

  /* ---------- импорт на главной ---------- */
  function bindHomeImport() {
    const cfg = state.home;
    const toggle = $("#imp-toggle");
    if (toggle) toggle.addEventListener("click", () => {
      cfg.open = !cfg.open;
      renderDiscover();
    });
    async function pickPack(title, extensions) {
      const picked = await api.pickFile(title, extensions).catch(() => null);
      if (!picked) return;
      cfg.zipPath = picked;
      cfg.status = "";
      if (/\.zip$/i.test(picked)) {
        cfg.versions = [];
        cfg.zipMc = "";
        cfg.zipLoader = "vanilla";
        cfg.zipLoaderVersion = "";
        cfg.zipLoaderVersions = [];
        renderDiscover();
        api.versions(false).then((versions) => {
          cfg.versions = versions || [];
          if (!cfg.zipMc) cfg.zipMc = (cfg.versions[0] || {}).id || "";
          renderDiscover();
        }).catch(() => {});
      } else {
        renderDiscover();
      }
    }
    const mrpack = $("#imp-mrpack");
    if (mrpack) mrpack.addEventListener("click", () => pickPack("Модпак .mrpack", ["mrpack"]));
    const zipBtn = $("#imp-zip");
    if (zipBtn) zipBtn.addEventListener("click", () => pickPack("Архив .zip", ["zip"]));

    const ext = $("#imp-ext");
    if (ext) ext.addEventListener("click", () => {
      cfg.extOpen = !cfg.extOpen;
      renderDiscover();
      if (cfg.extOpen && !cfg.external) loadHomeExternal();
    });
    const rescan = $("#imp-ext-rescan");
    if (rescan) rescan.addEventListener("click", () => loadHomeExternal(true));
    const close = $("#imp-ext-close");
    if (close) close.addEventListener("click", () => { cfg.extOpen = false; renderDiscover(); });
    const all = $("#imp-ext-all");
    if (all) all.addEventListener("click", () => {
      const list = cfg.external || [];
      const every = list.every((item) => cfg.extSelected.has(item.path));
      cfg.extSelected = new Set(every ? [] : list.map((item) => item.path));
      renderDiscover();
    });
    $$("#tab-body .imp-check").forEach((box) => box.addEventListener("change", () => {
      if (box.checked) cfg.extSelected.add(box.dataset.ext);
      else cfg.extSelected.delete(box.dataset.ext);
      const row = box.closest(".imp-item");
      if (row) row.classList.toggle("is-picked", box.checked);
      const go = $("#imp-ext-go");
      if (go) {
        go.disabled = !cfg.extSelected.size;
        go.textContent = cfg.extSelected.size ? `Импортировать (${cfg.extSelected.size})` : "Импортировать";
      }
      const count = $(".imp-count");
      if (count) count.textContent = cfg.extSelected.size ? `выбрано: ${cfg.extSelected.size}` : "отметь сборки галочками";
    }));
    const extGo = $("#imp-ext-go");
    if (extGo) extGo.addEventListener("click", importSelectedExternal);

    const urlInput = $("#imp-url-input");
    if (urlInput) urlInput.addEventListener("input", (event) => { cfg.url = event.target.value; });
    const urlGo = $("#imp-url-go");
    if (urlGo) urlGo.addEventListener("click", async () => {
      const url = (cfg.url || "").trim();
      if (!url) return toast("Вставь ссылку на модпак", "err");
      cfg.busy = true;
      cfg.status = "качаем модпак…";
      renderDiscover();
      try {
        const meta = await withInstallProgress("modpack", "modpack", (op) => api.installModpack(url, op));
        cfg.url = "";
        cfg.status = "";
        await refreshInstances();
        openInstance(meta.id);
        toast(`Сборка «${meta.name}» добавлена`, "ok");
      } catch (err) {
        toast(`Не удалось добавить: ${err}`, "err");
        cfg.status = "";
      } finally {
        cfg.busy = false;
      }
      if (state.tab === "discover") renderDiscover();
    });

    const cancel = $("#imp-cancel");
    if (cancel) cancel.addEventListener("click", () => { cfg.zipPath = ""; cfg.status = ""; renderDiscover(); });
    const mc = $("#imp-zip-mc");
    if (mc) mc.addEventListener("change", async (event) => {
      cfg.zipMc = event.target.value;
      if (cfg.zipLoader && cfg.zipLoader !== "vanilla") await loadHomeZipLoaderVersions();
      else renderDiscover();
    });
    $$("#tab-body [data-zip-loader]").forEach((chip) => chip.addEventListener("click", async () => {
      cfg.zipLoader = chip.dataset.zipLoader;
      await loadHomeZipLoaderVersions();
    }));
    const lv = $("#imp-zip-loader-version");
    if (lv) lv.addEventListener("change", (event) => { cfg.zipLoaderVersion = event.target.value; });
    const go = $("#imp-zip-go");
    if (go) go.addEventListener("click", importHomeZip);
  }

  async function loadHomeZipLoaderVersions() {
    const cfg = state.home;
    if (cfg.zipLoader === "vanilla") {
      cfg.zipLoaderVersions = [];
      cfg.zipLoaderVersion = "";
      renderDiscover();
      return;
    }
    const list = await api.loaderVersions(cfg.zipLoader, cfg.zipMc).catch(() => []);
    cfg.zipLoaderVersions = list || [];
    const current = cfg.zipLoaderVersions.find((option) => option.stable) || cfg.zipLoaderVersions[0];
    cfg.zipLoaderVersion = current ? current.version : "";
    renderDiscover();
  }

  async function importHomeZip() {
    const cfg = state.home;
    const path = cfg.zipPath;
    if (!path) return;
    const zip = /\.zip$/i.test(path);
    if (zip && !cfg.zipMc) return toast("Выбери версию Minecraft", "err");
    cfg.busy = true;
    cfg.status = "распаковываем…";
    renderDiscover();
    try {
      const meta = zip
        ? await api.installZip({
            path,
            name: null,
            mcVersion: cfg.zipMc,
            loader: cfg.zipLoader === "vanilla" ? null : cfg.zipLoader,
            loaderVersion: cfg.zipLoaderVersion || null
          })
        : await withInstallProgress("modpack", "modpack", (op) => api.installModpack(path, op));
      cfg.zipPath = "";
      cfg.status = "";
      await refreshInstances();
      openInstance(meta.id);
      toast(`Сборка «${meta.name}» добавлена`, "ok");
    } catch (err) {
      toast(`Не удалось импортировать: ${err}`, "err");
      cfg.status = "";
    } finally {
      cfg.busy = false;
      setProgress(null);
      if (state.tab === "discover") renderDiscover();
    }
  }

  async function loadHomeExternal(force = false) {
    const cfg = state.home;
    if (cfg.external && !force) return;
    cfg.extLoading = true;
    renderDiscover();
    try {
      cfg.external = await api.scanExternal();
    } catch (err) {
      cfg.external = [];
      toast(String(err), "err");
    }
    cfg.extLoading = false;
    if (state.tab === "discover") renderDiscover();
  }

  /** Импорт отмеченных сборок из других лаунчеров — по одной, с прогрессом. */
  async function importSelectedExternal() {
    const cfg = state.home;
    const list = (cfg.external || []).filter((item) => cfg.extSelected.has(item.path));
    if (!list.length) return;
    cfg.busy = true;
    let done = 0;
    let last = null;
    const failed = [];
    for (const item of list) {
      cfg.status = `импортируем ${done + 1} из ${list.length}: ${item.name}`;
      renderDiscover();
      try {
        // «stable»/«latest» из чужого лаунчера — не версия: подставляем
        // актуальную стабильную версию загрузчика для этой версии игры.
        let loaderVersion = item.loader_version || "";
        if (item.loader && item.loader !== "vanilla" && (!loaderVersion || loaderVersion === "stable" || loaderVersion === "latest")) {
          const options = await api.loaderVersions(item.loader, item.mc_version).catch(() => []);
          const current = (options || []).find((option) => option.stable) || (options || [])[0];
          loaderVersion = current ? current.version : "";
        }
        last = await api.importExternal({
          path: item.path,
          name: item.name,
          mcVersion: item.mc_version,
          loader: item.loader === "vanilla" ? null : item.loader,
          loaderVersion: loaderVersion || null,
          icon: item.icon || null
        });
        cfg.extSelected.delete(item.path);
        done += 1;
      } catch (err) {
        failed.push(`${item.name}: ${err}`);
      }
    }
    cfg.busy = false;
    cfg.status = "";
    await refreshInstances();
    if (failed.length) toast(`Импортировано ${done} из ${list.length}. Не удалось: ${failed.join("; ")}`, "err");
    else toast(`Импортировано сборок: ${done}`, "ok");
    if (done === 1 && last) {
      openInstance(last.id);
      return;
    }
    if (state.tab === "discover") renderDiscover();
  }

  // Автоповтор только пока открыта главная; ручной поиск отменяет старый таймер.
  const DV_RETRY_MS = [5000, 10000, 20000, 40000, 60000, 120000];
  let dvRetryTimer = null;
  let dvRetryCount = 0;
  let dvGeneration = 0;
  let discoverSearchTimer = null;

  function dvVisible() {
    return state.tab === "discover" && Boolean($("#dv-results"));
  }

  function cancelDiscoverSearchTimer() {
    if (discoverSearchTimer) clearTimeout(discoverSearchTimer);
    discoverSearchTimer = null;
  }

  function scheduleDiscoverSearch(value, composing = false) {
    const cfg = state.discover;
    cfg.query = value;
    cancelDiscoverSearchTimer();
    dvCancelRetry(true);
    // Ответ прежнего запроса или догрузки устаревает уже на первом символе.
    dvGeneration += 1;
    cfg.loading = true;
    cfg.loadingMore = false;
    cfg.tried = true;
    cfg.error = null;
    cfg.moreError = null;
    cfg.results = [];
    cfg.total = 0;
    if (dvVisible()) dvRenderResults();
    if (composing) return;
    discoverSearchTimer = setTimeout(() => {
      discoverSearchTimer = null;
      if (dvVisible()) dvReset();
      else { cfg.loading = false; cfg.tried = false; }
    }, SEARCH_INPUT_DELAY_MS);
  }

  function dvRetryable(error) {
    const text = String(error || "");
    const status = /\bHTTP(?:\/[\d.]+)?\s*(\d{3})\b/i.exec(text);
    if (status) {
      const code = Number(status[1]);
      return code === 408 || code === 425 || code === 429 || code >= 500;
    }
    return !/не задан API.ключ|ключ.*не принят|unauthorized|forbidden/i.test(text);
  }

  function dvCancelRetry(resetCount = false) {
    if (dvRetryTimer) clearTimeout(dvRetryTimer);
    dvRetryTimer = null;
    state.discover.retrySeconds = 0;
    if (resetCount) dvRetryCount = 0;
  }

  function dvScheduleRetry(kind) {
    const cfg = state.discover;
    const error = kind === "more" ? cfg.moreError : cfg.error;
    if (!dvVisible() || dvRetryTimer || !error || !dvRetryable(error)) return;
    const delay = DV_RETRY_MS[Math.min(dvRetryCount, DV_RETRY_MS.length - 1)];
    dvRetryCount += 1;
    cfg.retrySeconds = Math.round(delay / 1000);
    dvRetryTimer = setTimeout(() => {
      dvRetryTimer = null;
      cfg.retrySeconds = 0;
      if (!dvVisible()) return; // при возврате на главную таймер включится снова
      if (kind === "more") dvLoadMore(true);
      else dvReset({ automatic: true });
    }, delay);
  }

  function dvResultsHtml() {
    const cfg = state.discover;
    const label = cfg.type === "mod" ? "моды" : "готовые сборки";
    if (cfg.loading && !cfg.results.length) return `<div class="empty-state">Загружаем ${label}…</div>`;
    if (cfg.error) {
      const retryHint = cfg.retrySeconds
        ? `Повторим автоматически через ${cfg.retrySeconds} сек.`
        : "Проверь подключение, источник и настройки прокси.";
      return `<div class="empty-state dv-error" role="status">
        <strong>Не удалось загрузить ${label}</strong>
        <span>${retryHint}</span>
        <button class="btn" id="dv-retry">Повторить сейчас</button>
        <details><summary>Подробнее об ошибке</summary><pre>${esc(cfg.error)}</pre></details>
      </div>`;
    }
    if (!cfg.results.length) return `<div class="empty-state">Ничего не нашлось — попробуй другой запрос</div>`;
    return `${cfg.results.map((hit) => discCardHtml(hit)).join("")}<div class="mr-sentinel" id="dv-sentinel">${dvSentinelText()}</div>`;
  }

  function dvSentinelText() {
    const cfg = state.discover;
    if (cfg.loadingMore) return `<span class="mr-more-spinner"></span>Загружаем ещё…`;
    if (cfg.moreError) {
      const hint = cfg.retrySeconds ? `Повторим через ${cfg.retrySeconds} сек.` : "Проверь подключение.";
      return `<span>Не удалось загрузить остальные ${cfg.type === "mod" ? "моды" : "сборки"}. ${hint}</span> <button class="btn" id="dv-more-retry">Повторить сейчас</button>`;
    }
    if (cfg.results.length >= cfg.total) return `Показано всё: ${cfg.results.length}`;
    return `Прокрути вниз — ещё ${Math.max(0, cfg.total - cfg.results.length)}`;
  }

  function dvUpdateSentinel() {
    const sentinel = $("#dv-sentinel");
    if (!sentinel) return;
    sentinel.innerHTML = dvSentinelText();
    const retry = $("#dv-more-retry", sentinel);
    if (retry) retry.addEventListener("click", () => { dvCancelRetry(true); dvLoadMore(true); });
    const cfg = state.discover;
    if (cfg.moreError || (!cfg.loadingMore && cfg.results.length >= cfg.total)) {
      if (dvObserver) { dvObserver.disconnect(); dvObserver = null; }
    }
  }

  function dvWatch() {
    if (dvObserver) { dvObserver.disconnect(); dvObserver = null; }
    const sentinel = $("#dv-sentinel");
    const cfg = state.discover;
    if (!sentinel || cfg.moreError || cfg.results.length >= cfg.total) return;
    dvObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) dvLoadMore();
    }, { rootMargin: "240px" });
    dvObserver.observe(sentinel);
  }

  // Перерисовываем только результаты, не стирая набираемый поиск или форму импорта.
  function dvRenderResults() {
    const results = $("#dv-results");
    if (!results) return;
    results.innerHTML = dvResultsHtml();
    const retry = $("#dv-retry", results);
    if (retry) retry.addEventListener("click", () => dvReset());
    bindResultEvents();
    bindCfEvents();
    dvUpdateSentinel();
    dvWatch();
  }

  /** Карточка ленты: тип проекта и источник не зависят от вкладки сборки. */
  function discCardHtml(hit) {
    const cfg = state.discover;
    const pack = cfg.type !== "mod";
    if ((cfg.source || "modrinth") === "curseforge") return pack ? cfPackCardHtml(hit) : cfCardHtml(hit, "mod");
    return cardHtml(hit, pack ? "pack" : "mod");
  }

  /** Снимок фильтров не меняется, пока запрос находится в полёте. */
  function dvQuery(offset) {
    const cfg = state.discover;
    const source = cfg.source || "modrinth";
    const category = discoverCategoryValue(cfg, source);
    return { source, params: {
      query: cfg.query, projectType: cfg.type || "modpack", mcVersion: cfg.mc || null,
      loader: cfg.loader || null, categories: category ? [category] : [],
      offset, limit: DV_PAGE, sort: "downloads"
    } };
  }

  async function dvFetch(snapshot) {
    return snapshot.source === "curseforge" ? api.searchCurseforge(snapshot.params) : api.search(snapshot.params);
  }

  async function dvLoadMore(force = false) {
    const cfg = state.discover;
    if (cfg.loading || cfg.loadingMore || cfg.error || (cfg.moreError && !force)) return;
    if (!cfg.results.length || cfg.results.length >= cfg.total) return;
    dvCancelRetry(false);
    cfg.moreError = null;
    cfg.loadingMore = true;
    const generation = dvGeneration;
    const snapshot = dvQuery(cfg.results.length);
    dvUpdateSentinel();
    try {
      const page = await dvFetch(snapshot);
      if (generation !== dvGeneration) return;
      const known = new Set(cfg.results.map((hit) => hit.project_id));
      const fresh = (page.hits || []).filter((hit) => !known.has(hit.project_id));
      cfg.results = cfg.results.concat(fresh);
      cfg.total = page.total_hits ?? cfg.total;
      if (!fresh.length) cfg.total = cfg.results.length;
      const sentinel = $("#dv-sentinel");
      if (sentinel && fresh.length) sentinel.insertAdjacentHTML("beforebegin", fresh.map((hit) => discCardHtml(hit)).join(""));
      bindResultEvents();
      bindCfEvents();
      dvRetryCount = 0;
    } catch (err) {
      if (generation !== dvGeneration) return;
      cfg.moreError = String(err);
    }
    cfg.loadingMore = false;
    if (cfg.moreError) dvScheduleRetry("more");
    dvUpdateSentinel();
    if (!cfg.moreError) dvWatch();
  }

  async function dvReset({ automatic = false } = {}) {
    const input = $("#dv-query");
    const cfg = state.discover;
    cancelDiscoverSearchTimer();
    dvCancelRetry(!automatic);
    if (!automatic && input) cfg.query = input.value;
    cfg.loading = true;
    cfg.loadingMore = false;
    cfg.tried = true;
    cfg.error = null;
    cfg.moreError = null;
    cfg.results = [];
    cfg.total = 0;
    const generation = ++dvGeneration;
    const snapshot = dvQuery(0);
    dvRenderResults();
    try {
      const page = await dvFetch(snapshot);
      if (generation !== dvGeneration) return;
      cfg.results = page.hits || [];
      cfg.total = page.total_hits ?? cfg.results.length;
      dvRetryCount = 0;
    } catch (err) {
      if (generation !== dvGeneration) return;
      cfg.error = String(err);
    }
    cfg.loading = false;
    if (cfg.error) dvScheduleRetry("first");
    if (dvVisible()) dvRenderResults();
  }

  // Когда сеть вернулась, не ждём оставшуюся паузу backoff.
  window.addEventListener("online", () => {
    if (state.tab === "download" && state.selectedId) refreshInstalledProjects();
    const cfg = state.discover;
    if (!dvVisible() || cfg.loading || cfg.loadingMore) return;
    if (cfg.error && dvRetryable(cfg.error)) {
      dvCancelRetry(false);
      dvReset({ automatic: true });
    } else if (cfg.moreError && dvRetryable(cfg.moreError)) {
      dvCancelRetry(false);
      dvLoadMore(true);
    }
  });

  function resultsHtml() {
    const cfg = state.modrinth;
    if (cfg.loading && !cfg.results.length) return `<div class="empty-state">Ищем…</div>`;
    if (cfg.error) {
      return `<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="max-width:640px;text-align:left;white-space:pre-wrap;font-size:12px;color:var(--red)">${esc(cfg.error)}</div>
        <button class="btn" id="mr-retry">Повторить</button>
      </div>`;
    }
    if (!cfg.results.length) return `<div class="empty-state">Ничего не найдено — попробуй другой запрос или фильтры</div>`;
    return `${cfg.results.map(cardHtml).join("")}<div class="mr-sentinel" id="mr-sentinel">${sentinelText()}</div>`;
  }

  function sentinelText() {
    const cfg = state.modrinth;
    if (cfg.loadingMore) return `<span class="mr-more-spinner"></span>Загружаем ещё…`;
    if (cfg.results.length >= cfg.total) return `Показано всё: ${cfg.results.length}`;
    return `Прокрути вниз — ещё ${Math.max(0, cfg.total - cfg.results.length)}`;
  }

  /** Догрузка следующей страницы при прокрутке до конца. */
  function watchMore() {
    if (mrObserver) { mrObserver.disconnect(); mrObserver = null; }
    const sentinel = $("#mr-sentinel");
    if (!sentinel || state.modrinth.results.length >= state.modrinth.total) return;
    mrObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: "200px" });
    mrObserver.observe(sentinel);
  }

  async function loadMore() {
    const cfg = state.modrinth;
    if (!catalogVisible("modrinth") || cfg.loading || cfg.loadingMore || cfg.error) return;
    if (!cfg.results.length || cfg.results.length >= cfg.total) return;
    cfg.loadingMore = true;
    const generation = mrSearchGeneration;
    const params = searchQuery(cfg.results.length);
    updateSentinel();
    try {
      const hits = await api.search(params);
      if (generation !== mrSearchGeneration) return;
      const known = new Set(cfg.results.map((hit) => hit.project_id));
      const fresh = (hits.hits || []).filter((hit) => !known.has(hit.project_id));
      cfg.results = cfg.results.concat(fresh);
      cfg.total = hits.total_hits ?? cfg.total;
      if (!fresh.length) cfg.total = cfg.results.length;
      const container = catalogVisible("modrinth") && $("#mr-results");
      if (container && fresh.length) {
        const sentinel = $("#mr-sentinel");
        const html = fresh.map(cardHtml).join("");
        if (sentinel) sentinel.insertAdjacentHTML("beforebegin", html);
        else container.insertAdjacentHTML("beforeend", html);
        bindResultEvents();
      }
    } catch (err) {
      if (generation !== mrSearchGeneration) return;
      cfg.error = String(err);
      cfg.loadingMore = false;
      renderCatalogSource("modrinth");
      return;
    }
    cfg.loadingMore = false;
    if (catalogVisible("modrinth")) {
      updateSentinel();
      watchMore(); // если конец всё ещё виден, загрузим следующую страницу
    }
  }

  function updateSentinel() {
    const sentinel = $("#mr-sentinel");
    if (sentinel) sentinel.innerHTML = sentinelText();
    const cfg = state.modrinth;
    if (sentinel && !cfg.loadingMore && cfg.results.length >= cfg.total) {
      if (mrObserver) { mrObserver.disconnect(); mrObserver = null; }
    }
  }

  function searchQuery(offset) {
    const cfg = state.modrinth;
    const meta = selected();
    return {
      query: cfg.query,
      projectType: cfg.type,
      mcVersion: cfg.mc || (meta ? meta.mc_version : null),
      // у ресурспаков и шейдеров нет тега загрузчика — иначе Modrinth
      // возвращал моды с категорией fabric
      loader: cfg.type === "mod" ? (cfg.loader || (meta && meta.loader ? meta.loader.type : null)) : null,
      categories: [downloadCategoryValue(cfg)].filter(Boolean),
      offset: offset || 0,
      limit: MR_PAGE
    };
  }

  function bindResultEvents() {
    // клик по всей ячейке проекта открывает окно сведений (кнопки внутри — свои действия)
    $$(".card[data-project]").forEach((card) => {
      if (card.dataset.cardBound) return;
      card.dataset.cardBound = "1";
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        openProjectModal(card.dataset.project, card.dataset.kind, card.dataset.slug, card.dataset.title);
      });
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const id = card.dataset.project;
        const kind = card.dataset.kind;
        const title = card.dataset.title;
        const type = card.dataset.projectType || (kind === "pack" ? "modpack" : "mod");
        const url = `https://modrinth.com/${type}/${card.dataset.slug}`;
        fillCtxMenu(event.clientX, event.clientY, `
          <div class="ctx-caption" translate="no">${esc(title)}</div>
          <button class="ctx-item" data-act="install"><svg class="ic"><use href="#i-download"/></svg>Установить</button>
          <button class="ctx-item" data-act="versions"><svg class="ic"><use href="#i-list"/></svg>Версии</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" data-act="page"><svg class="ic"><use href="#i-link"/></svg>Открыть страницу</button>
          <button class="ctx-item" data-act="copy"><svg class="ic"><use href="#i-copy"/></svg>Копировать ссылку</button>`,
        (act) => {
          if (act === "install") installFromModrinth(id, kind, title);
          else if (act === "versions") openVersions(id, kind, title);
          else if (act === "page") api.openUrl(url).catch((error) => toast(String(error), "err"));
          else if (act === "copy") copyText(url);
        });
      });
    });
    $$("[data-install]").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => installFromModrinth(btn.dataset.install, btn.dataset.kind, btn.dataset.title));
    });
    $$("[data-versions]").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => openVersions(btn.dataset.versions, btn.dataset.kind, btn.dataset.title));
    });
    $$("[data-open-page]").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        const type = btn.dataset.openType || state.modrinth.type || "mod";
        const url = type === "modpack" ? `https://modrinth.com/modpack/${btn.dataset.openPage}` : `https://modrinth.com/${type}/${btn.dataset.openPage}`;
        api.openUrl(url).catch((error) => toast(String(error), "err"));
      });
    });
  }

  function cardHtml(hit, kind) {
    const isPack = kind === "pack" || (!kind && state.modrinth.type === "modpack");
    const openType = isPack ? "modpack" : (kind === "mod" ? "mod" : (state.modrinth.type || "mod"));
    return `<div class="card${projectInstalled(hit.project_id, "modrinth", openType) ? " is-installed" : ""}${projectStatus(hit.project_id, "modrinth", openType) === "downloading" ? " is-downloading" : ""}" role="group" aria-label="${esc(projectLabel(hit.title, hit.project_id, "modrinth", openType))}" data-project="${esc(hit.project_id)}" data-project-type="${esc(openType)}" data-kind="${isPack ? "pack" : "mod"}" data-slug="${esc(hit.slug || hit.project_id)}" data-title="${esc(hit.title)}">
      <div class="card-icon">${hit.icon_url ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy">` : `<span class="card-letter" translate="no">${esc(String(hit.title || "?").trim().charAt(0).toUpperCase())}</span>`}</div>
      <div class="card-body">
        <div class="card-title" translate="no">${esc(hit.title)}</div>
        <div class="card-desc" translate="no">${esc(hit.description)}</div>
        <div class="card-meta">
          ${projectBadge(hit.project_id, "modrinth", openType)}
          ${(hit.categories || []).slice(0, 3).map((cat) => `<span class="tag" translate="no">${esc(cat)}</span>`).join("")}
          <span class="tag">${(hit.downloads || 0).toLocaleString(I18N.locale())} ⬇</span>
        </div>
        <div class="card-actions">
          <button class="icon-btn card-icon-btn is-primary" data-install="${esc(hit.project_id)}" data-kind="${isPack ? "pack" : "mod"}" data-title="${esc(hit.title)}" title="Скачать и установить" aria-label="Скачать">
            <svg class="ic"><use href="#i-download"/></svg>
          </button>
          <button class="icon-btn card-icon-btn" data-versions="${esc(hit.project_id)}" data-kind="${isPack ? "pack" : "mod"}" data-title="${esc(hit.title)}" title="Версии" aria-label="Версии">
            <svg class="ic"><use href="#i-list"/></svg>
          </button>
          <button class="icon-btn card-icon-btn" data-open-page="${esc(hit.slug || hit.project_id)}" data-open-type="${esc(openType)}" title="Страница проекта" aria-label="Страница">
            <svg class="ic"><use href="#i-link"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  }

  /* ---------- куда поставить мод с главной ---------- */
  let activeModTarget = null;

  function modVersionMatches(version, mc, loader) {
    if (!version || !mc || !loader || loader === "vanilla") return false;
    return (version.game_versions || []).includes(mc)
      && (version.loaders || []).some((value) => String(value).toLowerCase() === loader);
  }

  function modVersionFor(cfg, mc, loader) {
    return (cfg.versions || []).find((version) => modVersionMatches(version, mc, loader)
      && (!version.project_id || String(version.project_id) === String(cfg.projectId)));
  }

  function closeModTarget(result = null) {
    const cfg = activeModTarget;
    if (!cfg) return;
    activeModTarget = null;
    $("#modal-mod-target").hidden = true;
    if (cfg.returnFocus && cfg.returnFocus.isConnected) cfg.returnFocus.focus();
    cfg.resolve(result);
  }

  function modTargetRefreshSubmit(cfg) {
    if (activeModTarget !== cfg) return;
    const button = $("#mod-target-submit");
    if (cfg.mode === "existing") {
      const status = cfg.statuses.get(cfg.selectedId);
      button.textContent = "Установить";
      button.disabled = !status || status.state !== "ok";
      $("#mod-target-hint").textContent = "Выбери подходящую сборку";
    } else {
      button.textContent = "Создать и установить";
      button.disabled = cfg.newLoading || cfg.loaderLoading || !cfg.name.trim() || !cfg.mc || !cfg.loader
        || !cfg.loaderVersion || !modVersionFor(cfg, cfg.mc, cfg.loader);
      $("#mod-target-hint").textContent = "Новая сборка будет создана после подтверждения";
    }
  }

  function modTargetLoaders(cfg, mc) {
    return CATALOG_LOADERS.filter((loader) => modVersionFor(cfg, mc, loader));
  }

  function renderModTarget(cfg) {
    if (activeModTarget !== cfg) return;
    const body = $("#mod-target-body");
    $("#mod-target-title").textContent = `Установить: ${cfg.title || "мод"}`;
    const versionText = cfg.specific ? `<div class="mod-target-note">Выбрана версия: <strong translate="no">${esc(cfg.specific.name || cfg.specific.version_number || cfg.specific.id)}</strong></div>` : "";
    if (cfg.mode === "existing") {
      const rows = cfg.instances.map((instance) => {
        const status = cfg.statuses.get(instance.id) || { state: "checking" };
        const ok = status.state === "ok";
        const message = ok ? "Подходит" : status.state === "no" ? "Нет совместимой версии"
          : status.state === "error" ? "Не удалось проверить" : "Проверяем…";
        return `<label class="mod-target-instance ${ok ? "is-compatible" : "is-unavailable"}">
          <input type="radio" name="mod-target-instance" value="${esc(instance.id)}" ${cfg.selectedId === instance.id ? "checked" : ""} ${ok ? "" : "disabled"}>
          <span class="mod-target-instance-main"><strong translate="no">${esc(instance.name)}</strong><span>MC ${esc(instance.mc_version)} · ${esc(loaderLabel(instance.loader))}</span></span>
          <span class="mod-target-status ${ok ? "is-ok" : ""}" title="${esc(status.error || message)}">${esc(message)}</span>
        </label>`;
      }).join("");
      body.innerHTML = `${versionText}
        <p class="mod-target-intro">Выбери сборку, в которую установить мод. Несовместимые сборки недоступны.</p>
        <div class="mod-target-list" role="radiogroup" aria-label="Сборки">${rows}</div>
        ${[...cfg.statuses.values()].some((item) => item.state === "error") ? `<div class="mod-target-note">Не все сборки удалось проверить. Проверь сеть и <button type="button" class="text-btn" id="mod-target-retry-existing">повтори проверку</button>.</div>` : ""}
        <button type="button" class="btn mod-target-switch" id="mod-target-create">Создать новую сборку</button>`;
      $$("input[name='mod-target-instance']", body).forEach((input) => input.addEventListener("change", () => {
        cfg.selectedId = input.value;
        modTargetRefreshSubmit(cfg);
      }));
      $("#mod-target-retry-existing")?.addEventListener("click", () => checkModTargetInstances(cfg));
      $("#mod-target-create").addEventListener("click", () => {
        cfg.mode = "create";
        renderModTarget(cfg);
        if (!cfg.newLoaded && !cfg.newLoading) loadModTargetNew(cfg);
      });
    } else {
      const availableGames = cfg.games || [];
      const loaders = modTargetLoaders(cfg, cfg.mc);
      const noVersions = cfg.newLoaded && !availableGames.length;
      body.innerHTML = `${versionText}
        <p class="mod-target-intro">${cfg.instances.length ? "Создадим отдельную сборку с этим модом." : "Сборок пока нет. Выбери совместимые параметры новой сборки."}</p>
        ${cfg.newLoading ? `<div class="mod-target-note">Получаем совместимые версии Minecraft и загрузчики…</div>` : ""}
        ${cfg.newError ? `<div class="mod-target-error">Не удалось получить совместимость: ${esc(cfg.newError)} <button type="button" class="text-btn" id="mod-target-retry-new">Повторить</button></div>` : ""}
        ${noVersions ? `<div class="mod-target-error">Для этой версии мода нет подтверждённых сочетаний Minecraft и поддерживаемого загрузчика.</div>` : ""}
        <div class="mod-target-fields">
          <label class="field"><span>Название сборки</span><input class="input" id="mod-target-name" maxlength="100" value="${esc(cfg.name)}" autocomplete="off"></label>
          <label class="field"><span>Версия Minecraft</span><select class="select" id="mod-target-mc" ${availableGames.length ? "" : "disabled"}>
            ${availableGames.length ? availableGames.map((game) => `<option value="${esc(game.id)}" ${game.id === cfg.mc ? "selected" : ""}>${esc(game.id)}${game.type && game.type !== "release" ? " · снимок" : ""}</option>`).join("") : `<option value="">Нет доступных версий</option>`}
          </select></label>
          <label class="field"><span>Загрузчик</span><select class="select" id="mod-target-loader" ${loaders.length ? "" : "disabled"}>
            ${loaders.length ? loaders.map((loader) => `<option value="${loader}" ${loader === cfg.loader ? "selected" : ""}>${LOADER_NAMES[loader]}</option>`).join("") : `<option value="">Нет подходящих загрузчиков</option>`}
          </select></label>
          <label class="field"><span>Версия загрузчика</span><select class="select" id="mod-target-loader-version" ${cfg.loaderOptions.length ? "" : "disabled"}>
            ${cfg.loaderOptions.length ? cfg.loaderOptions.map((option) => `<option value="${esc(option.version)}" ${option.version === cfg.loaderVersion ? "selected" : ""}>${esc(option.version)}${option.stable ? " · стабильная" : ""}</option>`).join("") : `<option value="">${cfg.loaderLoading ? "Проверяем…" : "Недоступна"}</option>`}
          </select></label>
        </div>
        ${cfg.loaderError ? `<div class="mod-target-error">${esc(cfg.loaderError)} <button type="button" class="text-btn" id="mod-target-retry-loader">Повторить</button></div>` : ""}
        ${cfg.instances.length ? `<button type="button" class="btn mod-target-switch" id="mod-target-existing">Выбрать существующую сборку</button>` : ""}`;
      $("#mod-target-name").addEventListener("input", (event) => { cfg.name = event.target.value; modTargetRefreshSubmit(cfg); });
      $("#mod-target-mc").addEventListener("change", (event) => {
        cfg.mc = event.target.value;
        const choices = modTargetLoaders(cfg, cfg.mc);
        if (!choices.includes(cfg.loader)) cfg.loader = choices[0] || "";
        loadModTargetLoader(cfg);
      });
      $("#mod-target-loader").addEventListener("change", (event) => { cfg.loader = event.target.value; loadModTargetLoader(cfg); });
      $("#mod-target-loader-version").addEventListener("change", (event) => { cfg.loaderVersion = event.target.value; modTargetRefreshSubmit(cfg); });
      $("#mod-target-retry-new")?.addEventListener("click", () => loadModTargetNew(cfg));
      $("#mod-target-retry-loader")?.addEventListener("click", () => loadModTargetLoader(cfg));
      $("#mod-target-existing")?.addEventListener("click", () => { cfg.mode = "existing"; renderModTarget(cfg); });
    }
    modTargetRefreshSubmit(cfg);
  }

  async function checkModTargetInstances(cfg) {
    if (activeModTarget !== cfg || cfg.checking) return;
    cfg.checking = true;
    const groups = new Map();
    for (const instance of cfg.instances) {
      const loader = instance.loader?.type || "vanilla";
      if (!CATALOG_LOADERS.includes(loader)) {
        cfg.statuses.set(instance.id, { state: "no" });
        continue;
      }
      const key = `${instance.mc_version}\u0000${loader}`;
      if (!groups.has(key)) groups.set(key, { mc: instance.mc_version, loader, ids: [] });
      groups.get(key).ids.push(instance.id);
      cfg.statuses.set(instance.id, { state: "checking" });
    }
    cfg.selectedId = null;
    renderModTarget(cfg);
    const queue = [...groups.values()];
    // Не посылаем сотни запросов сразу, если у пользователя много сборок.
    async function worker() {
      while (queue.length && activeModTarget === cfg) {
        const group = queue.shift();
        let status;
        try {
          const versions = cfg.specific ? [cfg.specific] : await (cfg.source === "curseforge"
            ? api.curseforgeVersions(cfg.projectId, group.mc, group.loader)
            : api.modrinthVersions(cfg.projectId, group.mc, group.loader));
          if (!Array.isArray(versions)) throw new Error("каталог вернул неполный ответ");
          const version = versions.find((item) => modVersionMatches(item, group.mc, group.loader)
            && (!item.project_id || String(item.project_id) === String(cfg.projectId)));
          status = version ? { state: "ok", versionId: version.id } : { state: "no" };
        } catch (error) { status = { state: "error", error: String(error) }; }
        if (activeModTarget !== cfg) return;
        group.ids.forEach((id) => cfg.statuses.set(id, status));
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (activeModTarget !== cfg) return;
    cfg.checking = false;
    renderModTarget(cfg);
  }

  async function loadModTargetNew(cfg) {
    if (activeModTarget !== cfg || cfg.newLoading) return;
    cfg.newLoading = true;
    cfg.newError = "";
    cfg.newLoaded = false;
    cfg.games = [];
    cfg.versions = [];
    cfg.mc = cfg.loader = cfg.loaderVersion = "";
    cfg.loaderOptions = [];
    renderModTarget(cfg);
    try {
      const [versions, manifest] = await Promise.all([
        cfg.specific ? Promise.resolve([cfg.specific]) : (cfg.source === "curseforge"
          ? api.curseforgeCompatibilityVersions(cfg.projectId)
          : api.modrinthVersions(cfg.projectId, null, null)),
        api.versions(true)
      ]);
      if (activeModTarget !== cfg) return;
      if (!Array.isArray(versions) || !Array.isArray(manifest)) throw new Error("каталог или манифест Minecraft вернул неполный ответ");
      cfg.versions = versions;
      cfg.games = manifest.filter((game) => game?.id && CATALOG_LOADERS.some((loader) => modVersionFor(cfg, game.id, loader)));
      cfg.newLoaded = true;
      cfg.mc = cfg.games[0]?.id || "";
      const choices = modTargetLoaders(cfg, cfg.mc);
      cfg.loader = choices.includes(state.discover.loader) ? state.discover.loader : (choices[0] || "");
    } catch (error) {
      if (activeModTarget !== cfg) return;
      cfg.newError = String(error);
    }
    cfg.newLoading = false;
    renderModTarget(cfg);
    if (cfg.mc && cfg.loader) loadModTargetLoader(cfg);
  }

  async function loadModTargetLoader(cfg) {
    if (activeModTarget !== cfg) return;
    const request = ++cfg.loaderRequest;
    const mc = cfg.mc, loader = cfg.loader;
    cfg.loaderOptions = [];
    cfg.loaderVersion = "";
    cfg.loaderError = "";
    cfg.loaderLoading = Boolean(mc && loader);
    renderModTarget(cfg);
    if (!cfg.loaderLoading) return;
    try {
      const options = await api.loaderVersions(loader, mc);
      if (activeModTarget !== cfg || request !== cfg.loaderRequest) return;
      if (!Array.isArray(options)) throw new Error("список версий загрузчика недоступен");
      cfg.loaderOptions = options.filter((option) => option?.version);
      cfg.loaderVersion = recommendedLoader(cfg.loaderOptions)?.version || "";
      if (!cfg.loaderVersion) cfg.loaderError = "Для этого Minecraft нет доступной версии загрузчика.";
    } catch (error) {
      if (activeModTarget !== cfg || request !== cfg.loaderRequest) return;
      cfg.loaderError = `Не удалось проверить версии загрузчика: ${String(error)}`;
    }
    cfg.loaderLoading = false;
    renderModTarget(cfg);
  }

  function chooseModTarget(source, projectId, title, specific = null) {
    if (activeModTarget) closeModTarget();
    return new Promise((resolve) => {
      const instances = state.instances.map((item) => ({ ...item, loader: { ...(item.loader || { type: "vanilla" }) } }));
      const cfg = activeModTarget = {
        source, projectId, title: title || "Мод", specific, instances, resolve,
        returnFocus: document.activeElement, mode: instances.length ? "existing" : "create",
        statuses: new Map(), selectedId: null, checking: false,
        name: `${title || "Мод"} — сборка`, versions: [], games: [], mc: "", loader: "",
        loaderOptions: [], loaderVersion: "", loaderRequest: 0, loaderLoading: false, loaderError: "",
        newLoading: false, newLoaded: false, newError: ""
      };
      $("#modal-mod-target").hidden = false;
      renderModTarget(cfg);
      $("#mod-target-close").focus();
      if (instances.length) checkModTargetInstances(cfg);
      else loadModTargetNew(cfg);
    });
  }

  function confirmModTarget() {
    const cfg = activeModTarget;
    if (!cfg || $("#mod-target-submit").disabled) return;
    if (cfg.mode === "existing") {
      const instance = cfg.instances.find((item) => item.id === cfg.selectedId);
      const status = cfg.statuses.get(cfg.selectedId);
      if (!instance || status?.state !== "ok" || !status.versionId) return;
      closeModTarget({ mode: "existing", instance, versionId: status.versionId });
      return;
    }
    const version = modVersionFor(cfg, cfg.mc, cfg.loader);
    if (!version || !cfg.loaderOptions.some((option) => option.version === cfg.loaderVersion) || !cfg.name.trim()) return;
    closeModTarget({ mode: "create", versionId: version.id, req: {
      name: cfg.name.trim(), mc_version: cfg.mc, loader: { type: cfg.loader, version: cfg.loaderVersion },
      icon: null, memory_mb: null, java_path: null, game_dir: null
    } });
  }

  async function installHomeMod(source, projectId, title, specific = null) {
    const target = await chooseModTarget(source, projectId, title, specific);
    if (!target) return false;
    try {
      if (target.mode === "existing") {
        const meta = target.instance;
        const outcome = await withDownloading(projectId, (op) => source === "curseforge"
          ? api.installCurseforge(meta.id, projectId, target.versionId, op)
          : api.installModVersion(meta.id, target.versionId, op, projectId), { instanceId: meta.id, source });
        if (!outcome || !Array.isArray(outcome.installed) || !Array.isArray(outcome.skipped)) throw new Error("нет подтверждения установки");
        if (outcome.skipped.length) {
          const added = outcome.installed.length ? `Загружено: ${outcome.installed.join(", ")}. ` : "";
          toast(`Установка в «${meta.name}»: ${added}существующие файлы не перезаписаны: ${outcome.skipped.join(", ")}`);
        } else if (outcome.installed.length) {
          toast(`Мод установлен в «${meta.name}»: ${outcome.installed.join(", ")}`, "ok");
        } else throw new Error("нет подтверждения установки");
      } else {
        const result = await withInstallProgress("new-mod", "mods", (op) => api.createInstanceForMod(target.req, source, projectId, target.versionId, op));
        await refreshInstances();
        if (result.instance && state.instances.some((item) => item.id === result.instance.id)) openInstance(result.instance.id);
        if (result.install_error || !result.outcome) {
          toast(`Сборка «${result.instance?.name || target.req.name}» создана, но установка мода не завершена: ${result.install_error || "нет подтверждения установки"}`, "err");
          return false;
        }
        if (result.profile_warning) toast(`Профиль загрузчика подготовится при запуске: ${result.profile_warning}`, "err");
        if (!Array.isArray(result.outcome.installed) || !Array.isArray(result.outcome.skipped)) throw new Error("сборка создана, но нет подтверждения установки мода");
        if (result.outcome.skipped.length) {
          toast(`Сборка «${result.instance?.name || target.req.name}» создана; существующие файлы не перезаписаны: ${result.outcome.skipped.join(", ")}`);
        } else if (result.outcome.installed.length) {
          toast(`Сборка «${result.instance?.name || target.req.name}» создана, мод установлен`, "ok");
        } else throw new Error("сборка создана, но нет подтверждения установки мода");
      }
      return true;
    } catch (error) {
      toast(String(error), "err");
      return false;
    }
  }

  /* ---------- выбор версии мода / модпака ---------- */
  /** Простое превращение описания Modrinth в читаемый текст. */
  function plainDescription(text) {
    if (!text) return "";
    let body = String(text);
    body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, "");          // картинки
    body = body.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");        // ссылки
    body = body.replace(/^#{1,6}\s*/gm, "");                       // заголовки
    body = body.replace(/[*_`>]{1,3}/g, "");                        // акценты
    body = body.replace(/<[^>]+>/g, "");                            // html
    body = body.replace(/\n{3,}/g, "\n\n").trim();
    return body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
  }

  let projectRequestGeneration = 0;
  let projectImages = [];
  let projectImageIndex = 0;
  let projectImageReturnFocus = null;

  function closeProjectModal() {
    projectRequestGeneration += 1;
    $("#modal-project").hidden = true;
    closeProjectImage();
  }

  function beginProjectModal(title, source) {
    const generation = ++projectRequestGeneration;
    $("#proj-title").textContent = title || "Проект";
    $("#proj-body").innerHTML = `<div class="empty-state">Загружаем сведения с ${esc(source)}…</div>`;
    $("#proj-tabs").hidden = true;
    ["#proj-site", "#proj-versions", "#proj-install"].forEach((id) => { $(id).disabled = true; });
    projectImages = [];
    $("#modal-project").hidden = false;
    return generation;
  }

  function setProjectTab(tab, focus = false) {
    const active = tab === "gallery" ? "gallery" : "description";
    $$("[data-proj-tab]", $("#proj-tabs")).forEach((button) => {
      const selected = button.dataset.projTab === active;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    const description = $("#proj-panel-description");
    const gallery = $("#proj-panel-gallery");
    if (description) description.hidden = active !== "description";
    if (gallery) gallery.hidden = active !== "gallery";
    $("#proj-body").scrollTop = 0;
  }

  function updateProjectImage() {
    const image = projectImages[projectImageIndex];
    if (!image) return;
    const caption = image.title || I18N.translate(`Изображение ${projectImageIndex + 1}`);
    $("#project-image-title").textContent = caption;
    $("#project-image-full").src = image.url;
    $("#project-image-full").alt = caption;
    $("#project-image-count").textContent = `${projectImageIndex + 1} / ${projectImages.length}`;
    $("#project-image-prev").disabled = projectImages.length < 2;
    $("#project-image-next").disabled = projectImages.length < 2;
  }

  function openProjectImage(index, trigger) {
    if (!projectImages[index]) return;
    projectImageReturnFocus = trigger || document.activeElement;
    projectImageIndex = index;
    updateProjectImage();
    $("#modal-project-image").hidden = false;
    $("#project-image-close").focus();
  }

  function closeProjectImage() {
    const modal = $("#modal-project-image");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    $("#project-image-full").removeAttribute("src");
    if (projectImageReturnFocus && projectImageReturnFocus.isConnected) projectImageReturnFocus.focus();
    projectImageReturnFocus = null;
  }

  function renderProjectDetails(project, title, source) {
    projectImages = (Array.isArray(project.gallery) ? project.gallery : [])
      .map((shot) => typeof shot === "string" ? { url: shot, title: "" } : { url: shot?.url, title: shot?.title || "" })
      .filter((shot) => typeof shot.url === "string" && /^(?:https?:\/\/|data:image\/)/i.test(shot.url));
    const tags = (project.categories || []).slice(0, 8);
    const downloads = (project.downloads || 0).toLocaleString(I18N.locale());
    const desc = plainDescription(project.body) || project.description || "";
    const subtitle = source === "modrinth"
      ? (project.license?.name ? ` · ${esc(project.license.name)}` : "")
      : ((project.loaders || []).length ? ` · ${esc(project.loaders.join(", "))}` : "");
    const gallery = (shots) => shots.map((shot, index) => `
      <button type="button" class="proj-shot" data-project-image="${index}" aria-label="Увеличить ${esc(shot.title || `изображение ${index + 1}`)}">
        <img src="${esc(shot.url)}" alt="${esc(shot.title || "")}" loading="lazy">
        <span class="proj-shot-hint">Увеличить</span>
      </button>`).join("");
    $("#proj-body").innerHTML = `
      <section id="proj-panel-description" class="proj-panel" role="tabpanel" aria-labelledby="proj-tab-description">
        <div class="proj-top">
          <div class="proj-icon">${project.icon_url
            ? `<img src="${esc(project.icon_url)}" alt="">`
            : `<span class="card-letter" translate="no">${esc(String(project.title || title || "?").charAt(0).toUpperCase())}</span>`}</div>
          <div class="proj-head">
            <div class="proj-title" translate="no">${esc(project.title || title || "")}</div>
            <div class="proj-sub" translate="no">${esc(project.description || "")}</div>
            <div class="proj-sub">${downloads} загрузок${subtitle}</div>
          </div>
        </div>
        ${tags.length ? `<div class="proj-tags">${tags.map((tag) => `<span class="tag" translate="no">${esc(tag)}</span>`).join("")}</div>` : ""}
        ${projectImages.length ? `<div class="proj-gallery">${gallery(projectImages.slice(0, 6))}</div>` : ""}
        ${projectImages.length > 6 ? `<button type="button" class="btn proj-show-all" id="proj-show-all">Все изображения (${projectImages.length})</button>` : ""}
        ${desc ? `<div class="proj-desc" translate="no">${esc(desc)}</div>` : `<div class="proj-empty">Описание пустое — смотри страницу проекта.</div>`}
      </section>
      <section id="proj-panel-gallery" class="proj-panel" role="tabpanel" aria-labelledby="proj-tab-gallery" hidden>
        ${projectImages.length ? `<div class="proj-gallery">${gallery(projectImages)}</div>` : `<div class="proj-empty">Изображений пока нет.</div>`}
      </section>`;
    $("#proj-tab-gallery").textContent = `Картинки${projectImages.length ? ` (${projectImages.length})` : ""}`;
    $("#proj-tabs").hidden = false;
    setProjectTab("description");
    $$("[data-project-image]", $("#proj-body")).forEach((button) => button.addEventListener("click", () => openProjectImage(Number(button.dataset.projectImage), button)));
    $("#proj-show-all")?.addEventListener("click", () => setProjectTab("gallery", true));
  }

  async function openProjectModal(projectId, kind, slug, title) {
    const modal = $("#modal-project");
    if (!modal) return;
    const isPack = kind === "pack";
    const generation = beginProjectModal(title, "Modrinth");
    let project = null;
    let error = null;
    try { project = await api.modrinthProject(projectId); }
    catch (err) { error = String(err); }
    if (generation !== projectRequestGeneration || modal.hidden) return;
    const projectType = project?.project_type || (isPack ? "modpack" : "mod");
    const slugOrId = project?.slug || project?.id || slug || projectId;
    const siteUrl = `https://modrinth.com/${projectType}/${slugOrId}`;
    if (project) renderProjectDetails(project, title, "modrinth");
    else $("#proj-body").innerHTML = `<div class="proj-empty" style="color:var(--red)">Не удалось получить сведения: ${esc(error || "нет данных")}</div>`;
    const projectTitle = title || project?.title || "Проект";
    $("#proj-site").disabled = false;
    $("#proj-site").onclick = () => api.openUrl(siteUrl).catch((error) => toast(String(error), "err"));
    $("#proj-versions").disabled = false;
    $("#proj-versions").onclick = () => {
      closeProjectModal();
      openVersions(projectId, isPack ? "pack" : "mod", projectTitle);
    };
    const installBtn = $("#proj-install");
    installBtn.disabled = !project;
    installBtn.onclick = () => {
      closeProjectModal();
      installFromModrinth(projectId, isPack ? "pack" : "mod", projectTitle);
    };
  }

  async function openVersions(projectId, kind, title, replaceEntry = null) {
    const modal = $("#modal-versions");
    if (!modal) return;
    modal.hidden = false;
    $("#ver-title").textContent = replaceEntry
      ? `Поменять версию: ${title || "мод"}`
      : `${title || "Версии"} — выбор версии`;
    $("#ver-body").innerHTML = `<div class="empty-state">Загружаем версии…</div>`;
    const meta = selected();
    // На главной ещё не выбрана цель: старые фильтры вкладки сборки не
    // должны скрывать версии, подходящие для других или новой сборки.
    const mc = !meta || kind === "pack" ? null : (replaceEntry ? meta.mc_version : (state.modrinth.mc || meta.mc_version));
    const loader = !meta || kind === "pack" ? null : (replaceEntry
      ? (kind === "mod" ? meta.loader?.type || null : null)
      : (state.modrinth.loader || meta.loader?.type || null));
    let versions = [];
    try {
      versions = await api.modrinthVersions(projectId, mc, loader);
    } catch (err) {
      $("#ver-body").innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(String(err))}</div>`;
      return;
    }
    if (!versions.length) {
      $("#ver-body").innerHTML = `<div class="empty-state">Подходящих версий нет${mc ? ` (MC ${esc(mc)}${loader ? `, ${esc(loader)}` : ""})` : ""}. Попробуй снять фильтры.</div>`;
      return;
    }
    $("#ver-body").innerHTML = `
      <div class="ver-list">
        ${versions.slice(0, 60).map((version) => {
          const isCurrent = Boolean(replaceEntry && replaceEntry.version_id && version.id === replaceEntry.version_id);
          return `
          <div class="ver-row">
            <div class="ver-main">
              <div class="ver-name" translate="no">${esc(version.name || version.version_number)}</div>
              <div class="ver-meta">
                <span class="tag">${esc(version.version_number)}</span>
                ${(version.game_versions || []).slice(0, 3).map((gv) => `<span class="tag">${esc(gv)}</span>`).join("")}
                ${(version.loaders || []).slice(0, 2).map((ld) => `<span class="tag">${esc(ld)}</span>`).join("")}
                ${isCurrent ? `<span class="tag tag-installed">текущая</span>` : ""}
              </div>
            </div>
            <span class="ver-date">${(version.date_published || "").slice(0, 10)}</span>
            <button class="btn btn-primary" data-install-version="${esc(version.id)}" data-kind="${kind}"${replaceEntry ? ` data-replace="${esc(replaceEntry.filename)}"` : ""}${isCurrent ? " disabled" : ""}>${replaceEntry ? "Заменить" : "Установить"}</button>
          </div>`;
        }).join("")}
      </div>`;
    $$("[data-install-version]").forEach((btn) => btn.addEventListener("click", () => {
      if (btn.dataset.replace) replaceModVersion(btn.dataset.replace, btn.dataset.installVersion, btn.dataset.kind, btn);
      else installVersion(btn.dataset.installVersion, btn.dataset.kind, btn, projectId,
        versions.find((version) => String(version.id) === btn.dataset.installVersion), title);
    }));
  }

  /** Заменить установленный файл на выбранную версию (ПКМ → «Поменять версию»). */
  async function replaceModVersion(filename, versionId, kind, btn) {
    const meta = selected();
    if (!meta) return toast("Сначала выбери сборку", "err");
    if (btn) { btn.disabled = true; btn.textContent = "Меняем…"; }
    try {
      await withDownloading(null, (op) => api.replaceModVersion(meta.id, kind, filename, versionId, op), { instanceId: meta.id, source: "modrinth" });
      state.contentUpdates[kind] = (state.contentUpdates[kind] || []).filter((item) => item.filename !== filename);
      const modal = $("#modal-versions");
      if (modal) modal.hidden = true;
      renderContent(kind);
      toast("Версия мода заменена", "ok");
    } catch (err) {
      toast(String(err), "err");
      if (btn) { btn.disabled = false; btn.textContent = "Заменить"; }
    }
  }

  async function installVersion(versionId, kind, btn, projectId, version, title) {
    const modal = $("#modal-versions");
    if (btn) { btn.disabled = true; btn.textContent = "Ставим…"; }
    try {
      if (kind === "pack") {
        const meta = await withInstallProgress("modpack", "modpack", (op) => api.installModpack(versionId, op));
        await refreshInstances();
        openInstance(meta.id);
        toast(`Ваша сборка «${meta.name}» установлена`, "ok");
      } else {
        const meta = selected();
        if (!meta) {
          if (!version || String(version.id) !== String(versionId)) throw new Error("Не удалось проверить выбранную версию мода");
          if (await installHomeMod("modrinth", projectId, title, version)) { if (modal) modal.hidden = true; }
          return;
        }
        const outcome = await withDownloading(projectId, (op) => api.installModVersion(meta.id, versionId, op, projectId), { instanceId: meta.id, source: "modrinth" });
        toast(outcome.installed.length ? `Ваш мод установлен: ${outcome.installed.join(", ")}` : "Файл уже существует и не был перезаписан", outcome.installed.length ? "ok" : "");
      }
      if (modal) modal.hidden = true;
    } catch (err) {
      toast(String(err), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Установить"; }
    }
  }

  async function runSearch() {
    cancelDownloadSearchTimer();
    const cfg = state.modrinth;
    if (catalogVisible("modrinth") && $("#dl-query")) state.modsQuery = cfg.query = $("#dl-query").value;
    const generation = ++mrSearchGeneration;
    const params = searchQuery(0);
    cfg.loading = true;
    cfg.loadingMore = false;
    cfg.tried = true;
    cfg.error = null;
    cfg.results = [];
    cfg.total = 0;
    renderCatalogSource("modrinth");
    try {
      const result = await api.search(params);
      if (generation !== mrSearchGeneration) return;
      cfg.results = result.hits || [];
      cfg.total = result.total_hits ?? cfg.results.length;
      cfg.error = null;
    } catch (err) {
      if (generation !== mrSearchGeneration) return;
      cfg.results = [];
      cfg.total = 0;
      cfg.error = String(err);
    }
    cfg.loading = false;
    renderCatalogSource("modrinth");
  }

  async function installFromModrinth(projectId, kind, title) {
    if (kind === "pack") {
      try {
        const meta = await withInstallProgress("modpack", "modpack", async (op) => {
          const versions = await api.modrinthVersions(projectId, null, null);
          if (!versions.length) throw new Error("У модпака нет версий");
          toast("Скачиваем модпак…");
          return api.installModpack(versions[0].id, op);
        });
        await refreshInstances();
        openInstance(meta.id);
        toast(`Ваша сборка «${meta.name}» установлена`, "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    const meta = selected();
    if (!meta) return installHomeMod("modrinth", projectId, title);
    try {
      const outcome = await withDownloading(projectId, (op) => api.installMod(meta.id, projectId, op), { instanceId: meta.id, source: "modrinth" });
      toast(outcome.installed.length ? `Ваш мод установлен: ${outcome.installed.join(", ")}` : "Файл уже существует и не был перезаписан", outcome.installed.length ? "ok" : "");
    } catch (err) { toast(String(err), "err"); }
  }

/* ==================== CURSEFORGE ==================== */

  const CF_PAGE = 24;
  let cfObserver = null;

  function cfGridLevel() { return modsGridLevel(); }
  function cfColumns(level = modsGridLevel()) { return modsColumns(level); }

  /** Куда ведёт страница проекта на curseforge.com. */
  function cfPath(projectType) {
    if (projectType === "resourcepack") return "texture-packs";
    if (projectType === "shader") return "shaders";
    if (projectType === "modpack") return "modpacks";
    return "mc-mods";
  }

  const CF_SORTS = [["downloads", "По загрузкам"], ["updated", "Обновлённые"], ["newest", "Новые"], ["follows", "Популярные"]];

  function renderCurseForge(container) {
    const root = container || state.dlRoot || $("#tab-body");
    const meta = selected();
    const cfg = state.curseforge;
    const view = state.modsView;
    // модпаки ставим отдельной сборкой, моды/ресурспаки/шейдеры — в текущую
    replaceCatalogHtml(root, `
      <div class="download-source-view">
        <div class="download-catalog-layout">
          ${downloadFilterPanelHtml("curseforge", cfg, meta)}
          <div class="modrinth-results ${view === "grid" ? `is-grid feed-grid-${modsGridLevel()}` : ""}" id="cf-results" style="--feed-cols:${modsColumns()}">
            ${cfResultsHtml()}
          </div>
        </div>
      </div>`);

    bindDownloadFilterControls("curseforge");
    bindCfEvents();
    const retry = $("#cf-retry");
    if (retry) retry.addEventListener("click", () => cfRunSearch());
    bindCatalogResize();
    cfWatchMore();
    if (!cfg.tried && !cfg.loading && !cfg.error) cfRunSearch();
  }

  function cfResultsHtml() {
    const cfg = state.curseforge;
    if (cfg.loading && !cfg.results.length) return `<div class="empty-state">Ищем на CurseForge…</div>`;
    if (cfg.error) {
      return `<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="max-width:640px;text-align:left;white-space:pre-wrap;font-size:12px;color:var(--red)">${esc(cfg.error)}</div>
        <button class="btn" id="cf-retry">Повторить</button>
      </div>`;
    }
    if (!cfg.results.length) return `<div class="empty-state">Ничего не найдено — попробуй другой запрос или фильтры</div>`;
    return `${cfg.results.map(cfCardHtml).join("")}<div class="mr-sentinel" id="cf-sentinel">${cfSentinelText()}</div>`;
  }

  function cfSentinelText() {
    const cfg = state.curseforge;
    if (cfg.loadingMore) return `<span class="mr-more-spinner"></span>Загружаем ещё…`;
    if (cfg.results.length >= cfg.total) return `Показано всё: ${cfg.results.length}`;
    return `Прокрути вниз — ещё ${Math.max(0, cfg.total - cfg.results.length)}`;
  }

  function cfWatchMore() {
    if (cfObserver) { cfObserver.disconnect(); cfObserver = null; }
    const sentinel = $("#cf-sentinel");
    if (!sentinel || state.curseforge.results.length >= state.curseforge.total) return;
    cfObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) cfLoadMore();
    }, { rootMargin: "200px" });
    cfObserver.observe(sentinel);
  }

  function cfUpdateSentinel() {
    const sentinel = $("#cf-sentinel");
    if (sentinel) sentinel.innerHTML = cfSentinelText();
    const cfg = state.curseforge;
    if (sentinel && !cfg.loadingMore && cfg.results.length >= cfg.total) {
      if (cfObserver) { cfObserver.disconnect(); cfObserver = null; }
    }
  }

  async function cfLoadMore() {
    const cfg = state.curseforge;
    if (!catalogVisible("curseforge") || cfg.loading || cfg.loadingMore || cfg.error) return;
    if (!cfg.results.length || cfg.results.length >= cfg.total) return;
    cfg.loadingMore = true;
    const generation = cfSearchGeneration;
    const params = cfSearchQuery(cfg.results.length);
    cfUpdateSentinel();
    try {
      const page = await api.searchCurseforge(params);
      if (generation !== cfSearchGeneration) return;
      const known = new Set(cfg.results.map((hit) => hit.project_id));
      const fresh = (page.hits || []).filter((hit) => !known.has(hit.project_id));
      cfg.results = cfg.results.concat(fresh);
      cfg.total = page.total_hits ?? cfg.total;
      const container = catalogVisible("curseforge") && $("#cf-results");
      if (container && fresh.length) {
        const sentinel = $("#cf-sentinel");
        const html = fresh.map(cfCardHtml).join("");
        if (sentinel) sentinel.insertAdjacentHTML("beforebegin", html);
        else container.insertAdjacentHTML("beforeend", html);
        bindCfEvents();
      }
      if (!fresh.length) cfg.total = cfg.results.length;
    } catch (err) {
      if (generation !== cfSearchGeneration) return;
      cfg.error = String(err);
      cfg.loadingMore = false;
      renderCatalogSource("curseforge");
      return;
    }
    cfg.loadingMore = false;
    if (catalogVisible("curseforge")) {
      cfUpdateSentinel();
      cfWatchMore();
    }
  }

  function cfSearchQuery(offset) {
    const cfg = state.curseforge;
    const meta = selected();
    return {
      query: cfg.query,
      projectType: cfg.type,
      mcVersion: cfg.mc || (meta ? meta.mc_version : null),
      loader: ["mod", "modpack"].includes(cfg.type)
        ? (cfg.loader || (cfg.type === "mod" && meta && meta.loader ? meta.loader.type : null)) : null,
      categories: [downloadCategoryValue(cfg)].filter(Boolean),
      offset: offset || 0,
      limit: CF_PAGE,
      sort: cfg.sort || "downloads"
    };
  }

  function cfCardHtml(hit, forcedType = null) {
    // Array.map передаёт вторым аргументом индекс; явный тип нужен ленте.
    const openType = typeof forcedType === "string" ? forcedType : (state.curseforge.type || "mod");
    return `<div class="card${projectInstalled(hit.project_id, "curseforge", openType) ? " is-installed" : ""}${projectStatus(hit.project_id, "curseforge", openType) === "downloading" ? " is-downloading" : ""}" role="group" aria-label="${esc(projectLabel(hit.title, hit.project_id, "curseforge", openType))}" data-cf-project="${esc(hit.project_id)}" data-project-type="${esc(openType)}" data-cf-slug="${esc(hit.slug || hit.project_id)}" data-cf-title="${esc(hit.title)}">
      <div class="card-icon">${hit.icon_url ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy">` : `<span class="card-letter" translate="no">${esc(String(hit.title || "?").trim().charAt(0).toUpperCase())}</span>`}</div>
      <div class="card-body">
        <div class="card-title" translate="no">${esc(hit.title)}</div>
        <div class="card-desc" translate="no">${esc(hit.description)}</div>
        <div class="card-meta">
          ${projectBadge(hit.project_id, "curseforge", openType)}
          <span class="tag">curseforge</span>
          ${(hit.categories || []).slice(0, 2).map((cat) => `<span class="tag" translate="no">${esc(cat)}</span>`).join("")}
          <span class="tag">${(hit.downloads || 0).toLocaleString(I18N.locale())} ⬇</span>
        </div>
        <div class="card-actions">
          ${openType === "modpack"
            ? `<button class="icon-btn card-icon-btn is-primary" data-cf-pack-install="${esc(hit.project_id)}" data-cf-title="${esc(hit.title)}" title="Установить как сборку" aria-label="Установить"><svg class="ic"><use href="#i-download"/></svg></button>`
            : `<button class="icon-btn card-icon-btn is-primary" data-cf-install="${esc(hit.project_id)}" data-cf-title="${esc(hit.title)}" title="Скачать и установить" aria-label="Скачать"><svg class="ic"><use href="#i-download"/></svg></button>`}
          <button class="icon-btn card-icon-btn" data-cf-versions="${esc(hit.project_id)}" data-cf-title="${esc(hit.title)}" title="Версии" aria-label="Версии">
            <svg class="ic"><use href="#i-list"/></svg>
          </button>
          <button class="icon-btn card-icon-btn" data-cf-page="${esc(hit.slug || hit.project_id)}" data-cf-type="${esc(openType)}" title="Страница проекта" aria-label="Страница">
            <svg class="ic"><use href="#i-link"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  }

  /** Карточка модпака CurseForge: ставится отдельной сборкой, а не в текущую. */
  function cfPackCardHtml(hit) {
    return `<div class="card" role="group" aria-label="${esc(hit.title)}" data-project-type="modpack" data-cf-project="${esc(hit.project_id)}" data-cf-slug="${esc(hit.slug || hit.project_id)}" data-cf-title="${esc(hit.title)}">
      <div class="card-icon">${hit.icon_url ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy">` : `<span class="card-letter" translate="no">${esc(String(hit.title || "?").trim().charAt(0).toUpperCase())}</span>`}</div>
      <div class="card-body">
        <div class="card-title" translate="no">${esc(hit.title)}</div>
        <div class="card-desc" translate="no">${esc(hit.description)}</div>
        <div class="card-meta">
          ${projectBadge(hit.project_id, "curseforge", "modpack")}
          <span class="tag">curseforge</span>
          ${(hit.categories || []).slice(0, 2).map((cat) => `<span class="tag" translate="no">${esc(cat)}</span>`).join("")}
          <span class="tag">${(hit.downloads || 0).toLocaleString(I18N.locale())} ⬇</span>
        </div>
        <div class="card-actions">
          <button class="icon-btn card-icon-btn is-primary" data-cf-pack-install="${esc(hit.project_id)}" data-cf-title="${esc(hit.title)}" title="Установить как сборку" aria-label="Установить">
            <svg class="ic"><use href="#i-download"/></svg>
          </button>
          <button class="icon-btn card-icon-btn" data-cf-pack-versions="${esc(hit.project_id)}" data-cf-title="${esc(hit.title)}" title="Версии модпака" aria-label="Версии">
            <svg class="ic"><use href="#i-list"/></svg>
          </button>
          <button class="icon-btn card-icon-btn" data-cf-page="${esc(hit.slug || hit.project_id)}" data-cf-type="modpack" title="Страница проекта" aria-label="Страница">
            <svg class="ic"><use href="#i-link"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  }

  /** Установка модпака CurseForge отдельной сборкой. */
  async function installCfPack(projectId, fileId, btn, title) {
    if (btn) { btn.disabled = true; }
    toast(`Ставим сборку${title ? ` «${title}»` : ""} — это может занять пару минут`, "info");
    try {
      const meta = await withInstallProgress("modpack", "modpack", (op) => api.installCurseforgeModpack(projectId, fileId || null, op));
      toast(`Сборка «${meta && meta.name ? meta.name : "модпак"}» готова`, "ok");
      try {
        const list = await api.instances();
        state.instances = list || state.instances;
        renderSidebar();
      } catch (_) { /* список обновится при следующем рендере */ }
      if ($("#modal-versions")) $("#modal-versions").hidden = true;
      if (state.tab === "discover" || state.tab === "download") renderTab();
      else if (state.tab === "console") renderSidebar();
    } catch (err) {
      toast(String(err), "err");
    } finally {
      if (btn) { btn.disabled = false; }
    }
  }

  function bindCfEvents() {
    $$(".card[data-cf-project]").forEach((card) => {
      if (card.dataset.cfBound) return;
      card.dataset.cfBound = "1";
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        openCfProjectModal(card.dataset.cfProject, card.dataset.cfTitle, card.dataset.cfSlug, card.dataset.projectType);
      });
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const id = card.dataset.cfProject;
        const title = card.dataset.cfTitle;
        const type = card.dataset.projectType || "mod";
        const pack = type === "modpack";
        const url = `https://www.curseforge.com/minecraft/${cfPath(type)}/${card.dataset.cfSlug}`;
        fillCtxMenu(event.clientX, event.clientY, `
          <div class="ctx-caption" translate="no">${esc(title)}</div>
          <button class="ctx-item" data-act="install"><svg class="ic"><use href="#i-download"/></svg>${pack ? "Установить как сборку" : "Установить"}</button>
          <button class="ctx-item" data-act="versions"><svg class="ic"><use href="#i-list"/></svg>Версии</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" data-act="page"><svg class="ic"><use href="#i-link"/></svg>Открыть страницу</button>
          <button class="ctx-item" data-act="copy"><svg class="ic"><use href="#i-copy"/></svg>Копировать ссылку</button>`,
        (act) => {
          if (act === "install") pack ? installCfPack(id, null, null, title) : installFromCurseForge(id, null, title);
          else if (act === "versions") openCfVersions(id, title, type);
          else if (act === "page") api.openUrl(url).catch((error) => toast(String(error), "err"));
          else if (act === "copy") copyText(url);
        });
      });
    });
    $$("[data-cf-install]").forEach((btn) => {
      if (btn.dataset.cfBound) return;
      btn.dataset.cfBound = "1";
      btn.addEventListener("click", () => installFromCurseForge(btn.dataset.cfInstall, btn, btn.dataset.cfTitle));
    });
    $$("[data-cf-versions]").forEach((btn) => {
      if (btn.dataset.cfBound) return;
      btn.dataset.cfBound = "1";
      btn.addEventListener("click", () => openCfVersions(btn.dataset.cfVersions, btn.dataset.cfTitle, btn.closest(".card")?.dataset.projectType));
    });
    $$("[data-cf-pack-install]").forEach((btn) => {
      if (btn.dataset.cfBound) return;
      btn.dataset.cfBound = "1";
      btn.addEventListener("click", () => installCfPack(btn.dataset.cfPackInstall, null, btn, btn.dataset.cfTitle));
    });
    $$("[data-cf-pack-versions]").forEach((btn) => {
      if (btn.dataset.cfBound) return;
      btn.dataset.cfBound = "1";
      btn.addEventListener("click", () => openCfVersions(btn.dataset.cfPackVersions, btn.dataset.cfTitle, "modpack"));
    });
    $$("[data-cf-page]").forEach((btn) => {
      if (btn.dataset.cfBound) return;
      btn.dataset.cfBound = "1";
      btn.addEventListener("click", () => {
        const type = btn.dataset.cfType || state.curseforge.type || "mod";
        api.openUrl(`https://www.curseforge.com/minecraft/${cfPath(type)}/${btn.dataset.cfPage}`)
          .catch((error) => toast(String(error), "err"));
      });
    });
  }

  async function cfRunSearch() {
    cancelDownloadSearchTimer();
    const cfg = state.curseforge;
    if (catalogVisible("curseforge") && $("#dl-query")) state.modsQuery = cfg.query = $("#dl-query").value;
    const generation = ++cfSearchGeneration;
    const params = cfSearchQuery(0);
    cfg.loading = true;
    cfg.loadingMore = false;
    cfg.tried = true;
    cfg.error = null;
    cfg.results = [];
    cfg.total = 0;
    renderCatalogSource("curseforge");
    try {
      const page = await api.searchCurseforge(params);
      if (generation !== cfSearchGeneration) return;
      cfg.results = page.hits || [];
      cfg.total = page.total_hits ?? cfg.results.length;
      cfg.error = null;
    } catch (err) {
      if (generation !== cfSearchGeneration) return;
      cfg.results = [];
      cfg.total = 0;
      cfg.error = String(err);
    }
    cfg.loading = false;
    renderCatalogSource("curseforge");
  }

  async function installFromCurseForge(projectId, btn, title) {
    const meta = selected();
    if (!meta) return installHomeMod("curseforge", projectId, title);
    if (btn) { btn.disabled = true; }
    try {
      const outcome = await withDownloading(projectId, (op) => api.installCurseforge(meta.id, projectId, null, op), { instanceId: meta.id, source: "curseforge" });
      toast(
        outcome.installed.length
          ? `Ваш мод установлен: ${outcome.installed.join(", ")}`
          : `Файл уже существует и не был перезаписан${outcome.skipped.length ? `: ${outcome.skipped.join(", ")}` : ""}`,
        outcome.installed.length ? "ok" : ""
      );
    } catch (err) {
      toast(String(err), "err");
    } finally {
      if (btn) { btn.disabled = false; }
    }
  }

  async function openCfProjectModal(projectId, title, slug, typeHint) {
    const modal = $("#modal-project");
    if (!modal) return;
    const generation = beginProjectModal(title, "CurseForge");
    let project = null;
    let error = null;
    try { project = await api.curseforgeProject(projectId); }
    catch (err) { error = String(err); }
    if (generation !== projectRequestGeneration || modal.hidden) return;
    const projectType = project?.project_type || typeHint || state.curseforge.type || "mod";
    const slugOrId = project?.slug || project?.id || slug || projectId;
    const siteUrl = `https://www.curseforge.com/minecraft/${cfPath(projectType)}/${slugOrId}`;
    if (project) renderProjectDetails(project, title, "curseforge");
    else $("#proj-body").innerHTML = `<div class="proj-empty" style="color:var(--red)">Не удалось получить сведения: ${esc(error || "нет данных")}</div>`;
    const projectTitle = title || project?.title || "Проект";
    $("#proj-site").disabled = false;
    $("#proj-site").onclick = () => api.openUrl(siteUrl).catch((error) => toast(String(error), "err"));
    $("#proj-versions").disabled = false;
    $("#proj-versions").onclick = () => {
      closeProjectModal();
      openCfVersions(projectId, projectTitle, projectType);
    };
    const installBtn = $("#proj-install");
    installBtn.disabled = !project;
    installBtn.onclick = () => {
      closeProjectModal();
      if (projectType === "modpack") installCfPack(projectId, null, null, projectTitle);
      else installFromCurseForge(projectId, null, projectTitle);
    };
  }

  async function openCfVersions(projectId, title, kind) {
    const modal = $("#modal-versions");
    if (!modal) return;
    modal.hidden = false;
    $("#ver-title").textContent = `${title || "Версии"} — выбор версии`;
    $("#ver-body").innerHTML = `<div class="empty-state">Загружаем файлы с CurseForge…</div>`;
    // Явный тип карточки важнее старого фильтра другой вкладки.
    const pack = kind ? kind === "modpack" : state.curseforge.type === "modpack";
    const meta = pack ? null : selected();
    const mc = meta ? (state.curseforge.mc || meta.mc_version) : null;
    const loader = meta ? (state.curseforge.loader || meta.loader?.type || null) : null;
    let versions = [];
    try {
      versions = await api.curseforgeVersions(projectId, mc, loader);
    } catch (err) {
      $("#ver-body").innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(String(err))}</div>`;
      return;
    }
    if (!versions.length) {
      $("#ver-body").innerHTML = `<div class="empty-state">Подходящих файлов нет${mc ? ` (MC ${esc(mc)}${loader ? `, ${esc(loader)}` : ""})` : ""}.</div>`;
      return;
    }
    $("#ver-body").innerHTML = `
      <div class="ver-list">
        ${versions.slice(0, 60).map((version) => `
          <div class="ver-row">
            <div class="ver-main">
              <div class="ver-name" translate="no">${esc(version.name || version.version_number)}</div>
              <div class="ver-meta">
                <span class="tag">${esc(version.version_number)}</span>
                ${(version.game_versions || []).slice(0, 3).map((gv) => `<span class="tag">${esc(gv)}</span>`).join("")}
                ${(version.loaders || []).slice(0, 2).map((ld) => `<span class="tag">${esc(ld)}</span>`).join("")}
              </div>
            </div>
            <span class="ver-date">${(version.date_published || "").slice(0, 10)}</span>
            <button class="btn btn-primary" data-cf-install-version="${esc(version.id)}">Установить</button>
          </div>`).join("")}
      </div>`;
    $$("[data-cf-install-version]").forEach((btn) => btn.addEventListener("click", () => (
      pack
        ? installCfPack(projectId, btn.dataset.cfInstallVersion, btn, title)
        : installCfFile(projectId, btn.dataset.cfInstallVersion, btn,
          versions.find((version) => String(version.id) === btn.dataset.cfInstallVersion), title)
    )));
  }

  async function installCfFile(projectId, fileId, btn, version, title) {
    const meta = selected();
    if (btn) { btn.disabled = true; btn.textContent = "Ставим…"; }
    const modal = $("#modal-versions");
    try {
      if (!meta) {
        if (!version || String(version.id) !== String(fileId)) throw new Error("Не удалось проверить выбранную версию мода");
        if (await installHomeMod("curseforge", projectId, title, version)) { if (modal) modal.hidden = true; }
        return;
      }
      const outcome = await withDownloading(projectId, (op) => api.installCurseforge(meta.id, projectId, fileId, op), { instanceId: meta.id, source: "curseforge" });
      toast(outcome.installed.length ? `Ваш мод установлен: ${outcome.installed.join(", ")}` : "Файл уже существует и не был перезаписан", outcome.installed.length ? "ok" : "");
      if (modal) modal.hidden = true;
    } catch (err) {
      toast(String(err), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Установить"; }
    }
  }

  /* ==================== АККАУНТЫ ==================== */
  const kindLabel = (kind) => (kind === "microsoft" ? "лицензия" : "пиратка");
  const kindClass = (kind) => (kind === "microsoft" ? "tag green" : "tag");

  function activeAccount() {
    const list = (state.accounts && state.accounts.accounts) || [];
    const activeId = state.accounts && state.accounts.active;
    return list.find((item) => item.uuid === activeId) || list[0] || null;
  }

  function currentProfileId() { return activeAccount()?.uuid || ""; }

  /** Скин аккаунта: у лицензии голова по UUID, у офлайна — по нику. */
  /** Метка кеша скинов: раз в час и принудительно после смены скина. */
  function skinStampBump() {
    state.skinStamp = String(Date.now());
    return state.skinStamp;
  }

  function skinStamp() {
    if (!state.skinStamp) state.skinStamp = String(Math.floor(Date.now() / 3600000));
    return state.skinStamp;
  }

  /**
   * Скин по нику. Без метки webview держал картинку вечно — скин в игре менялся,
   * а в лаунчере оставался старый.
   */
  function skinUrl(account) {
    if (!account) return "";
    const own = ownSkinHeadUrl(account);
    if (own) return own;
    const key = account.kind === "microsoft" ? (account.uuid || account.username) : account.username;
    if (!key) return "";
    return `https://mc-heads.net/avatar/${encodeURIComponent(key)}/64?t=${skinStamp()}`;
  }

  /**
   * Голова из PNG, который лаунчер уже скачал у Mojang: внешний сервис кеширует
   * картинку по нику и продолжает отдавать старый скин после смены.
   */
  function ownSkinHeadUrl(account) {
    const skin = state.skin;
    if (!skin || !skin.accountTexture) return "";
    const active = activeAccount();
    if (!active || !account || account.uuid !== active.uuid) return "";
    if (skin.headUrl && skin.headStamp === skinStamp()) return skin.headUrl;
    try {
      skin.headUrl = headThumb(skin.accountTexture, 64).toDataURL("image/png");
      skin.headStamp = skinStamp();
    } catch (error) {
      return "";
    }
    return skin.headUrl;
  }

  /** Аватар: буква + скин поверх. Если скин не загрузился — остаётся буква. */
  function avatarHtml(account, extra = "") {
    const letter = String((account && account.username) || "?").charAt(0).toUpperCase();
    const url = skinUrl(account);
    return `<span class="acc-avatar ${extra}">` +
      `<span class="acc-letter" translate="no">${esc(letter)}</span>` +
      (url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
      `</span>`;
  }

  function accountRowHtml(account, activeId) {
    const active = account.uuid === activeId;
    return `
      <div class="acc-row ${active ? "is-active" : ""}" data-uuid="${esc(account.uuid)}">
        ${avatarHtml(account)}
        <span class="acc-main">
          <span class="acc-name" translate="no">${esc(account.username)}</span>
          <span class="acc-sub">${esc(kindLabel(account.kind))}</span>
        </span>
        ${active ? '<span class="acc-dot" title="Активный"></span>' : ""}
      </div>`;
  }

  /* ---------- чип профиля слева сверху ---------- */
  function renderAccountChip() {
    const account = activeAccount();
    const avatar = $("#account-chip-avatar");
    const name = $("#account-chip-name");
    const kind = $("#account-chip-kind");
    if (!avatar || !name) return;
    if (!account) {
      avatar.innerHTML = '<svg class="ic"><use href="#i-user"/></svg>';
      avatar.classList.remove("has-skin");
      name.removeAttribute("translate");
      name.textContent = "Нет аккаунта";
      kind.textContent = "добавить";
      return;
    }
    avatar.outerHTML = avatarHtml(account).replace('class="acc-avatar', 'id="account-chip-avatar" class="acc-avatar has-skin');
    name.setAttribute("translate", "no");
    name.textContent = account.username;
    kind.textContent = kindLabel(account.kind);
  }

  /* ---------- выпадающий список аккаунтов ---------- */
  function renderAccountPopover() {
    const pop = $("#account-pop");
    if (!pop) return;
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || (accounts[0] && accounts[0].uuid);
    const active = accounts.find((item) => item.uuid === activeId) || null;
    pop.innerHTML = `
      <div class="pop-head">Профиль</div>
      ${active ? `
        <div class="pop-active">
          ${avatarHtml(active, "lg")}
          <div class="pop-active-main">
            <div class="pop-active-name" translate="no">${esc(active.username)}</div>
            <div class="pop-active-sub">${esc(kindLabel(active.kind))}</div>
          </div>
        </div>` : `<div class="pop-empty">Аккаунта нет</div>`}
      ${accounts.length > 1 ? `
        <div class="pop-label">Другие аккаунты</div>
        <div class="pop-list">${accounts.filter((item) => item.uuid !== activeId).map((item) => accountRowHtml(item, activeId)).join("")}</div>` : ""}
      <div class="pop-sep"></div>
      <button class="pop-item" data-acc-act="add"><svg class="ic"><use href="#i-plus"/></svg>Добавить аккаунт</button>
      <button class="pop-item" data-acc-act="profile"><svg class="ic"><use href="#i-user"/></svg>Профиль и аккаунты</button>
      <button class="pop-item" data-acc-act="settings"><svg class="ic"><use href="#i-settings"/></svg>Настройки лаунчера</button>`;
    bindAccountPopover();
  }

  function bindAccountPopover() {
    const pop = $("#account-pop");
    if (!pop) return;
    $$(".acc-row", pop).forEach((row) => {
      row.addEventListener("click", async () => {
        try {
          state.accounts = await api.accountSetActive(row.dataset.uuid);
          closeAccountPopover();
          renderAccounts();
          toast("Аккаунт переключён", "ok");
        } catch (err) { toast(String(err), "err"); }
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const account = ((state.accounts && state.accounts.accounts) || []).find((item) => item.uuid === row.dataset.uuid);
        if (account) openAccountCtx(event.clientX, event.clientY, account);
      });
    });
    $$("[data-acc-act]", pop).forEach((btn) => btn.addEventListener("click", () => {
      const act = btn.dataset.accAct;
      closeAccountPopover();
      if (act === "add") openAccounts();
      if (act === "profile") openPrefs("profile");
      if (act === "settings") openPrefs();
    }));
  }

  function openAccountPopover() {
    const pop = $("#account-pop");
    const chip = $("#account-chip");
    if (!pop || !chip) return;
    renderAccountPopover();
    const rect = chip.getBoundingClientRect();
    pop.hidden = false;
    const popRect = pop.getBoundingClientRect();
    pop.style.left = `${Math.round(rect.left)}px`;
    pop.style.top = `${Math.round(rect.bottom + 6)}px`;
    pop.style.minWidth = `${Math.round(Math.max(rect.width, 240))}px`;
    if (rect.bottom + 6 + popRect.height > window.innerHeight - 8) {
      pop.style.top = `${Math.round(Math.max(8, rect.top - popRect.height - 6))}px`;
    }
    chip.setAttribute("aria-expanded", "true");
  }

  function closeAccountPopover() {
    const pop = $("#account-pop");
    if (pop) pop.hidden = true;
    const chip = $("#account-chip");
    if (chip) chip.setAttribute("aria-expanded", "false");
  }

  function toggleAccountPopover() {
    const pop = $("#account-pop");
    if (!pop) return;
    if (pop.hidden) openAccountPopover();
    else closeAccountPopover();
  }

  /* ---------- ПКМ по аккаунту ---------- */
  function openAccountCtx(x, y, account) {
    const el = $("#ctx-menu");
    if (!el) return;
    const activeId = (state.accounts && state.accounts.active) || "";
    const isActive = account.uuid === activeId;
    const offline = account.kind !== "microsoft";
    el.innerHTML = `
      <div class="ctx-caption"><span translate="no">${esc(account.username)}</span> · ${esc(kindLabel(account.kind))}</div>
      ${isActive ? "" : `<button class="ctx-item" data-act="pick"><svg class="ic"><use href="#i-play"/></svg>Выбрать аккаунт</button>`}
      <button class="ctx-item" data-act="rename" ${offline ? "" : "disabled"}><svg class="ic"><use href="#i-pencil"/></svg>Изменить ник${offline ? "" : " (нельзя)"}</button>
      <button class="ctx-item" data-act="copy"><svg class="ic"><use href="#i-copy"/></svg>Скопировать ник</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="profile"><svg class="ic"><use href="#i-user"/></svg>Профиль и аккаунты</button>
      <button class="ctx-item" data-act="add"><svg class="ic"><use href="#i-plus"/></svg>Добавить аккаунт</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="remove"><svg class="ic"><use href="#i-trash"/></svg>Удалить аккаунт</button>`;
    el.hidden = false;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    $$(".ctx-item", el).forEach((btn) => btn.addEventListener("click", () => {
      closeCtxMenu();
      runAccountAction(btn.dataset.act, account);
    }));
  }

  async function runAccountAction(action, account) {
    if (action === "pick") {
      try {
        state.accounts = await api.accountSetActive(account.uuid);
        renderAccounts();
        toast(`Аккаунт ${account.username}`, "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (action === "rename") {
      if (account.kind === "microsoft") return toast("Ник лицензии задаёт Mojang", "err");
      const name = await promptModal({ title: "Изменить ник", label: "Ник (3–16 символов)", value: account.username });
      if (name === null || !name.trim() || name.trim() === account.username) return;
      try {
        state.accounts = await api.accountRename(account.uuid, name.trim());
        renderAccounts();
        toast("Ник изменён", "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (action === "copy") {
      try { await navigator.clipboard.writeText(account.username); toast("Ник скопирован", "ok"); }
      catch { toast("Не удалось скопировать", "err"); }
      return;
    }
    if (action === "profile") { openPrefs("profile"); return; }
    if (action === "add") { openAccounts(); return; }
    if (action === "remove") {
      const okAccount = await askConfirm({
        title: "Удалить аккаунт",
        text: `Аккаунт «${account.username}» будет удалён из лаунчера.`,
        ok: "Удалить"
      });
      if (!okAccount) return;
      try {
        state.accounts = await api.accountRemove(account.uuid);
        renderAccounts();
        toast("Аккаунт удалён", "ok");
      } catch (err) { toast(String(err), "err"); }
    }
  }

  /** Обновляет чип, поповер, карточку в настройках и экран профиля. */
  function renderAccounts() {
    const accountId = currentProfileId();
    if (state.profileAccountId !== accountId) {
      state.profileAccountId = accountId;
      // Нельзя оставлять плащи или разрешение смены скина от другого аккаунта.
      // Отложенный выбор не должен отправиться после переключения аккаунта.
      if (state.capes?.selectionTimer) clearTimeout(state.capes.selectionTimer);
      state.skin = null;
      state.capes = null;
      state.capeTexture = null;
      state.capeTextureSrc = "";
      // Свою голову из профиля Minecraft загружаем и при запуске, и при
      // переключении вне настроек; не зависим только от стороннего кеша.
      if (activeAccount()?.kind === "microsoft") {
        refreshAccountSkin().then(() => { if (accountPrefsVisible()) renderPrefs(); });
      } else {
        skinState(); // офлайн-профиль сразу не имеет разрешения менять скин
      }
      if (accountPrefsVisible()) {
        refreshAccountCapes().then(() => { if (accountPrefsVisible()) renderPrefs(); });
      }
    }
    renderAccountChip();
    const pop = $("#account-pop");
    if (pop && !pop.hidden) renderAccountPopover();
    renderPrefsAccountCard();
    if (accountPrefsVisible()) renderPrefs();
  }

  /** Карточка активного аккаунта в колонке настроек (как в OmniPanel). */
  function renderPrefsAccountCard() {
    const button = $("#prefs-account");
    if (!button) return;
    const account = activeAccount();
    if (!account) {
      button.innerHTML = `<span class="acc-avatar"><svg class="ic"><use href="#i-user"/></svg></span>
        <span class="acc-main"><span class="acc-name">Нет аккаунта</span><span class="acc-sub">добавить</span></span>`;
      return;
    }
    button.innerHTML = `${avatarHtml(account, "sm")}
      <span class="acc-main">
        <span class="acc-name" translate="no">${esc(account.username)}</span>
        <span class="acc-sub">${esc(kindLabel(account.kind))}</span>
      </span>`;
  }

  async function loadAccounts() {
    try {
      state.accounts = await api.accounts();
    } catch (err) {
      state.accounts = { accounts: [], active: null };
    }
    renderAccounts();
  }

  /* отдельное окно аккаунтов: выбор «лицензия / пиратка» */
  function openAccounts() {
    const modal = $("#modal-account");
    if (!modal) return;
    modal.hidden = false;
    renderAccountModal("choose");
  }

  function renderAccountModal(mode, extra = {}) {
    const body = $("#acc-body");
    if (!body) return;
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || "";
    const list = accounts.length ? `
      <div class="account-list" style="margin-bottom:12px">
        ${accounts.map((account) => `
          <div class="acc-row ${account.uuid === activeId ? "is-active" : ""}" data-pick="${esc(account.uuid)}">
            ${avatarHtml(account)}
            <span class="acc-main">
              <span class="acc-name" translate="no">${esc(account.username)}</span>
              <span class="acc-sub">${esc(kindLabel(account.kind))}</span>
            </span>
            ${account.uuid === activeId ? '<span class="acc-dot" title="Активный"></span>' : ""}
            <button class="icon-btn" data-del="${esc(account.uuid)}" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
          </div>`).join("")}
      </div>` : "";

    if (mode === "choose") {
      body.innerHTML = `
        ${list}
        <div class="choice-grid">
          <button class="choice" data-mode="microsoft">
            <span class="choice-title">Лицензия</span>
            <span class="choice-sub">вход через Microsoft, серверы с online-mode, свой скин</span>
          </button>
          <button class="choice" data-mode="offline">
            <span class="choice-title">Пиратка</span>
            <span class="choice-sub">просто ник, без интернета и пароля</span>
          </button>
        </div>`;
      $$("[data-mode]", body).forEach((btn) => btn.addEventListener("click", () => renderAccountModal(btn.dataset.mode)));
    }

    if (mode === "offline") {
      body.innerHTML = `
        <div class="acc-pane">
          <div class="field acc-field">
            <label>Ник в игре (3–16 символов, латиница, цифры, «_»)</label>
            <input class="input" id="acc-username" placeholder="Steve" spellcheck="false" autocomplete="off" maxlength="16">
          </div>
          <div class="acc-actions">
            <button class="btn btn-ghost" data-back>Назад</button>
            <button class="btn btn-primary" id="acc-add-offline">Добавить</button>
          </div>
        </div>`;
      const input = $("#acc-username");
      input.focus();
      $("#acc-add-offline").addEventListener("click", async () => {
        try {
          state.accounts = await api.accountAddOffline(input.value.trim());
          renderAccounts();
          toast("Офлайн-аккаунт добавлен", "ok");
          $("#modal-account").hidden = true;
        } catch (err) { toast(String(err), "err"); }
      });
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") $("#acc-add-offline").click(); });
      $$("[data-back]", body).forEach((btn) => btn.addEventListener("click", () => renderAccountModal("choose")));
    }

    if (mode === "microsoft") {
      body.innerHTML = `
        <div class="device-wrap">
          <div class="device-label">Код для входа</div>
          <div class="device-code" id="acc-code">получаем код…</div>
          <button class="btn" id="acc-copy"><svg class="ic"><use href="#i-copy"/></svg>Скопировать код</button>
        </div>
        <div class="settings-note" id="acc-status">
          Открой <b>microsoft.com/link</b> на телефоне или в браузере и введи этот код.
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-back>Назад</button>
          <button class="btn btn-primary" id="acc-open-link">Открыть microsoft.com/link</button>
        </div>`;
      $$("[data-back]", body).forEach((btn) => btn.addEventListener("click", () => renderAccountModal("choose")));
      $("#acc-open-link").addEventListener("click", () => {
        const link = ($("#acc-open-link").dataset.uri) || "https://www.microsoft.com/link";
        api.openUrl(link).catch(() => {});
      });
      $("#acc-copy").addEventListener("click", async () => {
        const code = $("#acc-code") ? $("#acc-code").textContent.trim() : "";
        if (!code || code === "получаем код…") return;
        try {
          await navigator.clipboard.writeText(code);
          toast(`Код ${code} скопирован`, "ok");
        } catch (error) {
          toast(`Не удалось скопировать — код ${code}`, "err");
        }
      });
      startMicrosoftLogin();
    }

    $$("[data-pick]", body).forEach((row) => row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const account = ((state.accounts && state.accounts.accounts) || []).find((item) => item.uuid === row.dataset.pick);
      if (account) openAccountCtx(event.clientX, event.clientY, account);
    }));
    $$("[data-pick]", body).forEach((row) => row.addEventListener("click", async (event) => {
      if (event.target.closest("[data-del]")) return;
      try {
        state.accounts = await api.accountSetActive(row.dataset.pick);
        renderAccounts();
        renderAccountModal("choose");
      } catch (err) { toast(String(err), "err"); }
    }));
    $$("[data-del]", body).forEach((btn) => btn.addEventListener("click", async () => {
      try {
        state.accounts = await api.accountRemove(btn.dataset.del);
        renderAccounts();
        renderAccountModal("choose");
      } catch (err) { toast(String(err), "err"); }
    }));
  }

  /** Device-code вход: показываем код и опрашиваем Microsoft, пока не подтвердят. */
  async function startMicrosoftLogin() {
    const codeBox = $("#acc-code");
    const status = $("#acc-status");
    const setStatus = (text, kind = "") => {
      if (!status) return;
      status.innerHTML = text;
      status.className = `settings-note${kind ? ` ${kind}` : ""}`;
    };
    let flow;
    try {
      flow = await api.msStart();
    } catch (err) {
      if (codeBox) codeBox.textContent = "—";
      setStatus(`Microsoft недоступен: ${esc(String(err))}`, "warn");
      return;
    }
    if (codeBox) { codeBox.setAttribute("translate", "no"); codeBox.textContent = flow.user_code; }
    setStatus("Ждём подтверждения… Открой <b>microsoft.com/link</b> и введи код выше.");
    const link = $("#acc-open-link");
    if (link) link.dataset.uri = flow.verification_uri || "https://www.microsoft.com/link";

    const deadline = Date.now() + (flow.expires_in || 900) * 1000;
    const interval = Math.max(3, flow.interval || 5) * 1000;

    const tick = async () => {
      if ($("#modal-account") && $("#modal-account").hidden) return;
      if (Date.now() > deadline) {
        setStatus("Код истёк — начни вход заново.", "warn");
        return;
      }
      try {
        const result = await api.msPoll(flow.device_code);
        if (result) {
          state.accounts = result;
          renderAccounts();
          toast("Вход выполнен — аккаунт лицензии добавлен", "ok");
          $("#modal-account").hidden = true;
          return;
        }
        setStatus("Ждём подтверждения… Открой <b>microsoft.com/link</b> и введи код выше.");
      } catch (err) {
        setStatus(`Не получилось: ${esc(String(err))}`, "warn");
        return;
      }
      setTimeout(tick, interval);
    };
    setTimeout(tick, interval);
  }

  /* ==================== НАСТРОЙКИ ЛАУНЧЕРА (по категориям) ==================== */
  const PREFS = [
    { id: "profile", label: "Профиль" },
    { id: "avatar", label: "Аватар" },
    { id: "look", label: "Оформление" },
    { id: "wall", label: "Фон" },
    { id: "fx", label: "Эффекты" },
    { id: "sound", label: "Звуки" },
    { id: "game", label: "Игра и Java" },
    { id: "updates", label: "Обновления" },
    { id: "discord", label: "Discord" }
  ];
  let prefsCategory = "look";
  // Списки аватара переживают перерисовку и переход в другие категории.
  const avatarScroll = { skins: 0, capes: 0, capeTop: 0, accountId: "" };

  function accountPrefsVisible() {
    const modal = $("#modal-prefs");
    return Boolean(modal && !modal.hidden && (prefsCategory === "profile" || prefsCategory === "avatar"));
  }

  function openPrefs(category) {
    const modal = $("#modal-prefs");
    if (!modal) return;
    if (category) prefsCategory = category;
    const settings = state.settings || {};
    state.wall = {
      wallpaper: settings.wallpaper || null,
      fit: settings.wallpaper_fit || "cover",
      blur: Number(settings.wallpaper_blur ?? 0),
      dim: Number(settings.wallpaper_dim ?? 40),
      // Старая запись custom указывает на единственный прежний файл.
      recent: normalizeWallpaperHistory(settings.wallpaper_recent, settings.custom_wallpaper)
    };
    skinState();
    // скин аккаунта тянем при каждом открытии настроек: лицензия могла появиться только что
    refreshAccountSkin().then(() => {
      if (accountPrefsVisible()) renderPrefs();
    });
    refreshAccountCapes().then(() => {
      if (accountPrefsVisible()) renderPrefs();
    });
    modal.hidden = false;
    renderPrefsAccountCard();
    renderPrefs();
  }

  function renderPrefs() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return;
    }
    const nav = $("#prefs-nav");
    const body = $("#prefs-body");
    if (!nav || !body) return;
    if (!nav.children.length) {
      nav.innerHTML = PREFS.map((item) => `
        <button class="prefs-tab" data-pref="${item.id}">${item.label}</button>`).join("");
      $$(".prefs-tab", nav).forEach((tab) => tab.addEventListener("click", () => {
        prefsCategory = tab.dataset.pref;
        renderPrefs();
      }));
    }
    $$(".prefs-tab", nav).forEach((tab) => tab.classList.toggle("is-active", tab.dataset.pref === prefsCategory));
    const settings = state.settings || {};
    const previousCategory = body.dataset.prefCategory || "";
    if (previousCategory !== prefsCategory) animateView(body);
    refreshActiveIndicators();
    const keepScroll = previousCategory === prefsCategory ? body.scrollTop : 0;
    // Выбор плаща перерисовывает гардероб. Сохраняем фокус карточки, чтобы
    // после Enter/пробела можно было продолжить пользоваться стрелками.
    const focusedCape = previousCategory === "avatar" && prefsCategory === "avatar"
      && body.dataset.avatarAccount === currentProfileId()
      ? document.activeElement?.closest?.("#skin-capes .cape-card") : null;
    const focusedCapeId = focusedCape?.dataset.capeId;
    if (previousCategory === "avatar") {
      avatarScroll.skins = $("#skin-library", body)?.scrollTop || 0;
      avatarScroll.capes = $("#skin-capes", body)?.scrollLeft || 0;
      avatarScroll.capeTop = $("#skin-capes", body)?.scrollTop || 0;
      avatarScroll.accountId = body.dataset.avatarAccount || "";
    }
    const accountId = currentProfileId();
    if (avatarScroll.accountId !== accountId) {
      avatarScroll.capes = 0;
      avatarScroll.capeTop = 0;
      avatarScroll.accountId = accountId;
    }
    body.classList.toggle("is-avatar", prefsCategory === "avatar");
    body.dataset.prefCategory = prefsCategory;
    body.dataset.avatarAccount = accountId;
    renderPrefsAccountCard();
    if (prefsCategory === "profile") body.innerHTML = prefsProfile();
    if (prefsCategory === "avatar") body.innerHTML = prefsAvatar();
    if (prefsCategory === "look") body.innerHTML = prefsLook(settings);
    if (prefsCategory === "wall") body.innerHTML = prefsWall(settings);
    if (prefsCategory === "fx") body.innerHTML = prefsFx();
    if (prefsCategory === "game") body.innerHTML = prefsGame(settings);
    if (prefsCategory === "updates") body.innerHTML = prefsUpdates(settings);
    if (prefsCategory === "discord") body.innerHTML = prefsDiscord(settings);
    if (prefsCategory === "sound") body.innerHTML = prefsSound(settings);
    bindPrefs();
    if (prefsCategory === "profile") bindPrefsProfile();
    if (prefsCategory === "avatar") {
      bindCapes();
      bindFavorites();
      bindSkin();
      const library = $("#skin-library", body);
      const capes = $("#skin-capes", body);
      if (library) library.scrollTop = avatarScroll.skins;
      if (capes) {
        capes.scrollLeft = avatarScroll.capes;
        capes.scrollTop = avatarScroll.capeTop;
        // При первом открытии ставим активный вариант в центр; при повторном
        // входе сохраняем ровно ту позицию, которую оставил пользователь.
        if (capeView() === "list" && avatarScroll.capes === 0) {
          centerCapeCard($(".cape-card.is-active", capes), capes);
        }
      }
      updateCapeScrollControls();
      if (capes && focusedCapeId !== undefined) {
        $$(".cape-card", capes).find((card) => card.dataset.capeId === focusedCapeId)?.focus({ preventScroll: true });
      }
    }
    if (prefsCategory === "wall") bindWallpaperLinks();
    body.scrollTop = keepScroll;
  }

  /** Компоновка профиля: аккаунты слева; профиль и избранное справа. */
  function prefsProfile() {
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || (accounts[0] && accounts[0].uuid);
    const active = accounts.find((item) => item.uuid === activeId) || null;
    return `
      <div class="profile-grid">
        <section class="prefs-section profile-accounts">
          <div class="prefs-label-row">
            <span class="prefs-label">Аккаунты</span><div class="spacer"></div>
            <button class="btn btn-small" data-acc="add-any" title="Добавить аккаунт"><svg class="ic"><use href="#i-plus"/></svg>Добавить</button>
          </div>
          <div class="profile-list">
            ${accounts.map((account) => `
              <div class="profile-row ${account.uuid === activeId ? "is-active" : ""}" data-uuid="${esc(account.uuid)}">
                ${avatarHtml(account)}
                <div class="acc-main"><div class="acc-name" translate="no">${esc(account.username)}</div><div class="acc-sub">${esc(kindLabel(account.kind))}</div></div>
                ${account.uuid === activeId ? '<span class="tag green">активный</span>' : '<button class="btn btn-small" data-acc="pick">Выбрать</button>'}
                ${account.kind === "microsoft" ? '<span class="acc-slot" aria-hidden="true"></span>'
                  : '<button class="icon-btn" data-acc="rename-one" title="Изменить ник"><svg class="ic"><use href="#i-pencil"/></svg></button>'}
                <button class="icon-btn" data-acc="remove-one" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
              </div>`).join("")}
            ${accounts.length ? "" : '<div class="skin-note">Добавь аккаунт, чтобы выбрать профиль.</div>'}
          </div>
        </section>
        <div class="profile-summary">
          <section class="prefs-section profile-active">
            <div class="prefs-label">Профиль</div>
            ${active ? `<div class="profile-card">
              ${avatarHtml(active, "lg")}
              <div class="profile-card-main"><div class="profile-card-name" translate="no">${esc(active.username)}</div><div class="profile-card-sub">${esc(kindLabel(active.kind))}</div></div>
              <div class="profile-card-actions">
                ${active.kind === "microsoft" ? "" : '<button class="btn btn-small" data-acc="rename">Изменить ник</button>'}
                <button class="btn btn-small" data-acc="remove">Выйти</button>
              </div>
            </div>` : '<div class="profile-card is-empty"><span class="muted">Аккаунта пока нет</span></div>'}
          </section>
        </div>
      </div>`;
  }

  function bindPrefsProfile() {
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || (accounts[0] && accounts[0].uuid);
    const active = accounts.find((item) => item.uuid === activeId) || null;
    const byUuid = (uuid) => accounts.find((item) => item.uuid === uuid) || null;

    $$("[data-acc]").forEach((el) => el.addEventListener("click", async () => {
      const act = el.dataset.acc;
      const row = el.closest("[data-uuid]");
      const account = row ? byUuid(row.dataset.uuid) : active;
      if (act === "add-any") return openAccounts();
      if (act === "add-offline" || act === "add-ms") {
        openAccounts();
        return;
      }
      if (!account) return;
      if (act === "pick") return runAccountAction("pick", account);
      if (act === "rename" || act === "rename-one") return runAccountAction("rename", account);
      if (act === "remove" || act === "remove-one") return runAccountAction("remove", account);
    }));
    $$(".profile-row").forEach((row) => row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const account = byUuid(row.dataset.uuid);
      if (account) openAccountCtx(event.clientX, event.clientY, account);
    }));
  }

  /** Строка своей темы: цвет + подпись + кнопка подбора пипеткой. */
  function colorRow({ id, label, value }) {
    return `<div class="settings-row">
      <span class="label">${label}</span>
      <div class="color-field">
        <input type="color" id="${id}" value="${esc(value)}" aria-label="${label}">
        <span class="color-hex" id="${id}-hex">${esc(value)}</span>
        <button class="btn btn-small" id="${id}-pick"><svg class="ic"><use href="#i-eyedrop"/></svg>Подобрать</button>
      </div>
    </div>`;
  }

  function prefsLook(settings) {
    const own = state.customTheme;
    const custom = state.theme === "custom";
    const selectedTab = INITIAL_TABS.find(([id]) => id === initialTab()) || INITIAL_TABS[0];
    return `
      <div class="prefs-section">
        <div class="prefs-label">Язык интерфейса</div>
        <div class="settings-row">
          <label class="label" for="prefs-language">Язык</label>
          <select class="select" id="prefs-language">${LANGUAGES.map(([code, label]) => `<option value="${code}" translate="no" ${displayedLanguage === code ? "selected" : ""}>${label}</option>`).join("")}</select>
        </div>
        <div class="hint language-hint">Язык сохраняется автоматически и применяется сразу.</div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label" id="launcher-icon-label">Иконка лаунчера</div>
        <div class="launcher-icon-grid" id="launcher-icon-grid" role="radiogroup" aria-labelledby="launcher-icon-label">
          ${LAUNCHER_ICONS.map(([id, label, src]) => `
            <label class="launcher-icon-option" ${["ru", "by", "kz", "ua", "us"].includes(id) ? 'translate="no"' : ""}>
              <input type="radio" name="launcher-icon" value="${id}" aria-label="${esc(label)}" ${displayedLauncherIcon === id ? "checked" : ""}>
              <span class="launcher-icon-card"><img src="${src}" alt="" draggable="false"><span>${esc(label)}</span></span>
            </label>`).join("")}
        </div>
        <div class="hint launcher-icon-hint">В шапке окна, на панели задач и в статусе Discord.</div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Начальная вкладка</div>
        <div class="settings-row">
          <div class="label">При открытии сборки</div>
          <div>
            <button type="button" class="btn initial-tab-trigger" id="prefs-initial-tab" aria-haspopup="dialog">
              <svg class="ic"><use href="#${selectedTab[2]}"/></svg><span>${esc(selectedTab[1])}</span>
              <svg class="ic initial-tab-chevron"><use href="#i-chev"/></svg>
            </button>
            <div class="hint">Выбери, что показывать первым при нажатии на сборку.</div>
          </div>
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Поведение окна</div>
        <div class="settings-row">
          <div class="label">Сворачивать в трей</div>
          <div>
            <div class="switch-row"><button type="button" class="switch ${settings.minimize_to_tray === true ? "on" : ""}" id="set-minimize-to-tray" role="switch" aria-label="Сворачивать окно в системный трей" aria-checked="${settings.minimize_to_tray === true}"></button><span class="muted">кнопка «свернуть» прячет окно; X по-прежнему закрывает приложение</span></div>
            <div class="hint">RPC Discord и серверы продолжают работать, пока окно скрыто.</div>
          </div>
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Тема оформления</div>
        <div class="theme-grid" id="theme-grid">
          ${Object.entries(THEMES).map(([id, theme]) => `
            <button class="theme-chip ${state.theme === id ? "is-active" : ""}" data-theme-id="${id}" title="${esc(theme.label)}">
              <span class="theme-swatch" style="background:${theme.bg}">
                <span class="theme-band" style="background:${theme.panel}"></span>
                <span class="theme-accent" style="background:${theme.accent}"></span>
              </span>
              <span class="theme-name">${esc(theme.label)}</span>
            </button>`).join("")}
          <button class="theme-chip ${custom ? "is-active" : ""}" data-theme-id="custom" title="Своя тема">
            <span class="theme-swatch" style="background:${own.bg}">
              <span class="theme-band" style="background:${own.bg}"></span>
              <span class="theme-accent" style="background:${own.accent}"></span>
            </span>
            <span class="theme-name">Кастом</span>
          </button>
        </div>
      </div>
      ${custom ? `
      <div class="prefs-section" id="custom-theme">
        <div class="prefs-label-row">
          <span class="prefs-label">Своя тема</span>
          <div class="spacer"></div>
          <button class="btn btn-small" id="theme-from-wall"><svg class="ic"><use href="#i-image"/></svg>Цвета из фона</button>
        </div>
        ${colorRow({ id: "theme-bg", label: "Фон", value: own.bg })}
        ${colorRow({ id: "theme-accent", label: "Акцент", value: own.accent })}
        ${colorRow({ id: "theme-text", label: "Текст", value: own.text })}
      </div>` : ""}
      <div class="prefs-section" id="tint-section">
        <div class="prefs-row-head">
          <span class="prefs-label">Базовый цвет фона</span>
          <div class="spacer"></div>
          <button class="btn btn-small" id="tint-auto"><svg class="ic"><use href="#i-refresh"/></svg>Как в теме</button>
        </div>
        <div class="settings-row">
          <span class="label">Цвет</span>
          <div class="color-field">
            <input type="color" id="tint-color" value="${esc(themeTintColor())}" aria-label="Базовый цвет фона">
            <span class="color-hex" id="tint-color-hex">${esc(themeTintColor())}</span>
          </div>
        </div>
        <div class="settings-row">
          <span class="label">Прозрачность</span>
          <div class="range" style="flex:1">
            <input type="range" id="tint-alpha" min="0" max="100" step="1" value="${Math.min(100, Math.max(0, Number(settings.wallpaper_dim ?? 40)))}">
            <span class="tag" id="tint-alpha-val">${Math.min(100, Math.max(0, Number(settings.wallpaper_dim ?? 40)))}%</span>
          </div>
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-row-head">
          <span class="prefs-label">Масштаб интерфейса</span>
          <div class="spacer"></div>
          <span class="mono prefs-value" id="ui-scale-value">${Number(state.uiScale) || 100}%</span>
        </div>
        <div class="chips" id="ui-scale-chips">
          ${UI_SCALES.map((scale) => `<button class="chip ${(Number(state.uiScale) || 100) === scale ? "is-active" : ""}" data-ui-scale="${scale}">${scale}%</button>`).join("")}
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Форма элементов</div>
        <div class="chips" id="shape-chips">
          ${SHAPES.map(([id, label]) => `<button class="chip ${state.shape === id ? "is-active" : ""}" data-shape="${id}">${label}</button>`).join("")}
        </div>
      </div>`;
  }

  function wallGridHtml(ids) {
    return ids.map((id) => {
      const label = (WALLS.find(([wall]) => wall === id) || [id, id])[1];
      return `<button class="wall-chip ${state.wall.wallpaper === id ? "is-active" : ""}" data-wall="${id}" style="background-image:url('${wallUrl(id)}')" title="${esc(label)}"><span>${esc(label)}</span></button>`;
    }).join("");
  }

  function wallpaperHistoryName(id) {
    return typeof id === "string" && id.startsWith("custom:") ? id.slice(7) : "";
  }
  function normalizeWallpaperHistory(recent, custom) {
    const result = [];
    for (const raw of Array.isArray(recent) ? recent : []) {
      const id = raw === "custom" && custom ? `custom:${custom}` : raw;
      const name = wallpaperHistoryName(id);
      if ((WALLS.some(([wall]) => wall === id) || (name && !/[\\/\\\\]/.test(name))) && !result.includes(id)) result.push(id);
    }
    return result;
  }
  function wallHistoryHtml(ids) {
    return ids.map((id) => {
      const name = wallpaperHistoryName(id);
      const builtin = WALLS.find(([wall]) => wall === id);
      const label = builtin ? builtin[1] : name.replace(/-[0-9a-f]+-[0-9a-f]+(?=\.[^.]+$)/i, "");
      const active = builtin ? state.wall.wallpaper === id : state.wall.wallpaper === "custom" && state.settings?.custom_wallpaper === name;
      const background = builtin ? ` style="background-image:url('${wallUrl(id)}')"` : "";
      return `<div class="wall-history-entry">
        <button type="button" class="wall-chip ${active ? "is-active" : ""}" data-wall-history-select="${esc(id)}"${name ? ` data-wall-history-preview="${esc(name)}"` : ""}${background} title="${esc(label)}"><span${name ? ' translate="no"' : ""}>${esc(label)}</span></button>
        <button type="button" class="wall-history-remove icon-btn" data-wall-history-remove="${esc(id)}" aria-label="Удалить из истории" title="Удалить из истории"><svg class="ic"><use href="#i-close"/></svg></button>
      </div>`;
    }).join("");
  }

  function prefsWall(settings) {
    const recent = normalizeWallpaperHistory(state.wall.recent ?? settings.wallpaper_recent, settings.custom_wallpaper);
    const groups = [
      { label: "Градиенты", ids: ["aurora", "waves", "blobs"] },
      { label: "Текстуры", ids: ["grid", "dots", "noise", "stripes"] },
      { label: "Природа", ids: ["mountains"] }
    ];
    return `
      <div class="prefs-section">
        <div class="prefs-label-row"><span class="prefs-label">Обои</span><div class="spacer"></div>
          <button class="wall-none ${!state.wall.wallpaper ? "is-active" : ""}" data-wall="">Убрать фон</button></div>
        <div class="wall-own">
          <button class="wall-chip ${state.wall.wallpaper === "custom" ? "is-active" : ""}" data-wall="custom" id="wall-custom-chip">
            <span>${state.customWall ? (state.customWall.kind === "video" ? "Своё видео" : "Свой фон") : "Свой фон…"}</span>
          </button>
          <button class="btn" id="wall-pick">${state.customWall ? "Заменить файл…" : "Выбрать файл…"}</button>
        </div>
        <div class="skin-note">PNG, JPG, WebP, GIF, MP4 или WebM · до 512 МБ. Видео воспроизводится без звука.</div>
        ${settings.wallpaper === "workshop" ? '<div class="skin-note">Прежний фон Workshop больше не поддерживается. Выбери другой фон; исходные файлы не удалены.</div>' : ""}
        <div class="wall-link-row">
          <input class="input" id="wall-link" value="${esc(state.wallLink.value)}" placeholder="Ссылка на файл или страницу Imgur" spellcheck="false" aria-label="Ссылка на обои">
          <button class="btn" id="wall-link-add" ${state.wallLink.busy ? "disabled" : ""}>${state.wallLink.busy ? "Загрузка…" : "Добавить"}</button>
        </div>
        <div class="skin-note">Прямая HTTP(S)-ссылка на медиа или ссылка Imgur. Другие страницы и альбомы могут не поддерживаться.</div>
        <div class="wall-group"><div class="wall-group-name">История фонов</div>
          <div class="skin-note">Удаление из истории не меняет текущий фон и не удаляет файл.</div>
          ${recent.length ? `<div class="wall-grid wall-history" id="wall-history">${wallHistoryHtml(recent)}</div>` : '<div class="skin-note">История пока пуста.</div>'}
        </div>
        ${groups.map((group) => `<div class="wall-group"><div class="wall-group-name">${esc(group.label)}</div><div class="wall-grid">${wallGridHtml(group.ids)}</div></div>`).join("")}
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Как показывать</div>
        <div class="prefs-inline">
          <div class="field"><label>Заполнение</label><select class="select" id="wall-fit">
            ${[["cover", "Заполнить"], ["contain", "Вписать"], ["fill", "Растянуть"], ["tile", "Плиткой"]]
              .map(([value, label]) => `<option value="${value}" ${state.wall.fit === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
          <div class="field" style="flex:1;min-width:170px"><label>Размытие</label><div class="range"><input type="range" id="wall-blur" min="0" max="20" value="${state.wall.blur}"><span class="tag" id="wall-blur-value">${state.wall.blur}</span></div></div>
          <div class="field" style="flex:1;min-width:170px"><label>Затемнение</label><div class="range"><input type="range" id="wall-dim" min="0" max="100" value="${state.wall.dim}"><span class="tag" id="wall-dim-value">${state.wall.dim}%</span></div></div>
        </div>
        <div class="skin-note">Для видео режим «Плиткой» работает как «Заполнить».</div>
      </div>`;
  }

  const wallpaperPreviewCache = new Map();
  function bindWallpaperLinks() {
    const customChip = $("#wall-custom-chip");
    if (customChip && state.customWall && state.customWall.kind !== "video") customChip.style.backgroundImage = `url("${state.customWall.src}")`;
    $$("[data-wall-history-preview]").forEach((button) => {
      const name = button.dataset.wallHistoryPreview;
      if (!wallpaperPreviewCache.has(name)) {
        const pending = api.wallpaperHistoryPreview(name).then((media) => {
          if (!media || media.kind === "video") return { video: media?.kind === "video" };
          return { src: media.src || (TAURI?.core?.convertFileSrc ? TAURI.core.convertFileSrc(media.path) : media.path) };
        }).catch(() => { wallpaperPreviewCache.delete(name); return {}; });
        wallpaperPreviewCache.set(name, pending);
      }
      wallpaperPreviewCache.get(name).then((media) => {
        if (!button.isConnected) return;
        if (media.src) button.style.backgroundImage = `url(${JSON.stringify(media.src)})`;
        if (media.video) button.classList.add("is-video");
      });
    });
    $$("[data-wall-history-select]").forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.wallHistorySelect;
      const name = wallpaperHistoryName(id);
      button.disabled = true;
      try {
        if (name) {
          // Сначала сохраняем историю: адресная команда не выбирает неизвестный файл.
          await settingsSaveQueue.catch(() => {});
          const saved = await api.selectWallpaperHistory(name);
          state.settings = { ...(state.settings || {}), custom_wallpaper: saved.custom_wallpaper, wallpaper: "custom" };
          state.wall.wallpaper = "custom";
          state.wall.recent = rememberWallpaper(state.wall.recent, id);
          state.customWall = null;
          await loadWallpaperSource("custom");
        } else {
          state.wall.wallpaper = id;
          state.wall.recent = rememberWallpaper(state.wall.recent, id);
        }
        await persistWallpaper();
        applyWallpaper(state.wall);
        if (prefsCategory === "wall" && !$("#modal-prefs").hidden) renderPrefs();
      } catch (error) { toast(String(error), "err"); if (button.isConnected) button.disabled = false; }
    }));
    $$("[data-wall-history-remove]").forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.wallHistoryRemove;
      state.wall.recent = state.wall.recent.filter((item) => item !== id);
      if (!await persistWallpaper()) toast("Не удалось сохранить историю фонов", "err");
      if (prefsCategory === "wall" && !$("#modal-prefs").hidden) renderPrefs();
    }));
    const link = $("#wall-link");
    link?.addEventListener("input", () => { state.wallLink.value = link.value; });
    link?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void addWallpaperLink(); } });
    $("#wall-link-add")?.addEventListener("click", addWallpaperLink);
  }

  async function addWallpaperLink() {
    const link = state.wallLink;
    const url = String(link.value || $("#wall-link")?.value || "").trim();
    if (!url || link.busy) return;
    link.busy = true; renderPrefs();
    try {
      const saved = await api.downloadWallpaper(url);
      state.settings = { ...(state.settings || {}), wallpaper: saved.wallpaper,
        custom_wallpaper: saved.custom_wallpaper, launcher_icon: displayedLauncherIcon };
      await loadWallpaperSource("custom");
      state.wall.wallpaper = "custom";
      state.wall.recent = rememberWallpaper(state.wall.recent, "custom");
      await persistWallpaper();
      applyWallpaper(state.wall);
      link.value = "";
      toast("Файл обоев загружен и выбран", "ok");
    } catch (error) { toast(String(error), "err"); }
    finally { link.busy = false; if (prefsCategory === "wall" && !$("#modal-prefs").hidden) renderPrefs(); }
  }

  function prefsFx() {
    const ambientOn = (state.ambient || "stars") !== "off";
    const trailOn = state.trail !== false;
    const trailStyle = state.trailStyle || TRAIL_DEFAULTS.style;
    const trailSize = Number(state.trailSize) || TRAIL_DEFAULTS.size;
    const trailLength = Number(state.trailLength) || TRAIL_DEFAULTS.length;
    const trailOpacity = Number(state.trailOpacity) || TRAIL_DEFAULTS.opacity;
    return `
      <div class="prefs-section">
        <div class="prefs-label">Эффект от клика</div>
        <div class="chips" id="fx-chips">
          ${Object.entries(FX_STYLES).map(([id, label]) => `<button class="chip ${state.fx === id ? "is-active" : ""}" data-fx="${id}">${label}</button>`).join("")}
        </div>
      </div>

      <!-- группа: трейсер за курсором -->
      <div class="fx-group">
        <div class="fx-group-head">
          <span class="fx-group-title">Трейсер за курсором</span>
          <div class="spacer"></div>
          <button class="switch ${trailOn ? "on" : ""}" id="set-trail"></button>
        </div>
        <div class="fx-group-body">
          <div class="prefs-section">
            <div class="prefs-label">Вариант</div>
            <div class="chips" id="trail-chips">
              ${Object.entries(TRAIL_STYLES).map(([id, label]) => `<button class="chip ${trailStyle === id ? "is-active" : ""}" data-trail-style="${id}">${label}</button>`).join("")}
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-row-head">
              <span class="prefs-label">Толщина</span>
              <div class="spacer"></div>
              <span class="mono" id="trail-size-value">${trailSize}%</span>
            </div>
            <div class="range">
              <input type="range" id="set-trail-size" min="10" max="300" step="10" value="${trailSize}" ${trailOn ? "" : "disabled"}>
              <span class="muted" style="font-size:11px">тонкий</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">широкий</span>
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-row-head">
              <span class="prefs-label">Длина следа</span>
              <div class="spacer"></div>
              <span class="mono" id="trail-length-value">${trailLength}%</span>
            </div>
            <div class="range">
              <input type="range" id="set-trail-length" min="10" max="300" step="10" value="${trailLength}" ${trailOn ? "" : "disabled"}>
              <span class="muted" style="font-size:11px">короткий</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">длинный</span>
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-row-head">
              <span class="prefs-label">Прозрачность</span>
              <div class="spacer"></div>
              <span class="mono" id="trail-opacity-value">${trailOpacity}%</span>
            </div>
            <div class="range">
              <input type="range" id="set-trail-opacity" min="5" max="100" step="5" value="${trailOpacity}">
              <span class="muted" style="font-size:11px">прозрачный</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">плотный</span>
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-label">Цвет</div>
            ${fxColorRow({ id: "trail-color", value: state.trailColor, fallback: themeTextColor() })}
          </div>
        </div>
      </div>

      <!-- группа: эффект на экране -->
      <div class="fx-group">
        <div class="fx-group-head">
          <span class="fx-group-title">Эффект на экране</span>
          <div class="spacer"></div>
          <button class="switch ${ambientOn ? "on" : ""}" id="set-ambient"></button>
        </div>
        <div class="fx-group-body">
          <div class="prefs-section">
            <div class="prefs-label">Что падает</div>
            <div class="chips" id="ambient-chips">
              ${Object.entries(AMBIENT_STYLES).filter(([id]) => id !== "off").map(([id, label]) => `<button class="chip ${(state.ambient || "stars") === id ? "is-active" : ""}" data-ambient="${id}">${label}</button>`).join("")}
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-row-head">
              <span class="prefs-label">Размер частиц</span>
              <div class="spacer"></div>
              <span class="mono" id="fx-size-value">${Number(state.effectSize) || 100}%</span>
            </div>
            <div class="range">
              <input type="range" id="set-fx-size" min="10" max="220" step="10" value="${Number(state.effectSize) || 100}">
              <span class="muted" style="font-size:11px">маленькие</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">крупные</span>
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-row-head">
              <span class="prefs-label">Количество</span>
              <div class="spacer"></div>
              <span class="mono" id="dens-value">${Number(state.ambientDensity) || 100}%</span>
            </div>
            <div class="range">
              <input type="range" id="set-density" min="10" max="200" step="10" value="${Number(state.ambientDensity) || 100}">
              <span class="muted" style="font-size:11px">редко</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">густо</span>
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-row-head">
              <span class="prefs-label">Прозрачность</span>
              <div class="spacer"></div>
              <span class="mono" id="amb-opacity-value">${Number(state.ambientOpacity) || 80}%</span>
            </div>
            <div class="range">
              <input type="range" id="set-amb-opacity" min="5" max="100" step="5" value="${Number(state.ambientOpacity) || 80}">
              <span class="muted" style="font-size:11px">прозрачные</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">плотные</span>
            </div>
          </div>
          <div class="prefs-section">
            <div class="prefs-label">Цвет</div>
            ${fxColorRow({ id: "ambient-color", value: state.ambientColor, fallback: themeTextColor() })}
          </div>
        </div>
      </div>`;
  }

  /** Цвет из темы — подставляется в палитру, пока свой цвет не выбран. */
  function themeTextColor() {
    const value = getComputedStyle(document.body).getPropertyValue("--text").trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#ececee";
  }

  /** Строка «цвет» для эффектов: палитра, hex и кнопка «как в теме». */
  function fxColorRow({ id, value, fallback }) {
    const color = value || fallback;
    return `<div class="color-field">
      <input type="color" id="${id}" value="${esc(color)}" aria-label="Цвет">
      <span class="color-hex" id="${id}-hex">${esc(value ? value : "как в теме")}</span>
      <button class="btn btn-small" id="${id}-reset" title="Брать цвет из темы"><svg class="ic"><use href="#i-refresh"/></svg>Как в теме</button>
    </div>`;
  }

  /** Плотность частиц: сколько их на экране, в процентах. */
  function applyDensity(percent) {
    const clean = ambient.density(percent);
    state.ambientDensity = clean;
    return clean;
  }

  const soundImports = new Set();
  async function updateCustomSound(event, path) {
    if (!SOUND_EVENTS.some(([id]) => id === event) || soundImports.has(event)) return;
    const trimmed = String(path || "").trim();
    const before = state.sound.custom?.[event] || {};
    if (trimmed === (before.path || "") && Boolean(trimmed) === Boolean(before.file)) return;
    soundImports.add(event);
    const row = $(`[data-sound-event="${event}"]`);
    if (row) $$("input, button", row).forEach((control) => { control.disabled = true; });
    try {
      const saved = await api.setCustomSound(event, trimmed);
      const sound = saved?.sound_custom?.[event];
      if (!sound) throw new Error("звук не сохранён");
      const latest = state.sound.custom?.[event] || before;
      state.sound.custom = { ...(state.sound.custom || {}), [event]: { ...sound, volume: latest.volume ?? sound.volume ?? 100 } };
      state.settings = { ...(state.settings || {}), sound_custom: state.sound.custom };
      await api.saveSettings(state.settings);
      if (trimmed && state.sound.on && state.sound.style === "custom") {
        try { await sfx.prepare(event); }
        catch (_) { toast("Не удалось воспроизвести звук: проверь формат и кодек системы", "err"); }
      }
    } catch (error) { toast(String(error), "err"); }
    finally {
      soundImports.delete(event);
      if (prefsCategory === "sound" && !$("#modal-prefs").hidden) renderPrefs();
    }
  }

  function prefsSound(settings) {
    return `
      <div class="prefs-section">
        <div class="prefs-label">Звуковые эффекты</div>
        <div class="prefs-rows">
          <div class="settings-row">
            <div class="label">Звуки интерфейса</div>
            <div><div class="switch-row"><button class="switch ${state.sound.on ? "on" : ""}" id="set-sound"></button><span class="muted">щелчки и переключатели</span></div></div>
          </div>
          <div class="settings-row">
            <div class="label">Громкость</div>
            <div class="range">
              <input type="range" id="set-sound-volume" min="0" max="200" step="5" value="${state.sound.volume}" aria-label="Общая громкость звуков">
              <span class="tag" id="set-sound-volume-value">${state.sound.volume}%</span>
            </div>
          </div>
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Вариант звука</div>
        <div class="chips" id="sound-style-chips">
          ${Object.entries(SOUND_STYLES).map(([id, label]) => `<button class="chip ${(state.sound.style || "soft") === id ? "is-active" : ""}" data-sound-style="${id}">${label}</button>`).join("")}
        </div>
      </div>
      ${state.sound.style === "custom" ? `<div class="prefs-section sound-custom-section">
        <div class="prefs-label">Звуки для событий</div>
        <div class="skin-note">WAV, MP3, OGG или FLAC · до 5 МБ. Пустые события беззвучны; файлы копируются в папку лаунчера.</div>
        <div class="sound-event-list">${SOUND_EVENTS.map(([id, label]) => {
          const sound = state.sound.custom?.[id] || {};
          const volume = Math.max(0, Math.min(200, Number(sound.volume ?? 100) || 0));
          return `<div class="sound-event" data-sound-event="${id}">
            <div class="sound-event-title">${esc(label)}</div>
            <div class="sound-path-row">
              <input class="input" data-sound-path="${id}" value="${esc(sound.path || "")}" placeholder="Файл не выбран" aria-label="Путь к звуку: ${esc(label)}" spellcheck="false">
              <button type="button" class="btn" data-sound-pick="${id}"><svg class="ic"><use href="#i-folder"/></svg>Выбрать</button>
              <button type="button" class="icon-btn" data-sound-clear="${id}" aria-label="Убрать звук" title="Убрать звук" ${sound.file ? "" : "disabled"}><svg class="ic"><use href="#i-close"/></svg></button>
            </div>
            <div class="sound-event-volume"><label for="sound-volume-${id}">Громкость</label>
              <input id="sound-volume-${id}" data-sound-volume="${id}" type="range" min="0" max="200" step="5" value="${volume}" aria-label="Громкость: ${esc(label)}">
              <span class="tag" data-sound-volume-value="${id}">${volume}%</span>
              <button type="button" class="btn btn-small" data-sound-preview="${id}" ${sound.file ? "" : "disabled"}>Прослушать</button>
            </div>
          </div>`;
        }).join("")}</div>
      </div>` : ""}
      <div class="prefs-section">
        <div class="prefs-label">Проверка</div>
        <div class="settings-actions">
          <button class="btn" id="sound-test">Прослушать все</button>
        </div>
      </div>`;
  }

  function prefsGame(settings) {
    return `
      <div class="prefs-section">
        <div class="prefs-label">Память и Java</div>
        <div class="prefs-rows">
          <div class="settings-row">
            <div class="label">Память по умолчанию, МБ</div>
            <div>${memoryRangeHtml("set-memory", settings.memory_mb, "Память по умолчанию")}</div>
          </div>
          <div class="settings-row">
            <div class="label">Java (новая)</div>
            <div class="flex-row">
              <input class="input grow" id="set-java" placeholder="автоматически" value="${esc(settings.java_path || "")}" spellcheck="false">
              <button class="btn" id="set-java-pick"><svg class="ic"><use href="#i-folder"/></svg>Выбрать…</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="label">Java 8 (для версий до 1.17)</div>
            <div class="flex-row">
              <input class="input grow" id="set-java-legacy" placeholder="автоматически" value="${esc(settings.java_path_legacy || "")}" spellcheck="false">
              <button class="btn" id="set-java-legacy-pick"><svg class="ic"><use href="#i-folder"/></svg>Выбрать…</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="label">Найденные Java</div>
            <div class="java-list" id="java-found"><span class="muted">поиск…</span></div>
          </div>
          <div class="settings-row">
            <div class="label">JVM-аргументы</div>
            <div><input class="input" style="width:100%" id="set-jvm" value="${esc(settings.jvm_args || "")}" spellcheck="false"></div>
          </div>
          <div class="settings-row">
            <div class="label">Автоскачивание Java</div>
            <div><div class="switch-row"><button class="switch ${settings.auto_java ? "on" : ""}" id="set-auto-java"></button><span class="muted">если подходящей Java нет</span></div></div>
          </div>
        </div>
      </div>`;
  }

  function prefsDiscord(settings) {
    return `
      <div class="prefs-section">
        <div class="prefs-label">Статус в Discord</div>
        <div class="prefs-rows">
          <div class="settings-row">
            <div class="label">Показывать статус</div>
            <div><div class="switch-row"><button type="button" class="switch ${settings.discord_rpc !== false ? "on" : ""}" id="set-discord-rpc" role="switch" aria-label="Показывать статус в Discord" aria-checked="${settings.discord_rpc !== false}"></button><span class="muted">«В ожидании / Запускает / Играет» + сборка</span></div></div>
          </div>
          <div class="settings-row">
            <div class="label">Изображения</div>
            <div class="muted" style="line-height:1.55">Большая картинка — логотип OmniSpec. Маленькая — значок выбранной сборки.</div>
          </div>
          <div class="settings-row">
            <div class="label">Иконка сборки</div>
            <div>
              <div class="switch-row"><button type="button" class="switch ${settings.discord_instance_icon !== false ? "on" : ""}" id="set-discord-icon" role="switch" aria-label="Показывать маленькую иконку сборки" aria-checked="${settings.discord_instance_icon !== false}"></button><span class="muted">Показывать маленькую иконку сборки</span></div>
              <div class="hint">Для Modrinth и CurseForge используется публичная иконка проекта, если она совпадает с иконкой сборки. Встроенные значки и буквы работают без загрузки файлов.</div>
            </div>
          </div>
          <div class="settings-row">
            <div class="label">Свои картинки</div>
            <div>
              <div class="switch-row"><button type="button" class="switch ${settings.discord_upload_local_icon === true ? "on" : ""}" id="set-discord-upload" role="switch" aria-label="Разрешить публикацию локальных иконок для Discord" aria-checked="${settings.discord_upload_local_icon === true}"></button><span class="muted">Разрешить публикацию локальных иконок для Discord</span></div>
              <div class="hint rpc-privacy">По умолчанию выключено. При включении выбранная иконка уменьшится и отправится на публичный сторонний сервис tmpfile.link: её сможет открыть любой, у кого есть ссылка. Сервис заявляет удаление через 7 дней; досрочно удалить файл нельзя, а Discord может кэшировать его дольше. Отключение переключателя не удаляет уже отправленные файлы. Без разрешения вместо своей картинки показывается буква сборки.</div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function prefsUpdates(settings) {
    const version = (state.update && state.update.version) || "—";
    const platform = (state.update && state.update.platform) || "";
    return `
      <div class="prefs-section">
        <div class="prefs-label">Версия лаунчера</div>
        <div class="settings-rows">
          <div class="settings-row">
            <div class="label">OmniSpec</div>
            <div><span class="kbd mono" id="upd-version">${esc(version)}</span></div>
          </div>
          <div class="settings-row">
            <div class="label">Платформа</div>
            <div><span class="muted" id="upd-platform">${esc(platform || "—")}</span></div>
          </div>
        </div>
      </div>

      <div class="prefs-section">
        <div class="prefs-label">Обновления</div>
        <div class="prefs-rows">
          <div class="settings-row">
            <div class="label">Проверять обновления</div>
            <div><div class="switch-row"><button class="switch ${settings.update_enabled !== false ? "on" : ""}" id="set-upd-enabled"></button></div></div>
          </div>
          <div class="settings-row">
            <div class="label">Авто-обновление при запуске</div>
            <div><div class="switch-row"><button class="switch ${settings.update_auto !== false ? "on" : ""}" id="set-upd-auto"></button></div></div>
          </div>
          <div class="settings-row">
            <div class="label">Бета-версии</div>
            <div><div class="switch-row"><button class="switch ${settings.update_prerelease ? "on" : ""}" id="set-upd-pre"></button></div></div>
          </div>
        </div>
        <div class="settings-actions">
          <button class="btn" id="upd-open-repo">Открыть репозиторий</button>
          <button class="btn" id="upd-check-now">Проверить сейчас</button>
        </div>
      </div>`;
  }

  // Последний подтверждённый выбор нужен для отката при ошибке записи;
  // номер защищает более поздний выбор от запоздавшего ответа предыдущего.
  let initialTabSaveGeneration = 0;
  let confirmedInitialTab = null;

  function closeInitialTabDialog() {
    const modal = $("#modal-initial-tab");
    if (modal) modal.hidden = true;
    $("#prefs-initial-tab")?.focus();
  }

  function openInitialTabDialog() {
    const modal = $("#modal-initial-tab");
    const list = $("#initial-tab-options");
    if (!modal || !list) return;
    const current = initialTab();
    list.innerHTML = INITIAL_TABS.map(([id, label, icon]) => `
      <button type="button" class="initial-tab-option ${id === current ? "is-active" : ""}" data-initial-tab="${id}" aria-pressed="${id === current}">
        <svg class="ic"><use href="#${icon}"/></svg><span>${esc(label)}</span>
        <svg class="ic initial-tab-check" aria-hidden="true"><use href="#i-check"/></svg>
      </button>`).join("");
    $$("[data-initial-tab]", list).forEach((button) => button.addEventListener("click", async () => {
      const chosen = button.dataset.initialTab;
      if (!INITIAL_TABS.some(([id]) => id === chosen)) return;
      if (confirmedInitialTab === null) confirmedInitialTab = initialTab();
      const generation = ++initialTabSaveGeneration;
      state.settings = { ...(state.settings || {}), initial_tab: chosen };
      modal.hidden = true;
      if (!$("#modal-prefs").hidden) renderPrefs();
      $("#prefs-initial-tab")?.focus();
      try {
        await api.saveSettings(state.settings);
        confirmedInitialTab = chosen;
      } catch (error) {
        if (generation === initialTabSaveGeneration && state.settings?.initial_tab === chosen) {
          state.settings = { ...state.settings, initial_tab: confirmedInitialTab };
          if (!$("#modal-prefs").hidden) renderPrefs();
          // Другая правка настроек могла уже поставить в очередь старый снимок.
          try { await api.saveSettings(state.settings); } catch (_) { /* покажем ошибку ниже */ }
        }
        toast(`Не удалось сохранить начальную вкладку: ${error}`, "err");
      }
    }));
    modal.hidden = false;
    $("[aria-pressed='true']", list)?.focus();
  }

  /* обработчики для всех категорий сразу — их немного */
  function bindPrefs() {
    $("#prefs-language")?.addEventListener("change", (event) => { void chooseLanguage(event.target.value); });
    const settings = state.settings || {};

    $$("#launcher-icon-grid input[name='launcher-icon']").forEach((radio) => radio.addEventListener("change", () => {
      if (radio.checked) chooseLauncherIcon(radio.value);
    }));
    $("#prefs-initial-tab")?.addEventListener("click", openInitialTabDialog);
    $$("#theme-grid .theme-chip").forEach((chip) => chip.addEventListener("click", () => {
      state.theme = applyTheme(chip.dataset.themeId);
      // тема запоминается сразу: иначе после перезапуска возвращалось «тёмная»
      state.settings = {
        ...(state.settings || {}),
        theme: state.theme,
        theme_bg: state.customTheme.bg,
        theme_accent: state.customTheme.accent,
        theme_text: state.customTheme.text
      };
      api.saveSettings(state.settings).catch(() => {});
      renderPrefs();
    }));
    // свои цвета: ползунки цвета + пипетка
    const bindColor = (key, id) => {
      const input = $(`#${id}`);
      if (!input) return;
      const paintLive = liveThrottle(() => { state.theme = applyTheme("custom", true); });
      const apply = (value, final) => {
        if (!/^#[0-9a-f]{6}$/i.test(String(value))) return;
        state.customTheme[key] = String(value).toLowerCase();
        input.value = state.customTheme[key];
        const hex = $(`#${id}-hex`);
        if (hex) hex.textContent = state.customTheme[key];
        if (final) {
          state.theme = applyTheme("custom");
          saveCustomTheme();
        } else {
          // живое обновление — троттлинг по времени и без записи на диск
          paintLive();
          saveCustomThemeSoon();
        }
      };
      input.addEventListener("input", () => apply(input.value, false));
      input.addEventListener("change", () => apply(input.value, true));
      const pick = $(`#${id}-pick`);
      if (pick) pick.addEventListener("click", async () => {
        // главное назначение кнопки — цвет ПОД ФОН: берём палитру обоев
        const palette = await wallpaperPalette();
        if (palette && palette[key]) { apply(palette[key], true); return; }
        // обоев нет (или картинка недоступна) — обычная пипетка
        if (window.EyeDropper) {
          try {
            const result = await new window.EyeDropper().open();
            const value = String(result.sRGBHex || "").toLowerCase();
            if (value) apply(value, true);
            return;
          } catch (error) { /* отменили выбор — открываем обычный выбор цвета */ }
        }
        input.click();
      });
    };
    const tintColor = $("#tint-color");
    if (tintColor) {
      const paintTint = liveThrottle(applyThemeTint);
      const applyTint = (value, final) => {
        if (!/^#[0-9a-f]{6}$/i.test(String(value))) return;
        state.settings = { ...(state.settings || {}), theme_tint: String(value).toLowerCase() };
        tintColor.value = state.settings.theme_tint;
        const hex = $("#tint-color-hex");
        if (hex) hex.textContent = state.settings.theme_tint;
        if (final) {
          applyThemeTint();
          api.saveSettings(state.settings).catch(() => {});
        } else {
          paintTint();
          saveSettingsSoon();
        }
      };
      tintColor.addEventListener("input", () => applyTint(tintColor.value, false));
      tintColor.addEventListener("change", () => applyTint(tintColor.value, true));
      const auto = $("#tint-auto");
      if (auto) auto.addEventListener("click", () => {
        state.settings = { ...(state.settings || {}), theme_tint: "" };
        applyThemeTint();
        api.saveSettings(state.settings).catch(() => {});
        renderPrefs();
      });
    }
    const tintAlpha = $("#tint-alpha");
    if (tintAlpha) {
      // applyWallpaper тянет подготовку слоя — троттлинг по времени
      const paintWall = liveThrottle(() => applyWallpaper(state.wall));
      tintAlpha.addEventListener("input", (event) => {
        const value = Math.min(100, Math.max(0, Number(event.target.value)));
        state.wall.dim = value;
        state.settings = { ...(state.settings || {}), wallpaper_dim: value };
        const label = $("#tint-alpha-val");
        if (label) label.textContent = `${value}%`;
        paintWall();
      });
    }
    bindColor("bg", "theme-bg");
    bindColor("accent", "theme-accent");
    bindColor("text", "theme-text");
    const fromWall = $("#theme-from-wall");
    if (fromWall) fromWall.addEventListener("click", async () => {
      const palette = await wallpaperPalette();
      if (!palette) { toast("Сначала выбери фон", "err"); return; }
      state.customTheme = { ...state.customTheme, ...palette };
      state.theme = applyTheme("custom");
      saveCustomTheme();
      renderPrefs();
      toast("Цвета взяты из фона", "ok");
    });
    const trailSwitch = $("#set-trail");
    if (trailSwitch) trailSwitch.addEventListener("click", () => {
      const on = !(state.trail !== false);
      applyTrail(on);
      trailSwitch.classList.toggle("on", on);
      ["#set-trail-size", "#set-trail-length"].forEach((selector) => {
        const slider = $(selector);
        if (slider) slider.disabled = !on;
      });
      state.settings = { ...(state.settings || {}), trail: on };
      api.saveSettings(state.settings).catch(() => {});
    });
    const fxSize = $("#set-fx-size");
    if (fxSize) {
      fxSize.addEventListener("input", () => {
        const size = applyEffectSize(fxSize.value);
        const label = $("#fx-size-value");
        if (label) label.textContent = `${size}%`;
      });
      fxSize.addEventListener("change", () => {
        state.settings = { ...(state.settings || {}), effect_size: applyEffectSize(fxSize.value) };
        api.saveSettings(state.settings).catch(() => {});
      });
    }
    $$("#trail-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      applyTrailStyle(chip.dataset.trailStyle);
      $$("#trail-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
      state.settings = { ...(state.settings || {}), trail_style: state.trailStyle };
      api.saveSettings(state.settings).catch(() => {});
    }));
    const trailLength = $("#set-trail-length");
    if (trailLength) {
      trailLength.addEventListener("input", () => {
        const value = applyTrailLength(trailLength.value);
        const label = $("#trail-length-value");
        if (label) label.textContent = `${value}%`;
      });
      trailLength.addEventListener("change", () => {
        state.settings = { ...(state.settings || {}), trail_length: applyTrailLength(trailLength.value) };
        api.saveSettings(state.settings).catch(() => {});
      });
    }
    const bindFxColor = (id, apply, key) => {
      const input = $(`#${id}`);
      const hex = $(`#${id}-hex`);
      const reset = $(`#${id}-reset`);
      const paint = (value) => {
        if (hex) hex.textContent = value ? value : "как в теме";
        if (input && value) input.value = value;
      };
      if (input) input.addEventListener("input", () => {
        const value = apply(input.value);
        paint(value);
        state.settings = { ...(state.settings || {}), [key]: value };
        api.saveSettings(state.settings).catch(() => {});
      });
      if (reset) reset.addEventListener("click", () => {
        apply(null);
        paint(null);
        state.settings = { ...(state.settings || {}), [key]: null };
        api.saveSettings(state.settings).catch(() => {});
      });
    };
    bindFxColor("trail-color", applyTrailColor, "trail_color");
    bindFxColor("ambient-color", applyAmbientColor, "ambient_color");
    const trailOpacity = $("#set-trail-opacity");
    if (trailOpacity) {
      trailOpacity.addEventListener("input", () => {
        const value = applyTrailOpacity(trailOpacity.value);
        const label = $("#trail-opacity-value");
        if (label) label.textContent = `${value}%`;
      });
      trailOpacity.addEventListener("change", () => {
        state.settings = { ...(state.settings || {}), trail_opacity: applyTrailOpacity(trailOpacity.value) };
        api.saveSettings(state.settings).catch(() => {});
      });
    }
    const ambOpacity = $("#set-amb-opacity");
    if (ambOpacity) {
      ambOpacity.addEventListener("input", () => {
        const value = applyAmbientOpacity(ambOpacity.value);
        const label = $("#amb-opacity-value");
        if (label) label.textContent = `${value}%`;
      });
      ambOpacity.addEventListener("change", () => {
        state.settings = { ...(state.settings || {}), ambient_opacity: applyAmbientOpacity(ambOpacity.value) };
        api.saveSettings(state.settings).catch(() => {});
      });
    }
    const densityInput = $("#set-density");
    if (densityInput) {
      densityInput.addEventListener("input", () => {
        const value = applyDensity(densityInput.value);
        const label = $("#dens-value");
        if (label) label.textContent = `${value}%`;
      });
      densityInput.addEventListener("change", () => {
        state.settings = { ...(state.settings || {}), ambient_density: applyDensity(densityInput.value) };
        api.saveSettings(state.settings).catch(() => {});
      });
    }
    const trailSize = $("#set-trail-size");
    if (trailSize) {
      trailSize.addEventListener("input", () => {
        const size = applyTrailSize(trailSize.value);
        const label = $("#trail-size-value");
        if (label) label.textContent = `${size}%`;
      });
      trailSize.addEventListener("change", () => {
        state.settings = { ...(state.settings || {}), trail_size: applyTrailSize(trailSize.value) };
        api.saveSettings(state.settings).catch(() => {});
      });
    }
    const ambientSwitch = $("#set-ambient");
    if (ambientSwitch) ambientSwitch.addEventListener("click", () => {
      const on = !(state.ambient && state.ambient !== "off");
      applyAmbient(on ? (state.ambient && state.ambient !== "off" ? state.ambient : "stars") : "off");
      ambientSwitch.classList.toggle("on", on);
      $$("#ambient-chips .chip").forEach((el) => el.classList.toggle("is-active", on && el.dataset.ambient === state.ambient));
      state.settings = { ...(state.settings || {}), ambient: state.ambient };
      api.saveSettings(state.settings).catch(() => {});
    });
    $$("#ambient-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      applyAmbient(chip.dataset.ambient);
      $$("#ambient-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
      const sw = $("#set-ambient");
      if (sw) sw.classList.add("on");
      state.settings = { ...(state.settings || {}), ambient: state.ambient };
      api.saveSettings(state.settings).catch(() => {});
    }));
    $$("#fx-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      state.fx = chip.dataset.fx;
      applyClickFx(state.fx);
      $$("#fx-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    $$("#ui-scale-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      applyUiScale(chip.dataset.uiScale);
      $$("#ui-scale-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
      const label = $("#ui-scale-value");
      if (label) label.textContent = `${state.uiScale}%`;
      state.settings = { ...(state.settings || {}), ui_scale: state.uiScale };
      api.saveSettings(state.settings).catch(() => {});
    }));
    $$("#shape-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      applyShape(chip.dataset.shape);
      $$("#shape-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    const wallPick = $("#wall-pick");
    if (wallPick) wallPick.addEventListener("click", async () => {
      const path = await api.pickFile("Свой фон: изображение, GIF или видео", ["png", "jpg", "jpeg", "webp", "gif", "mp4", "m4v", "webm"]).catch((error) => { toast(String(error), "err"); return null; });
      if (!path) return;
      wallPick.disabled = true;
      try {
        const saved = await api.setCustomWallpaper(path);
        state.settings = { ...(state.settings || {}), wallpaper: saved.wallpaper,
          custom_wallpaper: saved.custom_wallpaper, launcher_icon: displayedLauncherIcon };
        await loadWallpaperSource("custom");
        state.wall.wallpaper = "custom";
        state.wall.recent = rememberWallpaper(state.wall.recent, "custom");
        await persistWallpaper();
        applyWallpaper(state.wall);
        renderPrefs();
        toast("Фон выбран", "ok");
      } catch (err) { toast(String(err), "err"); wallPick.disabled = false; }
    });
    const soundSwitch = $("#set-sound");
    if (soundSwitch) soundSwitch.addEventListener("click", () => {
      state.sound.on = !state.sound.on;
      soundSwitch.classList.toggle("on", state.sound.on);
      if (state.sound.on) sfx.toggle();
    });
    const soundVolume = $("#set-sound-volume");
    if (soundVolume) soundVolume.addEventListener("input", (event) => {
      state.sound.volume = Number(event.target.value);
      $("#set-sound-volume-value").textContent = `${state.sound.volume}%`;
    });
    if (soundVolume) soundVolume.addEventListener("change", () => {
      sfx.click();
      commit({ sound_volume: state.sound.volume });
    });
    const soundTest = $("#sound-test");
    if (soundTest) soundTest.addEventListener("click", () => { sfx.demo(); });
    $$("#sound-style-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      state.sound.style = chip.dataset.soundStyle;
      state.settings = { ...(state.settings || {}), sound_style: state.sound.style };
      api.saveSettings(state.settings).catch(() => {});
      renderPrefs();
    }));
    $$("[data-sound-pick]").forEach((button) => button.addEventListener("click", async () => {
      const event = button.dataset.soundPick;
      button.disabled = true;
      try {
        const path = await api.pickFile(I18N.translate("Выбери звук для события"), ["wav", "mp3", "ogg", "oga", "flac"]);
        if (path) await updateCustomSound(event, path);
      } catch (error) { toast(String(error), "err"); }
      finally { if (button.isConnected) button.disabled = false; }
    }));
    $$("[data-sound-path]").forEach((input) => {
      input.addEventListener("change", () => { void updateCustomSound(input.dataset.soundPath, input.value); });
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); input.blur(); } });
    });
    $$("[data-sound-clear]").forEach((button) => button.addEventListener("click", () => { void updateCustomSound(button.dataset.soundClear, ""); }));
    $$("[data-sound-volume]").forEach((input) => {
      input.addEventListener("input", () => {
        const name = input.dataset.soundVolume;
        const previous = state.sound.custom?.[name] || { path: "", file: null };
        state.sound.custom = { ...(state.sound.custom || {}), [name]: { ...previous, volume: Number(input.value) } };
        $(`[data-sound-volume-value="${name}"]`).textContent = `${input.value}%`;
      });
      input.addEventListener("change", () => {
        commit({ sound_custom: state.sound.custom });
        sfx.play(input.dataset.soundVolume);
      });
    });
    $$("[data-sound-preview]").forEach((button) => button.addEventListener("click", () => sfx.play(button.dataset.soundPreview)));

    $$("#prefs-body [data-wall]").forEach((chip) => chip.addEventListener("click", async () => {
      const picked = chip.dataset.wall || null;
      if (picked === "custom" && !state.customWall) return toast("Сначала выбери файл фона", "err");
      state.wall.wallpaper = picked;
      state.wall.recent = rememberWallpaper(state.wall.recent, picked);
      $$("#prefs-body [data-wall]").forEach((el) => el.classList.toggle("is-active", el === chip));
      applyWallpaper(state.wall);
      await persistWallpaper();
      renderPrefs();
    }));
    const fit = $("#wall-fit");
    if (fit) fit.addEventListener("change", (event) => { state.wall.fit = event.target.value; applyWallpaper(state.wall); persistWallpaper(); });
    const blur = $("#wall-blur");
    if (blur) blur.addEventListener("input", (event) => {
      state.wall.blur = Number(event.target.value);
      $("#wall-blur-value").textContent = String(state.wall.blur);
      applyWallpaper(state.wall);
    });
    const dim = $("#wall-dim");
    if (dim) dim.addEventListener("input", (event) => {
      state.wall.dim = Number(event.target.value);
      $("#wall-dim-value").textContent = `${state.wall.dim}%`;
      applyWallpaper(state.wall);
    });
    if (blur) blur.addEventListener("change", persistWallpaper);
    if (dim) dim.addEventListener("change", persistWallpaper);

    const memory = $("#set-memory");
    if (memory) memory.addEventListener("input", () => updateMemoryRange(memory));
    const autoJava = $("#set-auto-java");
    if (autoJava) autoJava.addEventListener("click", () => autoJava.classList.toggle("on"));
    [$("#set-discord-rpc"), $("#set-discord-icon"), $("#set-discord-upload"), $("#set-minimize-to-tray")].forEach((control) => {
      if (!control) return;
      control.addEventListener("click", () => {
        const enabled = control.classList.toggle("on");
        control.setAttribute("aria-checked", String(enabled));
        if (control.id === "set-minimize-to-tray") {
          commit({ minimize_to_tray: enabled });
        }
      });
      control.parentElement?.addEventListener("click", (event) => {
        if (!control.contains(event.target)) control.click();
      });
    });
    const updEnabled = $("#set-upd-enabled");
    const updAuto = $("#set-upd-auto");
    // «авто-обновление» невозможно без проверки, а выключение проверки гасит и его
    if (updEnabled) updEnabled.addEventListener("click", () => {
      updEnabled.classList.toggle("on");
      if (!updEnabled.classList.contains("on") && updAuto) updAuto.classList.remove("on");
    });
    const updPre = $("#set-upd-pre");
    if (updPre) updPre.addEventListener("click", () => updPre.classList.toggle("on"));
    if (updAuto) updAuto.addEventListener("click", () => {
      updAuto.classList.toggle("on");
      if (updAuto.classList.contains("on") && updEnabled) updEnabled.classList.add("on");
    });

    const checkNow = $("#upd-check-now");
    if (checkNow) checkNow.addEventListener("click", async () => {
      const info = await checkUpdates(false);
      if (info) { $("#modal-prefs").hidden = true; $("#modal-update").hidden = false; }
    });
    const openRepo = $("#upd-open-repo");
    if (openRepo) openRepo.addEventListener("click", () => {
      const slug = (state.settings && state.settings.update_repo) || "Shokydo/OmniSpec";
      api.openUrl(`https://github.com/${slug}`).catch((error) => toast(String(error), "err"));
    });
    if ($("#upd-version")) {
      api.versionInfo().then((info) => {
        const box = $("#upd-version");
        if (!box || !info) return;
        state.update.version = info.version || state.update.version;
        state.update.platform = info.platform || state.update.platform;
        box.textContent = state.update.version || "—";
        const plat = $("#upd-platform");
        if (plat) plat.textContent = state.update.platform || "—";
      }).catch(() => {});
    }
    const openData = $("#prefs-open-data");
    if (openData) openData.addEventListener("click", () => api.openPath("").catch(() => {}));
    if ($("#prefs-version")) {
      api.appInfo().then((info) => {
        const box = $("#prefs-version");
        if (box) box.textContent = info.version || "—";
      }).catch(() => {});
    }
    const javaPick = $("#set-java-pick");
    if (javaPick) javaPick.addEventListener("click", async () => {
      const picked = await api.pickFile("Выбери java.exe / javaw.exe / java", ["exe", ""]).catch(() => null);
      if (picked) { $("#set-java").value = picked; toast("Путь к Java выбран — не забудь сохранить", "ok"); }
    });
    const javaLegacyPick = $("#set-java-legacy-pick");
    if (javaLegacyPick) javaLegacyPick.addEventListener("click", async () => {
      const picked = await api.pickFile("Java 8 (для старых версий)", ["exe", ""]).catch(() => null);
      if (picked) $("#set-java-legacy").value = picked;
    });
    const javaFound = $("#java-found");
    if (javaFound) {
      api.javas().then((list) => {
        javaFound.innerHTML = list.length
          ? list.map((item) => `<button class="link-chip" data-java="${esc(item.path)}">Java ${item.major}</button>`).join("")
          : `<span class="muted">не найдено</span>`;
        $$("#java-found [data-java]").forEach((chip) => chip.addEventListener("click", () => {
          const target = $("#set-java");
          if (target) target.value = chip.dataset.java;
        }));
      }).catch(() => { javaFound.innerHTML = ""; });
    }

    // точечное сохранение: правки в полях не теряются при переключении вкладок
    const commit = (patch) => {
      state.settings = { ...(state.settings || {}), ...patch };
      return api.saveSettings(state.settings).catch(() => {});
    };
    const bindField = (selector, key, { number = false, trim = false } = {}) => {
      const el = $(selector);
      if (!el) return;
      let last = null;
      const apply = () => {
        let value = el.value;
        if (trim) value = value.trim() || null;
        if (number) value = Number(value);
        if (value === last) return;
        last = value;
        commit({ [key]: value });
      };
      el.addEventListener("change", apply);
      el.addEventListener("blur", apply);
    };
    const discordToggle = $("#set-discord-rpc");
    const discordIcon = $("#set-discord-icon");
    const discordUpload = $("#set-discord-upload");
    const discordControls = [discordToggle, discordIcon, discordUpload].filter(Boolean);
    const commitDiscord = async (key, enabled, control) => {
      const previous = key === "discord_upload_local_icon"
        ? state.settings?.[key] === true : state.settings?.[key] !== false;
      discordControls.forEach((el) => { el.disabled = true; });
      state.settings = { ...(state.settings || {}), [key]: enabled };
      const saving = api.saveSettings(state.settings);
      // Скрываем старую картинку сразу, не ожидая медленную запись на диск.
      invalidatePresenceIcon();
      syncPresence();
      try {
        await saving;
      } catch (error) {
        // Не оставляем отмеченным разрешение, которое не удалось сохранить.
        if (enabled && state.settings?.[key] === enabled) {
          state.settings = { ...(state.settings || {}), [key]: previous };
          control.classList.toggle("on", previous);
          control.setAttribute("aria-checked", String(previous));
          // Перезаписываем возможные изменения других настроек, уже стоящие в очереди.
          try { await api.saveSettings(state.settings); } catch (_) { /* покажем ошибку ниже */ }
        }
        toast(`Не удалось сохранить настройки Discord: ${error}. Проверь файл настроек; после перезапуска значение может вернуться.`, "err");
      } finally {
        discordControls.forEach((el) => { el.disabled = false; });
        invalidatePresenceIcon();
        syncPresence();
      }
    };
    if (discordToggle) discordToggle.addEventListener("click", () =>
      commitDiscord("discord_rpc", discordToggle.classList.contains("on"), discordToggle));
    if (discordIcon) discordIcon.addEventListener("click", () =>
      commitDiscord("discord_instance_icon", discordIcon.classList.contains("on"), discordIcon));
    if (discordUpload) discordUpload.addEventListener("click", () =>
      commitDiscord("discord_upload_local_icon", discordUpload.classList.contains("on"), discordUpload));
    if (memory) {
      const commitMemory = () => {
        if (memory.dataset.memoryDirty !== "true") return;
        memory.dataset.memoryDirty = "false";
        commit({ memory_mb: Number(memory.value) });
      };
      memory.addEventListener("change", commitMemory);
      memory.addEventListener("blur", commitMemory);
    }
    bindField("#set-jvm", "jvm_args");
    bindField("#set-java", "java_path", { trim: true });
    bindField("#set-java-legacy", "java_path_legacy", { trim: true });
    // тумблеры: слушаем после их собственных обработчиков, чтобы взять новое состояние
    const autoJavaToggle = $("#set-auto-java");
    if (autoJavaToggle) autoJavaToggle.addEventListener("click", () => commit({ auto_java: autoJavaToggle.classList.contains("on") }));
    [$("#set-upd-enabled"), $("#set-upd-auto"), $("#set-upd-pre")].forEach((el) => {
      if (!el) return;
      el.addEventListener("click", () => commit({
        update_enabled: $("#set-upd-enabled") ? $("#set-upd-enabled").classList.contains("on") : true,
        update_auto: $("#set-upd-auto") ? $("#set-upd-auto").classList.contains("on") : true,
        update_prerelease: $("#set-upd-pre") ? $("#set-upd-pre").classList.contains("on") : false
      }));
    });
    const soundToggle = $("#set-sound");
    if (soundToggle) soundToggle.addEventListener("click", () => commit({ sound_fx: soundToggle.classList.contains("on") }));

    // сохранение общих настроек
    const save = $("#prefs-save");
    if (save) save.addEventListener("click", saveLauncherSettings);
    const reset = $("#prefs-reset");
    if (reset) reset.addEventListener("click", async () => {
      const okReset = await askConfirm({
        title: "Сбросить настройки",
        text: "Оформление, фон, звук и Java вернутся к значениям по умолчанию.",
        ok: "Сбросить"
      });
      if (!okReset) return;
      if (displayedLauncherIcon !== "default") await chooseLauncherIcon("default");
      state.theme = applyTheme("dark");
      applyShape("soft");
      state.fx = "wave";
      applyClickFx(state.fx);
      applyAmbient("stars");
      state.wall = { wallpaper: null, fit: "cover", blur: 0, dim: 40, recent: [] };
      state.sound = { on: true, volume: 60, style: "soft" };
      applyWallpaper(state.wall);
      persistWallpaper();
      renderPrefs();
    });
  }

  async function saveLauncherSettings() {
    const settings = state.settings || {};
    const value = (selector) => { const el = $(selector); return el ? el.value : undefined; };
    const flag = (selector, fallback) => { const el = $(selector); return el ? el.classList.contains("on") : fallback; };
    const next = {
      ...settings,
      memory_mb: $("#set-memory")?.dataset.memoryDirty === "true" ? Number(value("#set-memory")) : settings.memory_mb,
      java_path: value("#set-java") !== undefined ? (value("#set-java").trim() || null) : settings.java_path,
      java_path_legacy: value("#set-java-legacy") !== undefined ? (value("#set-java-legacy").trim() || null) : settings.java_path_legacy,
      jvm_args: value("#set-jvm") !== undefined ? value("#set-jvm") : settings.jvm_args,
      auto_java: flag("#set-auto-java", settings.auto_java),
      minimize_to_tray: flag("#set-minimize-to-tray", settings.minimize_to_tray === true),
      proxy: value("#set-proxy") !== undefined ? (value("#set-proxy").trim() || null) : settings.proxy,
      ms_client_id: value("#set-ms-client") !== undefined ? (value("#set-ms-client").trim() || null) : settings.ms_client_id,
      discord_rpc: flag("#set-discord-rpc", settings.discord_rpc),
      discord_instance_icon: flag("#set-discord-icon", settings.discord_instance_icon),
      discord_upload_local_icon: flag("#set-discord-upload", settings.discord_upload_local_icon),
      update_enabled: flag("#set-upd-enabled", settings.update_enabled),
      update_auto: flag("#set-upd-auto", settings.update_auto),
      update_prerelease: flag("#set-upd-pre", settings.update_prerelease),
      theme: state.theme,
      theme_bg: state.customTheme.bg,
      theme_accent: state.customTheme.accent,
      theme_text: state.customTheme.text,
      shape: state.shape,
      ui_scale: Number(state.uiScale) || 100,
      sound_fx: state.sound.on,
      sound_volume: state.sound.volume,
      sound_style: state.sound.style || "soft",
      click_fx: state.fx,
      ambient: state.ambient || "stars",
      effect_size: Number(state.effectSize) || 100,
      trail_size: Number(state.trailSize) || TRAIL_DEFAULTS.size,
      trail_style: state.trailStyle || TRAIL_DEFAULTS.style,
      trail_length: Number(state.trailLength) || TRAIL_DEFAULTS.length,
      ambient_density: Number(state.ambientDensity) || 100,
      trail_opacity: Number(state.trailOpacity) || TRAIL_DEFAULTS.opacity,
      trail_color: state.trailColor || null,
      ambient_opacity: Number(state.ambientOpacity) || 80,
      ambient_color: state.ambientColor || null,
      trail: state.trail !== false,
      feed_grid: feedGridLevel(),
      feed_source: (state.discover && state.discover.source) || "modrinth",
      wallpaper: state.wall.wallpaper,
      wallpaper_fit: state.wall.fit,
      wallpaper_blur: state.wall.blur,
      wallpaper_dim: state.wall.dim,
      wallpaper_recent: state.wall.recent || rememberWallpaper(settings.wallpaper_recent, state.wall.wallpaper)
    };
    try {
      await api.saveSettings(next);
      // Addressed changes and wallpaper controls may have completed while this
      // older full-settings snapshot was waiting to save.
      state.settings = { ...next, language: displayedLanguage, launcher_icon: displayedLauncherIcon,
        wallpaper: state.wall.wallpaper, wallpaper_fit: state.wall.fit,
        wallpaper_blur: state.wall.blur, wallpaper_dim: state.wall.dim,
        wallpaper_recent: state.wall.recent || [],
        custom_wallpaper: state.settings?.custom_wallpaper ?? next.custom_wallpaper,
        sound_custom: state.sound.custom || {}, sound_style: state.sound.style, sound_volume: state.sound.volume, sound_fx: state.sound.on };
      toast("Настройки сохранены", "ok");
      $("#modal-prefs").hidden = true;
    } catch (err) { toast(String(err), "err"); }
  }

  /** Фон запоминается сразу: после перезапуска он должен быть тем же. */
  async function persistWallpaper() {
    const settings = state.settings || {};
    const next = {
      ...settings,
      wallpaper: state.wall.wallpaper,
      wallpaper_fit: state.wall.fit,
      wallpaper_blur: state.wall.blur,
      wallpaper_dim: state.wall.dim,
      wallpaper_recent: state.wall.recent || []
    };
    state.settings = next;
    try { await api.saveSettings(next); return true; } catch (error) { return false; }
  }

  /** Свежие впереди; собственные файлы различаются, а удаление не трогает сами файлы. */
  function rememberWallpaper(recent, current) {
    const list = normalizeWallpaperHistory(recent, state.settings?.custom_wallpaper);
    const id = current === "custom" && state.settings?.custom_wallpaper ? `custom:${state.settings.custom_wallpaper}` : current;
    if (!id || id === "custom") return list;
    return [id, ...list.filter((item) => item !== id)];
  }

  /* ==================== СКИН: МОДЕЛЬ, ПРЕСЕТЫ, ПЛАЩИ ==================== */

  /*
   * Модель скина: координаты и UV взяты ровно из Blockbench (3px / 4px руки),
   * без «на глаз». Оси как в Blockbench: X вправо, Y вверх, Z к зрителю (юг).
   * У каждой грани свой прямоугольник текстуры 64×64.
   */
  const MODEL_CLASSIC = [
      { n: "Head", b: [-4, 24, -4, 4, 32, 4], i: 0, uv: { north: [8, 8, 16, 16], east: [0, 8, 8, 16], south: [24, 8, 32, 16], west: [16, 8, 24, 16], up: [16, 8, 8, 0], down: [24, 0, 16, 8] } },
      { n: "Hat Layer", b: [-4, 24, -4, 4, 32, 4], i: 0.5, uv: { north: [40, 8, 48, 16], east: [32, 8, 40, 16], south: [56, 8, 64, 16], west: [48, 8, 56, 16], up: [48, 8, 40, 0], down: [56, 0, 48, 8] } },
      { n: "Body", b: [-4, 12, -2, 4, 24, 2], i: 0, uv: { north: [20, 20, 28, 32], east: [16, 20, 20, 32], south: [32, 20, 40, 32], west: [28, 20, 32, 32], up: [28, 20, 20, 16], down: [36, 16, 28, 20] } },
      { n: "Body Layer", b: [-4, 12, -2, 4, 24, 2], i: 0.25, uv: { north: [20, 36, 28, 48], east: [16, 36, 20, 48], south: [32, 36, 40, 48], west: [28, 36, 32, 48], up: [28, 36, 20, 32], down: [36, 32, 28, 36] } },
      { n: "Right Arm", b: [4, 12, -2, 8, 24, 2], i: 0, uv: { north: [44, 20, 48, 32], east: [40, 20, 44, 32], south: [52, 20, 56, 32], west: [48, 20, 52, 32], up: [48, 20, 44, 16], down: [52, 16, 48, 20] } },
      { n: "Right Arm Layer", b: [4, 12, -2, 8, 24, 2], i: 0.25, uv: { north: [44, 36, 48, 48], east: [40, 36, 44, 48], south: [52, 36, 56, 48], west: [48, 36, 52, 48], up: [48, 36, 44, 32], down: [52, 32, 48, 36] } },
      { n: "Left Arm", b: [-8, 12, -2, -4, 24, 2], i: 0, uv: { north: [36, 52, 40, 64], east: [32, 52, 36, 64], south: [44, 52, 48, 64], west: [40, 52, 44, 64], up: [40, 52, 36, 48], down: [44, 48, 40, 52] } },
      { n: "Left Arm Layer", b: [-8, 12, -2, -4, 24, 2], i: 0.25, uv: { north: [52, 52, 56, 64], east: [48, 52, 52, 64], south: [60, 52, 64, 64], west: [56, 52, 60, 64], up: [56, 52, 52, 48], down: [60, 48, 56, 52] } },
      { n: "Right Leg", b: [0, 0, -2, 4, 12, 2], i: 0, uv: { north: [4, 20, 8, 32], east: [0, 20, 4, 32], south: [12, 20, 16, 32], west: [8, 20, 12, 32], up: [8, 20, 4, 16], down: [12, 16, 8, 20] } },
      { n: "Right Leg Layer", b: [0, 0, -2, 4, 12, 2], i: 0.25, uv: { north: [4, 36, 8, 48], east: [0, 36, 4, 48], south: [12, 36, 16, 48], west: [8, 36, 12, 48], up: [8, 36, 4, 32], down: [12, 32, 8, 36] } },
      { n: "Left Leg", b: [-4, 0, -2, 0, 12, 2], i: 0, uv: { north: [20, 52, 24, 64], east: [16, 52, 20, 64], south: [28, 52, 32, 64], west: [24, 52, 28, 64], up: [24, 52, 20, 48], down: [28, 48, 24, 52] } },
      { n: "Left Leg Layer", b: [-4, 0, -2, 0, 12, 2], i: 0.25, uv: { north: [4, 52, 8, 64], east: [0, 52, 4, 64], south: [12, 52, 16, 64], west: [8, 52, 12, 64], up: [8, 52, 4, 48], down: [12, 48, 8, 52] } }
    ];

  const MODEL_SLIM = [
      { n: "Head", b: [-4, 24, -4, 4, 32, 4], i: 0, uv: { north: [8, 8, 16, 16], east: [0, 8, 8, 16], south: [24, 8, 32, 16], west: [16, 8, 24, 16], up: [16, 8, 8, 0], down: [24, 0, 16, 8] } },
      { n: "Hat Layer", b: [-4, 24, -4, 4, 32, 4], i: 0.5, uv: { north: [40, 8, 48, 16], east: [32, 8, 40, 16], south: [56, 8, 64, 16], west: [48, 8, 56, 16], up: [48, 8, 40, 0], down: [56, 0, 48, 8] } },
      { n: "Body", b: [-4, 12, -2, 4, 24, 2], i: 0, uv: { north: [20, 20, 28, 32], east: [16, 20, 20, 32], south: [32, 20, 40, 32], west: [28, 20, 32, 32], up: [28, 20, 20, 16], down: [36, 16, 28, 20] } },
      { n: "Body Layer", b: [-4, 12, -2, 4, 24, 2], i: 0.25, uv: { north: [20, 36, 28, 48], east: [16, 36, 20, 48], south: [32, 36, 40, 48], west: [28, 36, 32, 48], up: [28, 36, 20, 32], down: [36, 32, 28, 36] } },
      { n: "Right Arm", b: [4, 12, -2, 7, 24, 2], i: 0, uv: { north: [44, 20, 47, 32], east: [40, 20, 44, 32], south: [51, 20, 54, 32], west: [47, 20, 51, 32], up: [47, 20, 44, 16], down: [50, 16, 47, 20] } },
      { n: "Right Arm Layer", b: [4, 12, -2, 7, 24, 2], i: 0.25, uv: { north: [44, 36, 47, 48], east: [40, 36, 44, 48], south: [51, 36, 54, 48], west: [47, 36, 51, 48], up: [47, 36, 44, 32], down: [50, 32, 47, 36] } },
      { n: "Left Arm", b: [-7, 12, -2, -4, 24, 2], i: 0, uv: { north: [36, 52, 39, 64], east: [32, 52, 36, 64], south: [43, 52, 46, 64], west: [39, 52, 43, 64], up: [39, 52, 36, 48], down: [42, 48, 39, 52] } },
      { n: "Left Arm Layer", b: [-7, 12, -2, -4, 24, 2], i: 0.25, uv: { north: [52, 52, 55, 64], east: [48, 52, 52, 64], south: [59, 52, 62, 64], west: [55, 52, 59, 64], up: [55, 52, 52, 48], down: [58, 48, 55, 52] } },
      { n: "Right Leg", b: [0, 0, -2, 4, 12, 2], i: 0, uv: { north: [4, 20, 8, 32], east: [0, 20, 4, 32], south: [12, 20, 16, 32], west: [8, 20, 12, 32], up: [8, 20, 4, 16], down: [12, 16, 8, 20] } },
      { n: "Right Leg Layer", b: [0, 0, -2, 4, 12, 2], i: 0.25, uv: { north: [4, 36, 8, 48], east: [0, 36, 4, 48], south: [12, 36, 16, 48], west: [8, 36, 12, 48], up: [8, 36, 4, 32], down: [12, 32, 8, 36] } },
      { n: "Left Leg", b: [-4, 0, -2, 0, 12, 2], i: 0, uv: { north: [20, 52, 24, 64], east: [16, 52, 20, 64], south: [28, 52, 32, 64], west: [24, 52, 28, 64], up: [24, 52, 20, 48], down: [28, 48, 24, 52] } },
      { n: "Left Leg Layer", b: [-4, 0, -2, 0, 12, 2], i: 0.25, uv: { north: [4, 52, 8, 64], east: [0, 52, 4, 64], south: [12, 52, 16, 64], west: [8, 52, 12, 64], up: [8, 52, 4, 48], down: [12, 48, 8, 52] } }
    ];

  const SKIN_MODEL = {
    classic: MODEL_CLASSIC,
    slim: MODEL_SLIM
  };

  /**
   * Плащ 10×16×1, закреплён у плеч и немного отклонён от спины,
   * как в Minecraft. Внешняя сторона официальной текстуры — 1..11 × 1..17;
   * 12..22 — подкладка. Отдельный наклон не должен вращать остальную модель.
   */
  const SKIN_CAPE = {
    n: "Cape",
    b: [-5, 8, 2.25, 5, 24, 3.25],
    i: 0,
    cape: true,
    uv: {
      // Порядок координат важен: наружную сторону Minecraft поворачивает
      // вместе с моделью, а не зеркалит. Верх/низ имеют ширину 10 пикселей.
      south: [11, 1, 1, 17],
      north: [22, 1, 12, 17],
      east: [1, 1, 0, 17],
      west: [12, 1, 11, 17],
      up: [1, 1, 11, 0],
      down: [21, 0, 11, 1]
    }
  };

  const SKIN_FACE_NORMALS = {
    north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0],
    west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0]
  };

  /** Четыре угла каждой грани коробки: [верх-лево, верх-право, низ-право, низ-лево]. */
  function skinFaceCorners(box, inflate) {
    const [x0, y0, z0, x1, y1, z1] = box;
    const ix0 = x0 - inflate, iy0 = y0 - inflate, iz0 = z0 - inflate;
    const ix1 = x1 + inflate, iy1 = y1 + inflate, iz1 = z1 + inflate;
    return {
      north: [[ix1, iy1, iz0], [ix0, iy1, iz0], [ix0, iy0, iz0], [ix1, iy0, iz0]],
      south: [[ix0, iy1, iz1], [ix1, iy1, iz1], [ix1, iy0, iz1], [ix0, iy0, iz1]],
      east: [[ix1, iy1, iz1], [ix1, iy1, iz0], [ix1, iy0, iz0], [ix1, iy0, iz1]],
      west: [[ix0, iy1, iz0], [ix0, iy1, iz1], [ix0, iy0, iz1], [ix0, iy0, iz0]],
      up: [[ix1, iy1, iz1], [ix0, iy1, iz1], [ix0, iy1, iz0], [ix1, iy1, iz0]],
      down: [[ix0, iy0, iz0], [ix1, iy0, iz0], [ix1, iy0, iz1], [ix0, iy0, iz1]]
    };
  }

  /**
   * Отрисовка модели в canvas: второй слой поверх, грани отвёрнутые от камеры не рисуем,
   * дальние — первыми. `yaw` крутит вокруг оси Y, `pitch` наклоняет (плюс — камера сверху).
   */
  function drawSkinModel(canvas, texture, variant, yawDeg, pitchDeg, capeTexture, options = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Minecraft-текстура состоит из жёстких пикселей: сглаживание canvas
    // превращает увеличенную модель в «мыльную», особенно на WebView2.
    ctx.imageSmoothingEnabled = false;
    const capeOnly = options.capeOnly === true;
    if (capeOnly ? !capeTexture : !texture) return;

    const yaw = (Number(yawDeg) || 0) * Math.PI / 180;
    const pitch = (Number(pitchDeg) || 0) * Math.PI / 180;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = -Math.sin(pitch);

    const rotate = ([x, y, z]) => {
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
    };

    // Масштаб постоянный: модель не «дышит» при вращении. Для отдельной
    // миниатюры плаща увеличиваем ту же трёхмерную деталь, а не плоский кроп.
    const unit = capeOnly ? Math.min(W / 16, H / 22) : Math.min(W / 24, H / 38);
    const originX = W / 2;
    const originY = H / 2;
    const project = ([x, y, z]) => [originX + x * unit, originY - (y - 16) * unit, z];

    const parts = capeOnly ? [] : (SKIN_MODEL[variant] || SKIN_MODEL.classic).slice();
    // плащ — отдельная деталь со своей картинкой (64×32), показываем, если он есть
    if (capeTexture) parts.push({ ...SKIN_CAPE, tex: capeTexture });

    const faces = [];
    const capeAngle = 10.8 * Math.PI / 180;
    const capeCos = Math.cos(capeAngle), capeSin = Math.sin(capeAngle);
    const tiltCape = ([x, y, z]) => {
      const dy = y - 24, dz = z - 2.25;
      return [x, 24 + dy * capeCos + dz * capeSin, 2.25 + dz * capeCos - dy * capeSin];
    };
    const tiltCapeNormal = ([x, y, z]) => [x, y * capeCos + z * capeSin, z * capeCos - y * capeSin];
    parts.forEach((part) => {
      const corners = skinFaceCorners(part.b, part.i);
      Object.keys(part.uv).forEach((dir) => {
        const normal = rotate(part.cape ? tiltCapeNormal(SKIN_FACE_NORMALS[dir]) : SKIN_FACE_NORMALS[dir]);
        if (normal[2] >= -0.001) return; // грань смотрит от камеры
        const pts = corners[dir].map((point) => rotate(part.cape ? tiltCape(point) : point)).map(project);
        faces.push({ uv: part.uv[dir], pts, cape: part.cape, part: part.n, tex: part.tex || texture, depth: (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4 });
      });
    });

    // дальние (больший z) — раньше, ближние — поверх. Одной общей сортировки
    // недостаточно: на виде со спины средняя глубина корпуса может оказаться
    // после плаща и нарисовать скин поверх его непрозрачной части. Сначала
    // рисуем модель и наружную сторону плаща отдельными слоями. На виде со
    // спины весь непрозрачный плащ должен быть последним: ни торс, ни часть
    // конечности не может случайно проступить сквозь его текстуру.
    const drawFaces = (items) => {
      items.slice().sort((a, b) => b.depth - a.depth).forEach((face) => {
        const [p0, p1, , p3] = face.pts;
        const u1 = Math.min(face.uv[0], face.uv[2]);
        const u2 = Math.max(face.uv[0], face.uv[2]);
        const v1 = Math.min(face.uv[1], face.uv[3]);
        const v2 = Math.max(face.uv[1], face.uv[3]);
        const uw = u2 - u1;
        const vh = v2 - v1;
        if (uw <= 0 || vh <= 0) return;
        ctx.save();
        ctx.beginPath();
        face.pts.forEach((point, index) => (index ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1])));
        ctx.closePath();
        ctx.clip();
        // аффинное преобразование: прямоугольник текстуры → четырёхугольник на экране
        // У плаща UV могут идти в обратном направлении; игнорирование знака
        // зеркалило рисунок. Поведение старой модели скина не меняем.
        const flipU = face.cape && face.uv[0] > face.uv[2];
        const flipV = face.cape && face.uv[1] > face.uv[3];
        const a = (p1[0] - p0[0]) / (flipU ? -uw : uw), b = (p1[1] - p0[1]) / (flipU ? -uw : uw);
        const c = (p3[0] - p0[0]) / (flipV ? -vh : vh), d = (p3[1] - p0[1]) / (flipV ? -vh : vh);
        const startU = flipU ? u2 : u1, startV = flipV ? v2 : v1;
        const e = p0[0] - a * startU - c * startV, f = p0[1] - b * startU - d * startV;
        ctx.setTransform(a, b, c, d, e, f);
        // Явно сбрасываем состояние композиции: canvas мог использоваться
        // предыдущим кадром с прозрачной текстурой миниатюры.
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.drawImage(face.tex, 0, 0);
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      });
    };
    const capeFaces = faces.filter((face) => face.cape);
    const skinFaces = faces.filter((face) => !face.cape);
    if (!capeFaces.length || capeOnly) {
      drawFaces(faces);
    } else {
      const outerNormal = rotate(tiltCapeNormal(SKIN_FACE_NORMALS.south));
      const outerSideVisible = outerNormal[2] < -0.001;
      if (outerSideVisible) {
        // Наружная сторона смотрит на пользователя: плащ — непроницаемый
        // верхний слой, поэтому скин под ним больше не просвечивает.
        drawFaces(skinFaces);
        drawFaces(capeFaces);
      } else {
        // Спереди плащ находится за корпусом и должен оставаться под моделью.
        drawFaces(capeFaces);
        drawFaces(skinFaces);
      }
    }
  }

  /** Размер канваса под реальный размер блока: без мыла при любом зуме интерфейса. */
  function skinCanvasSize(canvas, cssWidth, cssHeight) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }

  /** Состояние раздела «Скин» (живёт в профиле). */
  function skinState() {
    if (!state.skin) {
      state.skin = {
        selectedSkin: null, variant: "classic", yaw: -18, pitch: 6, licensed: false, touchedVariant: false,
        currentPath: "", currentName: "", texture: null, dataUrl: "", fromAccount: false,
        accountTexture: null, requestSerial: 0, selectionRevision: 0, loading: false, error: "", notice: ""
      };
    }
    return state.skin;
  }

  /** Старый ключ настроек остаётся совместимым с уже сохранёнными скинами. */
  function userSkinLibrary() {
    const list = state.settings && Array.isArray(state.settings.skin_presets) ? state.settings.skin_presets : [];
    return list.filter((item) => item && item.id && item.path);
  }

  function findLibrarySkin(id) {
    return userSkinLibrary().find((item) => item.id === id) || null;
  }

  /** Строка под кнопками: обновляется без перерисовки всего профиля. */
  /** Избранные образы: скин + плащ, ровно пять слотов под списком аккаунтов. */
  const FAV_SLOTS = 5;

  function skinFavorites() {
    const list = state.settings && Array.isArray(state.settings.skin_favorites) ? state.settings.skin_favorites : [];
    return list.filter((item) => item && item.id).slice(0, FAV_SLOTS);
  }

  async function saveSkinFavorites(next) {
    const favorites = next.slice(0, FAV_SLOTS);
    const updated = { ...(state.settings || {}), skin_favorites: favorites };
    try {
      await api.saveSettings(updated);
      state.settings = { ...(state.settings || {}), skin_favorites: favorites };
      renderPrefs();
      return true;
    } catch (error) {
      toast(`Не удалось сохранить избранное: ${error}`, "err");
      return false;
    }
  }

  function activeCapeId(capes = capeState()) {
    return ((capes.list || []).find((cape) => cape.active) || {}).id || "";
  }

  // Выделенный вариант может ещё применяться к аккаунту. Пустая строка —
  // сознательный выбор «Без плаща», null — выбор пока не инициализирован.
  function selectedCapeId(capes = capeState()) {
    const selected = capes.selectedId;
    if (typeof selected === "string" && (!selected || (capes.list || []).some((cape) => cape.id === selected))) return selected;
    return activeCapeId(capes);
  }

  function capeAliasOf(id) {
    const list = capeState().list || [];
    return (list.find((cape) => cape.id === id) || {}).alias || "";
  }

  /** Пять слотов: занятые образы, «+» для нового и пустые рамки до пяти. */
  function favoriteSlotsHtml() {
    const favorites = skinFavorites();
    const filled = favorites.map((fav) => `
      <button class="fav-slot ${fav.id === (skinState().favorite || "") ? "is-active" : ""}" data-fav="${esc(fav.id)}" title="${esc(fav.name)}">
        <span class="skin-mini fav-mini" data-fav-src="${esc(fav.skinDataUrl || "")}" data-fav-cape="${esc(fav.capeDataUrl || "")}"></span>
        <span class="fav-name" translate="no">${esc(fav.name)}</span>
        <span class="fav-cape" ${fav.capeAlias ? 'translate="no"' : ""}>${esc(fav.capeAlias || "без плаща")}</span>
        <span class="preset-del" data-del-fav="${esc(fav.id)}" title="Удалить образ">×</span>
      </button>`);
    const canAdd = favorites.length < FAV_SLOTS;
    const add = canAdd
      ? `<button class="fav-slot is-empty" id="fav-add" title="Сохранить текущий скин и плащ">
          <svg class="ic"><use href="#i-plus"/></svg>
          <span class="fav-name">образ</span>
        </button>`
      : "";
    const placeholders = Array.from({ length: Math.max(0, FAV_SLOTS - filled.length - (canAdd ? 1 : 0)) })
      .map(() => '<span class="fav-slot is-blank" aria-hidden="true"></span>');
    return `<div class="fav-slots" id="skin-favorites">${filled.join("")}${add}${placeholders.join("")}</div>`;
  }

  /** Мини-модели образов рисуем из сохранённого PNG — файл искать не нужно. */
  function paintFavoriteMinis() {
    $$("#skin-favorites [data-fav-src]").forEach(async (slot) => {
      const src = slot.dataset.favSrc;
      if (!src) return;
      const texture = await textureFromImage(src);
      if (!texture) return;
      const cape = slot.dataset.favCape ? await textureFromImage(slot.dataset.favCape) : null;
      paintSkinMini(slot, texture, cape);
    });
  }

  async function applyFavorite(fav) {
    const skin = skinState();
    const accountId = currentProfileId();
    let loaded = false;
    if (fav.skinPath) {
      const revision = skin.selectionRevision + 1;
      loaded = await loadSkinFile(fav.skinPath, fav.skinName || fav.name, null);
      if (state.skin !== skin || currentProfileId() !== accountId || skin.selectionRevision !== revision) return;
    }
    if (!loaded && fav.skinDataUrl) {
      const revision = ++skin.selectionRevision;
      const texture = await textureFromImage(fav.skinDataUrl);
      if (state.skin !== skin || currentProfileId() !== accountId || skin.selectionRevision !== revision) return;
      if (texture) {
        skin.texture = texture;
        skin.dataUrl = fav.skinDataUrl;
        skin.currentPath = "";
        skin.currentName = fav.skinName || fav.name;
        skin.fromAccount = false;
        loaded = true;
      }
    }
    if (!loaded) return toast("Скин из образа не читается — сохрани образ заново", "err");
    skin.variant = fav.variant === "slim" ? "slim" : "classic";
    skin.touchedVariant = true;
    if (Number.isFinite(Number(fav.angle))) skin.yaw = Number(fav.angle);
    skin.favorite = fav.id;

    // Плащ меняется только у лицензии через Mojang. При отказе не показываем
    // чужой плащ так, будто он действительно надет на аккаунт.
    const capes = capeState();
    const wanted = fav.capeId || "";
    let capeError = "";
    if (capes.licensed && (capes.loading || capes.busy || capes.selectionTimer)) {
      capeError = "дождись завершения предыдущего изменения плаща";
    } else if (capes.licensed && wanted !== activeCapeId(capes)) {
      capes.busy = true;
      try {
        ++capes.requestSerial; capes.loading = false;
        const result = await setCapeSerialized(capes, wanted, accountId);
        if (result === CAPE_CANCELLED || state.capes !== capes || state.skin !== skin || currentProfileId() !== accountId) return;
        capes.list.forEach((cape) => { cape.active = wanted ? cape.id === wanted : false; });
        capes.selectedId = activeCapeId(capes);
      } catch (error) { capeError = String(error); }
      finally { capes.busy = false; }
    }
    if (state.capes !== capes || state.skin !== skin || currentProfileId() !== accountId) return;
    await loadCapeTexture(capeError ? selectedCapeId(capes) : activeCapeId(capes));
    if (state.skin !== skin || currentProfileId() !== accountId) return;
    skin.selectedSkin = null;
    renderPrefs();
    if (capeError) toast(`Скин выбран; плащ не применён: ${capeError}`, "err");
    else toast(`Образ «${fav.name}» выбран. Чтобы сменить скин, нажми «Применить к аккаунту».`, "ok");
  }

  async function saveFavorite() {
    const skin = skinState();
    if (!skin.texture) return toast("Сначала выбери скин", "err");
    const favorites = skinFavorites();
    if (favorites.length >= FAV_SLOTS) return toast(`Образов не больше ${FAV_SLOTS} — удали один`, "err");
    const capes = capeState();
    if (capes.loading || capes.busy || capes.selectionTimer) return toast("Дождись завершения изменения плаща", "err");
    const capeId = activeCapeId(capes);
    const capeAlias = capeId ? capeAliasOf(capeId) : "";
    const capeEntry = (capes.list || []).find((cape) => cape.id === capeId);
    const capeDataUrl = (capeEntry && capeEntry.data_url) || "";
    const name = await promptModal({
      title: "Сохранить образ",
      label: "Название",
      value: `${skin.currentName || "Скин"} + ${capeAlias || "без плаща"}`
    });
    if (!name) return;
    const favorite = {
      id: `fav-${Date.now().toString(36)}`,
      name,
      skinPath: skin.currentPath || "",
      skinDataUrl: skin.dataUrl || "",
      skinName: skin.currentName || name,
      variant: skin.variant === "slim" ? "slim" : "classic",
      capeId,
      capeAlias,
      capeDataUrl,
      angle: Math.round(Number(skin.yaw) || 0)
    };
    if (!await saveSkinFavorites([...favorites, favorite])) return;
    skin.favorite = favorite.id;
    renderPrefs();
    toast(`Образ «${name}» сохранён`, "ok");
  }

  function bindFavorites() {
    paintFavoriteMinis();
    const add = $("#fav-add");
    if (add) add.addEventListener("click", saveFavorite);
    $$("#skin-favorites .fav-slot[data-fav]").forEach((slot) => {
      slot.addEventListener("click", () => {
        const fav = skinFavorites().find((item) => item.id === slot.dataset.fav);
        if (fav) applyFavorite(fav);
      });
      const del = slot.querySelector("[data-del-fav]");
      if (del) del.addEventListener("click", async (event) => {
        event.stopPropagation();
        const next = skinFavorites().filter((item) => item.id !== del.dataset.delFav);
        if (!await saveSkinFavorites(next)) return;
        if (skinState().favorite === del.dataset.delFav) skinState().favorite = "";
        renderPrefs();
        toast("Образ удалён", "ok");
      });
    });
  }

  function skinStatusText() {
    const skin = skinState();
    const variant = skin.variant === "slim" ? "slim, руки 3 px" : "wide, руки 4 px";
    let text = skin.fromAccount && skin.accountNameDefault
      ? `Выбран скин аккаунта · ${variant}.${skin.licensed ? "" : " Смена скина доступна только лицензионному аккаунту."}`
      : skin.currentName
      ? `Выбран скин «${skin.currentName}» · ${variant}.${skin.licensed ? "" : " Смена скина доступна только лицензионному аккаунту."}`
      : skin.licensed ? "Загрузи PNG 64×64, чтобы поставить новый скин."
        : "Смена скина возможна только у лицензионного аккаунта.";
    if (skin.loading) text += " Загружаем скин аккаунта…";
    else if (skin.error) text += ` Не удалось обновить скин: ${skin.error}`;
    else if (skin.notice) text += ` ${skin.notice}`;
    return text;
  }

  /** Перерисовать только строку статуса. */
  function refreshSkinStatus() {
    const el = $("#skin-status");
    if (el) el.textContent = skinStatusText();
  }

  /** Аватар: модель и библиотека сверху, горизонтальный гардероб плащей снизу. */
  function prefsAvatar() {
    const skin = skinState();
    const licensed = Boolean(skin.licensed);
    const library = userSkinLibrary();
    const variant = skin.variant === "slim" ? "slim" : "classic";
    return `
      <div class="avatar-layout">
        <section class="prefs-section profile-model skin-section">
          <div class="prefs-label-row">
            <span class="prefs-label">Модель игрока</span><div class="spacer"></div>
            <button class="icon-btn" id="skin-refresh" title="Обновить скин аккаунта"><svg class="ic"><use href="#i-refresh"/></svg></button>
          </div>
          <div class="skin-stage ${skin.texture ? "" : "is-empty"}">
            ${skin.texture ? '<canvas id="skin-canvas"></canvas><span class="skin-stage-hint">ЛКМ — повернуть</span>'
              : '<div class="skin-stage-empty">Скин появится здесь в объёме.<br>Выбери PNG 64×64.</div>'}
          </div>
          <div class="skin-model-options">
            <div class="skin-top-label">Ширина рук</div>
            <div class="chips" id="skin-variant">
              <button class="chip ${variant === "classic" ? "is-active" : ""}" data-variant="classic">Wide · 4 px</button>
              <button class="chip ${variant === "slim" ? "is-active" : ""}" data-variant="slim">Slim · 3 px</button>
            </div>
          </div>
          <button class="btn btn-primary skin-apply" id="skin-apply" ${licensed ? "" : "disabled"}>Применить к аккаунту</button>
          <div class="skin-note ${licensed ? "" : "warn"}" id="skin-status">${esc(skinStatusText())}</div>
        </section>
        <div class="avatar-collection">
          <section class="prefs-section profile-favorites">
            <div class="prefs-label-row"><span class="prefs-label">Избранные образы</span><div class="spacer"></div><span class="muted avatar-fav-count">скин + плащ · до ${FAV_SLOTS}</span></div>
            ${favoriteSlotsHtml()}
          </section>
          <section class="prefs-section profile-skins">
          <div class="prefs-label-row"><span class="prefs-label">Скины <span class="muted">${library.length}</span></span><div class="spacer"></div>
            <button class="btn btn-small" id="skin-upload" ${skin.importing ? "disabled" : ""}><svg class="ic"><use href="#i-plus"/></svg>${skin.importing ? "Загружаем…" : "Загрузить PNG…"}</button>
          </div>
          <div class="skin-note">Выбери один или несколько PNG 64×64 / 64×32. Они сразу сохранятся в библиотеке.</div>
          ${skin.importErrors?.length ? `<div class="skin-import-errors" role="alert"><b>Не удалось загрузить ${skin.importErrors.length}:</b> ${skin.importErrors.map(esc).join("; ")}</div>` : ""}
          <div class="skin-library" id="skin-library" tabindex="0" role="region" aria-label="Библиотека скинов">
            ${library.length ? library.map((item) => `
              <div class="skin-library-item ${item.id === skin.selectedSkin ? "is-active" : ""}">
                <button class="skin-library-select" data-skin-id="${esc(item.id)}" title="${esc(item.name)}">
                  <span class="skin-mini" data-thumb-path="${esc(item.path)}"></span><span class="skin-library-name" translate="no">${esc(item.name)}</span>
                </button>
                <button class="skin-library-remove" data-del-skin="${esc(item.id)}" title="Убрать из библиотеки" aria-label="Убрать ${esc(item.name)} из библиотеки">×</button>
              </div>`).join("") : '<div class="skin-note">Библиотека пуста — загрузи свои скины.</div>'}
          </div>
          </section>
        </div>
        <section class="prefs-section profile-capes">
          <div class="prefs-label-row"><span class="prefs-label">Плащи</span><span class="avatar-cape-hint" id="cape-status" role="status" aria-live="polite">${capeStatusText(capeState())}</span><div class="spacer"></div>
            <div class="cape-view-switch" role="group" aria-label="Вид плащей">
              <button type="button" class="btn btn-small cape-view-btn ${capeView() === "list" ? "is-active" : ""}" id="cape-view-list" aria-label="Список плащей" title="Список плащей" aria-pressed="${capeView() === "list"}"><svg class="ic"><use href="#i-list"/></svg><span>Список</span></button>
              <button type="button" class="btn btn-small cape-view-btn ${capeView() === "grid" ? "is-active" : ""}" id="cape-view-grid" aria-label="Плитка плащей" title="Плитка плащей" aria-pressed="${capeView() === "grid"}"><svg class="ic"><use href="#i-grid"/></svg><span>Плитка</span></button>
            </div>
            <button class="icon-btn" id="cape-refresh" title="Обновить плащи аккаунта"><svg class="ic"><use href="#i-refresh"/></svg></button>
          </div>
          ${capeColumnHtml()}
        </section>
      </div>`;
  }

  /** Показываем только официальные плащи текущего аккаунта. */
  function capeColumnHtml() {
    const capes = capeState();
    const licensed = Boolean(capes.licensed);
    const list = capes.list || [];
    const selectedId = selectedCapeId(capes);
    const view = capeView();
    const cards = list.map((cape) => `
      <button type="button" class="cape-card ${cape.id === selectedId ? "is-active" : ""}" data-cape-id="${esc(cape.id)}" title="${esc(cape.alias)}" aria-pressed="${cape.id === selectedId}">
        <canvas class="cape-thumb" width="108" height="128" data-cape-src="${esc(cape.data_url || "")}" aria-hidden="true"></canvas>
        <span class="cape-name" translate="no">${esc(cape.alias)}</span>
      </button>`).join("");
    return `
      <div class="cape-carousel ${view === "grid" ? "is-grid-view" : "is-list-view"}">
        <button type="button" class="icon-btn cape-scroll cape-scroll-prev" id="cape-prev" aria-controls="skin-capes" title="Выбрать предыдущий плащ" aria-label="Выбрать предыдущий плащ" disabled><svg class="ic"><use href="#i-chev"/></svg></button>
        <div class="cape-list ${view === "grid" ? "is-grid" : "is-list"}" id="skin-capes" data-cape-view="${view}" tabindex="0" role="region" aria-label="Гардероб плащей" aria-busy="${Boolean(capes.selectionTimer || (capes.busy && capes.mutationKind === "wardrobe"))}">
          <button type="button" class="cape-card cape-off ${selectedId ? "" : "is-active"}" data-cape-id="" title="Снять плащ" aria-pressed="${!selectedId}">
            <span class="cape-thumb cape-thumb-off"><svg class="ic"><use href="#i-minus"/></svg></span>
            <span class="cape-name">Без плаща</span>
          </button>
          ${cards}
          ${!licensed ? `<div class="cape-note">Плащи есть только у лицензионного аккаунта.</div>`
            : (capes.error && !capes.loading ? `<div class="cape-note">${esc(capes.error)}</div>`
              : (!list.length && !capes.loading ? `<div class="cape-note">У аккаунта нет плащей.</div>` : ""))}
          ${capes.loading ? `<div class="cape-note">Загружаем плащи…</div>` : ""}
        </div>
        <button type="button" class="icon-btn cape-scroll cape-scroll-next" id="cape-next" aria-controls="skin-capes" title="Выбрать следующий плащ" aria-label="Выбрать следующий плащ" disabled><svg class="ic"><use href="#i-chev"/></svg></button>
      </div>`;
  }

  /* ==================== ПЛАЩИ АККАУНТА ==================== */
  // Не допускаем одновременных записей одного аккаунта даже при быстром
  // переключении на другой аккаунт и обратно. Разные аккаунты независимы.
  const capeMutations = new Map();
  const CAPE_CANCELLED = Symbol("cape-cancelled");
  const CAPE_SELECTION_DELAY = 650;

  function capeAccountKey(accountId) { return String(accountId || "").toLowerCase().replace(/-/g, ""); }

  function capeState() {
    if (!state.capes) state.capes = { licensed: false, list: [], loading: false, error: "", busy: false,
      requestSerial: 0, textureRevision: 0, selectedId: null, selectionTimer: null, selectionDueAt: 0, mutationKind: "" };
    return state.capes;
  }

  function capeView() {
    return state.capeView === "grid" ? "grid" : "list";
  }

  function setCapeView(view) {
    const next = view === "grid" ? "grid" : "list";
    if (state.capeView === next) return;
    state.capeView = next;
    state.settings = { ...(state.settings || {}), cape_view: next };
    // Рендерим сразу: переключатель не должен ждать записи settings.json.
    renderPrefs();
    api.saveSettings(state.settings).catch(() => {});
  }

  function capeStatusText(capes) {
    return capes.selectionTimer || (capes.busy && capes.mutationKind === "wardrobe")
      ? "Применяем плащ…" : "Стрелки и колесо — выбор плаща";
  }

  function setCapeSerialized(capes, id, accountId) {
    const key = capeAccountKey(accountId);
    const previous = capeMutations.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      // Ожидание предыдущего запроса не должно применить плащ к другому
      // профилю, если пользователь успел сменить аккаунт.
      if (state.capes !== capes || currentProfileId() !== accountId || !capes.licensed) return CAPE_CANCELLED;
      return api.setCape(id || null, accountId);
    });
    capeMutations.set(key, next);
    const cleanup = () => { if (capeMutations.get(key) === next) capeMutations.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  }

  /** Та же объёмная деталь, что и на модели, повернута спиной в три четверти. */
  function paintCapeThumb(canvas, src) {
    if (!canvas || !src) return;
    const image = new Image();
    image.onload = () => {
      if (!canvas.isConnected) return;
      drawSkinModel(canvas, null, "classic", 154, 7, image, { capeOnly: true });
      canvas.dataset.capeRendered = "3d";
    };
    image.src = src;
  }

  /** Предпросмотр выделенного или уже применённого плаща на модели. */
  async function loadCapeTexture(id = activeCapeId()) {
    const capes = capeState();
    const accountId = currentProfileId();
    const revision = ++capes.textureRevision;
    const cape = (capes.list || []).find((item) => item.id === id);
    const src = (cape && cape.data_url) || "";
    if (!src) {
      state.capeTexture = null;
      state.capeTextureSrc = "";
      return null;
    }
    if (state.capeTexture && state.capeTextureSrc === src) return state.capeTexture;
    const texture = await textureFromImage(src);
    if (state.capes !== capes || currentProfileId() !== accountId || capes.textureRevision !== revision) return null;
    state.capeTexture = texture || null;
    state.capeTextureSrc = texture ? src : "";
    return state.capeTexture;
  }

  async function refreshAccountCapes() {
    const capes = capeState();
    if (capes.busy || capes.selectionTimer) return false;
    const active = activeAccount();
    const accountId = active?.uuid || "";
    const request = ++capes.requestSerial;
    const current = () => state.capes === capes && currentProfileId() === accountId && capes.requestSerial === request;
    capes.licensed = Boolean(active && active.kind === "microsoft");
    capes.loading = capes.licensed;
    capes.error = "";
    if (!capes.licensed) { capes.list = []; capes.selectedId = ""; await loadCapeTexture(); return false; }
    try {
      // После возврата на аккаунт дождаться его предыдущей записи, иначе
      // запоздавший PUT/DELETE может сделать только что загруженный список устаревшим.
      const mutation = capeMutations.get(capeAccountKey(accountId));
      if (mutation) await mutation.catch(() => {});
      if (!current()) return false;
      const info = await api.accountCapes(accountId);
      if (!current()) return false;
      if (!info || !info.licensed) throw new Error("сервер не подтвердил профиль Minecraft");
      if (info.account_uuid && String(info.account_uuid).toLowerCase().replace(/-/g, "") !== String(accountId).toLowerCase().replace(/-/g, "")) {
        throw new Error("сервер вернул профиль другого аккаунта");
      }
      capes.list = Array.isArray(info.capes) ? info.capes : [];
      capes.selectedId = activeCapeId(capes);
      capes.error = info.warning || "";
      await loadCapeTexture();
      return current();
    } catch (error) {
      if (current()) capes.error = String(error?.message || error || "не удалось получить плащи");
      return false;
    } finally {
      if (current()) capes.loading = false;
    }
  }

  function updateCapeScrollControls() {
    const list = $("#skin-capes");
    const prev = $("#cape-prev");
    const next = $("#cape-next");
    if (!list || !prev || !next) return;
    const capes = capeState();
    const cards = $$(".cape-card", list);
    const index = cards.findIndex((card) => card.dataset.capeId === selectedCapeId(capes));
    const blocked = !capes.licensed || capes.loading || (capes.busy && capes.mutationKind !== "wardrobe");
    prev.disabled = blocked || index <= 0;
    next.disabled = blocked || index < 0 || index >= cards.length - 1;
  }

  function centerCapeCard(card, list = $("#skin-capes")) {
    if (!card || !list) return;
    if (capeView() !== "list") {
      card.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const max = Math.max(0, list.scrollWidth - list.clientWidth);
    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const contentLeft = list.scrollLeft + cardRect.left - listRect.left;
    const left = Math.max(0, Math.min(max, contentLeft + cardRect.width / 2 - list.clientWidth / 2));
    list.scrollLeft = left;
  }

  function updateCapeSelectionUI(capes) {
    if (state.capes !== capes) return;
    const list = $("#skin-capes");
    if (!list) return;
    const id = selectedCapeId(capes);
    $$(".cape-card", list).forEach((card) => {
      const selected = card.dataset.capeId === id;
      card.classList.toggle("is-active", selected);
      card.setAttribute("aria-pressed", String(selected));
    });
    const busy = Boolean(capes.selectionTimer || (capes.busy && capes.mutationKind === "wardrobe"));
    list.setAttribute("aria-busy", String(busy));
    const status = $("#cape-status");
    if (status) status.textContent = capeStatusText(capes);
    updateCapeScrollControls();
  }

  function previewCapeSelection(capes, id, accountId) {
    loadCapeTexture(id).then(() => {
      if (state.capes === capes && currentProfileId() === accountId && selectedCapeId(capes) === id) redrawSkinPreview();
    });
  }

  function clearCapeSelectionTimer(capes) {
    if (capes.selectionTimer) clearTimeout(capes.selectionTimer);
    capes.selectionTimer = null;
  }

  function scheduleCapeSelection(capes, accountId) {
    clearCapeSelectionTimer(capes);
    capes.selectionTimer = setTimeout(() => {
      capes.selectionTimer = null;
      void commitCapeSelection(capes, accountId);
    }, Math.max(0, capes.selectionDueAt - Date.now()));
  }

  async function commitCapeSelection(capes, accountId) {
    if (state.capes !== capes || currentProfileId() !== accountId || !capes.licensed) return;
    // Пока один запрос в пути, запоминаем только последний выбор; следующий
    // запрос запустится после первого, никогда параллельно с ним.
    if (capes.busy) { updateCapeSelectionUI(capes); return; }
    const id = selectedCapeId(capes);
    if (id === activeCapeId(capes)) { updateCapeSelectionUI(capes); return; }
    capes.busy = true;
    capes.mutationKind = "wardrobe";
    updateCapeSelectionUI(capes);
    let success = false;
    try {
      const result = await setCapeSerialized(capes, id, accountId);
      if (result === CAPE_CANCELLED || state.capes !== capes || currentProfileId() !== accountId) return;
      if (result?.account_uuid && capeAccountKey(result.account_uuid) !== capeAccountKey(accountId)) throw new Error("сервер вернул профиль другого аккаунта");
      capes.list.forEach((cape) => { cape.active = id ? cape.id === id : false; });
      success = true;
    } catch (error) {
      if (state.capes !== capes || currentProfileId() !== accountId) return;
      // Не показываем неудачный выбор как надетый. Если за время запроса уже
      // выбран другой вариант, дадим ему завершиться отдельно.
      if (selectedCapeId(capes) === id) {
        clearCapeSelectionTimer(capes);
        capes.selectedId = activeCapeId(capes);
        previewCapeSelection(capes, capes.selectedId, accountId);
        toast(String(error), "err");
      }
    } finally {
      capes.busy = false;
      capes.mutationKind = "";
    }
    if (state.capes !== capes || currentProfileId() !== accountId) return;
    if (selectedCapeId(capes) !== activeCapeId(capes)) {
      if (!capes.selectionTimer) scheduleCapeSelection(capes, accountId);
    } else {
      clearCapeSelectionTimer(capes);
      if (success) toast(id ? "Плащ включён" : "Плащ выключен", "ok");
    }
    updateCapeSelectionUI(capes);
  }

  function chooseCape(id, immediate = false) {
    const capes = capeState();
    const accountId = currentProfileId();
    id = id || "";
    if (!capes.licensed) { toast("Плащи есть только у лицензионного аккаунта", "err"); return false; }
    if (capes.loading || (capes.busy && capes.mutationKind !== "wardrobe")) {
      toast("Дождись завершения изменения плаща", "err"); return false;
    }
    if (id && !(capes.list || []).some((cape) => cape.id === id)) return false;
    clearCapeSelectionTimer(capes);
    // Старая загрузка списка не должна перезаписать только что выбранный плащ.
    ++capes.requestSerial;
    capes.loading = false;
    capes.selectedId = id;
    capes.selectionDueAt = Date.now() + (immediate ? 0 : CAPE_SELECTION_DELAY);
    if (capes.busy || id !== activeCapeId(capes)) scheduleCapeSelection(capes, accountId);
    previewCapeSelection(capes, id, accountId);
    updateCapeSelectionUI(capes);
    requestAnimationFrame(() => {
      if (state.capes === capes && currentProfileId() === accountId && selectedCapeId(capes) === id) {
        centerCapeCard($$("#skin-capes .cape-card").find((card) => card.dataset.capeId === id));
      }
    });
    return true;
  }

  function bindCapeCarousel() {
    const list = $("#skin-capes");
    if (!list) return;
    const cards = () => $$(".cape-card", list);
    const index = () => cards().findIndex((card) => card.dataset.capeId === selectedCapeId());
    const select = (next, focus = false) => {
      const all = cards();
      if (next < 0 || next >= all.length || !chooseCape(all[next].dataset.capeId)) return false;
      const card = all[next];
      if (focus) card.focus({ preventScroll: true });
      centerCapeCard(card);
      return true;
    };
    $("#cape-prev")?.addEventListener("click", () => select(index() - 1));
    $("#cape-next")?.addEventListener("click", () => select(index() + 1));
    list.addEventListener("scroll", updateCapeScrollControls, { passive: true });
    // Накопление позволяет одинаково пользоваться колесом и плавным тачпадом;
    // шквал событий выбирает конечную карточку, а не шлёт запрос на каждую.
    let wheelRemainder = 0;
    let wheelDirection = 0;
    list.addEventListener("wheel", (event) => {
      const capes = capeState();
      if (event.ctrlKey || event.altKey || event.metaKey || !capes.licensed || capes.loading
        || (capes.busy && capes.mutationKind !== "wardrobe")) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const direction = Math.sign(delta);
      const current = index();
      if (current < 0 || (direction < 0 && current === 0) || (direction > 0 && current === cards().length - 1)) {
        wheelRemainder = 0; return;
      }
      event.preventDefault();
      if (direction !== wheelDirection) wheelRemainder = 0;
      wheelDirection = direction;
      wheelRemainder += Math.abs(delta) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1);
      const steps = Math.min(8, Math.floor(wheelRemainder / 50));
      if (!steps) return;
      wheelRemainder = Math.min(49, Math.max(0, wheelRemainder - steps * 50));
      select(Math.max(0, Math.min(cards().length - 1, current + direction * steps)));
    }, { passive: false });
    list.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const all = cards();
      const current = index();
      if (!all.length || current < 0) return;
      let next = current;
      if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
      if (event.key === "ArrowRight") next = Math.min(all.length - 1, current + 1);
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = all.length - 1;
      event.preventDefault();
      select(next, true);
    });
    requestAnimationFrame(updateCapeScrollControls);
  }

  function bindCapes() {
    const thumbs = $$(".cape-thumb[data-cape-src]");
    thumbs.forEach((canvas) => paintCapeThumb(canvas, canvas.dataset.capeSrc));
    $("#cape-view-list")?.addEventListener("click", () => setCapeView("list"));
    $("#cape-view-grid")?.addEventListener("click", () => setCapeView("grid"));
    bindCapeCarousel();
    const refresh = $("#cape-refresh");
    if (refresh) refresh.addEventListener("click", async () => {
      const capes = capeState();
      if (capes.busy || capes.selectionTimer) return toast("Дождись завершения изменения плаща", "err");
      const accountId = currentProfileId();
      const pending = refreshAccountCapes();
      const request = capes.requestSerial;
      const fresh = await pending;
      if (state.capes !== capes || currentProfileId() !== accountId || capes.requestSerial !== request) return;
      renderPrefs();
      toast(fresh && !capes.error ? "Список плащей обновлён" : (capes.error || "Выбери лицензионный аккаунт"), fresh && !capes.error ? "ok" : "err");
    });
    $$("#skin-capes .cape-card").forEach((card) => card.addEventListener("click", () => {
      chooseCape(card.dataset.capeId || "", true);
    }));
  }

  /** PNG-скин → offscreen-канвас 64×64 для рендера. */
  function textureFromImage(dataUrl) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, 0, 64, Math.min(64, image.height), 0, 0, 64, Math.min(64, image.height));
        resolve(canvas);
      };
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    });
  }

  /** Миниатюра головы скина: лицо + второй слой (шапка/волосы), как в игре. */
  function headThumb(texture, size = 64) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(texture, 8, 8, 8, 8, 0, 0, size, size);          // лицо
    ctx.drawImage(texture, 40, 8, 8, 8, 0, 0, size, size);         // второй слой
    return canvas;
  }

  async function loadSkinFile(filePath, name, libraryId) {
    const skin = skinState();
    const revision = ++skin.selectionRevision;
    const dataUrl = await api.imageDataUrl(filePath).catch(() => null);
    if (!dataUrl || state.skin !== skin || skin.selectionRevision !== revision) return false;
    const texture = await textureFromImage(dataUrl);
    if (!texture || state.skin !== skin || skin.selectionRevision !== revision) return false;
    skin.texture = texture;
    skin.dataUrl = dataUrl;
    skin.currentPath = filePath;
    skin.currentName = name || "скин";
    skin.fromAccount = false;
    if (libraryId !== undefined) skin.selectedSkin = libraryId;
    return true;
  }

  /** Перерисовать модель в модалке настроек. */
  function redrawSkinPreview() {
    const canvas = $("#skin-canvas");
    if (!canvas) return;
    const skin = skinState();
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.round(rect.width || 260);
    const cssHeight = Math.round(rect.height || 380);
    if (!cssWidth || !cssHeight) return;
    skinCanvasSize(canvas, cssWidth, cssHeight);
    drawSkinModel(canvas, skin.texture || null, skin.variant, skin.yaw, skin.pitch, state.capeTexture || null);
  }

  /** Мини-модель для пресета: тот же рендер, маленький. */
  function paintSkinMini(slot, texture, capeTexture) {
    if (!slot || !texture) return;
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 140;
    // с плащом мини показываем в три четверти со спины — иначе плаща не видно
    const yaw = capeTexture ? 130 : -22;
    drawSkinModel(canvas, texture, "classic", yaw, 6, capeTexture || null);
    slot.innerHTML = "";
    slot.appendChild(canvas);
  }

  function bindSkin() {
    const skin = skinState();
    if ($("#skin-canvas")) requestAnimationFrame(redrawSkinPreview);

    // мини-скины пресетов собираем из их же PNG
    $$("[data-thumb-path]").forEach(async (slot) => {
      const dataUrl = await api.imageDataUrl(slot.dataset.thumbPath).catch(() => null);
      if (!dataUrl) return;
      const texture = await textureFromImage(dataUrl);
      if (texture) paintSkinMini(slot, texture);
    });

    // поворот модели мышью: зажал ЛКМ и крутишь
    const canvas = $("#skin-canvas");
    if (canvas) {
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.classList.add("is-dragging");
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        const zoom = uiZoom();
        skin.yaw = ((Number(skin.yaw) || 0) - (dx / zoom) * 0.6) % 360;
        skin.pitch = Math.max(-70, Math.min(70, (Number(skin.pitch) || 0) + (dy / zoom) * 0.45));
        redrawSkinPreview();
      });
      const stopDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        canvas.classList.remove("is-dragging");
        if (event && event.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
          canvas.releasePointerCapture(event.pointerId);
        }
      };
      canvas.addEventListener("pointerup", stopDrag);
      canvas.addEventListener("pointercancel", stopDrag);
      canvas.addEventListener("pointerleave", stopDrag);
      canvas.addEventListener("dblclick", () => {
        skin.yaw = -18;
        skin.pitch = 6;
        redrawSkinPreview();
      });
    }

    $$("#skin-library [data-skin-id]").forEach((btn) => btn.addEventListener("click", async () => {
      const item = findLibrarySkin(btn.dataset.skinId);
      if (!item) return;
      const loaded = await loadSkinFile(item.path, item.name, item.id);
      if (!loaded) return toast(`Файл скина «${item.name}» не читается — загрузи его заново`, "err");
      if (item.variant === "classic" || item.variant === "slim") skin.variant = item.variant;
      if (Number.isFinite(Number(item.angle))) skin.yaw = Number(item.angle);
      skin.favorite = "";
      renderPrefs();
    }));
    $$("#skin-library [data-del-skin]").forEach((btn) => btn.addEventListener("click", () => removeLibrarySkin(btn.dataset.delSkin)));

    $$("#skin-variant .chip").forEach((chip) => chip.addEventListener("click", () => {
      skin.variant = chip.dataset.variant === "slim" ? "slim" : "classic";
      skin.touchedVariant = true;
      if (skin.selectedSkin) {
        const list = Array.isArray(state.settings?.skin_presets) ? state.settings.skin_presets : [];
        const next = { ...(state.settings || {}), skin_presets: list.map((item) => item.id === skin.selectedSkin ? { ...item, variant: skin.variant } : item) };
        state.settings = next;
        api.saveSettings(next).catch((error) => toast(`Не удалось сохранить модель: ${error}`, "err"));
      }
      $$("#skin-variant .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
      redrawSkinPreview();
      refreshSkinStatus();
    }));

    const upload = $("#skin-upload");
    if (upload) upload.addEventListener("click", uploadSkin);
    const apply = $("#skin-apply");
    if (apply) apply.addEventListener("click", applySkinToAccount);
    const refresh = $("#skin-refresh");
    if (refresh) refresh.addEventListener("click", async () => {
      const accountId = currentProfileId();
      const pending = refreshAccountSkin(true);
      const request = skin.requestSerial;
      const fresh = await pending;
      if (state.skin !== skin || currentProfileId() !== accountId || skin.requestSerial !== request) return;
      if (fresh) skinStampBump();
      renderAccounts();
      toast(fresh ? "Скин обновлён с сервера" : (skin.error || skin.notice || "Выбери лицензионный аккаунт"), fresh ? "ok" : "err");
    });

  }

  window.addEventListener("resize", () => {
    if ($("#skin-canvas")) redrawSkinPreview();
    updateCapeScrollControls();
  }, { passive: true });

  async function uploadSkin() {
    const skin = skinState();
    if (skin.importing) return;
    const paths = await api.pickFiles("Выбери один или несколько PNG-скинов", ["png"]).catch((error) => { toast(String(error), "err"); return []; });
    if (!Array.isArray(paths) || !paths.length) return;
    skin.importing = true;
    skin.importErrors = [];
    renderPrefs();
    const imported = [];
    for (const path of paths) {
      try {
        const item = await api.importSkin(path);
        if (!item || !item.path) throw new Error("файл не сохранён");
        imported.push({
          id: `skin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          name: item.name || "Скин", path: item.path, variant: skin.variant || "classic", angle: Math.round(Number(skin.yaw) || 0)
        });
      } catch (error) {
        const name = String(path).split(/[\\/]/).pop() || "PNG";
        skin.importErrors.push(`${name}: ${error}`);
      }
    }
    if (imported.length) {
      const previous = Array.isArray(state.settings?.skin_presets) ? state.settings.skin_presets : [];
      const next = { ...(state.settings || {}), skin_presets: [...previous, ...imported] };
      try {
        await api.saveSettings(next);
        // Не заменяем параллельно изменённые настройки устаревшим снимком.
        state.settings = { ...(state.settings || {}), skin_presets: next.skin_presets };
        if (skinState() === skin) await loadSkinFile(imported[0].path, imported[0].name, imported[0].id);
      } catch (error) {
        skin.importErrors.push(`Не удалось сохранить библиотеку: ${error}. Файлы остались в папке скинов лаунчера.`);
      }
    }
    skin.importing = false;
    renderPrefs();
    if (skin.importErrors.length) toast(`Загружено: ${imported.length}; ошибок: ${skin.importErrors.length}. Подробности в библиотеке.`, "err");
    else toast(`Скинов добавлено: ${imported.length}`, "ok");
  }

  async function removeLibrarySkin(id) {
    const item = findLibrarySkin(id);
    if (!item) return;
    const confirmed = await askConfirm({
      title: "Убрать скин из библиотеки",
      text: `Скин «${item.name}» исчезнет из списка. Сам файл останется в папке лаунчера, избранные образы не удалятся.`,
      ok: "Убрать"
    });
    if (!confirmed) return;
    const all = Array.isArray(state.settings?.skin_presets) ? state.settings.skin_presets : [];
    const next = { ...(state.settings || {}), skin_presets: all.filter((entry) => entry.id !== id) };
    try {
      await api.saveSettings(next);
      state.settings = { ...(state.settings || {}), skin_presets: next.skin_presets };
      if (skinState().selectedSkin === id) skinState().selectedSkin = null;
      toast("Скин убран из библиотеки", "ok");
      renderPrefs();
    } catch (error) { toast(String(error), "err"); }
  }

  async function applySkinToAccount() {
    const skin = skinState();
    if (!skin.licensed) return toast("Смена скина только для лицензии", "err");
    if (!skin.currentPath && !skin.dataUrl) return toast("Сначала выбери скин", "err");
    const account = activeAccount();
    const accountId = account?.uuid || "";
    const selection = skin.selectionRevision;
    const name = skin.currentName || "скин";
    const variant = skin.variant || "classic";
    const button = $("#skin-apply");
    if (button) button.disabled = true;
    try {
      // Избранный образ может содержать PNG с сервера, но не локальный путь.
      const path = skin.currentPath || await api.saveSkinPng(skin.dataUrl, name);
      if (state.skin !== skin || currentProfileId() !== accountId || skin.selectionRevision !== selection) {
        return toast("Выбор изменился — примени скин ещё раз", "err");
      }
      await api.applySkin(path, variant, accountId);
      // Запрос уже мог успешно завершиться, пока пользователь переключался.
      if (state.skin !== skin || currentProfileId() !== accountId) {
        return toast(`Скин аккаунта «${account?.username || "Minecraft"}» обновлён`, "ok");
      }
      if (skin.selectionRevision === selection) skin.fromAccount = true;
      skinStampBump();
      const pending = refreshAccountSkin(true);
      const request = skin.requestSerial;
      const fresh = await pending;
      if (state.skin !== skin || currentProfileId() !== accountId || skin.requestSerial !== request) return;
      renderAccounts();
      if (fresh) toast(`Скин «${name}» обновлён`, "ok");
      else toast(`Скин принят Minecraft, но предпросмотр не обновлён: ${skin.error || skin.notice || "попробуй позже"}`, "err");
    } catch (error) {
      toast(String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** Текущий скин аккаунта — показываем при открытии профиля (только просмотр). */
  /**
   * Скин с сервера Mojang. `force` — обновить даже если модель уже нарисована:
   * скин в игре могли поменять, а в лаунчере он висел старый.
   */
  async function refreshAccountSkin(force = false) {
    const skin = skinState();
    const active = activeAccount();
    const accountId = active?.uuid || "";
    const request = ++skin.requestSerial;
    const selection = skin.selectionRevision;
    const current = () => state.skin === skin && currentProfileId() === accountId && skin.requestSerial === request;
    skin.licensed = Boolean(active && active.kind === "microsoft");
    skin.loading = skin.licensed;
    skin.error = "";
    skin.notice = "";
    if (!skin.licensed) return false;
    refreshSkinStatus();
    try {
      const info = await api.accountSkin(accountId);
      if (!current()) return false;
      if (!info || !info.licensed) throw new Error("сервер не подтвердил профиль Minecraft");
      if (info.account_uuid && String(info.account_uuid).toLowerCase().replace(/-/g, "") !== String(accountId).toLowerCase().replace(/-/g, "")) {
        throw new Error("сервер вернул профиль другого аккаунта");
      }
      if (!info.data_url) {
        skin.accountTexture = null;
        skin.headUrl = "";
        if (skin.fromAccount && skin.selectionRevision === selection) {
          skin.texture = null; skin.dataUrl = ""; skin.currentName = ""; skin.currentPath = ""; skin.fromAccount = false;
        }
        skin.notice = info.message || "Сервер не вернул активную текстуру скина.";
        renderAccountChip(); renderPrefsAccountCard();
        return false;
      }
      const texture = await textureFromImage(info.data_url);
      if (!current()) return false;
      if (!texture) throw new Error("текстура скина не читается");
      // Голова аккаунта хранится отдельно от выбранного пользователем локального
      // файла: предпросмотр не должен менять аватар до применения скина.
      skin.accountTexture = texture;
      skin.headUrl = ""; skin.headStamp = "";
      const keepLocal = (!skin.fromAccount && Boolean(skin.currentPath || skin.dataUrl)) || skin.selectionRevision !== selection;
      if (!keepLocal && (force || !skin.texture)) {
        skin.texture = texture;
        skin.dataUrl = info.data_url;
        skin.fromAccount = true;
        skin.currentPath = "";
        skin.accountNameDefault = !info.name;
        skin.currentName = info.name || "скин аккаунта";
      }
      if (!keepLocal && info.variant && !skin.touchedVariant) skin.variant = info.variant === "slim" ? "slim" : "classic";
      renderAccountChip(); renderPrefsAccountCard();
      const pop = $("#account-pop");
      if (pop && !pop.hidden) renderAccountPopover();
      return true;
    } catch (error) {
      if (current()) skin.error = String(error?.message || error || "неизвестная ошибка");
      return false;
    } finally {
      if (current()) { skin.loading = false; refreshSkinStatus(); }
    }
  }

  /* ==================== НАСТРОЙКИ СБОРКИ (свои у каждой) ==================== */
  let settingsRenderSerial = 0;
  async function renderSettings() {
    const meta = selected();
    if (!meta) {
      $("#tab-body").innerHTML = `<div class="empty-state">Выбери сборку слева</div>`;
      return;
    }
    const generation = tabRenderGeneration;
    const serial = ++settingsRenderSerial;
    const javas = await api.javas().catch(() => []);
    if (serial !== settingsRenderSerial || generation !== tabRenderGeneration
        || state.tab !== "settings" || state.selectedId !== meta.id) return;
    $("#tab-body").innerHTML = `
      <div class="settings-wrap">
        <div class="settings-grid">
          <div class="panel">
            <div class="panel-head">
              <strong>Сборка «${esc(meta.name)}»</strong>
              <span class="badge">MC ${esc(meta.mc_version)}</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">только эта сборка</span>
            </div>
            <div style="padding:14px;display:grid;gap:14px">
              <div class="settings-row">
                <div class="label">Название</div>
                <div><input class="input" id="inst-name" style="width:100%" value="${esc(meta.name)}" spellcheck="false"></div>
              </div>
              <div class="settings-row is-wide">
                <div class="label">Иконка</div>
                <div class="settings-cell">
                <div class="icon-grid" id="inst-icons">
                  <button class="icon-chip letter ${!meta.icon ? "is-active" : ""}" data-icon="" title="Первая буква">${esc(String(meta.name).trim().charAt(0).toUpperCase())}</button>
                  ${isImageIcon(meta.icon) && state.iconCache[meta.id] ? `<button class="icon-chip img is-active" data-icon="${esc(meta.icon)}" title="Своя картинка"><img src="${state.iconCache[meta.id]}" alt=""></button>` : ""}
                  ${INSTANCE_ICONS.map((icon) => `<button class="icon-chip ${meta.icon === icon ? "is-active" : ""}" data-icon="${icon}" title="${icon.replace("i-", "")}"><svg class="ic"><use href="#${icon}"/></svg></button>`).join("")}
                </div>
                <div class="settings-actions">
                  <button class="btn" id="inst-icon-file"><svg class="ic"><use href="#i-image"/></svg>Иконка из картинки…</button>
                  ${isImageIcon(meta.icon) ? '<button class="btn btn-ghost" id="inst-icon-reset">Сбросить</button>' : ""}
                </div>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Память, МБ</div>
                <div>${memoryRangeHtml("inst-memory", meta.memory_mb ?? state.settings?.memory_mb, "Память этой сборки")}</div>
              </div>
              <div class="settings-row">
                <div class="label">Java для этой сборки</div>
                <div class="flex-row">
                  <select class="select grow" id="inst-java">
                    <option value="" ${!meta.java_path ? "selected" : ""}>автоматически</option>
                    ${javas.map((item) => `<option translate="no" value="${esc(item.path)}" ${meta.java_path === item.path ? "selected" : ""}>Java ${item.major} — ${esc(item.path)}</option>`).join("")}
                    ${meta.java_path && !javas.some((item) => item.path === meta.java_path) ? `<option translate="no" value="${esc(meta.java_path)}" selected>${esc(meta.java_path)}</option>` : ""}
                  </select>
                  <button class="btn" id="inst-java-pick"><svg class="ic"><use href="#i-folder"/></svg>Файл…</button>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">JVM-аргументы</div>
                <div><input class="input" id="inst-jvm" style="width:100%" placeholder="как в общих" value="${esc(meta.jvm_args || "")}" spellcheck="false"></div>
              </div>
              <div class="settings-row">
                <div class="label">Заметка</div>
                <div><input class="input" id="inst-notes" style="width:100%" placeholder="например: для сборки с шейдерами" value="${esc(meta.notes || "")}" spellcheck="false"></div>
              </div>
              <div class="settings-row">
                <div class="label">Версия игры</div>
                <div class="flex-row">
                  <div class="muted grow" style="padding-top:7px">MC ${esc(meta.mc_version)} · ${esc(loaderLabel(meta.loader))} <span class="kbd">${esc(versionId(meta))}</span></div>
                  <button class="btn" id="inst-change-version">Сменить версию</button>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Наиграно</div>
                <div class="muted instance-playtime" style="padding-top:7px">${esc(playtimeLabel(meta.playtime_secs))}${meta.last_played ? ` · последний запуск ${esc(relativeWhen(meta.last_played))}` : ""}</div>
              </div>
              <div class="settings-row">
                <div class="label">Экспорт</div>
                <div class="settings-actions" style="margin:0">
                  <button class="btn" id="inst-export-mrpack">В .mrpack</button>
                  <button class="btn" id="inst-export-zip">В .zip</button>
                </div>
              </div>
              <div class="settings-actions">
                <button class="btn btn-primary" id="inst-save">Сохранить сборку</button>
                <button class="btn" id="inst-folder">Открыть папку</button>
                <button class="btn btn-danger" id="inst-delete">Удалить сборку</button>
              </div>
            </div>
          </div>

        </div>
      </div>`;

    $$("#inst-icons .icon-chip").forEach((chip) => chip.addEventListener("click", () => {
      $$("#inst-icons .icon-chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    const memorySlider = $("#inst-memory");
    if (memorySlider) memorySlider.addEventListener("input", () => updateMemoryRange(memorySlider));
    const javaPick = $("#inst-java-pick");
    if (javaPick) javaPick.addEventListener("click", async () => {
      const picked = await api.pickFile("Java для сборки", ["exe", ""]).catch(() => null);
      if (!picked) return;
      const select = $("#inst-java");
      const option = document.createElement("option");
      option.setAttribute("translate", "no");
      option.value = picked;
      option.textContent = picked;
      option.selected = true;
      select.appendChild(option);
    });
    const iconFile = $("#inst-icon-file");
    if (iconFile) iconFile.addEventListener("click", async () => {
      const path = await api.pickFile("Иконка сборки", ["png", "jpg", "jpeg", "webp", "gif"]).catch(() => null);
      if (path) await setIconFromFile(meta, path);
    });
    const iconReset = $("#inst-icon-reset");
    if (iconReset) iconReset.addEventListener("click", async () => {
      invalidatePresenceIcon();
      try {
        await api.updateInstance({ ...meta, icon: null });
        delete state.iconCache[meta.id];
        await refreshInstances();
        renderSettings();
      } catch (err) { syncPresence(); toast(String(err), "err"); }
    });
    $("#inst-save").addEventListener("click", async () => {
      const chip = $("#inst-icons .icon-chip.is-active");
      const next = {
        ...meta,
        name: $("#inst-name").value.trim() || meta.name,
        icon: chip && chip.dataset.icon ? chip.dataset.icon : null,
        memory_mb: memorySlider?.dataset.memoryDirty === "true" ? Number(memorySlider.value) : (meta.memory_mb ?? null),
        java_path: $("#inst-java").value.trim() || null,
        jvm_args: $("#inst-jvm").value.trim() || null,
        notes: $("#inst-notes").value.trim()
      };
      if (next.icon !== meta.icon || next.name !== meta.name) invalidatePresenceIcon();
      try {
        await api.updateInstance(next);
        await refreshInstances();
        toast("Сборка сохранена", "ok");
      } catch (err) { syncPresence(); toast(String(err), "err"); }
    });
    $("#inst-change-version").addEventListener("click", () => openVersionChange());
    $("#inst-export-mrpack").addEventListener("click", () => openExportModal(meta, "mrpack"));
    $("#inst-export-zip").addEventListener("click", () => openExportModal(meta, "zip"));
    $("#inst-folder").addEventListener("click", () => api.openPath(`/instances/${meta.id}/minecraft`).catch((err) => toast(String(err), "err")));
    $("#inst-delete").addEventListener("click", async () => {
      const okDelete2 = await askConfirm({
        title: "Удалить сборку",
        text: `Сборка «${meta.name}» будет удалена вместе с модами и мирами.`,
        ok: "Удалить"
      });
      if (!okDelete2) return;
      try {
        await api.deleteInstance(meta.id);
        diagnostics.forget(meta.id);
        state.selectedId = null;
        await refreshInstances();
        renderTab();
        toast("Сборка удалена", "ok");
      } catch (err) { toast(String(err), "err"); }
    });
  }

  /** Диалог экспорта: формат, что включить и куда сохранить. */
  let exportState = null;
  function openExportModal(meta, format) {
    exportState = { meta, format: format || "mrpack", path: "" };
    renderExportModal();
    $("#modal-export").hidden = false;
  }

  function renderExportModal() {
    const st = exportState;
    if (!st) return;
    $$("#modal-export [data-exp-format]").forEach((chip) =>
      chip.classList.toggle("is-active", chip.dataset.expFormat === st.format));
    $$("#exp-list .imp-check").forEach((box) =>
      box.closest(".imp-item").classList.toggle("is-picked", box.checked));
    $("#exp-path").value = st.path || "";
    $("#exp-go").disabled = !st.path;
    $("#exp-hint").textContent = st.path ? "" : "сначала выбери, куда сохранить";
  }

  function versionId(meta) {
    if (meta.version_override) return meta.version_override;
    const loader = meta.loader || { type: "vanilla" };
    switch (loader.type) {
      case "fabric": return `fabric-loader-${loader.version}-${meta.mc_version}`;
      case "quilt": return `quilt-loader-${loader.version}-${meta.mc_version}`;
      case "forge": return `forge-${meta.mc_version}-${loader.version}`;
      case "neoforge": return `neoforge-${loader.version}`;
      default: return meta.mc_version;
    }
  }

  /* ==================== ОБНОВЛЕНИЯ ==================== */
  async function initUpdates() {
    const info = await api.versionInfo().catch(() => null);
    if (info) {
      state.update.version = info.version;
      state.update.repo = info.repo;
      state.update.enabled = info.enabled;
    }
    if (!(info && info.enabled && info.repo)) return;
    if (state.settings && state.settings.update_enabled === false) return;
    const found = await checkUpdates(true);
    // авто-обновление: в приложении новая версия ставится и применяется сразу
    const auto = state.settings ? state.settings.update_auto !== false : true;
    if (found && auto && IS_APP) {
      $("#modal-update").hidden = false;
      await installUpdate();
    }
  }

  async function checkUpdates(silent) {
    if (state.update.checking) return null;
    state.update.checking = true;
    try {
      const info = await api.checkUpdate();
      if (info) {
        showUpdate(info);
        return info;
      }
      if (!silent) toast(`Установлена последняя версия ${state.update.version}`, "ok");
      return null;
    } catch (error) {
      if (!silent) toast(`Не удалось проверить обновления: ${error}`, "err");
      return null;
    } finally {
      state.update.checking = false;
    }
  }

  /** Список изменений: каждая версия между текущей и новой — отдельным блоком. */
  function renderUpdateNotes(info) {
    const box = $("#upd-notes");
    box.innerHTML = "";
    const entries = info.changelog && info.changelog.length
      ? info.changelog
      : [{ version: info.version, notes: info.notes, published_at: info.published_at }];
    for (const entry of entries) {
      const block = document.createElement("div");
      block.className = "upd-change";
      const head = document.createElement("div");
      head.className = "upd-change-head";
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "v" + entry.version;
      head.appendChild(tag);
      if (entry.published_at) {
        const date = document.createElement("span");
        date.className = "muted";
        date.dataset.localeDate = entry.published_at;
        date.setAttribute("translate", "no");
        date.textContent = localizedReleaseDate(entry.published_at);
        head.appendChild(date);
      }
      const pre = document.createElement("pre");
      if (entry.notes && entry.notes.trim()) pre.textContent = entry.notes;
      else {
        pre.dataset.emptyUpdateNotes = "";
        pre.textContent = I18N.translate("Описание изменений не указано.");
      }
      block.appendChild(head);
      block.appendChild(pre);
      box.appendChild(block);
    }
  }

  function showUpdate(info) {
    state.update.info = info;
    const pill = $("#btn-update");
    if (pill) {
      pill.hidden = false;
      $("#btn-update-text").textContent = `Обновить до ${info.version}`;
    }
    $("#upd-title").textContent = `Доступна версия ${info.version}`;
    $("#upd-versions").textContent = `${info.current_version} → ${info.version}`;
    const date = $("#upd-date");
    if (info.published_at) {
      date.dataset.localeDate = info.published_at;
      date.setAttribute("translate", "no");
      date.textContent = localizedReleaseDate(info.published_at);
    } else {
      delete date.dataset.localeDate;
      date.textContent = "";
    }
    $("#upd-asset").textContent = info.asset_name || "";
    renderUpdateNotes(info);
    $("#upd-progress").hidden = true;
    $("#upd-install").disabled = false;
    $("#upd-install").textContent = "Обновить и перезапустить";
  }

  async function openUpdateModal() {
    if (state.update.info) {
      $("#modal-update").hidden = false;
      return;
    }
    const info = await checkUpdates(false);
    if (info) $("#modal-update").hidden = false;
  }

  async function installUpdate() {
    if (!state.update.info || state.update.installing) return;
    state.update.installing = true;
    const button = $("#upd-install");
    button.disabled = true;
    button.textContent = "Скачиваем…";
    $("#upd-progress").hidden = false;
    $("#upd-progress-text").textContent = "Подготовка…";
    try {
      await api.installUpdate();
      $("#upd-title").textContent = "Обновление установлено";
      button.textContent = "Перезапускаем…";
      $("#upd-fill").style.width = "100%";
      $("#upd-progress-text").textContent = "Лаунчер перезапустится автоматически";
      if (!IS_APP) toast("Демо-режим: настоящий перезапуск только в приложении", "");
    } catch (error) {
      toast(`Не удалось обновить: ${error}`, "err");
      button.disabled = false;
      button.textContent = "Обновить и перезапустить";
      $("#upd-progress").hidden = true;
      state.update.installing = false;
    }
  }

  /* ==================== ДЕЙСТВИЯ ==================== */
  let instancesRefreshPending = null;
  function previousInstanceIds(item) {
    return Array.isArray(item.renamed_froms) ? item.renamed_froms : (item.renamed_from ? [item.renamed_from] : []);
  }
  function refreshInstances() {
    if (state.windowHidden) {
      state.uiRefreshPending = true;
      return Promise.resolve();
    }
    // Два одновременных запроса не должны применять старый список поверх нового.
    if (instancesRefreshPending) return instancesRefreshPending;
    instancesRefreshPending = (async () => {
      const runningRevision = state.runningRevision;
      let selectionChanged = false;
      try {
        const instances = await api.instances();
        const sessions = await api.runningSessions().catch(() => null);
        const running = Array.isArray(sessions) ? null : await api.running().catch(() => null);
        const previous = state.selectedId;
        state.instances = instances;
        // Ответ может запоздать за game-exit или запуском другого окна.
        if (state.runningRevision === runningRevision && Array.isArray(sessions)) {
          const next = new Map();
          for (const item of sessions) {
            if (!item || !item.instance_id || !item.run_id || !instances.some((meta) => meta.id === item.instance_id)) continue;
            if (!next.has(item.instance_id)) next.set(item.instance_id, new Map());
            next.get(item.instance_id).set(item.run_id, { account: item.account || "", runId: item.run_id, startedAt: Number(item.started_at) || 0 });
          }
          state.sessions = next;
          state.running = new Set(next.keys());
          state.runningRevision += 1;
        } else if (running && state.runningRevision === runningRevision) {
          // Совместимость с демо и более старым бэкендом.
          state.running = new Set([...running, ...state.sessions.keys()]);
          state.runningRevision += 1;
        } else if (state.runningRevision !== runningRevision) {
          // Во время первого ответа могла завершиться одна игра, а другие
          // ещё не попали в UI. Не применяем старый снимок и запрашиваем новый
          // после завершения текущего coalesced refresh.
          setTimeout(() => refreshInstances(), 0);
        }
        const last = state.settings?.last_instance;
        if (last && !instances.some((item) => item.id === last)) {
          const candidates = instances.filter((item) => previousInstanceIds(item).includes(last));
          if (candidates.length === 1) state.settings.last_instance = candidates[0].id;
        }
        if (previous && !instances.some((item) => item.id === previous)) {
          const candidates = instances.filter((item) => previousInstanceIds(item).includes(previous));
          const next = candidates.length === 1 ? candidates[0].id : null;
          if (next) {
            if (state.logs[previous] && !state.logs[next]) state.logs[next] = state.logs[previous];
            delete state.logs[previous];
            diagnostics.rename(previous, next);
            if (state.settings?.last_instance === previous) state.settings.last_instance = next;
          }
          state.selectedId = next;
          selectionChanged = true;
        }
        // Подтверждаем только после обработки ответа. При сбое повторный список
        // снова передаст незаконченные переименования, в том числе цепочки.
        const acknowledgements = instances.map((item) => ({ id: item.id, previousIds: previousInstanceIds(item) }))
          .filter((item) => item.previousIds.length);
        if (acknowledgements.length) api.acknowledgeInstanceRenames(acknowledgements).catch(() => {});
      } catch (err) {
        toast(String(err), "err");
      }
      await loadInstanceIcons();
      if (selectionChanged) selectInstance(state.selectedId);
      else {
        renderSidebar();
        renderBuildIcon(selected());
        syncPresence();
      }
    })().finally(() => { instancesRefreshPending = null; });
    return instancesRefreshPending;
  }

  /** Двойной клик по сборке в списке или на главной: выбрать её и запустить игру. */
  async function launchFromList(id) {
    const meta = state.instances.find((item) => item.id === id);
    if (!meta) return;
    if (state.running.has(id) || state.preparing.has(id)) {
      toast(`«${meta.name}» уже запущена или подготавливается`, "");
      openInstance(id);
      return;
    }
    if (state.selectedId !== id) openInstance(id);
    play();
  }

  async function play() {
    const meta = selected();
    if (!meta) return toast("Выбери сборку", "err");
    if (isServer(meta)) {
      if (state.running.has(meta.id)) return toast("Сервер уже запущен", "");
      try { await api.serverStart(meta.id); await refreshInstances(); renderSidebar(); renderTab(); toast("Сервер запущен", "ok"); }
      catch (error) { toast(String(error), "err"); }
      return;
    }
    if (state.running.has(meta.id) || state.preparing.has(meta.id)) return toast("Сборка уже запущена или подготавливается", "err");
    const attemptId = nextAttemptId();
    diagnostics.begin(meta.id, attemptId, diagnosticLaunchContext(meta));
    changePreparing(meta.id, 1);
    syncPresence("launching");
    pushLog(meta.id, `[omnispec] Подготовка «${meta.name}» (MC ${meta.mc_version}, ${loaderLabel(meta.loader)})`, "dim");
    if (state.tab === "console" && state.selectedId === meta.id) renderLogs(meta.id);
    try {
      const plan = await api.launch(meta.id, null, attemptId);
      finishLaunchProgress(attemptId, "done");
      const run = diagnostics.started(meta.id, attemptId, plan && plan.run_id, plan && plan.account);
      // Завершение и последние строки могут прийти раньше ответа launch_instance.
      if (run && run.status === "running") {
        addSession(meta.id, plan && plan.run_id, plan && plan.account, plan && plan.started_at);
        pushLog(meta.id, `[omnispec] Java ${(plan && (plan.java_major || plan.major)) || "—"}: ${(plan && plan.java) || "java"}`, "dim");
        pushLog(meta.id, `[omnispec] Память ${(plan && plan.memory_mb) || "—"} МБ, артефактов в classpath: ${(plan && plan.classpath_entries) ?? "—"}`, "dim");
      }
      renderSidebar();
      updateStatus();
      syncPresence();
    } catch (err) {
      const failed = diagnostics.fail(meta.id, attemptId, err);
      const cancelled = failed && failed.status === "cancelled";
      finishLaunchProgress(attemptId, cancelled ? "cancelled" : "error");
      pushLog(meta.id, `[omnispec] ${cancelled ? "Подготовка отменена" : "Ошибка запуска"}: ${err}`, cancelled ? "dim" : "err");
      if (cancelled) toast("Подготовка запуска отменена", "info");
      else toast(`Не удалось запустить. Подробности — во вкладке «Ошибки»: ${err}`, "err");
      if (state.tab === "console" && state.selectedId === meta.id) renderLogs(meta.id);
      syncPresence();
    } finally {
      changePreparing(meta.id, -1);
    }
  }

  async function stopGame() {
    const meta = selected();
    if (!meta) return;
    if (isServer(meta)) {
      try { await api.serverStop(meta.id); await refreshInstances(); renderSidebar(); renderTab(); toast("Сервер останавливается", ""); }
      catch (error) { toast(String(error), "err"); }
      return;
    }
    const marked = diagnostics.requestStop(meta.id);
    const targetedRuns = sessionsOf(meta.id).map((session) => session.runId);
    try {
      await api.stop(meta.id);
      finishDemoStops(meta.id, marked);
      // Новое окно могло открыться, пока команда остановки ожидала ответа.
      for (const runId of targetedRuns) dropSession(meta.id, runId);
      if (!state.sessions.has(meta.id)) { state.running.delete(meta.id); state.runningRevision += 1; }
      renderSidebar();
      updateStatus();
      syncPresence();
      toast("Игра остановлена");
    }
    catch (err) { diagnostics.undoStop(meta.id, marked); toast(String(err), "err"); }
  }

  async function installInstance() {
    const meta = selected();
    if (!meta) return toast("Выбери сборку", "err");
    try {
      await api.installInstance(meta.id);
      toast("Файлы сборки готовы", "ok");
    } catch (err) { toast(String(err), "err"); }
  }

  /* ==================== МОДАЛКА «ДОБАВИТЬ СУЩЕСТВУЮЩУЮ» ====================
   * Сюда переехала кнопка Modrinth: добавить готовую сборку можно тремя путями —
   * поиском модпака на Modrinth, локальным .mrpack или ссылкой.
   */
  /* ==================== СМЕНА ВЕРСИИ СБОРКИ ==================== */
  /** Два списка: слева версии Minecraft, справа загрузчик и его версии. */
  async function openVersionChange() {
    const meta = selected();
    if (!meta) return;
    const loader = meta.loader || { type: "vanilla" };
    state.mcver = {
      meta,
      versions: [],
      query: "",
      mc: meta.mc_version,
      loader: loader.type || "vanilla",
      loaderVersion: loader.version || "",
      loaderVersions: [],
      loading: true
    };
    $("#modal-mcver").hidden = false;
    renderVersionChange();
    state.mcver.versions = await api.versions((state.settings && state.settings.show_snapshots) || false).catch(() => []);
    state.mcver.loading = false;
    renderVersionChange();
    loadVersionLoaderVersions();
  }

  async function loadVersionLoaderVersions() {
    const cfg = state.mcver;
    if (!cfg) return;
    if (cfg.loader === "vanilla") {
      cfg.loaderVersions = [];
      cfg.loaderVersion = "";
      renderVersionChange();
      return;
    }
    cfg.loaderVersions = [];
    renderVersionChange();
    const list = await api.loaderVersions(cfg.loader, cfg.mc).catch(() => []);
    if (!state.mcver || state.mcver !== cfg) return;
    cfg.loaderVersions = list || [];
    const keep = cfg.loaderVersions.some((option) => option.version === cfg.loaderVersion);
    if (!keep) {
      const current = cfg.loaderVersions.find((option) => option.stable) || cfg.loaderVersions[0];
      cfg.loaderVersion = current ? current.version : "";
    }
    renderVersionChange();
  }

  function renderVersionChange() {
    const cfg = state.mcver;
    if (!cfg) return;
    const filter = cfg.query.toLowerCase();
    const versions = cfg.versions.filter((version) => !filter || version.id.toLowerCase().includes(filter));
    const loaderName = LOADER_NAMES[cfg.loader] || cfg.loader;

    $("#mcver-body").innerHTML = `
      <div class="mcver-grid">
        <section class="mcver-col">
          <div class="mcver-head">Minecraft</div>
          <label class="search" style="margin:8px">
            <svg class="ic"><use href="#i-search"/></svg>
            <input id="mcver-search" type="text" placeholder="найти версию" value="${esc(cfg.query)}" spellcheck="false">
          </label>
          <div class="mcver-list" id="mcver-list">
            ${cfg.loading ? `<div class="add-empty">Загружаем версии…</div>` : versions.length ? versions.map((version) => `
              <button class="mcver-item ${version.id === cfg.mc ? "is-active" : ""}" data-mcver-mc="${esc(version.id)}">
                <span>${esc(version.id)}</span>
                ${version.id === latestReleaseId(cfg.versions) ? `<span class="tag">рекомендуется</span>` : ""}
                ${version.type && version.type !== "release" ? `<span class="tag">${esc(version.type)}</span>` : ""}
              </button>`).join("") : `<div class="add-empty">Ничего не найдено</div>`}
          </div>
        </section>
        <section class="mcver-col">
          <div class="mcver-head">Загрузчик</div>
          <div class="chips" id="mcver-loaders" style="padding:8px">
            ${Object.entries(LOADER_NAMES).map(([value, label]) => `<button class="chip ${cfg.loader === value ? "is-active" : ""}" data-mcver-loader="${value}">${label}</button>`).join("")}
          </div>
          <div class="mcver-list" id="mcver-loader-list">
            ${cfg.loader === "vanilla"
              ? `<div class="add-empty">Ваниль без загрузчика</div>`
              : cfg.loaderVersions.length
                ? cfg.loaderVersions.map((option) => `
                  <button class="mcver-item ${option.version === cfg.loaderVersion ? "is-active" : ""}" data-mcver-loader-version="${esc(option.version)}">
                    <span>${esc(option.version)}</span>
                    ${recommendedLoader(cfg.loaderVersions) && option.version === recommendedLoader(cfg.loaderVersions).version ? `<span class="tag">рекомендуется</span>` : ""}
                    ${option.stable ? "" : `<span class="tag">beta</span>`}
                  </button>`).join("")
                : `<div class="add-empty">Загружаем версии ${esc(loaderName)}…</div>`}
          </div>
        </section>
      </div>`;

    $("#mcver-search").addEventListener("input", (event) => {
      cfg.query = event.target.value;
      renderVersionChange();
      const input = $("#mcver-search");
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
    $$("#mcver-list [data-mcver-mc]").forEach((el) => el.addEventListener("click", () => {
      cfg.mc = el.dataset.mcverMc;
      renderVersionChange();
      loadVersionLoaderVersions();
    }));
    $$("#mcver-loaders .chip").forEach((chip) => chip.addEventListener("click", () => {
      cfg.loader = chip.dataset.mcverLoader;
      cfg.loaderVersion = "";
      renderVersionChange();
      loadVersionLoaderVersions();
    }));
    $$("#mcver-loader-list [data-mcver-loader-version]").forEach((el) => el.addEventListener("click", () => {
      cfg.loaderVersion = el.dataset.mcverLoaderVersion;
      renderVersionChange();
    }));

    $("#mcver-hint").textContent = `MC ${cfg.mc} · ${loaderName}${cfg.loaderVersion ? " " + cfg.loaderVersion : ""}`;
  }

  async function applyVersionChange() {
    const cfg = state.mcver;
    if (!cfg) return;
    const meta = selected();
    if (!meta || meta.id !== cfg.meta.id) return toast("Сборка изменилась — открой смену версии заново", "err");
    const loader = cfg.loader === "vanilla" || !cfg.loader
      ? { type: "vanilla" }
      : { type: cfg.loader, version: cfg.loaderVersion };
    if (loader.type !== "vanilla" && !loader.version) return toast("Выбери версию загрузчика", "err");
    const changed = meta.mc_version !== cfg.mc
      || JSON.stringify(meta.loader || { type: "vanilla" }) !== JSON.stringify(loader);
    if (!changed) {
      $("#modal-mcver").hidden = true;
      return;
    }
    const button = $("#mcver-apply");
    button.disabled = true;
    try {
      // Смена версии сама по себе ничего не удаляет. Только явное согласие
      // запускает проверку каталога и обновление модов под новый профиль.
      const updateMods = await askConfirm({
        title: "Обновить моды под новую версию?",
        text: `Сборка будет переключена на Minecraft ${cfg.mc} · ${loaderLabel(loader)}. Хотите обновить моды под этот профиль?\n\nЕсли отказаться, файлы модов и пользовательские данные останутся без изменений.`,
        ok: "Проверить и обновить",
        danger: false
      });
      let updateSummary = null;
      let incompatibleCount = 0;
      if (updateMods) {
        const target = { mcVersion: cfg.mc, loader };
        const report = await withInstallProgress(
          meta.id,
          "check",
          (op) => api.contentCompatibility(meta.id, "mod", target, op),
          { detail: "Проверяем совместимость…", opPrefix: "check:" }
        );
        const updates = Array.isArray(report) ? report : (report?.updates || []);
        state.contentUpdates.mod = updates;
        if (updates.length) {
          updateSummary = await updateContentBatch("mod", updates, {
            confirmed: true,
            announce: false,
            openDialogOnFailure: false,
            closeModal: false
          });
        } else {
          updateSummary = { succeeded: [], failed: [] };
        }
        incompatibleCount = Array.isArray(report?.incompatible) ? report.incompatible.length : 0;
        if (updateSummary.failed.length || incompatibleCount) {
          toast(`Проверка завершена: обновлено ${updateSummary.succeeded.length}, несовместимых ${incompatibleCount}, ошибок ${updateSummary.failed.length}.`, "err");
        }
      }

      // Метаданные меняются после проверки/обновления; игровая папка, миры,
      // конфиги, настройки и оставшиеся несовместимые моды не трогаются.
      await api.updateInstance({ ...meta, mc_version: cfg.mc, loader, version_override: null });
      $("#modal-mcver").hidden = true;
      state.contentUpdates = {};
      await refreshInstances();
      selectInstance(meta.id);
      if (updateMods && updateSummary && !updateSummary.failed.length && !incompatibleCount) {
        toast(`Версия сборки — MC ${cfg.mc}; моды обновлены`, "ok");
      } else if (!updateMods) {
        toast(`Версия сборки — MC ${cfg.mc}; моды сохранены без изменений`, "ok");
      } else {
        toast(`Версия сборки — MC ${cfg.mc}; проверь оставшиеся моды`, "");
      }
    } catch (err) {
      toast(`Не удалось сменить версию: ${contentErrorText(err)}`, "err");
    } finally {
      button.disabled = false;
    }
  }

  /** Последняя стабильная версия Minecraft из списка манифеста (рекомендуемая). */
  function latestReleaseId(versions) {
    const list = versions || [];
    const found = list.find((version) => !version.type || version.type === "release");
    return found ? found.id : ((list[0] || {}).id || "");
  }

  /** Первая стабильная версия загрузчика — рекомендуемая. */
  function recommendedLoader(list) {
    const options = list || [];
    return options.find((option) => option.stable) || options[0] || null;
  }

  /* ==================== МОДАЛКА СОЗДАНИЯ ==================== */
  async function openCreate(options = {}) {
    const settings = state.settings || {};
    state.create = {
      mode: options.mode === "server" ? "server" : "build",
      serverSource: options.importPath ? "import" : "new",
      importPath: options.importPath || "",
      serverKernel: "paper",
      serverKernelVersion: "",
      serverKernels: [],
      serverVersions: [],
      serverUrl: "",
      serverPort: 25565,
      serverCommand: "",
      serverStopCommand: "stop",
      name: "",
      mc: "",
      loader: "fabric",
      loaderVersion: "",
      versions: [],
      loaderVersionsList: [],
      // иконка: "" — первая буква названия, "i-cube" — встроенная, путь — своя картинка
      icon: "",
      iconFile: "",
      iconPreview: "",
      memory: Math.min(memoryLimits().max, Math.max(MEMORY_MIN, Math.round(memoryValue(settings.memory_mb) / MEMORY_STEP) * MEMORY_STEP)),
      installMode: "default",
      customDir: "",
      javaPath: "",
      javas: [],
      category: options.category || null
    };
    $("#modal-create").hidden = false;
    renderCreateModal();
    if (state.create.mode === "server") {
      state.create.serverKernels = await api.serverKernels().catch(() => []);
      if (state.create.serverSource === "new") {
        state.create.mc = "1.21.4";
        state.create.name = "Сервер 1.21.4";
      } else {
        state.create.name = state.create.importPath.split(/[\\/]/).pop() || "Импортированный сервер";
        const found = await api.serverScan([state.create.importPath]).catch(() => []);
        const candidate = found[0];
        if (candidate) {
          state.create.serverKernel = candidate.kernel || state.create.serverKernel;
          state.create.mc = candidate.mc_version || "";
          state.create.serverKernelVersion = candidate.mc_version || "";
          state.create.serverPort = candidate.port || state.create.serverPort;
          state.create.serverCommand = candidate.command || "";
        }
      }
      state.create.serverVersions = await api.serverKernelVersions(state.create.serverKernel).catch(() => []);
      const recommended = state.create.serverVersions[0];
      state.create.serverKernelVersion = state.create.serverKernelVersion || recommended?.id || state.create.mc;
      if (state.create.serverSource === "new" && recommended?.mc_version) state.create.mc = recommended.mc_version;
      renderCreateModal();
      return;
    }
    state.create.versions = await api.versions((settings.show_snapshots) || false).catch(() => []);
    state.create.mc = latestReleaseId(state.create.versions) || "1.21.4";
    state.create.name = `Сборка ${state.create.mc}`;
    renderCreateModal();
    await loadLoaderVersions();
    // список Java — из кеша ядра, не блокирует окно
    api.javas().then((list) => {
      state.create.javas = Array.isArray(list) ? list : [];
      if (!$("#modal-create").hidden) renderCreateModal();
    }).catch(() => {});
    if (!state.appHome) {
      api.appInfo().then((info) => {
        state.appHome = (info && info.home) || "";
        if (!$("#modal-create").hidden) renderCreateModal();
      }).catch(() => {});
    }
  }

  /** Папка лаунчера, куда сборка ставится по умолчанию. */
  function defaultInstallDir() {
    const home = state.appHome || "";
    const sep = home.includes("\\") ? "\\" : "/";
    return home ? `${home}${sep}instances` : "папка лаунчера/instances";
  }

  /** Превью иконки: буква, встроенная иконка или своя картинка. */
  function createIconHtml(cfg) {
    if (cfg.iconFile && cfg.iconPreview) return `<img src="${esc(cfg.iconPreview)}" alt="">`;
    if (cfg.icon) return `<svg class="ic"><use href="#${esc(cfg.icon)}"/></svg>`;
    return esc(String(cfg.name || "?").trim().charAt(0).toUpperCase() || "?");
  }

  function renderServerCreateModal() {
    const cfg = state.create;
    const body = $("#create-body");
    const kernels = cfg.serverKernels || [];
    const versions = cfg.serverVersions || [];
    body.innerHTML = `<div class="create-grid">
      <div class="field is-wide"><label>Тип</label><div class="chips" id="c-mode"><button class="chip" id="c-mode-build">Сборка</button><button class="chip is-active" id="c-mode-server">Сервер</button></div></div>
      <div class="field"><label>Название</label><input class="input" id="s-name" value="${esc(cfg.name)}" spellcheck="false"></div>
      <div class="field"><label>Источник</label><div class="chips" id="s-source"><button class="chip ${cfg.serverSource === "new" ? "is-active" : ""}" data-server-source="new">Создать с нуля</button><button class="chip ${cfg.serverSource === "import" ? "is-active" : ""}" data-server-source="import">Импорт папки</button></div></div>
      <div class="field is-wide" ${cfg.serverSource === "import" ? "" : "hidden"}><label>Папка сервера</label><div class="flex-row"><input class="input grow" id="s-import" value="${esc(cfg.importPath)}" readonly placeholder="Выбери готовую папку"><button class="btn" id="s-import-pick"><svg class="ic"><use href="#i-folder"/></svg>Выбрать…</button></div><div class="hint">Сохраняются все файлы, миры, плагины/моды и server-icon.png.</div></div>
      <div class="field"><label>Ядро</label><select class="select" id="s-kernel">${kernels.map((item) => `<option value="${esc(item.id)}" ${item.id === cfg.serverKernel ? "selected" : ""}>${esc(item.label)} — ${esc(item.group || "")}</option>`).join("") || `<option value="paper">Paper</option>`}</select></div>
      <div class="field"><label>Версия ядра / Minecraft</label><select class="select" id="s-version">${versions.map((item) => `<option value="${esc(item.id)}" ${item.id === cfg.serverKernelVersion ? "selected" : ""}>${esc(item.label || item.id)}</option>`).join("") || `<option value="${esc(cfg.serverKernelVersion || cfg.mc || "1.21.4")}">${esc(cfg.serverKernelVersion || cfg.mc || "1.21.4")}</option>`}</select></div>
      <div class="field is-wide" ${["custom", "spigot", "bungeecord"].includes(cfg.serverKernel) ? "" : "hidden"}><label>Прямая ссылка на jar (если нужна)</label><input class="input" id="s-url" value="${esc(cfg.serverUrl)}" placeholder="https://…/server.jar" spellcheck="false"></div>
      <div class="field"><label>Порт</label><input class="input" id="s-port" type="number" min="1" max="65535" value="${esc(cfg.serverPort)}"></div>
      <div class="field"><label>ОЗУ, МБ</label><input class="input" id="s-memory" type="number" min="512" max="65536" step="256" value="${esc(cfg.memory || 4096)}"></div>
      <div class="field"><label>Java (необязательно)</label><input class="input" id="s-java" value="${esc(cfg.javaPath || "")}" placeholder="java или путь к java.exe" spellcheck="false"></div>
      <div class="field"><label>Команда остановки</label><input class="input" id="s-stop" value="${esc(cfg.serverStopCommand)}" placeholder="stop"></div>
      <div class="field is-wide"><label>Команда запуска (необязательно)</label><input class="input" id="s-command" value="${esc(cfg.serverCommand)}" placeholder="по умолчанию: java -Xmx… -jar server.jar nogui" spellcheck="false"></div>
      <div class="field is-wide server-icon-note"><strong>server-icon.png</strong><span>При импорте файл используется автоматически. Для нового сервера его можно положить в папку после создания — OmniSpec подхватит его без конвертации в иконку сборки.</span></div>
    </div>`;
    $("#c-mode-build")?.addEventListener("click", async () => {
      cfg.mode = "build";
      if (!cfg.versions.length) cfg.versions = await api.versions((state.settings?.show_snapshots) || false).catch(() => []);
      cfg.mc = cfg.mc || latestReleaseId(cfg.versions) || "1.21.4";
      cfg.name = /^Сервер /.test(cfg.name) ? `Сборка ${cfg.mc}` : (cfg.name || `Сборка ${cfg.mc}`);
      renderCreateModal();
      await loadLoaderVersions();
    });
    $$("[data-server-source]").forEach((button) => button.addEventListener("click", async () => { cfg.serverSource = button.dataset.serverSource; if (cfg.serverSource === "import") { renderCreateModal(); return; } renderCreateModal(); }));
    $("#s-name")?.addEventListener("input", (event) => { cfg.name = event.target.value; });
    $("#s-import-pick")?.addEventListener("click", async () => { const picked = await api.pickDir("Папка существующего сервера").catch(() => null); if (!picked) return; cfg.importPath = picked; cfg.serverSource = "import"; const found = await api.serverScan([picked]).catch(() => []); const item = found[0]; if (item) { cfg.serverKernel = item.kernel || cfg.serverKernel; cfg.mc = item.mc_version || cfg.mc; cfg.serverKernelVersion = item.mc_version || cfg.serverKernelVersion; } renderCreateModal(); });
    $("#s-kernel")?.addEventListener("change", async (event) => {
      cfg.serverKernel = event.target.value;
      cfg.serverVersions = await api.serverKernelVersions(cfg.serverKernel).catch(() => []);
      const recommended = cfg.serverVersions[0];
      cfg.serverKernelVersion = recommended?.id || cfg.serverKernelVersion;
      if (recommended?.mc_version) cfg.mc = recommended.mc_version;
      else if (cfg.serverKernel !== "neoforge" && recommended?.id) cfg.mc = recommended.id;
      renderCreateModal();
    });
    $("#s-version")?.addEventListener("change", (event) => {
      cfg.serverKernelVersion = event.target.value;
      const option = cfg.serverVersions.find((item) => item.id === cfg.serverKernelVersion);
      if (option?.mc_version) cfg.mc = option.mc_version;
      else if (cfg.serverKernel !== "neoforge") cfg.mc = event.target.value;
    });
    $("#s-url")?.addEventListener("input", (event) => { cfg.serverUrl = event.target.value; });
    $("#s-port")?.addEventListener("input", (event) => { cfg.serverPort = Number(event.target.value) || 25565; });
    $("#s-memory")?.addEventListener("input", (event) => { cfg.memory = Number(event.target.value) || 4096; });
    $("#s-java")?.addEventListener("input", (event) => { cfg.javaPath = event.target.value; });
    $("#s-stop")?.addEventListener("input", (event) => { cfg.serverStopCommand = event.target.value; });
    $("#s-command")?.addEventListener("input", (event) => { cfg.serverCommand = event.target.value; });
  }

  function renderCreateModal() {
    const cfg = state.create;
    const body = $("#create-body");
    if (cfg?.mode === "server") return renderServerCreateModal();
    const dir = cfg.installMode === "custom" && cfg.customDir ? cfg.customDir : defaultInstallDir();
    body.innerHTML = `
      <div class="create-grid">
        <div class="field is-wide"><label>Тип</label><div class="chips" id="c-mode"><button class="chip is-active" id="c-mode-build">Сборка</button><button class="chip" id="c-mode-server">Сервер</button></div></div>
        <div class="field">
          <label>Название</label>
          <input class="input" id="c-name" value="${esc(cfg.name)}" spellcheck="false" autocomplete="off">
        </div>
        <div class="field">
          <label>Версия</label>
          <select class="select" id="c-mc">
            ${cfg.versions.map((version) => `<option value="${esc(version.id)}" ${version.id === cfg.mc ? "selected" : ""}>${esc(version.id)}${version.type && version.type !== "release" ? ` (${esc(version.type)})` : ""}${version.id === latestReleaseId(cfg.versions) ? " ★ рекомендуется" : ""}</option>`).join("") || `<option value="${esc(cfg.mc)}">${esc(cfg.mc)}</option>`}
          </select>
        </div>

        <div class="field is-wide">
          <label>Иконка</label>
          <div class="icon-grid create-icons" id="c-icons">
            <button class="icon-chip letter ${!cfg.icon && !cfg.iconFile ? "is-active" : ""}" data-icon="" title="Первая буква">${esc(String(cfg.name || "?").trim().charAt(0).toUpperCase() || "?")}</button>
            ${cfg.iconFile ? `<button class="icon-chip img is-active" data-icon-file="1" title="Своя картинка">${createIconHtml(cfg)}</button>` : ""}
            ${INSTANCE_ICONS.map((icon) => `<button class="icon-chip ${!cfg.iconFile && cfg.icon === icon ? "is-active" : ""}" data-icon="${icon}" title="${icon.replace("i-", "")}"><svg class="ic"><use href="#${icon}"/></svg></button>`).join("")}
          </div>
          <div class="settings-actions">
            <button class="btn" id="c-icon-file"><svg class="ic"><use href="#i-image"/></svg>Иконка из картинки…</button>
          </div>
        </div>

        <div class="field is-wide">
          <label>Загрузчик</label>
          <div class="chips" id="c-loaders">
            ${Object.entries(LOADER_NAMES).map(([value, label]) => `<button class="chip ${cfg.loader === value ? "is-active" : ""}" data-loader="${value}">${label}</button>`).join("")}
          </div>
        </div>
        <div class="field" id="c-loader-version-field" ${cfg.loader === "vanilla" ? "hidden" : ""}>
          <label>Версия загрузчика</label>
          <select class="select" id="c-loader-version">
            ${cfg.loaderVersionsList.length ? cfg.loaderVersionsList.map((option) => `<option value="${esc(option.version)}" ${option.version === cfg.loaderVersion ? "selected" : ""}>${esc(option.version)}${option.stable ? "" : " (beta)"}${recommendedLoader(cfg.loaderVersionsList) && option.version === recommendedLoader(cfg.loaderVersionsList).version ? " ★ рекомендуется" : ""}</option>`).join("") : `<option value="">загружаем…</option>`}
          </select>
        </div>

        <div class="field">
          <label>Java</label>
          <select class="select" id="c-java">
            <option value="" ${!cfg.javaPath ? "selected" : ""}>по умолчанию — подобрать автоматически</option>
            ${cfg.javas.map((item) => `<option translate="no" value="${esc(item.path)}" ${cfg.javaPath === item.path ? "selected" : ""}>Java ${esc(String(item.major))} — ${esc(item.vendor || "Java")} (${esc(item.path)})</option>`).join("")}
            ${cfg.javaPath && !cfg.javas.some((item) => item.path === cfg.javaPath) ? `<option translate="no" value="${esc(cfg.javaPath)}" selected>${esc(cfg.javaPath)}</option>` : ""}
          </select>
        </div>

        <div class="field is-wide">
          <label>Выделение ОЗУ</label>
          ${memoryRangeHtml("c-memory", cfg.memory, "Выделение ОЗУ для новой сборки")}
        </div>

        <div class="field is-wide">
          <label>Место установки</label>
          <div class="chips" id="c-install-mode">
            <button class="chip ${cfg.installMode !== "custom" ? "is-active" : ""}" data-install-mode="default">По умолчанию</button>
            <button class="chip ${cfg.installMode === "custom" ? "is-active" : ""}" data-install-mode="custom">Своя папка</button>
          </div>
          <div class="flex-row" style="margin-top:8px">
            <input class="input grow" id="c-dir" value="${esc(dir)}" spellcheck="false" ${cfg.installMode === "custom" ? "" : "readonly"}>
            <button class="btn" id="c-dir-pick"><svg class="ic"><use href="#i-folder"/></svg>Выбрать папку…</button>
          </div>
          <div class="hint">${cfg.installMode === "custom" ? "игра, моды и миры будут в этой папке" : "по умолчанию — в папке лаунчера, рядом с остальными сборками"}</div>
        </div>
      </div>`;

    // --- привязки ---
    $("#c-mode-server")?.addEventListener("click", async () => {
      cfg.mode = "server";
      cfg.serverKernels = await api.serverKernels().catch(() => []);
      cfg.serverVersions = await api.serverKernelVersions(cfg.serverKernel).catch(() => []);
      cfg.serverKernelVersion = cfg.serverVersions[0]?.id || cfg.mc || "1.21.4";
      renderCreateModal();
    });
    $("#c-name").addEventListener("input", (event) => {
      cfg.name = event.target.value;
      const chips = $("#c-icons");
      if (chips && chips.firstElementChild) chips.firstElementChild.textContent = String(cfg.name || "?").trim().charAt(0).toUpperCase() || "?";
      updateCreateHint();
    });
    $("#c-mc").addEventListener("change", async (event) => {
      cfg.mc = event.target.value;
      if (!cfg.name || /^Сборка /.test(cfg.name)) cfg.name = `Сборка ${cfg.mc}`;
      await loadLoaderVersions();
      renderCreateModal();
    });
    $$("#c-icons .icon-chip").forEach((chip) => chip.addEventListener("click", () => {
      if (chip.dataset.iconFile) return;
      cfg.icon = chip.dataset.icon || "";
      cfg.iconFile = "";
      cfg.iconPreview = "";
      renderCreateModal();
    }));
    $("#c-icon-file").addEventListener("click", async () => {
      const path = await api.pickFile("Иконка сборки", ["png", "jpg", "jpeg", "webp", "gif"]).catch(() => null);
      if (!path) return;
      cfg.iconFile = path;
      cfg.icon = "";
      cfg.iconPreview = await readImagePreview(path).catch(() => "");
      renderCreateModal();
    });
    $$("#c-loaders .chip").forEach((chip) => chip.addEventListener("click", async () => {
      cfg.loader = chip.dataset.loader;
      renderCreateModal();
      await loadLoaderVersions();
    }));
    const loaderVersion = $("#c-loader-version");
    if (loaderVersion) loaderVersion.addEventListener("change", (event) => {
      cfg.loaderVersion = event.target.value;
      updateCreateHint();
    });
    const memory = $("#c-memory");
    memory.addEventListener("input", () => {
      cfg.memory = Number(memory.value);
      updateMemoryRange(memory);
      updateCreateHint();
    });
    $$("#c-install-mode .chip").forEach((chip) => chip.addEventListener("click", () => {
      cfg.installMode = chip.dataset.installMode === "custom" ? "custom" : "default";
      renderCreateModal();
    }));
    $("#c-dir").addEventListener("input", (event) => {
      if (cfg.installMode !== "custom") return;
      cfg.customDir = event.target.value;
      updateCreateHint();
    });
    $("#c-dir-pick").addEventListener("click", async () => {
      const picked = await api.pickDir("Куда ставить сборку").catch(() => null);
      if (!picked) return;
      cfg.installMode = "custom";
      cfg.customDir = picked;
      renderCreateModal();
    });
    $("#c-java").addEventListener("change", (event) => { cfg.javaPath = event.target.value; });
    updateCreateHint();
  }

  function updateCreateHint() {
    const cfg = state.create;
    const hint = $("#create-hint");
    if (!hint || !cfg) return;
    const loader = cfg.loader === "vanilla" ? "ваниль" : `${LOADER_NAMES[cfg.loader] || cfg.loader} ${cfg.loaderVersion || "—"}`;
    const customPath = cfg.installMode === "custom" && cfg.customDir;
    const where = customPath ? cfg.customDir : "папка лаунчера";
    hint.innerHTML = `<span translate="no">MC ${esc(cfg.mc || "—")}</span> · <span>${esc(loader)}</span> · <span>${esc(cfg.memory)} МБ</span> · <span ${customPath ? 'translate="no"' : ""}>${esc(where)}</span>`;
  }

  /** Превью картинки-иконки до создания сборки. */
  async function readImagePreview(path) {
    const data = await api.imageDataUrl(path).catch(() => null);
    return typeof data === "string" ? data : "";
  }

  async function loadLoaderVersions() {
    const cfg = state.create;
    if (!cfg) return;
    if (cfg.loader === "vanilla") { cfg.loaderVersionsList = []; cfg.loaderVersion = ""; return; }
    cfg.loaderVersionsList = await api.loaderVersions(cfg.loader, cfg.mc).catch(() => []);
    const current = cfg.loaderVersionsList.find((option) => option.stable) || cfg.loaderVersionsList[0];
    cfg.loaderVersion = current ? current.version : "";
    renderCreateModal();
  }

  async function submitServerCreate(cfg) {
    const submit = $("#create-submit");
    submit.disabled = true;
    try {
      if (cfg.serverSource === "import" && !cfg.importPath) throw new Error("выбери папку существующего сервера");
      if (cfg.serverSource === "new" && !cfg.mc) throw new Error("укажи версию Minecraft");
      const meta = await api.serverCreate({
        name: cfg.name || "Новый сервер",
        mc_version: cfg.serverSource === "import" ? (cfg.mc || "") : cfg.mc,
        kernel: cfg.serverKernel,
        kernel_version: cfg.serverSource === "import" ? "" : (cfg.serverKernelVersion || cfg.mc),
        import_path: cfg.serverSource === "import" ? cfg.importPath : null,
        custom_url: cfg.serverUrl || null,
        java_path: cfg.javaPath || null,
        memory_mb: Number(cfg.memory || 4096),
        port: Number(cfg.serverPort || 25565),
        command: cfg.serverCommand || null,
        stop_command: cfg.serverStopCommand || "stop",
        category: cfg.category || null
      });
      $("#modal-create").hidden = true;
      await refreshInstances();
      openInstance(meta.id);
      toast(`Сервер «${meta.name}» готов`, "ok");
    } catch (error) { toast(String(error), "err"); }
    finally { submit.disabled = false; }
  }

  async function submitCreate() {
    const cfg = state.create;
    if (!cfg) return;
    if (cfg.mode === "server") return submitServerCreate(cfg);
    const submit = $("#create-submit");
    submit.disabled = true;
    try {
      const loader = cfg.loader === "vanilla" ? { type: "vanilla" } : { type: cfg.loader, version: cfg.loaderVersion };
      const customDir = cfg.installMode === "custom" ? (cfg.customDir || "").trim() : "";
      const meta = await api.createInstance({
        name: cfg.name || `Сборка ${cfg.mc}`,
        mc_version: cfg.mc,
        loader,
        icon: cfg.iconFile ? null : (cfg.icon || null),
        memory_mb: cfg.memory,
        java_path: cfg.javaPath || null,
        game_dir: customDir || null
      });
      $("#modal-create").hidden = true;
      if (cfg.iconFile) await api.setInstanceIconFile(meta.id, cfg.iconFile).catch(() => {});
      if (cfg.category) await moveInstanceToCategory(meta.id, cfg.category);
      await refreshInstances();
      openInstance(meta.id);
      toast(`Сборка «${meta.name}» создана`, "ok");
    } catch (err) {
      toast(String(err), "err");
    } finally {
      submit.disabled = false;
    }
  }

  /* ==================== СОБЫТИЯ ==================== */
    // Ни один клик не должен уводить webview с интерфейса лаунчера:
    // внешние ссылки открываем системным браузером, а не внутри окна.
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest("a[href]");
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (href.startsWith("#") || href.startsWith("javascript:")) return;
      event.preventDefault();
      if (IS_APP) api.openUrl(href).catch((error) => toast(String(error), "err"));
      else window.open(href, "_blank");
    }, true);

  /** Привязка, которая не падает, если элемента нет (часть кнопок живёт в модалках). */
  function on(selector, event, handler) {
    const el = $(selector);
    if (el) el.addEventListener(event, handler);
  }

  function bindEvents() {
    initSmoothScroll();
    initSoundEvents();
    document.addEventListener("click", () => requestAnimationFrame(refreshActiveIndicators), true);
    window.addEventListener("resize", refreshActiveIndicators);
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
      state.tab = tab.dataset.tab;
      if (state.tab === "download") refreshInstalledProjects();
      renderTab();
    }));
    on("#btn-play", "click", play);
    on("#btn-stop", "click", stopGame);
    on("#btn-restart", "click", async () => {
      const meta = selected();
      await stopGame();
      if (!meta || !isServer(meta)) { setTimeout(play, 800); return; }
      for (let attempt = 0; attempt < 20 && state.running.has(meta.id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await refreshInstances();
      }
      if (!state.running.has(meta.id)) play();
      else toast("Сервер ещё останавливается — запусти его после завершения", "");
    });
    on("#btn-home", "click", () => selectInstance(null));
    on("#btn-create", "click", openCreate);

    /* аккаунты и настройки лаунчера */
    on("#account-chip", "click", (event) => { event.stopPropagation(); toggleAccountPopover(); });
    on("#account-chip", "contextmenu", (event) => {
      event.preventDefault();
      const account = activeAccount();
      if (account) openAccountCtx(event.clientX, event.clientY, account);
      else openAccounts();
    });
    on("#prefs-account", "click", () => { prefsCategory = "profile"; renderPrefs(); });
    // клик мимо — закрываем выпадающий список
    document.addEventListener("mousedown", (event) => {
      const pop = $("#account-pop");
      if (!pop || pop.hidden) return;
      if (pop.contains(event.target) || (event.target.closest && event.target.closest("#account-chip"))) return;
      closeAccountPopover();
    });
    window.addEventListener("resize", () => closeAccountPopover());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeAccountPopover();
      const menu = $("#ctx-menu");
      if (menu && !menu.hidden) closeCtxMenu();
    });
    on("#btn-quick-settings", "click", () => openPrefs());
    on("#btn-new-build", "click", openCreate);
    on("#mod-target-close", "click", () => closeModTarget());
    on("#mod-target-cancel", "click", () => closeModTarget());
    on("#mod-target-submit", "click", confirmModTarget);
    const targetModal = $("#modal-mod-target");
    targetModal.addEventListener("mousedown", (event) => { if (event.target === targetModal) closeModTarget(); });
    targetModal.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = $$("button:not([disabled]), input:not([disabled]), select:not([disabled])", targetModal).filter((element) => element.offsetParent !== null);
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
    });
    $$("[data-close-project]").forEach((el) => el.addEventListener("click", closeProjectModal));
    const projectModal = $("#modal-project");
    if (projectModal) projectModal.addEventListener("mousedown", (event) => { if (event.target === projectModal) closeProjectModal(); });
    $$("[data-proj-tab]").forEach((button) => button.addEventListener("click", () => setProjectTab(button.dataset.projTab)));
    $("#proj-tabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "description" : event.key === "End" ? "gallery"
        : (document.activeElement?.dataset.projTab === "gallery" ? "description" : "gallery");
      setProjectTab(next, true);
    });
    on("#project-image-close", "click", closeProjectImage);
    const imageModal = $("#modal-project-image");
    imageModal.addEventListener("mousedown", (event) => { if (event.target === imageModal) closeProjectImage(); });
    on("#project-image-prev", "click", () => { projectImageIndex = (projectImageIndex + projectImages.length - 1) % projectImages.length; updateProjectImage(); });
    on("#project-image-next", "click", () => { projectImageIndex = (projectImageIndex + 1) % projectImages.length; updateProjectImage(); });
    imageModal.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); $("#project-image-prev").click(); }
      if (event.key === "ArrowRight") { event.preventDefault(); $("#project-image-next").click(); }
      if (event.key !== "Tab") return;
      const controls = $$("button:not([disabled])", imageModal);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
    });
    $$("[data-close-dup]").forEach((el) => el.addEventListener("click", () => { $("#modal-dup").hidden = true; }));
    const dupModal = $("#modal-dup");
    if (dupModal) dupModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-dup") dupModal.hidden = true; });
    on("#btn-global-settings", "click", () => openPrefs());
    on("[data-close-prefs]", "click", () => { $("#modal-prefs").hidden = true; });
    on("#build-path-copy", "click", async () => {
      const text = ($("#build-path span") || {}).textContent || "";
      if (!text) return;
      try { await navigator.clipboard.writeText(text); toast("Путь скопирован", "ok"); }
      catch { toast("Не удалось скопировать", "err"); }
    });
    on("[data-close-acc]", "click", () => { $("#modal-account").hidden = true; });
    on("[data-close-versions]", "click", () => { $("#modal-versions").hidden = true; });
    on("[data-close-upd-list]", "click", () => { $("#modal-updates-list").hidden = true; });
    // Версия в шапке кликабельна и ведёт на смену версии.
    on("#btn-build-menu", "click", (event) => {
      const meta = selected();
      if (!meta) return;
      const rect = event.currentTarget.getBoundingClientRect();
      openInstanceMenu(rect.left, rect.bottom + 4, meta);
    });
    on("#mcver-apply", "click", () => applyVersionChange());
    $$("[data-close-mcver]").forEach((el) => el.addEventListener("click", () => { $("#modal-mcver").hidden = true; }));
    const mcverModal = $("#modal-mcver");
    if (mcverModal) mcverModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-mcver") mcverModal.hidden = true; });
    on("[data-close-prompt]", "click", () => { const modal = $("#modal-prompt"); if (modal) modal.hidden = true; });
    const verModal = $("#modal-versions");
    if (verModal) verModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-versions") verModal.hidden = true; });
    const prefsModal = $("#modal-prefs");
    if (prefsModal) prefsModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-prefs") prefsModal.hidden = true; });
    const initialTabModal = $("#modal-initial-tab");
    if (initialTabModal) {
      $("[data-close-initial-tab]", initialTabModal)?.addEventListener("click", closeInitialTabDialog);
      initialTabModal.addEventListener("mousedown", (event) => { if (event.target === initialTabModal) closeInitialTabDialog(); });
      initialTabModal.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const controls = $$("button:not([disabled])", initialTabModal);
        if (!controls.length) return;
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
      });
    }
    const accModal = $("#modal-account");
    if (accModal) accModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-account") accModal.hidden = true; });

    on("#btn-folder", "click", () => { const meta = selected(); if (!meta) return; const path = isServer(meta) ? api.instancePath(meta.id) : Promise.resolve(`/instances/${meta.id}/minecraft`); path.then((value) => api.openPath(value)).catch(() => {}); });
    // «Вид» больше не переключает компактный список — открывает окно «Все сборки»
    binderAllBuilds();
    on("#btn-sort", "click", () => {
      state.instances.sort((a, b) => a.name.localeCompare(b.name));
      renderSidebar();
    });
    on("#instance-search", "input", renderSidebar);

    $$("[data-win]").forEach((btn) => btn.addEventListener("click", () => api.window(btn.dataset.win).catch(() => {})));
    // перетаскивание окна за шапку — в оконном и развёрнутом режимах;
    // двойной клик по шапке — развернуть/свернуть, как в Windows
    const titlebar = $(".titlebar");
    if (titlebar) {
      titlebar.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || !IS_APP) return;
        if (event.target.closest("button")) return;
        api.window("drag").catch(() => {});
      });
      titlebar.addEventListener("dblclick", (event) => {
        if (!IS_APP || event.target.closest("button")) return;
        api.window("maximize").catch(() => {});
      });
    }
    $$("[data-close-modal]").forEach((btn) => btn.addEventListener("click", () => { $("#modal-create").hidden = true; }));
    $$("[data-close-update]").forEach((btn) => btn.addEventListener("click", () => { $("#modal-update").hidden = true; }));
    $("#modal-update").addEventListener("mousedown", (event) => { if (event.target.id === "modal-update") $("#modal-update").hidden = true; });
    $("#btn-update").addEventListener("click", openUpdateModal);
    $("#upd-install").addEventListener("click", installUpdate);
    $("#upd-page").addEventListener("click", () => {
      const url = (state.update.info && state.update.info.page_url) || "https://github.com";
      api.openUrl(url).catch((error) => toast(String(error), "err"));
    });
    $("#modal-create").addEventListener("mousedown", (event) => { if (event.target.id === "modal-create") $("#modal-create").hidden = true; });
    $("#create-submit").addEventListener("click", submitCreate);

    // контекстное меню закрывается кликом мимо, прокруткой и Escape
    document.addEventListener("mousedown", (event) => {
      const menu = $("#ctx-menu");
      if (menu && !menu.hidden && !menu.contains(event.target)) closeCtxMenu();
    });
    window.addEventListener("blur", closeCtxMenu);
    window.addEventListener("resize", closeCtxMenu);

    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); refreshInstances(); }
      if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); state.logs[state.selectedId] = []; renderLogs(state.selectedId); }
      if (event.key === "Escape") {
        if (!$("#modal-project-image").hidden) { event.preventDefault(); closeProjectImage(); return; }
        if (!$("#modal-mod-target").hidden) { event.preventDefault(); closeModTarget(); return; }
        if (!$("#modal-project").hidden) { event.preventDefault(); closeProjectModal(); return; }
        const initialTabModal = $("#modal-initial-tab");
        if (initialTabModal && !initialTabModal.hidden) {
          event.preventDefault();
          closeInitialTabDialog();
          return;
        }
        $("#modal-create").hidden = true;
        const prefs = $("#modal-prefs");
        if (prefs) prefs.hidden = true;
        const acc = $("#modal-account");
        if (acc) acc.hidden = true;
        const ver = $("#modal-versions");
        if (ver) ver.hidden = true;
        const prompt = $("#modal-prompt");
        if (prompt) prompt.hidden = true;
        closeCtxMenu();
      }
      if (event.key === "F11") {
        event.preventDefault();
        api.window("fullscreen").catch(() => {});
        return;
      }
      // Enter без фокуса на кнопке не запускает игру: после перерисовки
      // элементов фокус может оказаться на BODY. Кнопка «Играть» по-прежнему
      // работает с Enter и пробелом штатным поведением браузера.
    });
  }

  async function attachBackendEvents() {
    // Событие приходит только от нативного tray/window слоя. Оно не влияет
    // на set_presence: RPC должен жить независимо от видимости WebView.
    await api.onWindowVisibility((payload) => setQuietMode(Boolean(payload && payload.hidden)));
    if (!IS_APP) {
      // демо-режим: показываем «живой» лог
      const demo = DEMO.demoLogs;
      let index = 0;
      const timer = setInterval(() => {
        if (index >= demo.length) { clearInterval(timer); return; }
        pushLog("fabulously-optimized", demo[index], classify(demo[index]));
        index += 1;
      }, 260);
      // прогресс импорта в демо-режиме тоже доходит до полосы процессов
      api.onProgress((payload) => setProgress(payload));
      return;
    }

    await api.onProgress((payload) => setProgress(payload));
    await api.onLog((payload) => {
      if (!payload || !payload.instance) return;
      diagnostics.log(payload);
      const line = String(payload.line ?? "");
      pushLog(payload.instance, line, classify(line));
    });
    await api.onExit(async (payload) => {
      if (!payload || !payload.instance) return;
      const run = diagnostics.exit(payload);
      const stopped = typeof payload.stopped === "boolean" ? payload.stopped : Boolean(run && run.status === "stopped");
      dropSession(payload.instance, payload.run_id);
      const hasCode = Number.isInteger(payload.code);
      const subject = payload.server ? "Сервер" : "Игра";
      const endText = stopped ? `${subject} остановлен пользователем` : `${subject} завершён`;
      pushLog(payload.instance, `[omnispec] ${endText}${hasCode ? ` (код ${payload.code})` : ""}`, stopped || !hasCode || payload.code === 0 ? "ok" : "err");
      // время игры пишется в мету сборки на стороне ядра — подтягиваем его
      await refreshInstances();
      if (state.tab === "discover") renderDiscover();
      renderSidebar();
      updateStatus();
      syncPresence();
      if (hasCode && payload.code !== 0 && !stopped) toast(`Игра закрылась с ошибкой (код ${payload.code}). Открой вкладку «Ошибки».`, "err");
    });
    await api.onToast((payload) => toast(payload.message, payload.kind || ""));
  }

  /* ==================== ПЕРВЫЙ ЗАПУСК ====================
   * Короткие шаги: язык, тема, эффекты, трей, трейсер, масштаб и импорт сборок.
   * Показываем один раз — отметка onboarded живёт в настройках.
   */
  const ONBOARD_STEPS = ["language", "theme", "effects", "tray", "trail", "scale", "import"];
  let onboardStep = 0;

  /** Окно первого запуска — только при самом первом входе, не при обновлении. */
  function onboardNeeded() {
    // Поле создаётся только у нового профиля; в старых настройках его нет/false.
    return state.settings?.onboarded !== true && state.settings?.onboarding_pending === true;
  }

  /**
   * Лаунчером уже пользовались? Ник по умолчанию («Player») не в счёт — смотрим
   * только на то, что появляется от реальной работы: выбранная сборка, категории,
   * обои, своя тема, масштаб, образы.
   */
  function onboardLooksUsed() {
    const settings = state.settings || {};
    return Boolean(settings.last_instance)
      || (Array.isArray(state.instances) && state.instances.length > 0)
      || (Array.isArray(state.accounts?.accounts) && state.accounts.accounts.length > 0)
      || Boolean(settings.wallpaper)
      || Boolean(settings.mc_version)
      || (Array.isArray(settings.categories) && settings.categories.length > 0)
      || (Array.isArray(settings.skin_favorites) && settings.skin_favorites.length > 0)
      || (Boolean(settings.theme) && settings.theme !== "dark")
      || (Number(settings.ui_scale) > 0 && Number(settings.ui_scale) !== 100);
  }

  function onboardEffectsOn() {
    return (state.fx && state.fx !== "off") || (state.ambient && state.ambient !== "off");
  }

  function onboardSave(patch) {
    state.settings = { ...(state.settings || {}), ...patch };
    api.saveSettings(state.settings).catch(() => {});
  }

  function onboardStepHtml() {
    const step = ONBOARD_STEPS[onboardStep];
    if (step === "language") {
      return `<div class="onboard-lead">
          <span class="onboard-title">Выберите язык</span>
          <span class="muted">Его можно изменить позже в настройках.</span>
        </div>
        <div class="onboard-languages" role="group" aria-label="Язык интерфейса">
          ${LANGUAGES.map(([code, label]) => `<button type="button" class="onboard-language ${displayedLanguage === code ? "is-active" : ""}" data-onboard-language="${code}" aria-pressed="${displayedLanguage === code}" translate="no">${esc(label)}</button>`).join("")}
        </div>`;
    }
    if (step === "theme") {
      return `<div class="onboard-lead">
          <span class="onboard-title">Тема оформления</span>
          <span class="muted">перекрашивает весь лаунчер — панели, текст и акцент</span>
        </div>
        <div class="theme-grid onboard-themes" id="onboard-themes">
          ${Object.entries(THEMES).map(([id, theme]) => `
            <button class="theme-chip ${state.theme === id ? "is-active" : ""}" data-theme-id="${id}" title="${esc(theme.label)}">
              <span class="theme-swatch" style="background:${theme.bg}">
                <span class="theme-band" style="background:${theme.panel}"></span>
                <span class="theme-accent" style="background:${theme.accent}"></span>
              </span>
              <span class="theme-name">${esc(theme.label)}</span>
            </button>`).join("")}
        </div>`;
    }
    if (step === "effects") {
      return `<div class="onboard-lead">
          <span class="onboard-title">Эффекты на экране</span>
          <span class="muted">волна от клика и частицы на фоне</span>
        </div>
        <div class="onboard-row">
          <div class="onboard-row-main">
            <span class="onboard-row-title">${onboardEffectsOn() ? "Включены" : "Выключены"}</span>
            <span class="muted">если мешают — выключите, лаунчер будет спокойнее</span>
          </div>
          <button class="switch ${onboardEffectsOn() ? "on" : ""}" id="onboard-fx"></button>
        </div>`;
    }
    if (step === "tray") {
      const on = state.settings?.minimize_to_tray === true;
      return `<div class="onboard-lead">
          <span class="onboard-title">Сворачивание в трей</span>
          <span class="muted">окно можно спрятать в область уведомлений, не останавливая Discord RPC и серверы</span>
        </div>
        <div class="onboard-row">
          <div class="onboard-row-main">
            <span class="onboard-row-title">${on ? "Включено" : "Выключено"}</span>
            <span class="muted">кнопка «свернуть» прячет окно; кнопка X завершает приложение</span>
          </div>
          <button class="switch ${on ? "on" : ""}" id="onboard-tray" role="switch" aria-label="Сворачивать окно в системный трей" aria-checked="${on}"></button>
        </div>`;
    }
    if (step === "trail") {
      const on = state.trail !== false;
      return `<div class="onboard-lead">
          <span class="onboard-title">Трейсер за курсором</span>
          <span class="muted">искры тянутся за мышкой</span>
        </div>
        <div class="onboard-row">
          <div class="onboard-row-main">
            <span class="onboard-row-title">${on ? "Включён" : "Выключен"}</span>
            <span class="muted">толщину, длину и цвет можно подобрать в настройках</span>
          </div>
          <button class="switch ${on ? "on" : ""}" id="onboard-trail"></button>
        </div>`;
    }
    if (step === "scale") {
      const current = Number(state.uiScale) || 100;
      return `<div class="onboard-lead">
          <span class="onboard-title">Масштаб лаунчера</span>
          <span class="muted">размер интерфейса — как «размер интерфейса» в Minecraft</span>
        </div>
        <div class="chips onboard-scale" id="onboard-scale">
          ${UI_SCALES.map((scale) => `<button class="chip ${current === scale ? "is-active" : ""}" data-scale="${scale}">${scale}%</button>`).join("")}
        </div>`;
    }
    return `<div class="onboard-lead">
        <span class="onboard-title">Сборки</span>
        <span class="muted">можно добавить сразу или позже — кнопка «Добавить сборку» всегда на главной</span>
      </div>
      <div class="onboard-row">
        <div class="onboard-row-main">
          <span class="onboard-row-title">Импорт готовой сборки</span>
          <span class="muted">файл .mrpack или .zip, папка лаунчера (PolyMC/Prism), ссылка</span>
        </div>
        <button class="btn" id="onboard-import"><svg class="ic"><use href="#i-download"/></svg>Выбрать файл</button>
      </div>
      <div class="onboard-row">
        <div class="onboard-row-main">
          <span class="onboard-row-title">Импорт из другого лаунчера</span>
          <span class="muted">Prism, MultiMC, PolyMC, Modrinth App, AstralRinth, ATLauncher, CurseForge, GDLauncher — найдём сборки сами</span>
        </div>
        <button class="btn" id="onboard-import-launcher"><svg class="ic"><use href="#i-grid"/></svg>Из лаунчера</button>
      </div>`;
  }

  function renderOnboard() {
    const body = $("#onboard-body");
    if (!body) return;
    $("#onboard-count").textContent = `${onboardStep + 1} / ${ONBOARD_STEPS.length}`;
    $("#onboard-prev").hidden = onboardStep === 0;
    $("#onboard-next").textContent = onboardStep === ONBOARD_STEPS.length - 1 ? "Готово" : "Далее";
    body.innerHTML = onboardStepHtml();
    const step = ONBOARD_STEPS[onboardStep];

    if (step === "language") {
      $$("[data-onboard-language]", body).forEach((button) => button.addEventListener("click", async () => {
        const buttons = $$("[data-onboard-language]", body);
        buttons.forEach((item) => { item.disabled = true; item.classList.toggle("is-active", item === button); item.setAttribute("aria-pressed", String(item === button)); });
        const next = $("#onboard-next");
        next.disabled = true;
        await chooseLanguage(button.dataset.onboardLanguage);
        next.disabled = false;
        if (!$("#modal-onboard").hidden && ONBOARD_STEPS[onboardStep] === "language") renderOnboard();
      }));
    }
    if (step === "theme") {
      $$("#onboard-themes .theme-chip").forEach((chip) => chip.addEventListener("click", () => {
        const id = chip.dataset.themeId;
        applyTheme(id);
        state.theme = id;
        $$("#onboard-themes .theme-chip").forEach((el) => el.classList.toggle("is-active", el === chip));
        onboardSave({ theme: id });
        applyWallpaper();
      }));
    }
    if (step === "effects") {
      $("#onboard-fx").addEventListener("click", (event) => {
        const on = !onboardEffectsOn();
        const style = (state.settings && FX_STYLES[state.settings.click_fx]) ? state.settings.click_fx : "wave";
        state.fx = on ? style : "off";
        applyClickFx(state.fx);
        applyAmbient(on ? (state.ambient && state.ambient !== "off" ? state.ambient : "stars") : "off");
        event.currentTarget.classList.toggle("on", on);
        onboardSave({ click_fx: state.fx, ambient: on ? "stars" : "off" });
        renderOnboard();
      });
    }
    if (step === "tray") {
      $("#onboard-tray").addEventListener("click", (event) => {
        const on = event.currentTarget.classList.toggle("on");
        event.currentTarget.setAttribute("aria-checked", String(on));
        onboardSave({ minimize_to_tray: on });
        renderOnboard();
      });
    }
    if (step === "trail") {
      $("#onboard-trail").addEventListener("click", (event) => {
        const on = !(state.trail !== false);
        applyTrail(on);
        event.currentTarget.classList.toggle("on", on);
        onboardSave({ trail: on, ...(on ? {
          trail_style: TRAIL_DEFAULTS.style,
          trail_size: TRAIL_DEFAULTS.size,
          trail_length: TRAIL_DEFAULTS.length,
          trail_opacity: TRAIL_DEFAULTS.opacity
        } : {}) });
        renderOnboard();
      });
    }
    if (step === "scale") {
      $$("#onboard-scale .chip").forEach((chip) => chip.addEventListener("click", () => {
        const scale = Number(chip.dataset.scale) || 100;
        applyUiScale(scale);
        $$("#onboard-scale .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
        onboardSave({ ui_scale: scale });
      }));
    }
    if (step === "import") {
      $("#onboard-import").addEventListener("click", async () => {
        await finishOnboard();
        importFromExplorer(null);
      });
      $("#onboard-import-launcher").addEventListener("click", async () => {
        await finishOnboard();
        // открываем главную и сразу разворачиваем поиск сборок в других лаунчерах
        state.tab = "discover";
        state.home.extOpen = true;
        renderTab();
        loadHomeExternal();
      });
    }
  }

  function openOnboard() {
    const modal = $("#modal-onboard");
    if (!modal) return;
    modal.hidden = false;
    onboardStep = 0;
    renderOnboard();
  }

  /** Закрываем первый запуск: больше окно этой версии не показываем. */
  async function finishOnboard() {
    const modal = $("#modal-onboard");
    if (modal) modal.hidden = true;
    state.settings = { ...(state.settings || {}), onboarded: true, onboarding_pending: false };
    try { await api.saveSettings(state.settings); } catch (error) { /* не критично */ }
  }

  async function init() {
    bindEvents();
    initClickFx();
    initDownloadsPanel();
    // Подписываемся до появления списка сборок и сетевой проверки обновлений,
    // иначе быстрый запуск может завершиться до регистрации game-log/game-exit.
    try { await attachBackendEvents(); state.liveLogAvailable = true; }
    catch (error) { state.liveLogAvailable = false; toast(`Живой лог недоступен: ${error && error.message ? error.message : error}`, "err"); }
    try {
      state.settings = await api.settings();
    } catch { state.settings = { ...DEMO.settings }; }
    displayedLanguage = LANGUAGES.some(([code]) => code === state.settings?.language) ? state.settings.language : "ru";
    confirmedLanguage = displayedLanguage;
    I18N.setLanguage(displayedLanguage);
    displayedLauncherIcon = launcherIconOption(state.settings?.launcher_icon)[0];
    confirmedLauncherIcon = displayedLauncherIcon;
    state.settings = { ...(state.settings || {}), launcher_icon: displayedLauncherIcon };
    paintLauncherIcon(displayedLauncherIcon);
    // Значение физической ОЗУ нужно до открытия настроек или создания сборки.
    state.systemMemory = await api.systemMemory().catch(() => null);
    // Вид каталога один для Modrinth и CurseForge и не теряется при перезапуске.
    state.modsView = state.settings?.mods_view === "grid" ? "grid" : "list";
    // Гардероб плащей по умолчанию открывается центральной каруселью;
    // настройка сохраняется, чтобы переключатель не приходилось нажимать снова.
    state.capeView = state.settings?.cape_view === "grid" ? "grid" : "list";
    // Оформление из settings.json (как prefs в OmniPanel): тема и эффект клика.
    state.customTheme = {
      bg: (state.settings && state.settings.theme_bg) || CUSTOM_THEME_DEFAULT.bg,
      accent: (state.settings && state.settings.theme_accent) || CUSTOM_THEME_DEFAULT.accent,
      text: (state.settings && state.settings.theme_text) || CUSTOM_THEME_DEFAULT.text
    };
    state.theme = applyTheme((state.settings && state.settings.theme) || "dark");
    state.fx = (state.settings && state.settings.click_fx) || "wave";
    applyClickFx(state.fx);
    applyAmbient((state.settings && state.settings.ambient) || "stars");
    applyEffectSize((state.settings && state.settings.effect_size) || 100);
    applyTrailSize((state.settings && state.settings.trail_size) || TRAIL_DEFAULTS.size);
    applyTrailLength((state.settings && state.settings.trail_length) || TRAIL_DEFAULTS.length);
    applyTrailStyle((state.settings && state.settings.trail_style) || TRAIL_DEFAULTS.style);
    applyDensity((state.settings && state.settings.ambient_density) || 100);
    applyTrailOpacity((state.settings && state.settings.trail_opacity) || TRAIL_DEFAULTS.opacity);
    applyTrailColor((state.settings && state.settings.trail_color) || null);
    // трейс ещё не трогали (или это первый запуск) — ставим новый вид по умолчанию: искры
    const storedTrail = state.settings || {};
    const untouchedTrail = (!storedTrail.trail_style || storedTrail.trail_style === "line")
      && Number(storedTrail.trail_size || 100) === 100
      && Number(storedTrail.trail_length || 100) === 100
      && Number(storedTrail.trail_opacity || 100) === 100;
    if (untouchedTrail) {
      applyTrailStyle(TRAIL_DEFAULTS.style);
      applyTrailSize(TRAIL_DEFAULTS.size);
      applyTrailLength(TRAIL_DEFAULTS.length);
      applyTrailOpacity(TRAIL_DEFAULTS.opacity);
      state.settings = {
        ...(state.settings || {}),
        trail: true,
        trail_style: TRAIL_DEFAULTS.style,
        trail_size: TRAIL_DEFAULTS.size,
        trail_length: TRAIL_DEFAULTS.length,
        trail_opacity: TRAIL_DEFAULTS.opacity
      };
      api.saveSettings(state.settings).catch(() => {});
    }
    applyAmbientOpacity((state.settings && state.settings.ambient_opacity) ?? 80);
    applyAmbientColor((state.settings && state.settings.ambient_color) || null);
    applyTrail(!state.settings || state.settings.trail !== false);
    applyShape((state.settings && state.settings.shape) || "soft");
    applyUiScale((state.settings && state.settings.ui_scale) || 100);
    state.sound = {
      on: state.settings && state.settings.sound_fx !== false,
      volume: Math.max(0, Math.min(200, Number((state.settings && state.settings.sound_volume) ?? 60) || 0)),
      style: (state.settings && SOUND_STYLES[state.settings.sound_style] && state.settings.sound_style) || "soft",
      custom: { ...((state.settings && state.settings.sound_custom) || {}) }
    };
    // обои: тот же выбор, что был в прошлый раз (иначе каждый старт — «свой фон»)
    state.wall = {
      wallpaper: (state.settings && state.settings.wallpaper) || null,
      fit: (state.settings && state.settings.wallpaper_fit) || "cover",
      blur: Number((state.settings && state.settings.wallpaper_blur) ?? 0),
      dim: Number((state.settings && state.settings.wallpaper_dim) ?? 40),
      recent: normalizeWallpaperHistory(state.settings?.wallpaper_recent, state.settings?.custom_wallpaper)
    };
    loadWallpaperSource("custom").then(() => applyWallpaper(state.wall)).catch(() => null);
    applyWallpaper();
    await loadAccounts();
    bindFileDrop();
    await refreshInstances();
    // После возвращения из проводника замечаем внешнее переименование папки.
    // Ожидание объединяет серию событий фокуса от системного диалога.
    if (IS_APP) {
      let focusRefresh = 0;
      window.addEventListener("focus", () => {
        clearTimeout(focusRefresh);
        focusRefresh = setTimeout(async () => {
          await refreshInstances();
          if (state.tab === "download" && state.selectedId) refreshInstalledProjects();
        }, 300);
      });
    }
    // ничего не выбираем автоматически: стартовый экран — готовые сборки
    if (!state.selectedId) state.tab = "discover";
    updateStatus();
    renderTab();
    syncPresence();
    try { await initUpdates(); }
    catch (error) { toast(`Не удалось проверить обновления: ${error && error.message ? error.message : error}`, "err"); }
    // .mrpack, с которым запустили лаунчер (двойной щелчок в проводнике)
    if (IS_APP) {
      try {
        const startup = await api.startupFile();
        if (startup) installMrpackPath(startup);
      } catch (error) { /* без аргументов — обычный запуск */ }
    }
    // первое окно: короткая настройка (язык, тема, эффекты, трей, трейсер,
    // масштаб и импорт). Показывается только при самом первом входе. Если лаунчером уже
    // пользовались (есть следы работы в настройках), просто ставим отметку.
    if (onboardNeeded() && onboardLooksUsed()) {
      state.settings = { ...(state.settings || {}), onboarded: true, onboarding_pending: false };
      api.saveSettings(state.settings).catch(() => {});
    } else if (onboardNeeded()) {
      openOnboard();
    } else if (state.settings?.onboarded !== true && state.settings?.onboarding_pending !== true) {
      // Старые установки даже без сборок и аккаунтов не считаем новыми.
      state.settings = { ...(state.settings || {}), onboarded: true, onboarding_pending: false };
      api.saveSettings(state.settings).catch(() => {});
    }
    if (!IS_APP) {
      /* демо-режим без бэкенда — тихо */
    }
  }

  /* диалог экспорта сборки */
  (() => {
    const modal = $("#modal-export");
    if (!modal) return;
    $$("[data-close-export]", modal).forEach((btn) => btn.addEventListener("click", () => { modal.hidden = true; }));
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) modal.hidden = true; });
    $$("[data-exp-format]", modal).forEach((chip) => chip.addEventListener("click", () => {
      if (!exportState) return;
      exportState.format = chip.dataset.expFormat;
      // путь уже выбран — поправляем расширение под новый формат
      if (exportState.path) {
        exportState.path = exportState.path.replace(/\.(mrpack|zip)$/i, "") + "." + exportState.format;
      }
      renderExportModal();
    }));
    $$("#exp-list .imp-check", modal).forEach((box) => box.addEventListener("change", () => {
      box.closest(".imp-item").classList.toggle("is-picked", box.checked);
    }));
    $("#exp-pick").addEventListener("click", async () => {
      if (!exportState) return;
      const safeName = String(exportState.meta.name).replace(/[\\/:*?"<>|]/g, "_").trim() || "build";
      const path = await api.pickSave(
        exportState.format === "zip" ? "Экспорт сборки в .zip" : "Экспорт сборки в .mrpack",
        `${safeName}.${exportState.format}`,
        [exportState.format]
      ).catch(() => null);
      if (!path) return;
      exportState.path = path;
      renderExportModal();
    });
    $("#exp-go").addEventListener("click", async () => {
      if (!exportState || !exportState.path) return;
      const { meta, format, path } = exportState;
      const include = $$("#exp-list .imp-check:checked", modal).map((box) => box.dataset.expKey);
      modal.hidden = true;
      toast(`Собираем архив «${meta.name}»…`, "info");
      try {
        const saved = await api.exportInstance(meta.id, path, format, include);
        toast(`Готово: ${saved}. Сборка осталась в лаунчере.`, "ok");
        await refreshInstances();
      } catch (err) {
        toast(`Не удалось экспортировать: ${err}`, "err");
      }
    });
  })();

  /* просмотр скриншота */
  (() => {
    const modal = $("#modal-shot");
    if (!modal) return;
    $$("[data-close-shot]", modal).forEach((btn) => btn.addEventListener("click", closeShot));
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeShot(); });
    $("#shot-copy").addEventListener("click", () => { if (shotCurrent) copyShotImage(shotCurrent); });
    $("#shot-img").addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (shotCurrent) openShotMenu(event.clientX, event.clientY, shotCurrent);
    });
    $("#shot-open-file").addEventListener("click", () => {
      if (!shotCurrent) return;
      api.openPath(shotCurrent.path).catch((error) => toast(String(error), "err"));
    });
    $("#shot-open-folder").addEventListener("click", () => {
      if (!shotCurrent) return;
      const dir = shotCurrent.path.replace(/\\[^\\/]*$/, "");
      api.openPath(dir).catch((error) => toast(String(error), "err"));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) closeShot();
    });
  })();

  /* кнопки окна первого запуска */
  (() => {
    const modal = $("#modal-onboard");
    if (!modal) return;
    $("#onboard-next").addEventListener("click", () => {
      if (onboardStep >= ONBOARD_STEPS.length - 1) { finishOnboard(); return; }
      onboardStep += 1;
      renderOnboard();
    });
    $("#onboard-prev").addEventListener("click", () => {
      if (onboardStep === 0) return;
      onboardStep -= 1;
      renderOnboard();
    });
    $("#onboard-skip").addEventListener("click", finishOnboard);
    $$("[data-close-onboard]", modal).forEach((btn) => btn.addEventListener("click", finishOnboard));
  })();

  // отладочный мостик для автотестов интерфейса (Playwright): не влияет на работу лаунчера
  window.omnispecDebug = { state, paletteFromImage, wallpaperPalette, feedGridLevel, ambientSnapshot: ambient.snapshot };

  init();
})();
