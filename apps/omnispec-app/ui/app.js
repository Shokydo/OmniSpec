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
  const FX_STYLES = { wave: "Волна", dot: "Точка", ring: "Кольцо", cross: "Крест", off: "Выкл" };

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
  function applyTheme(name) {
    const theme = THEMES[name] || THEMES.dark;
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
    vars["--bg-1a"] = rgbaOf(vars["--bg-2"], 0.94);
    vars["--bg-2a"] = rgbaOf(vars["--bg-2"], 0.84);
    vars["--bg-3a"] = rgbaOf(vars["--bg-3"], 0.88);
    for (const [key, value] of Object.entries(vars)) document.body.style.setProperty(key, value);
    document.body.dataset.theme = THEMES[name] ? name : "dark";
    return THEMES[name] ? name : "dark";
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

  function applyShape(name) {
    const known = SHAPES.some(([id]) => id === name);
    state.shape = known ? name : "soft";
    document.body.dataset.shape = state.shape;
    return state.shape;
  }

  /* Короткие звуки интерфейса на WebAudio — без файлов и зависимостей. */
  const sfx = (() => {
    let ctx = null;
    function ensure() {
      if (!state.sound || !state.sound.on) return null;
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }
    function blip(freq, duration = 0.05, gain = 0.04, type = "sine") {
      const audio = ensure();
      if (!audio) return;
      const volume = Math.max(0, Math.min(100, Number(state.sound.volume ?? 60))) / 100;
      if (volume <= 0) return;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      amp.gain.value = gain * volume;
      amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
      osc.connect(amp).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
    }
    return {
      click: () => blip(520, 0.045, 0.05, "triangle"),
      toggle: (on) => blip(on ? 760 : 400, 0.05, 0.045, "sine"),
      open: () => blip(640, 0.06, 0.04, "sine"),
      error: () => blip(240, 0.12, 0.06, "sawtooth")
    };
  })();

  function wallUrl(name) {
    return name === "noise" ? "assets/wallpapers/noise.jpg" : `assets/wallpapers/${name}.png`;
  }

  /** Показать обои по настройкам (или по переданным значениям — для живого превью). */
  function applyWallpaper(overrides = {}) {
    const settings = state.settings || {};
    const layer = $("#wall");
    if (!layer) return;
    const name = overrides.wallpaper !== undefined ? overrides.wallpaper : settings.wallpaper;
    const fit = overrides.fit || settings.wallpaper_fit || "cover";
    const blur = Number(overrides.blur ?? settings.wallpaper_blur ?? 0);
    const dim = Number(overrides.dim ?? settings.wallpaper_dim ?? 40);
    const known = name === "custom" ? Boolean(state.customWall) : name && WALLS.some(([id]) => id === name);
    if (!known) {
      layer.hidden = true;
      layer.style.backgroundImage = "";
      document.body.classList.remove("has-wall");
      return;
    }
    layer.hidden = false;
    layer.style.backgroundImage = `url("${name === "custom" ? state.customWall : wallUrl(name)}")`;
    layer.style.backgroundSize = fit === "fill" ? "100% 100%" : fit === "contain" ? "contain" : fit === "tile" ? "auto" : "cover";
    layer.style.backgroundRepeat = fit === "tile" ? "repeat" : "no-repeat";
    layer.style.filter = blur ? `blur(${blur}px)` : "";
    layer.style.transform = blur ? "scale(1.05)" : "";
    layer.style.setProperty("--wall-dim", String(Math.min(80, Math.max(0, dim)) / 100));
    document.body.classList.add("has-wall");
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
    const icon = meta && meta.icon;
    if (isImageIcon(icon)) {
      const data = state.iconCache[meta.id];
      return data ? `<img src="${data}" alt="">` : "";
    }
    if (icon && INSTANCE_ICONS.includes(icon)) return `<svg class="ic"><use href="#${icon}"/></svg>`;
    return esc(String((meta && meta.name) || "?").trim().charAt(0).toUpperCase());
  }

  /** Подтянуть картинки-иконки сборок (webview не читает локальные пути). */
  async function loadInstanceIcons() {
    const customs = state.instances.filter((item) => isImageIcon(item.icon));
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

  function openInstanceMenu(x, y, meta) {
    const el = $("#ctx-menu");
    if (!el) return;
    const running = state.running.has(meta.id);
    el.innerHTML = `
      <div class="ctx-caption">${esc(meta.name)} · MC ${esc(meta.mc_version)}</div>
      <button class="ctx-item" data-act="play"><svg class="ic"><use href="#${running ? "i-stop" : "i-play"}"/></svg>${running ? "Остановить" : "Играть"}</button>
      <button class="ctx-item" data-act="settings"><svg class="ic"><use href="#i-sliders"/></svg>Настройки сборки</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="icon"><svg class="ic"><use href="#i-image"/></svg>Иконка из картинки…</button>
      ${isImageIcon(meta.icon) ? `<button class="ctx-item" data-act="icon-reset"><svg class="ic"><use href="#i-close"/></svg>Вернуть обычную иконку</button>` : ""}
      <button class="ctx-item" data-act="rename"><svg class="ic"><use href="#i-pencil"/></svg>Переименовать</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="folder"><svg class="ic"><use href="#i-folder"/></svg>Открыть папку сборки</button>
      <button class="ctx-item" data-act="refresh"><svg class="ic"><use href="#i-download"/></svg>Обновить файлы игры</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Удалить сборку</button>`;
    el.hidden = false;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    $$(".ctx-item", el).forEach((btn) => btn.addEventListener("click", () => {
      closeCtxMenu();
      runInstanceAction(btn.dataset.act, meta);
    }));
  }

  async function runInstanceAction(action, meta) {
    const fresh = state.instances.find((item) => item.id === meta.id) || meta;
    if (action === "play") {
      state.selectedId = fresh.id;
      renderSidebar();
      if (state.running.has(fresh.id)) await stopGame();
      else play();
      return;
    }
    if (action === "settings") {
      selectInstance(fresh.id);
      state.tab = "settings";
      renderTab();
      return;
    }
    if (action === "icon") {
      const path = await api.pickFile("Иконка сборки", ["png", "jpg", "jpeg", "webp"]).catch(() => null);
      if (path) await setIconFromFile(fresh, path);
      return;
    }
    if (action === "icon-reset") {
      try {
        await api.updateInstance({ ...fresh, icon: null });
        delete state.iconCache[fresh.id];
        await refreshInstances();
        toast("Иконка сброшена", "ok");
      } catch (err) { toast(String(err), "err"); }
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
      if (!confirm(`Удалить сборку «${fresh.name}» вместе с модами и мирами?`)) return;
      try {
        await api.deleteInstance(fresh.id);
        if (state.selectedId === fresh.id) state.selectedId = null;
        await refreshInstances();
        renderTab();
        toast("Сборка удалена", "ok");
      } catch (err) { toast(String(err), "err"); }
    }
  }

  /** Своя иконка сборки из файла-картинки. */
  async function setIconFromFile(meta, path) {
    try {
      await api.setInstanceIconFile(meta.id, path);
      const data = await api.instanceIcon(meta.id).catch(() => null);
      if (data) state.iconCache[meta.id] = data;
      await refreshInstances();
      toast("Иконка обновлена", "ok");
      if (state.tab === "settings") renderSettings();
    } catch (err) { toast(String(err), "err"); }
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
  async function installMrpackPath(path) {
    try {
      toast("Разворачиваем модпак…");
      const meta = await api.installModpack(path);
      await refreshInstances();
      selectInstance(meta.id);
      toast(`Сборка «${meta.name}» установлена`, "ok");
    } catch (err) { toast(String(err), "err"); }
  }

  async function handleDroppedFiles(paths) {
    if (!paths || !paths.length) return;
    for (const raw of paths) {
      const path = String(raw);
      const name = path.split(/[\\/]/).pop() || path;
      const lower = name.toLowerCase();
      if (lower.endsWith(".mrpack")) { await installMrpackPath(path); continue; }
      const meta = selected();
      if (!meta) { toast("Сначала выбери сборку слева", "err"); continue; }
      if (/\.(png|jpe?g|webp)$/.test(lower)) { await setIconFromFile(meta, path); continue; }
      if (lower.endsWith(".jar") || lower.endsWith(".zip")) {
        const sub = lower.endsWith(".zip") ? "resourcepacks" : "mods";
        try {
          const saved = await api.copyInstanceFile(meta.id, path, sub);
          toast(`${sub === "mods" ? "Мод" : "Ресурспак"} «${saved}» добавлен в сборку`, "ok");
          if (["mods", "resourcepacks", "files"].includes(state.tab)) renderTab();
        } catch (err) { toast(String(err), "err"); }
        continue;
      }
      toast(`Файл «${name}» не подходит: нужен .mrpack, .jar, .zip или картинка`, "err");
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
      if (event.target.closest("button, .instance, .tab, .theme-chip, .chip, .wall-chip")) sfx.click();
      const style = document.body.dataset.fx || "wave";
      if (style === "off" || document.body.classList.contains("no-fx")) return;
      const effect = document.createElement("span");
      effect.className = `cfx cfx-${style}`;
      effect.style.left = `${event.clientX}px`;
      effect.style.top = `${event.clientY}px`;
      layer.appendChild(effect);
      setTimeout(() => effect.remove(), 700);
    }, true);
  }

  /* ==================== ДЕМО-ДАННЫЕ ==================== */
  const now = Math.floor(Date.now() / 1000);
  const DEMO = {
    instances: [
      { id: "fabulously-optimized", name: "Fabulously Optimized", mc_version: "1.21.4", loader: { type: "fabric", version: "0.16.9" }, icon: null, created: now - 86400 * 9, last_played: now - 3600, playtime_secs: 7200, memory_mb: null, java_path: null, jvm_args: null, notes: "", source: "modrinth", source_url: null, version_override: null },
      { id: "atm10", name: "All the Mods 10", mc_version: "1.21.1", loader: { type: "neoforge", version: "21.1.72" }, icon: null, created: now - 86400 * 20, last_played: now - 86400 * 2, playtime_secs: 32000, memory_mb: 8192, java_path: null, jvm_args: null, notes: "", source: "modrinth", source_url: null, version_override: null },
      { id: "vanya-vanilla", name: "Ванилла 1.20.1", mc_version: "1.20.1", loader: { type: "vanilla" }, icon: null, created: now - 86400 * 3, last_played: null, playtime_secs: 0, memory_mb: null, java_path: null, jvm_args: null, notes: "", source: "manual", source_url: null, version_override: null },
      { id: "cobblemon", name: "Cobblemon", mc_version: "1.21.1", loader: { type: "fabric", version: "0.16.5" }, icon: null, created: now - 86400 * 40, last_played: now - 86400 * 5, playtime_secs: 5400, memory_mb: null, java_path: null, jvm_args: null, notes: "", source: "modrinth", source_url: null, version_override: null }
    ],
    accounts: [
      { username: "Steve", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", kind: "microsoft", access_token: "demo", expires_at: 0 },
      { username: "Vanya_2012", uuid: "5627dd98-1f5e-3f4e-9c1a-2b3c4d5e6f70", kind: "offline", access_token: "" }
    ],
    active: "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    settings: { username: "Player", java_path: null, memory_mb: 4096, jvm_args: "-XX:+UseG1GC", game_args: "", auto_java: true, show_snapshots: false, verify_hashes: false, language: "ru", keep_console_open: false, enable_modrinth: true, hide_on_launch: false, last_instance: null, update_repo: "Shokydo/OmniSpec", update_enabled: true, update_token: null, update_prerelease: false, theme: "dark", click_fx: "wave" },
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
  const realApi = {
    appInfo: () => invoke("app_info"),
    settings: () => invoke("get_settings"),
    saveSettings: (settings) => invoke("save_settings", { settings }),
    instances: () => invoke("list_instances"),
    createInstance: (req) => invoke("create_instance", { req }),
    deleteInstance: (id) => invoke("delete_instance", { instanceId: id }),
    updateInstance: (meta) => invoke("update_instance", { meta }),
    versions: (snapshots) => invoke("minecraft_versions", { snapshots }),
    loaderVersions: (kind, mc) => invoke("loader_versions", { kind, mcVersion: mc }),
    installInstance: (id) => invoke("install_instance", { instanceId: id }),
    launch: (id) => invoke("launch_instance", { instanceId: id }),
    stop: (id) => invoke("stop_instance", { instanceId: id }),
    running: () => invoke("running_instances"),
    search: (q) => invoke("search_modrinth", q),
    modrinthVersions: (projectId, mc, loader) => invoke("modrinth_versions", { projectId, mcVersion: mc, loader }),
    installMod: (instanceId, projectId) => invoke("install_mod", { instanceId, projectId }),
    installModVersion: (instanceId, versionId) => invoke("install_mod_version", { instanceId, versionId }),
    installModpack: (versionId) => invoke("install_modpack", { versionId }),
    listDir: (instanceId, sub) => invoke("list_dir", { instanceId, sub }),
    readFile: (instanceId, path) => invoke("read_text_file", { instanceId, path }),
    deleteFile: (instanceId, path) => invoke("delete_file", { instanceId, path }),
    mods: (instanceId) => invoke("list_mods", { instanceId }),
    toggleMod: (instanceId, name) => invoke("toggle_mod", { instanceId, name }),
    javas: () => invoke("list_java"),
    openPath: (path) => invoke("open_path", { path }),
    window: (action) => invoke("window_action", { action }),
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
    accountRemove: (uuid) => invoke("account_remove", { uuid }),
    msStart: () => invoke("ms_login_start"),
    msPoll: (deviceCode) => invoke("ms_login_poll", { deviceCode }),
    pickFile: (title, extensions) => invoke("pick_file", { title, extensions }),
    pickDir: (title) => invoke("pick_dir", { title }),
    setInstanceIconFile: (instanceId, path) => invoke("set_instance_icon_file", { instanceId, path }),
    instanceIcon: (instanceId) => invoke("instance_icon", { instanceId }),
    copyInstanceFile: (instanceId, path, sub) => invoke("copy_instance_file", { instanceId, path, sub }),
    startupFile: () => invoke("startup_file"),
    setCustomWallpaper: (path) => invoke("set_custom_wallpaper", { path }),
    customWallpaper: () => invoke("custom_wallpaper"),
    instancePath: (instanceId) => invoke("instance_path", { instanceId }),
    openUrl: (url) => invoke("open_url", { url })
  };

  /** Заглушка обновления для демо-режима (чтобы можно было посмотреть окно). */
  const DEMO_UPDATE = {
    version: "0.2.0",
    current_version: "0.1.0",
    notes: "Что нового в 0.2.0:\n\n• Автообновление через GitHub Releases\n• Кнопка «Обновить и перезапустить» прямо в лаунчере\n• Исправлена установка модов с обязательными зависимостями\n• Ускорена проверка файлов после первого запуска",
    published_at: new Date().toISOString(),
    page_url: "https://github.com/Shokydo/OmniSpec/releases",
    asset_name: "OmniSpec.exe",
    asset_url: "https://github.com/Shokydo/OmniSpec/releases/latest",
    asset_size: 12582912,
    asset_digest: null
  };

  const demoMods = [
    { name: "sodium-fabric-0.6.13+mc1.21.4.jar", size: 1306799, enabled: true },
    { name: "lithium-fabric-0.14.3+mc1.21.4.jar", size: 645120, enabled: true },
    { name: "iris-fabric-1.8.8+mc1.21.4.jar", size: 9175040, enabled: true },
    { name: "modmenu-11.0.4.jar", size: 706560, enabled: false }
  ];

  const demoSearch = (q) => ({
    hits: [
      { project_id: "AANobbMI", title: "Sodium", description: "Современный движок рендера: больше FPS, меньше фризов.", icon_url: null, categories: ["fabric", "optimization"], downloads: 252141115, author: "jellysquid3", project_type: "mod", slug: "sodium" },
      { project_id: "gvQqBUqZ", title: "Lithium", description: "Оптимизация игровой логики без изменения поведения игры.", icon_url: null, categories: ["fabric", "optimization"], downloads: 106922325, author: "jellysquid3", project_type: "mod", slug: "lithium" },
      { project_id: "YL57xq9U", title: "Iris Shaders", description: "Шейдеры для Fabric с поддержкой OptiFine-паков.", icon_url: null, categories: ["fabric", "shaders"], downloads: 88568147, author: "coderbot", project_type: "mod", slug: "iris" },
      { project_id: "mOgUt4GM", title: "Mod Menu", description: "Список модов и настройки прямо в игре.", icon_url: null, categories: ["fabric", "utility"], downloads: 60000000, author: "Prospector", project_type: "mod", slug: "modmenu" }
    ].filter((hit) => !q || hit.title.toLowerCase().includes(String(q.query || "").toLowerCase())),
    total_hits: 4, offset: 0, limit: 20
  });

  const demoApi = {
    appInfo: async () => ({ home: "C:\\Users\\Player\\AppData\\Roaming\\OmniSpec", version: "0.1.0 (демо-режим)", demo: true }),
    settings: async () => ({ ...DEMO.settings }),
    saveSettings: async (s) => { DEMO.settings = s; return null; },
    instances: async () => DEMO.instances.map((i) => ({ ...i })),
    createInstance: async (req) => {
      const meta = { ...DEMO.instances[0], id: "demo-" + Date.now(), name: req.name, mc_version: req.mc_version, loader: req.loader || { type: "vanilla" }, last_played: null };
      DEMO.instances.unshift(meta);
      return meta;
    },
    deleteInstance: async (id) => { DEMO.instances = DEMO.instances.filter((i) => i.id !== id); return null; },
    updateInstance: async (meta) => { const i = DEMO.instances.findIndex((x) => x.id === meta.id); if (i >= 0) DEMO.instances[i] = meta; return null; },
    versions: async () => DEMO.versions,
    loaderVersions: async (kind) => (kind === "vanilla" ? [] : [{ version: "0.16.9", stable: true }, { version: "0.16.5", stable: true }, { version: "0.15.11", stable: false }]),
    installInstance: async () => null,
    launch: async () => ({ version_id: "demo", java: "java", memory_mb: 4096, args: [], instance_id: "demo", game_dir: "", natives_dir: "", classpath_entries: 0 }),
    stop: async () => null,
    running: async () => [],
    search: async (q) => {
      const base = demoSearch(q).hits;
      const seed = ["Sodium", "Lithium", "Iris Shaders", "Mod Menu", "Fabric API", "Cloth Config", "Indium", "FerriteCore", "Krypton", "LazyDFU", "Starlight", "C2ME", "Entity Culling", "Dynamic FPS", "Reese's Sodium Options", "Zoomify", "AppleSkin", "Jade", "Roughly Enough Items", "Continuity", "Controlling", "BetterF3", "ImmediatelyFast", "No Chat Reports"];
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
    installModVersion: async () => ({ installed: ["mod.jar"], skipped: [] }),
    installModpack: async () => DEMO.instances[0],
    listDir: async () => ([
      { name: "mods", is_dir: true, size: 0, path: "mods" },
      { name: "config", is_dir: true, size: 0, path: "config" },
      { name: "saves", is_dir: true, size: 0, path: "saves" },
      { name: "resourcepacks", is_dir: true, size: 0, path: "resourcepacks" },
      { name: "options.txt", is_dir: false, size: 2048, path: "options.txt" },
      { name: "logs", is_dir: true, size: 0, path: "logs" }
    ]),
    readFile: async () => "fov:0.0\nlang:ru_ru\nrenderDistance:12\nnarrator:0\n",
    deleteFile: async () => null,
    mods: async () => demoMods.map((m) => ({ ...m })),
    toggleMod: async (_i, name) => (name.endsWith(".disabled") ? name.slice(0, -9) : name + ".disabled"),
    javas: async () => ([
      { path: "C:\\OmniSpec\\java\\java-runtime-delta\\21.0.7\\bin\\javaw.exe", major: 21, vendor: "Mojang", source: "mojang" },
      { path: "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9\\bin\\javaw.exe", major: 17, vendor: "Eclipse Temurin", source: "system" }
    ]),
    openPath: async () => null,
    window: async () => null,
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
    accountRemove: async (uuid) => {
      DEMO.accounts = DEMO.accounts.filter((a) => a.uuid !== uuid);
      if (DEMO.active === uuid) DEMO.active = DEMO.accounts[0] ? DEMO.accounts[0].uuid : null;
      return { accounts: DEMO.accounts.map((a) => ({ ...a })), active: DEMO.active };
    },
    msStart: async () => ({ user_code: "K7QP2X4MB", device_code: "demo", verification_uri: "https://www.microsoft.com/link", expires_in: 900, interval: 5 }),
    msPoll: async () => null,
    pickFile: async () => "C:\\Users\\Vanya\\Downloads\\pack.mrpack",
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
    customWallpaper: async () => null,
    instancePath: async (id) => `demo/instances/${id}`,
    openUrl: async (url) => { window.open(url, "_blank"); return null; },
    onProgress: () => Promise.resolve(),
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
    accounts: { accounts: [], active: null },
    tab: "console",
    running: new Set(),
    logs: {},
    files: { path: "", entries: [], selected: null },
    mods: [],
    iconCache: {},
    modrinth: {
      query: "", type: "mod", mc: "", loader: "",
      results: [], total: 0, loading: false, loadingMore: false,
      error: null, tried: false, view: "list"
    },
    discover: {
      query: "", results: [], total: 0,
      loading: false, loadingMore: false, error: null, tried: false, view: "grid"
    },
    wall: { wallpaper: null, fit: "cover", blur: 0, dim: 40 },
    update: { info: null, version: "0.1.0", repo: null, enabled: true, checking: false, installing: false },
    theme: "dark",
    fx: "wave",
    shape: "soft",
    customWall: null,
    sound: { on: true, volume: 60 },
    add: { mode: "modrinth", query: "", packs: [], selected: null, path: "", url: "", loading: false },
    create: { mode: "manual", name: "", mc: "", loader: "fabric", loaderVersion: "", versions: [], loaderVersionsList: [], packQuery: "", packs: [], selectedPack: null }
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const LOADER_NAMES = { vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };

  function loaderLabel(loader) {
    if (!loader || loader.type === "vanilla") return "Vanilla";
    return `${LOADER_NAMES[loader.type] || loader.type} ${loader.version || ""}`.trim();
  }

  function humanSize(bytes) {
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let size = Number(bytes) || 0;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return unit === 0 ? `${size} ${units[unit]}` : `${size.toFixed(1)} ${units[unit]}`;
  }

  function toast(message, kind = "") {
    const box = document.createElement("div");
    box.className = `toast ${kind}`;
    box.textContent = message;
    $("#toasts").appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; box.style.transition = "opacity .3s"; }, 3600);
    setTimeout(() => box.remove(), 4000);
  }

  const selected = () => state.instances.find((item) => item.id === state.selectedId) || null;

  /* ==================== ЛОГИ ==================== */
  function pushLog(instanceId, line, kind = "") {
    const list = state.logs[instanceId] || (state.logs[instanceId] = []);
    list.push({ line, kind });
    if (list.length > 4000) list.splice(0, 500);
    if (state.tab === "console" && state.selectedId === instanceId) appendLogLine(list.length - 1, list[list.length - 1]);
  }

  function appendLogLine(index, entry) {
    const consoleEl = $("#console-out");
    if (!consoleEl) return;
    const empty = consoleEl.querySelector(".empty-state");
    if (empty) empty.remove();
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = `<span class="log-num">${index + 1}</span><span class="log-text ${entry.kind}">${esc(entry.line)}</span>`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function renderLogs(instanceId) {
    const consoleEl = $("#console-out");
    if (!consoleEl) return;
    const list = state.logs[instanceId] || [];
    consoleEl.innerHTML = "";
    list.forEach((entry, index) => appendLogLine(index, entry));
    if (!list.length) {
      consoleEl.innerHTML = `<div class="empty-state">Лог пуст</div>`;
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
  function renderSidebar() {
    const list = $("#instance-list");
    const filter = ($("#instance-search").value || "").toLowerCase();
    const items = state.instances.filter((item) => item.name.toLowerCase().includes(filter));
    $("#instances-count").textContent = String(state.instances.length);
    $("#active-count").textContent = `${state.running.size}/${state.instances.length}`;

    if (!items.length) {
      list.innerHTML = `<div class="empty-state" style="font-size:12px;padding:24px 8px">Сборок нет.<br>Создай первую →</div>`;
      return;
    }

    list.innerHTML = items.map((item) => {
      const running = state.running.has(item.id);
      return `<div class="instance ${item.id === state.selectedId ? "is-active" : ""}" data-id="${esc(item.id)}">
        <div class="instance-icon">${instanceIconHtml(item)}</div>
        <div class="instance-body">
          <div class="instance-name">${esc(item.name)}</div>
          <div class="instance-sub">MC ${esc(item.mc_version)} · ${esc(loaderLabel(item.loader))}</div>
        </div>
        ${running ? '<div class="instance-running" title="Запущена"></div>' : ""}
      </div>`;
    }).join("");

    $$(".instance", list).forEach((el) => {
      el.addEventListener("click", () => selectInstance(el.dataset.id));
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const meta = state.instances.find((item) => item.id === el.dataset.id);
        if (meta) openInstanceMenu(event.clientX, event.clientY, meta);
      });
    });
  }

  function selectInstance(id) {
    state.selectedId = id;
    const meta = selected();
    renderSidebar();
    $("#tb-name").textContent = meta ? meta.name : "OmniSpec";
    $("#tb-version").textContent = meta ? `MC ${meta.mc_version} · ${loaderLabel(meta.loader)}` : "—";
    const pill = $("#loader-pill");
    pill.hidden = !meta;
    pill.textContent = meta ? loaderLabel(meta.loader) : "";
    const pathbar = $("#build-path");
    if (pathbar) {
      pathbar.hidden = !meta;
      if (meta) {
        api.instancePath(meta.id)
          .then((path) => { pathbar.querySelector("span").textContent = path; })
          .catch(() => { pathbar.querySelector("span").textContent = "папка сборки"; });
      }
    }
    updateStatus();
    renderTab();
  }

  function updateStatus() {
    const meta = selected();
    const running = meta && state.running.has(meta.id);
    $("#tb-dot").className = `dot ${running ? "on" : ""}`;
    $("#tb-status").textContent = !meta ? "сборка не выбрана" : running ? "запущена" : "остановлена";
    $("#tb-center").textContent = meta ? `${meta.name} — ${running ? "запущена" : "остановлена"}` : "OmniSpec — лаунчер Minecraft";
    $("#btn-play").querySelector("span").textContent = running ? "Играть снова" : "Играть";
  }

  /* ==================== ПРОГРЕСС ==================== */
  function setProgress(payload) {
    const box = $("#progress");
    if (!payload) { box.hidden = true; return; }
    box.hidden = false;
    const percent = payload.total > 0 ? Math.min(100, Math.round((payload.done / payload.total) * 100)) : 0;
    $("#progress-fill").style.width = `${percent}%`;
    const stageNames = { version: "версия", libraries: "библиотеки", assets: "ресурсы", java: "Java", mods: "моды", modpack: "модпак", loader: "загрузчик", launch: "запуск" };
    $("#progress-text").textContent = `${stageNames[payload.stage] || payload.stage}: ${payload.detail || ""}`.slice(0, 70);
    if (payload.stage === "update") {
      const modal = $("#modal-update");
      if (modal && !modal.hidden) {
        $("#upd-progress").hidden = false;
        $("#upd-fill").style.width = `${percent}%`;
        $("#upd-progress-text").textContent = payload.detail || "";
      }
    }
    if (payload.stage === "launch" && payload.done >= payload.total) setTimeout(() => setProgress(null), 2500);
  }

  /* ==================== ВКЛАДКИ ==================== */
  function renderTab() {
    const body = $("#tab-body");
    const meta = selected();
    // без выбранной сборки вкладки, которым нужна сборка, показывают ленту
    if (!meta && !["discover", "modrinth", "settings"].includes(state.tab)) state.tab = "discover";
    $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.tab));

    if (!meta) {
      // Сборка не выбрана — в главном окне лента готовых сборок, ничего не
      // подставляем сами: любую сборку пользователь выбирает осознанно.
      if (state.tab === "modrinth") return renderModrinth();
      if (state.tab === "settings") return renderSettings();
      return renderDiscover();
    }

    switch (state.tab) {
      case "discover": return renderDiscover();
      case "console": return renderConsole();
      case "files": return renderFiles();
      case "mods": return renderMods();
      case "resourcepacks": return renderAssetsList("resourcepacks", "Ресурспаки", "resourcepack");
      case "worlds": return renderWorlds();
      case "modrinth": return renderModrinth();
      case "settings": return renderSettings();
    }
  }

  /* ---------- консоль ---------- */
  function renderConsole() {
    const meta = selected();
    $("#tab-body").innerHTML = `
      <div class="console-wrap">
        <div class="console-bar">
          <input class="input" id="log-search" placeholder="Найти..." spellcheck="false">
          <button class="btn btn-small" id="log-clear">Очистить</button>
          <button class="btn btn-small" id="log-copy">Скопировать</button>
          <div class="spacer"></div>
          <span class="muted" style="font-size:11px">${meta ? esc(meta.name) : ""}</span>
        </div>
        <div class="console" id="console-out"></div>
      </div>`;
    renderLogs(state.selectedId);
    $("#log-clear").addEventListener("click", () => {
      state.logs[state.selectedId] = [];
      renderLogs(state.selectedId);
    });
    $("#log-copy").addEventListener("click", async () => {
      const text = (state.logs[state.selectedId] || []).map((entry) => entry.line).join("\n");
      try { await navigator.clipboard.writeText(text); toast("Лог скопирован", "ok"); }
      catch { toast("Не удалось скопировать", "err"); }
    });
    $("#log-search").addEventListener("input", (event) => {
      const term = event.target.value.toLowerCase();
      $$("#console-out .log-line").forEach((line) => {
        line.style.display = !term || line.textContent.toLowerCase().includes(term) ? "" : "none";
      });
    });
  }

  /* ---------- файлы ---------- */
  /* ---------- файлы: менеджер в духе OmniPanel ----------
   * Слева — дерево папок сборки (ленивое, раскрывается по клику),
   * справа — хлебные крошки, список с колонками и статус-бар.
   * Файл открывается вместо списка, с номерами строк.
   */
  const fm = {
    path: "",
    entries: [],
    dirs: new Map(),     // путь -> [{ name, path }] (только папки)
    expanded: new Set(),
    selected: null,
    preview: null,       // { path, text, error }
    query: ""
  };

  function fmExt(name) {
    const dot = String(name).lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function fmKind(name) {
    const ext = fmExt(name);
    if (!ext) return "файл";
    const groups = {
      конфиг: ["json", "json5", "toml", "yaml", "yml", "properties", "cfg", "conf", "ini", "txt", "mcmeta", "snbt"],
      код: ["js", "ts", "rs", "py", "sh", "bat", "cmd", "lua", "java"],
      архив: ["jar", "zip", "mrpack", "7z", "rar"],
      картинка: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"],
      лог: ["log", "txt"]
    };
    for (const [kind, list] of Object.entries(groups)) if (list.includes(ext)) return kind;
    return ext;
  }

  function fmIcon(name, isDir) {
    if (isDir) return "i-folder";
    const kind = fmKind(name);
    if (kind === "архив") return "i-mod";
    if (kind === "картинка") return "i-grid";
    return "i-base";
  }

  function fmDate(seconds) {
    if (!seconds) return "—";
    const date = new Date(seconds * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function fmList(path) {
    const entries = await api.listDir(state.selectedId, path)
      .catch((err) => { toast(String(err), "err"); return []; });
    return entries.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "ru"));
  }

  async function fmDirs(path) {
    if (!fm.dirs.has(path)) {
      const entries = await fmList(path);
      fm.dirs.set(path, entries.filter((entry) => entry.is_dir).map((entry) => ({ name: entry.name, path: entry.path })));
    }
    return fm.dirs.get(path);
  }

  async function fmTreeHtml(path, depth) {
    const dirs = await fmDirs(path);
    const term = fm.query.trim().toLowerCase();
    let html = "";
    for (const dir of dirs) {
      if (term && !dir.name.toLowerCase().includes(term)) continue;
      const open = fm.expanded.has(dir.path);
      const active = fm.path === dir.path;
      html += `<div class="fm-row${open ? " open" : ""}${active ? " active" : ""}" data-dir="${esc(dir.path)}" style="padding-left:${6 + depth * 12}px">
        <span class="arrow" data-toggle="${esc(dir.path)}">▸</span>
        <span class="ico"><svg class="ic" width="13" height="13"><use href="#i-folder"/></svg></span>
        <span class="nm">${esc(dir.name)}</span>
      </div>`;
      if (open) html += await fmTreeHtml(dir.path, depth + 1);
    }
    return html;
  }

  async function fmRenderTree() {
    const box = $("#fm-tree");
    if (!box) return;
    const html = await fmTreeHtml("", 0);
    box.innerHTML = html || `<div class="fm-empty">${fm.query ? "Ничего не найдено" : "Папок нет"}</div>`;
    $$(".fm-row", box).forEach((row) => {
      const path = row.dataset.dir;
      const arrow = $(".arrow", row);
      if (arrow) {
        arrow.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (fm.expanded.has(path)) fm.expanded.delete(path); else fm.expanded.add(path);
          await fmRenderTree();
        });
      }
      row.addEventListener("click", () => fmOpen(path));
    });
  }

  function fmRenderCrumb() {
    const box = $("#fm-crumb");
    if (!box) return;
    const meta = selected();
    const parts = fm.path ? fm.path.split("/").filter(Boolean) : [];
    const chips = [`<span class="c" data-crumb="">${esc(meta ? meta.name : "сборка")}</span>`];
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      chips.push(`<span class="s">/</span><span class="c${index === parts.length - 1 ? " last" : ""}" data-crumb="${esc(path)}">${esc(part)}</span>`);
    });
    box.innerHTML = chips.join("");
    $$(".c", box).forEach((chip) => chip.addEventListener("click", () => fmOpen(chip.dataset.crumb)));
  }

  function fmRenderList() {
    const list = $("#fm-list");
    if (!list) return;
    const term = fm.query.trim().toLowerCase();
    const rows = fm.entries.filter((entry) => !term || entry.name.toLowerCase().includes(term));
    const items = rows.map((entry) => `
      <div class="fm-item${fm.selected === entry.path ? " active" : ""}" data-path="${esc(entry.path)}" data-dir="${entry.is_dir}">
        <span class="fname">
          <span class="ico"><svg class="ic" width="13" height="13"><use href="#${fmIcon(entry.name, entry.is_dir)}"/></svg></span>
          <span>${esc(entry.name)}</span>
        </span>
        <span class="fsize">${entry.is_dir ? "—" : humanSize(entry.size)}</span>
        <span class="fdate">${entry.is_dir ? "—" : fmDate(entry.modified)}</span>
      </div>`).join("");
    list.innerHTML = `
      <div class="fm-head"><span>Имя</span><span>Размер</span><span>Изменён</span></div>
      ${items || `<div class="fm-empty">Папка пуста</div>`}`;
    $$(".fm-item", list).forEach((row) => row.addEventListener("click", () => {
      if (row.dataset.dir === "true") fmOpen(row.dataset.path);
      else fmPreviewFile(row.dataset.path);
    }));
  }

  function fmRenderView() {
    const view = $("#fm-view");
    if (!view) return;
    const preview = fm.preview;
    if (!preview) { view.hidden = true; return; }
    view.hidden = false;
    if (preview.error) {
      view.innerHTML = `<div class="fm-empty">${esc(preview.error)}</div>`;
      return;
    }
    const lines = preview.text.split("\n");
    const gutter = lines.map((_, index) => index + 1).join("\n");
    view.innerHTML = `<div class="fm-gutter">${gutter}</div><pre class="fm-pre">${esc(preview.text)}</pre>`;
  }

  function fmRenderStatus() {
    const meta = selected();
    const pathBox = $("#fm-path");
    if (!pathBox) return;
    const target = fm.selected || fm.path;
    pathBox.textContent = target ? `${meta ? meta.name : "сборка"}/${target}` : `${meta ? meta.name : "сборка"}`;
    const entry = fm.entries.find((item) => item.path === fm.selected);
    $("#fm-kind").hidden = !entry;
    if (entry) $("#fm-kind").textContent = fmKind(entry.name);
    $("#fm-size").textContent = entry ? humanSize(entry.size) : `${fm.entries.length} объектов`;
    const lines = fm.preview && !fm.preview.error ? fm.preview.text.split("\n").length : 0;
    $("#fm-lines").textContent = lines ? `${lines} стр.` : "";
  }

  async function fmRefresh() {
    if (!$("#fm-tree")) return;
    const entries = await fmList(fm.path);
    fm.entries = entries;
    fm.dirs.set(fm.path, entries.filter((entry) => entry.is_dir).map((entry) => ({ name: entry.name, path: entry.path })));
    await fmRenderTree();
    fmRenderList();
    fmRenderCrumb();
    fmRenderStatus();
  }

  async function fmOpen(path) {
    fm.path = path;
    fm.selected = null;
    fm.preview = null;
    fm.expanded.add(path);
    $("#fm-list").hidden = false;
    const backButton = $("#fm-back");
    if (backButton) backButton.hidden = true;
    fmRenderView();
    await fmRefresh();
  }

  async function fmPreviewFile(path) {
    fm.selected = path;
    fmRenderList();
    const view = $("#fm-view");
    const list = $("#fm-list");
    if (view) { view.hidden = false; view.innerHTML = `<div class="fm-empty">Читаем файл…</div>`; }
    if (list) list.hidden = true;
    const back = $("#fm-back");
    if (back) back.hidden = false;
    try {
      const text = await api.readFile(state.selectedId, path);
      fm.preview = { path, text, error: null };
    } catch (err) {
      fm.preview = { path, text: "", error: String(err) };
    }
    fmRenderView();
    fmRenderStatus();
  }

  async function renderFiles() {
    fm.path = "";
    fm.entries = [];
    fm.dirs.clear();
    fm.expanded.clear();
    fm.selected = null;
    fm.preview = null;
    fm.query = "";
    $("#tab-body").innerHTML = `
      <div class="fm">
        <aside class="fm-side">
          <div class="fm-side-head">
            <input class="filter" id="fm-search" placeholder="найти папку…" spellcheck="false">
            <button class="btn-mini" id="fm-refresh" title="Обновить дерево">⟳</button>
          </div>
          <div class="fm-tree" id="fm-tree"><div class="fm-empty">Загрузка…</div></div>
        </aside>
        <div class="fm-main">
          <div class="fm-bar">
            <div class="fm-crumb" id="fm-crumb"></div>
            <div class="right">
              <button class="btn btn-small" id="fm-back" hidden>← К списку</button>
              <button class="btn btn-small" id="fm-open-ext">Открыть папку</button>
              <button class="btn btn-small" id="fm-reload">Обновить</button>
            </div>
          </div>
          <div class="fm-list" id="fm-list"></div>
          <div class="fm-view" id="fm-view" hidden></div>
          <div class="fm-status">
            <span id="fm-path">—</span>
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
    $("#fm-refresh").addEventListener("click", async () => { fm.dirs.clear(); await fmRenderTree(); });
    $("#fm-back").addEventListener("click", () => {
      fm.preview = null;
      fm.selected = null;
      $("#fm-view").hidden = true;
      $("#fm-list").hidden = false;
      $("#fm-back").hidden = true;
      fmRenderList();
      fmRenderStatus();
    });
    $("#fm-reload").addEventListener("click", async () => { fm.dirs.clear(); await fmRefresh(); });
    $("#fm-open-ext").addEventListener("click", () => {
      const meta = selected();
      if (!meta) return toast("Сборка не выбрана", "err");
      const suffix = fm.path ? `/${fm.path}` : "";
      api.openPath(`/instances/${meta.id}/minecraft${suffix}`).catch((error) => toast(String(error), "err"));
    });

    await fmRefresh();
  }

  /* ---------- моды ---------- */
  async function renderMods() {
    const meta = selected();
    const mods = await api.mods(meta.id).catch(() => []);
    state.mods = mods;
    $("#badge-mods").hidden = !mods.length;
    $("#badge-mods").textContent = String(mods.length);
    const enabled = mods.filter((mod) => mod.enabled).length;

    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>Моды сборки</strong>
            <span class="badge">${enabled} вкл. / ${mods.length}</span>
            <div class="spacer"></div>
            <button class="btn btn-small" id="mods-open">Открыть папку</button>
            <button class="btn btn-small btn-primary" id="mods-add">Добавить с Modrinth</button>
          </div>
          ${mods.length ? mods.map((mod) => `
            <div class="item-row">
              <svg class="ic" style="color:#6b727a"><use href="#i-mod"/></svg>
              <div class="item-main">
                <div class="item-title">${esc(mod.name)}</div>
                <div class="item-sub">${humanSize(mod.size)} · ${mod.enabled ? "включён" : "выключен"}</div>
              </div>
              <button class="switch ${mod.enabled ? "on" : ""}" data-toggle="${esc(mod.name)}" title="Включить/выключить"></button>
              <button class="icon-btn" data-delete="${esc(mod.name)}" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
            </div>`).join("") : `<div class="item-row"><div class="item-main muted">Модов нет. Добавь их на вкладке Modrinth.</div></div>`}
        </div>
      </div>`;

    $("#mods-add").addEventListener("click", () => { state.modrinth.type = "mod"; state.tab = "modrinth"; renderTab(); });
    $("#mods-open").addEventListener("click", () => api.openPath(`${meta.id}/minecraft/mods`).catch((err) => toast(String(err), "err")));
    $$("[data-toggle]").forEach((el) => el.addEventListener("click", async () => {
      try { await api.toggleMod(meta.id, el.dataset.toggle); renderMods(); }
      catch (err) { toast(String(err), "err"); }
    }));
    $$("[data-delete]").forEach((el) => el.addEventListener("click", async () => {
      try { await api.deleteFile(meta.id, `mods/${el.dataset.delete}`); renderMods(); toast("Удалено", "ok"); }
      catch (err) { toast(String(err), "err"); }
    }));
  }

  /* ---------- ресурспаки / шейдеры ---------- */
  async function renderAssetsList(sub, title, projectType) {
    const meta = selected();
    const entries = await api.listDir(meta.id, sub).catch(() => []);
    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>${title}</strong>
            <span class="badge">${entries.length}</span>
            <div class="spacer"></div>
            <button class="btn btn-small" id="assets-open">Открыть папку</button>
            <button class="btn btn-small btn-primary" id="assets-add">Скачать с Modrinth</button>
          </div>
          ${entries.length ? entries.map((entry) => `
            <div class="item-row">
              <svg class="ic" style="color:#6b727a"><use href="#i-base"/></svg>
              <div class="item-main">
                <div class="item-title">${esc(entry.name)}</div>
                <div class="item-sub">${humanSize(entry.size)}</div>
              </div>
              <button class="icon-btn" data-del="${esc(entry.path)}"><svg class="ic"><use href="#i-trash"/></svg></button>
            </div>`).join("") : `<div class="item-row"><div class="item-main muted">Пусто</div></div>`}
        </div>
      </div>`;
    $("#assets-add").addEventListener("click", () => { state.modrinth.type = projectType; state.tab = "modrinth"; renderTab(); });
    $("#assets-open").addEventListener("click", () => api.openPath(`${meta.id}/minecraft/${sub}`).catch(() => {}));
    $$("[data-del]").forEach((el) => el.addEventListener("click", async () => {
      await api.deleteFile(meta.id, el.dataset.del).catch((err) => toast(String(err), "err"));
      renderAssetsList(sub, title, projectType);
    }));
  }

  /* ---------- миры ---------- */
  async function renderWorlds() {
    const meta = selected();
    const entries = await api.listDir(meta.id, "saves").catch(() => []);
    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>Миры</strong>
            <span class="badge">${entries.length}</span>
            <div class="spacer"></div>
            <button class="btn btn-small" id="worlds-open">Открыть папку</button>
          </div>
          ${entries.length ? entries.map((entry) => `
            <div class="item-row">
              <svg class="ic" style="color:#6b727a"><use href="#i-folder"/></svg>
              <div class="item-main"><div class="item-title">${esc(entry.name)}</div><div class="item-sub">${humanSize(entry.size)}</div></div>
            </div>`).join("") : `<div class="item-row"><div class="item-main muted">Миров пока нет — создай их в игре</div></div>`}
        </div>
      </div>`;
    $("#worlds-open").addEventListener("click", () => api.openPath(`${meta.id}/minecraft/saves`).catch(() => {}));
  }

  /* ---------- Modrinth ---------- */
  const MR_PAGE = 24;
  let mrObserver = null;
  /* лента готовых сборок в главном окне */
  const DV_PAGE = 24;
  let dvObserver = null;

  function renderModrinth() {
    const meta = selected();
    const cfg = state.modrinth;
    const view = cfg.view || "list";
    const types = [["mod", "Моды"], ["modpack", "Модпаки"], ["resourcepack", "Ресурспаки"], ["shader", "Шейдеры"]];
    const mcOptions = Array.from(new Set([meta && meta.mc_version, ...(DEMO.versions || []).map((v) => v.id)].filter(Boolean))).slice(0, 14);
    $("#tab-body").innerHTML = `
      <div class="modrinth-wrap">
        <div class="modrinth-filters">
          <div class="field" style="flex:1;min-width:220px">
            <label>Поиск на Modrinth</label>
            <input class="input grow" id="mr-query" placeholder="sodium, cobblemon, iris…" value="${esc(cfg.query)}" spellcheck="false">
          </div>
          <div class="field">
            <label>Тип</label>
            <select class="select" id="mr-type">
              ${types.map(([value, label]) => `<option value="${value}" ${cfg.type === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Версия игры</label>
            <select class="select" id="mr-mc">
              <option value="">любая</option>
              ${mcOptions.map((value) => `<option value="${esc(value)}" ${cfg.mc === value ? "selected" : ""}>${esc(value)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Загрузчик</label>
            <select class="select" id="mr-loader">
              <option value="">любой</option>
              ${Object.entries(LOADER_NAMES).map(([value, label]) => `<option value="${value}" ${cfg.loader === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>
          <button class="btn" id="mr-search" style="align-self:flex-end">Найти</button>
          <div class="mr-view" style="align-self:flex-end" title="Вид списка">
            <button class="${view === "list" ? "is-active" : ""}" data-view="list"><svg class="ic"><use href="#i-list"/></svg>Список</button>
            <button class="${view === "grid" ? "is-active" : ""}" data-view="grid"><svg class="ic"><use href="#i-grid"/></svg>Плитка</button>
          </div>
        </div>
        <div class="modrinth-results ${view === "grid" ? "is-grid" : ""}" id="mr-results">
          ${resultsHtml()}
        </div>
      </div>`;

    $("#mr-search").addEventListener("click", () => runSearch());
    $("#mr-query").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
    $("#mr-type").addEventListener("change", (event) => { state.modrinth.type = event.target.value; runSearch(); });
    $("#mr-mc").addEventListener("change", (event) => { state.modrinth.mc = event.target.value; runSearch(); });
    $("#mr-loader").addEventListener("change", (event) => { state.modrinth.loader = event.target.value; runSearch(); });
    $$("#tab-body [data-view]").forEach((btn) => btn.addEventListener("click", () => {
      state.modrinth.view = btn.dataset.view;
      renderModrinth();
    }));
    bindResultEvents();
    const retry = $("#mr-retry");
    if (retry) retry.addEventListener("click", () => runSearch());
    watchMore();
    if (!cfg.tried && !cfg.loading && !cfg.error) runSearch();
  }

  /* ---------- готовые сборки в главном окне ---------- */
  /**
   * Лента модпаков с Modrinth: те же карточки, что во вкладке Modrinth,
   * но без привязки к выбранной сборке и без единого автовыбора —
   * пока пользователь сам не нажмёт «Установить», ничего не происходит.
   */
  function renderDiscover() {
    const cfg = state.discover;
    const view = cfg.view || "grid";
    $("#tab-body").innerHTML = `
      <div class="discover">
        <div class="discover-head">
          <div class="discover-titles">
            <div class="discover-title">Готовые сборки</div>
          </div>
          <div class="discover-tools">
            <label class="search">
              <svg class="ic"><use href="#i-search"/></svg>
              <input id="dv-query" type="text" placeholder="Найти сборку" spellcheck="false" value="${esc(cfg.query)}">
            </label>
            <div class="mr-view" title="Вид">
              <button class="${view === "grid" ? "is-active" : ""}" data-dv-view="grid"><svg class="ic"><use href="#i-grid"/></svg>Плитка</button>
              <button class="${view === "list" ? "is-active" : ""}" data-dv-view="list"><svg class="ic"><use href="#i-list"/></svg>Список</button>
            </div>
          </div>
        </div>
        <div class="modrinth-results ${view === "grid" ? "is-grid" : ""}" id="dv-results">${dvResultsHtml()}</div>
      </div>`;

    $("#dv-query").addEventListener("keydown", (event) => { if (event.key === "Enter") dvReset(); });
    $$("#tab-body [data-dv-view]").forEach((btn) => btn.addEventListener("click", () => {
      state.discover.view = btn.dataset.dvView;
      renderDiscover();
    }));
    const retry = $("#dv-retry");
    if (retry) retry.addEventListener("click", () => dvReset());
    bindResultEvents();
    dvWatch();
    if (!cfg.tried && !cfg.loading && !cfg.error) dvReset();
  }

  function dvResultsHtml() {
    const cfg = state.discover;
    if (cfg.loading && !cfg.results.length) return `<div class="empty-state">Загружаем готовые сборки…</div>`;
    if (cfg.error) {
      return `<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="max-width:640px;text-align:left;white-space:pre-wrap;font-size:12px;color:var(--red)">${esc(cfg.error)}</div>
        <button class="btn" id="dv-retry">Повторить</button>
      </div>`;
    }
    if (!cfg.results.length) return `<div class="empty-state">Ничего не нашлось — попробуй другой запрос</div>`;
    return `${cfg.results.map((hit) => cardHtml(hit, "pack")).join("")}<div class="mr-sentinel" id="dv-sentinel">${dvSentinelText()}</div>`;
  }

  function dvSentinelText() {
    const cfg = state.discover;
    if (cfg.loadingMore) return `<span class="mr-more-spinner"></span>Загружаем ещё…`;
    if (cfg.results.length >= cfg.total) return `Показано всё: ${cfg.results.length}`;
    return `Прокрути вниз — ещё ${Math.max(0, cfg.total - cfg.results.length)}`;
  }

  function dvUpdateSentinel() {
    const sentinel = $("#dv-sentinel");
    if (sentinel) sentinel.innerHTML = dvSentinelText();
    const cfg = state.discover;
    if (sentinel && !cfg.loadingMore && cfg.results.length >= cfg.total) {
      if (dvObserver) { dvObserver.disconnect(); dvObserver = null; }
    }
  }

  function dvWatch() {
    if (dvObserver) { dvObserver.disconnect(); dvObserver = null; }
    const sentinel = $("#dv-sentinel");
    if (!sentinel) return;
    dvObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) dvLoadMore();
    }, { rootMargin: "240px" });
    dvObserver.observe(sentinel);
  }

  async function dvLoadMore() {
    const cfg = state.discover;
    if (cfg.loading || cfg.loadingMore || cfg.error) return;
    if (!cfg.results.length || cfg.results.length >= cfg.total) return;
    cfg.loadingMore = true;
    dvUpdateSentinel();
    try {
      const page = await api.search({
        query: cfg.query,
        projectType: "modpack",
        mcVersion: null,
        loader: null,
        offset: cfg.results.length,
        limit: DV_PAGE,
        sort: "downloads"
      });
      const known = new Set(cfg.results.map((hit) => hit.project_id));
      const fresh = (page.hits || []).filter((hit) => !known.has(hit.project_id));
      cfg.results = cfg.results.concat(fresh);
      cfg.total = page.total_hits || cfg.total;
      const sentinel = $("#dv-sentinel");
      if (sentinel && fresh.length) sentinel.insertAdjacentHTML("beforebegin", fresh.map((hit) => cardHtml(hit, "pack")).join(""));
      bindResultEvents();
      if (!fresh.length) cfg.total = cfg.results.length;
    } catch (err) {
      cfg.error = String(err);
    }
    cfg.loadingMore = false;
    if (cfg.error) { renderDiscover(); return; }
    dvUpdateSentinel();
  }

  async function dvReset() {
    const input = $("#dv-query");
    const cfg = state.discover;
    cfg.query = input ? input.value : cfg.query;
    cfg.loading = true;
    cfg.loadingMore = false;
    cfg.tried = true;
    cfg.error = null;
    cfg.results = [];
    cfg.total = 0;
    renderDiscover();
    try {
      const page = await api.search({
        query: cfg.query,
        projectType: "modpack",
        mcVersion: null,
        loader: null,
        offset: 0,
        limit: DV_PAGE,
        sort: "downloads"
      });
      cfg.results = page.hits || [];
      cfg.total = page.total_hits || cfg.results.length;
      cfg.error = null;
    } catch (err) {
      cfg.results = [];
      cfg.total = 0;
      cfg.error = String(err);
    }
    cfg.loading = false;
    if (state.tab === "discover" || !selected()) renderDiscover();
  }

  function resultsHtml() {
    const cfg = state.modrinth;
    if (cfg.loading && !cfg.results.length) return `<div class="empty-state">Ищем…</div>`;
    if (cfg.error) {
      return `<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="max-width:640px;text-align:left;white-space:pre-wrap;font-size:12px;color:var(--red)">${esc(cfg.error)}</div>
        <button class="btn" id="mr-retry">Повторить</button>
      </div>`;
    }
    if (!cfg.results.length) return `<div class="empty-state">Введи запрос и нажми «Найти»</div>`;
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
    if (!sentinel) return;
    mrObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: "200px" });
    mrObserver.observe(sentinel);
  }

  async function loadMore() {
    const cfg = state.modrinth;
    if (cfg.loading || cfg.loadingMore || cfg.error) return;
    if (!cfg.results.length || cfg.results.length >= cfg.total) return;
    cfg.loadingMore = true;
    updateSentinel();
    try {
      const hits = await api.search(searchQuery(cfg.results.length));
      const known = new Set(cfg.results.map((hit) => hit.project_id));
      cfg.results = cfg.results.concat((hits.hits || []).filter((hit) => !known.has(hit.project_id)));
      cfg.total = hits.total_hits || cfg.total;
      // сервер может отдать пустую страницу в конце — считаем, что всё
      if (!(hits.hits || []).length) cfg.results.length = cfg.results.length;
      const container = $("#mr-results");
      if (container) {
        const sentinel = $("#mr-sentinel");
        const html = (hits.hits || []).filter((hit) => !known.has(hit.project_id)).map(cardHtml).join("");
        if (sentinel) sentinel.insertAdjacentHTML("beforebegin", html);
        else container.insertAdjacentHTML("beforeend", html);
        bindResultEvents();
      }
    } catch (err) {
      cfg.error = String(err);
      renderModrinth();
      return;
    }
    cfg.loadingMore = false;
    updateSentinel();
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
      loader: cfg.loader || (meta && meta.loader ? meta.loader.type : null),
      offset: offset || 0,
      limit: MR_PAGE
    };
  }

  function bindResultEvents() {
    $$("[data-install]").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => installFromModrinth(btn.dataset.install, btn.dataset.kind));
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
    const openType = isPack ? "modpack" : (state.modrinth.type || "mod");
    return `<div class="card">
      <div class="card-icon">${hit.icon_url ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy">` : "MOD"}</div>
      <div class="card-body">
        <div class="card-title">${esc(hit.title)}</div>
        <div class="card-desc">${esc(hit.description)}</div>
        <div class="card-meta">
          ${(hit.categories || []).slice(0, 3).map((cat) => `<span class="tag">${esc(cat)}</span>`).join("")}
          <span class="tag">${(hit.downloads || 0).toLocaleString("ru-RU")} ⬇</span>
        </div>
        <div class="card-actions">
          <button class="btn btn-primary" data-install="${esc(hit.project_id)}" data-kind="${isPack ? "pack" : "mod"}">
            ${isPack ? "Установить" : "Установить"}
          </button>
          <button class="btn btn-ghost" data-versions="${esc(hit.project_id)}" data-kind="${isPack ? "pack" : "mod"}" data-title="${esc(hit.title)}">Версии</button>
          <button class="btn btn-ghost" data-open-page="${esc(hit.slug || hit.project_id)}" data-open-type="${esc(openType)}">Страница</button>
        </div>
      </div>
    </div>`;
  }

  /* ---------- выбор версии мода / модпака ---------- */
  async function openVersions(projectId, kind, title) {
    const modal = $("#modal-versions");
    if (!modal) return;
    modal.hidden = false;
    $("#ver-title").textContent = `${title || "Версии"} — выбор версии`;
    $("#ver-body").innerHTML = `<div class="empty-state">Загружаем версии…</div>`;
    const meta = selected();
    const mc = kind === "pack" ? null : (state.modrinth.mc || (meta ? meta.mc_version : null));
    const loader = kind === "pack" ? null : (state.modrinth.loader || (meta && meta.loader ? meta.loader.type : null));
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
      <div class="settings-note" style="margin-top:0">${kind === "pack" ? "Версия модпака создаст новую сборку." : "Версия будет установлена в текущую сборку."}</div>
      <div class="ver-list">
        ${versions.slice(0, 60).map((version) => `
          <div class="ver-row">
            <div class="ver-main">
              <div class="ver-name">${esc(version.name || version.version_number)}</div>
              <div class="ver-meta">
                <span class="tag">${esc(version.version_number)}</span>
                ${(version.game_versions || []).slice(0, 3).map((gv) => `<span class="tag">${esc(gv)}</span>`).join("")}
                ${(version.loaders || []).slice(0, 2).map((ld) => `<span class="tag">${esc(ld)}</span>`).join("")}
              </div>
            </div>
            <span class="ver-date">${(version.date_published || "").slice(0, 10)}</span>
            <button class="btn btn-primary" data-install-version="${esc(version.id)}" data-kind="${kind}">Установить</button>
          </div>`).join("")}
      </div>`;
    $$("[data-install-version]").forEach((btn) => btn.addEventListener("click", () => installVersion(btn.dataset.installVersion, btn.dataset.kind, btn)));
  }

  async function installVersion(versionId, kind, btn) {
    const modal = $("#modal-versions");
    if (btn) { btn.disabled = true; btn.textContent = "Ставим…"; }
    try {
      if (kind === "pack") {
        const meta = await api.installModpack(versionId);
        await refreshInstances();
        selectInstance(meta.id);
        toast(`Сборка «${meta.name}» установлена`, "ok");
      } else {
        const meta = selected();
        if (!meta) { toast("Сначала выбери сборку", "err"); return; }
        const outcome = await api.installModVersion(meta.id, versionId);
        toast(outcome.installed.length ? `Установлено: ${outcome.installed.join(", ")}` : "Уже установлено", "ok");
        if (state.tab === "modrinth") renderModrinth();
      }
      if (modal) modal.hidden = true;
    } catch (err) {
      toast(String(err), "err");
      if (btn) { btn.disabled = false; btn.textContent = "Установить"; }
    }
  }

  async function runSearch() {
    if ($("#mr-query")) state.modrinth.query = $("#mr-query").value;
    if ($("#mr-mc")) state.modrinth.mc = $("#mr-mc").value;
    if ($("#mr-loader")) state.modrinth.loader = $("#mr-loader").value;
    const cfg = state.modrinth;
    cfg.loading = true;
    cfg.loadingMore = false;
    cfg.tried = true;
    cfg.error = null;
    cfg.results = [];
    cfg.total = 0;
    renderModrinth();
    try {
      const result = await api.search(searchQuery(0));
      state.modrinth.results = result.hits || [];
      state.modrinth.total = result.total_hits || state.modrinth.results.length;
      state.modrinth.error = null;
    } catch (err) {
      state.modrinth.results = [];
      state.modrinth.total = 0;
      state.modrinth.error = String(err);
    }
    state.modrinth.loading = false;
    renderModrinth();
  }

  async function installFromModrinth(projectId, kind) {
    if (kind === "pack") {
      try {
        const versions = await api.modrinthVersions(projectId, null, null);
        if (!versions.length) return toast("У модпака нет версий", "err");
        toast("Скачиваем модпак…");
        const meta = await api.installModpack(versions[0].id);
        await refreshInstances();
        selectInstance(meta.id);
        toast(`Сборка «${meta.name}» установлена`, "ok");
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    const meta = selected();
    if (!meta) return toast("Сначала выбери сборку", "err");
    try {
      const outcome = await api.installMod(meta.id, projectId);
      toast(outcome.installed.length ? `Установлено: ${outcome.installed.join(", ")}` : "Уже установлено", "ok");
      if (state.tab === "modrinth") renderTab();
    } catch (err) { toast(String(err), "err"); }
  }

  /* ==================== АККАУНТЫ ==================== */
  const kindLabel = (kind) => (kind === "microsoft" ? "лицензия" : "пиратка");
  const kindClass = (kind) => (kind === "microsoft" ? "tag green" : "tag");

  function activeAccount() {
    const list = (state.accounts && state.accounts.accounts) || [];
    const activeId = state.accounts && state.accounts.active;
    return list.find((item) => item.uuid === activeId) || list[0] || null;
  }

  function renderAccounts() {
    const list = $("#account-list");
    if (!list) return;
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || (accounts[0] && accounts[0].uuid);
    if (!accounts.length) {
      list.innerHTML = `<div class="account-empty">Аккаунтов нет — добавь первый</div>`;
      return;
    }
    list.innerHTML = accounts.map((account) => `
      <div class="account-row ${account.uuid === activeId ? "is-active" : ""}" data-uuid="${esc(account.uuid)}">
        <span class="account-ava">${esc((account.username || "?").charAt(0).toUpperCase())}</span>
        <span class="account-body">
          <span class="account-name">${esc(account.username)}</span>
          <span class="${kindClass(account.kind)}">${kindLabel(account.kind)}</span>
        </span>
        ${account.uuid === activeId ? '<span class="account-dot" title="Активный"></span>' : ""}
      </div>`).join("");
    $$(".account-row", list).forEach((row) => row.addEventListener("click", async () => {
      try {
        state.accounts = await api.accountSetActive(row.dataset.uuid);
        renderAccounts();
        toast("Аккаунт переключён", "ok");
      } catch (err) { toast(String(err), "err"); }
    }));
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
    const list = accounts.length ? `
      <div class="account-list" style="margin-bottom:12px">
        ${accounts.map((account) => `
          <div class="account-row ${account.uuid === ((state.accounts && state.accounts.active) || "") ? "is-active" : ""}" data-pick="${esc(account.uuid)}">
            <span class="account-ava">${esc((account.username || "?").charAt(0).toUpperCase())}</span>
            <span class="account-body">
              <span class="account-name">${esc(account.username)}</span>
              <span class="${kindClass(account.kind)}">${kindLabel(account.kind)}</span>
            </span>
            ${account.uuid === ((state.accounts && state.accounts.active) || "") ? '<span class="account-dot" title="Активный"></span>' : ""}
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
        <div class="field" style="max-width:320px">
          <label>Ник в игре (3–16 символов, латиница, цифры, «_»)</label>
          <input class="input" id="acc-username" placeholder="Steve" spellcheck="false" autocomplete="off">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-back>Назад</button>
          <button class="btn btn-primary" id="acc-add-offline">Добавить</button>
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
    if (codeBox) codeBox.textContent = flow.user_code;
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
    { id: "look", label: "Оформление" },
    { id: "wall", label: "Фон" },
    { id: "fx", label: "Эффекты" },
    { id: "sound", label: "Звуки" },
    { id: "game", label: "Игра и Java" },
    { id: "net", label: "Сеть" },
    { id: "updates", label: "Обновления" }
  ];
  let prefsCategory = "look";

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
      // история: сохранённая + то, что выбрали в этом сеансе
      recent: Array.isArray(settings.wallpaper_recent) ? settings.wallpaper_recent.slice(0, 6) : []
    };
    modal.hidden = false;
    renderPrefs();
  }

  function renderPrefs() {
    const nav = $("#prefs-nav");
    const body = $("#prefs-body");
    if (!nav || !body) return;
    nav.innerHTML = PREFS.map((item) => `
      <button class="prefs-tab ${item.id === prefsCategory ? "is-active" : ""}" data-pref="${item.id}">${item.label}</button>`).join("");
    $$(".prefs-tab", nav).forEach((tab) => tab.addEventListener("click", () => {
      prefsCategory = tab.dataset.pref;
      renderPrefs();
    }));

    const settings = state.settings || {};
    if (prefsCategory === "look") body.innerHTML = prefsLook(settings);
    if (prefsCategory === "wall") body.innerHTML = prefsWall(settings);
    if (prefsCategory === "fx") body.innerHTML = prefsFx();
    if (prefsCategory === "game") body.innerHTML = prefsGame(settings);
    if (prefsCategory === "net") body.innerHTML = prefsNet(settings);
    if (prefsCategory === "updates") body.innerHTML = prefsUpdates(settings);
    if (prefsCategory === "sound") body.innerHTML = prefsSound(settings);
    bindPrefs();
  }

  function prefsLook(settings) {
    return `
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

  function prefsWall(settings) {
    const recent = ((state.wall.recent && state.wall.recent.length) ? state.wall.recent : (settings.wallpaper_recent || []))
      .filter((id) => WALLS.some(([wall]) => wall === id))
      .slice(0, 6);
    const groups = [
      { label: "Градиенты", ids: ["aurora", "waves", "blobs"] },
      { label: "Текстуры", ids: ["grid", "dots", "noise", "stripes"] },
      { label: "Природа", ids: ["mountains"] }
    ];
    return `
      <div class="prefs-section">
        <div class="prefs-label-row">
          <span class="prefs-label">Обои</span>
          <div class="spacer"></div>
          <button class="wall-none ${!state.wall.wallpaper ? "is-active" : ""}" data-wall="">Убрать фон</button>
        </div>
        <div class="wall-own">
          <button class="wall-chip ${state.wall.wallpaper === "custom" ? "is-active" : ""}" data-wall="custom"
                  ${state.customWall ? `style="background-image:url('${state.customWall}')"` : ""}>
            <span>${state.customWall ? "Свой фон" : "Свой фон…"}</span>
          </button>
          <button class="btn" id="wall-pick">${state.customWall ? "Заменить картинку…" : "Выбрать картинку…"}</button>
        </div>
        ${groups.map((group) => `
          <div class="wall-group">
            <div class="wall-group-name">${esc(group.label)}</div>
            <div class="wall-grid">${wallGridHtml(group.ids)}</div>
          </div>`).join("")}
        ${recent.length ? `
          <div class="wall-group">
            <div class="wall-group-name">Недавние</div>
            <div class="wall-grid">${wallGridHtml(recent)}</div>
          </div>` : ""}
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Как показывать</div>
        <div class="prefs-inline">
          <div class="field">
            <label>Заполнение</label>
            <select class="select" id="wall-fit">
              ${[["cover", "Заполнить"], ["contain", "Вписать"], ["fill", "Растянуть"], ["tile", "Плиткой"]]
                .map(([value, label]) => `<option value="${value}" ${state.wall.fit === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>
          <div class="field" style="flex:1;min-width:170px">
            <label>Размытие</label>
            <div class="range"><input type="range" id="wall-blur" min="0" max="20" value="${state.wall.blur}"><span class="tag" id="wall-blur-value">${state.wall.blur}</span></div>
          </div>
          <div class="field" style="flex:1;min-width:170px">
            <label>Затемнение</label>
            <div class="range"><input type="range" id="wall-dim" min="0" max="80" value="${state.wall.dim}"><span class="tag" id="wall-dim-value">${state.wall.dim}%</span></div>
          </div>
        </div>

      </div>`;
  }

  function prefsFx() {
    return `
      <div class="prefs-section">
        <div class="prefs-label">Эффект от клика</div>
        <div class="chips" id="fx-chips">
          ${Object.entries(FX_STYLES).map(([id, label]) => `<button class="chip ${state.fx === id ? "is-active" : ""}" data-fx="${id}">${label}</button>`).join("")}
        </div>
      </div>`;
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
              <input type="range" id="set-sound-volume" min="0" max="100" step="5" value="${state.sound.volume}">
              <span class="tag" id="set-sound-volume-value">${state.sound.volume}%</span>
            </div>
          </div>
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Проверка</div>
        <div class="settings-actions">
          <button class="btn" id="sound-test">Прослушать</button>
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
            <div class="range">
              <input type="range" id="set-memory" min="1024" max="16384" step="512" value="${settings.memory_mb || 4096}">
              <span class="tag" id="set-memory-value">${settings.memory_mb || 4096} МБ</span>
            </div>
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

  function prefsNet(settings) {
    return `
      <div class="prefs-section">
        <div class="prefs-label">Прокси</div>
        <div class="settings-row">
          <div class="label">Адрес</div>
          <div>
            <input class="input" style="width:100%" id="set-proxy" placeholder="http://127.0.0.1:8080 или socks5://…" value="${esc(settings.proxy || "")}" spellcheck="false">
            <div class="hint">Применяется после перезапуска лаунчера. Пусто — напрямую.</div>
          </div>
        </div>
        <div class="settings-actions">
          <button class="btn" id="net-check">Проверить связь с Modrinth</button>
          <span class="muted" id="net-check-result" style="font-size:11px;align-self:center;max-width:520px"></span>
        </div>
      </div>
      <div class="prefs-section">
        <div class="prefs-label">Вход через Microsoft</div>
        <div class="settings-row">
          <div class="label">Свой client id</div>
          <div>
            <input class="input" style="width:100%" id="set-ms-client" placeholder="00000000402b5328 (публичный ID лаунчера)" value="${esc(settings.ms_client_id || "")}" spellcheck="false">
            <div class="hint">Оставь пустым — вход работает на публичном client id официального лаунчера. Свой ID требует одобрения Mojang.</div>
          </div>
        </div>
      </div>`;
  }

  function prefsUpdates(settings) {
    return `
      <div class="prefs-section">
        <div class="prefs-label">Откуда обновляться</div>
        <div class="prefs-rows">
          <div class="settings-row">
            <div class="label">Репозиторий GitHub</div>
            <div><input class="input" style="width:100%" id="set-upd-repo" value="${esc(settings.update_repo || "")}" placeholder="владелец/репозиторий" spellcheck="false"></div>
          </div>
          <div class="settings-row">
            <div class="label">Токен (если репозиторий приватный)</div>
            <div><input class="input" style="width:100%" id="set-upd-token" value="${esc(settings.update_token || "")}" placeholder="необязательно" spellcheck="false"></div>
          </div>
          <div class="settings-row">
            <div class="label">Проверять при запуске</div>
            <div><div class="switch-row"><button class="switch ${settings.update_enabled ? "on" : ""}" id="set-upd-enabled"></button><span class="muted">спрашивать GitHub о новом релизе</span></div></div>
          </div>
          <div class="settings-row">
            <div class="label">Бета-версии</div>
            <div><div class="switch-row"><button class="switch ${settings.update_prerelease ? "on" : ""}" id="set-upd-pre"></button><span class="muted">учитывать prerelease</span></div></div>
          </div>
        </div>
        <div class="settings-actions">
          <button class="btn" id="upd-check-now">Проверить сейчас</button>
        </div>
      </div>`;
  }

  /* обработчики для всех категорий сразу — их немного */
  function bindPrefs() {
    const settings = state.settings || {};

    $$("#theme-grid .theme-chip").forEach((chip) => chip.addEventListener("click", () => {
      state.theme = applyTheme(chip.dataset.themeId);
      $$("#theme-grid .theme-chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    $$("#fx-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      state.fx = chip.dataset.fx;
      applyClickFx(state.fx);
      $$("#fx-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    $$("#shape-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      applyShape(chip.dataset.shape);
      $$("#shape-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    const wallPick = $("#wall-pick");
    if (wallPick) wallPick.addEventListener("click", async () => {
      const path = await api.pickFile("Свой фон", ["png", "jpg", "jpeg", "webp"]).catch(() => null);
      if (!path) return;
      try {
        const updated = await api.setCustomWallpaper(path);
        state.settings = updated;
        state.customWall = await api.customWallpaper().catch(() => null);
        state.wall.wallpaper = "custom";
        applyWallpaper(state.wall);
        renderPrefs();
      } catch (err) { toast(String(err), "err"); }
    });
    const soundSwitch = $("#set-sound");
    if (soundSwitch) soundSwitch.addEventListener("click", () => {
      state.sound.on = !state.sound.on;
      soundSwitch.classList.toggle("on", state.sound.on);
      if (state.sound.on) sfx.toggle(true);
    });
    const soundVolume = $("#set-sound-volume");
    if (soundVolume) soundVolume.addEventListener("input", (event) => {
      state.sound.volume = Number(event.target.value);
      $("#set-sound-volume-value").textContent = `${state.sound.volume}%`;
    });
    if (soundVolume) soundVolume.addEventListener("change", () => sfx.click());
    const soundTest = $("#sound-test");
    if (soundTest) soundTest.addEventListener("click", () => { sfx.open(); setTimeout(() => sfx.toggle(true), 120); });

    $$("#prefs-body [data-wall]").forEach((chip) => chip.addEventListener("click", () => {
      const picked = chip.dataset.wall || null;
      state.wall.wallpaper = picked;
      state.wall.recent = rememberWallpaper(state.wall.recent, picked);
      $$("#prefs-body [data-wall]").forEach((el) => el.classList.toggle("is-active", el === chip));
      applyWallpaper(state.wall);
      renderPrefs();
    }));
    const fit = $("#wall-fit");
    if (fit) fit.addEventListener("change", (event) => { state.wall.fit = event.target.value; applyWallpaper(state.wall); });
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

    const memory = $("#set-memory");
    if (memory) memory.addEventListener("input", (event) => { $("#set-memory-value").textContent = `${event.target.value} МБ`; });
    const autoJava = $("#set-auto-java");
    if (autoJava) autoJava.addEventListener("click", () => autoJava.classList.toggle("on"));
    const updEnabled = $("#set-upd-enabled");
    if (updEnabled) updEnabled.addEventListener("click", () => updEnabled.classList.toggle("on"));
    const updPre = $("#set-upd-pre");
    if (updPre) updPre.addEventListener("click", () => updPre.classList.toggle("on"));

    const netCheck = $("#net-check");
    if (netCheck) netCheck.addEventListener("click", async () => {
      const box = $("#net-check-result");
      box.className = "muted";
      box.textContent = "Проверяем…";
      try { box.textContent = await api.netCheck(); }
      catch (err) { box.textContent = String(err); box.className = "settings-note warn"; }
    });
    const checkNow = $("#upd-check-now");
    if (checkNow) checkNow.addEventListener("click", async () => {
      const info = await checkUpdates(false);
      if (info) { $("#modal-prefs").hidden = true; $("#modal-update").hidden = false; }
    });
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

    // сохранение общих настроек
    const save = $("#prefs-save");
    if (save) save.addEventListener("click", saveLauncherSettings);
    const reset = $("#prefs-reset");
    if (reset) reset.addEventListener("click", () => {
      if (!confirm("Сбросить оформление, фон, звук и Java к значениям по умолчанию?")) return;
      state.theme = applyTheme("dark");
      applyShape("soft");
      state.fx = "wave";
      applyClickFx(state.fx);
      state.wall = { wallpaper: null, fit: "cover", blur: 0, dim: 40, recent: [] };
      state.sound = { on: true, volume: 60 };
      applyWallpaper(state.wall);
      renderPrefs();
    });
  }

  async function saveLauncherSettings() {
    const settings = state.settings || {};
    const value = (selector) => { const el = $(selector); return el ? el.value : undefined; };
    const flag = (selector, fallback) => { const el = $(selector); return el ? el.classList.contains("on") : fallback; };
    const next = {
      ...settings,
      memory_mb: value("#set-memory") !== undefined ? Number(value("#set-memory")) : settings.memory_mb,
      java_path: value("#set-java") !== undefined ? (value("#set-java").trim() || null) : settings.java_path,
      java_path_legacy: value("#set-java-legacy") !== undefined ? (value("#set-java-legacy").trim() || null) : settings.java_path_legacy,
      jvm_args: value("#set-jvm") !== undefined ? value("#set-jvm") : settings.jvm_args,
      auto_java: flag("#set-auto-java", settings.auto_java),
      proxy: value("#set-proxy") !== undefined ? (value("#set-proxy").trim() || null) : settings.proxy,
      ms_client_id: value("#set-ms-client") !== undefined ? (value("#set-ms-client").trim() || null) : settings.ms_client_id,
      update_repo: value("#set-upd-repo") !== undefined ? (value("#set-upd-repo").trim() || null) : settings.update_repo,
      update_token: value("#set-upd-token") !== undefined ? (value("#set-upd-token").trim() || null) : settings.update_token,
      update_enabled: flag("#set-upd-enabled", settings.update_enabled),
      update_prerelease: flag("#set-upd-pre", settings.update_prerelease),
      theme: state.theme,
      shape: state.shape,
      sound_fx: state.sound.on,
      sound_volume: state.sound.volume,
      click_fx: state.fx,
      wallpaper: state.wall.wallpaper,
      wallpaper_fit: state.wall.fit,
      wallpaper_blur: state.wall.blur,
      wallpaper_dim: state.wall.dim,
      wallpaper_recent: state.wall.recent || rememberWallpaper(settings.wallpaper_recent, state.wall.wallpaper)
    };
    try {
      await api.saveSettings(next);
      state.settings = next;
      toast("Настройки сохранены", "ok");
      $("#modal-prefs").hidden = true;
    } catch (err) { toast(String(err), "err"); }
  }

  /** История обоев: свежие впереди, без повторов, не длиннее шести. */
  function rememberWallpaper(recent, current) {
    const list = Array.isArray(recent) ? recent.slice() : [];
    if (!current) return list.filter((id) => id !== current);
    return [current, ...list.filter((id) => id !== current)].slice(0, 6);
  }

  /* ==================== НАСТРОЙКИ СБОРКИ (свои у каждой) ==================== */
  async function renderSettings() {
    const meta = selected();
    if (!meta) {
      $("#tab-body").innerHTML = `<div class="empty-state">Выбери сборку слева</div>`;
      return;
    }
    const javas = await api.javas().catch(() => []);
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
              <div class="settings-row">
                <div class="label">Иконка</div>
                <div class="icon-grid" id="inst-icons">
                  <button class="icon-chip letter ${!meta.icon ? "is-active" : ""}" data-icon="" title="Первая буква">${esc(String(meta.name).trim().charAt(0).toUpperCase())}</button>
                  ${isImageIcon(meta.icon) && state.iconCache[meta.id] ? `<button class="icon-chip img is-active" data-icon="${esc(meta.icon)}" title="Своя картинка"><img src="${state.iconCache[meta.id]}" alt=""></button>` : ""}
                  ${INSTANCE_ICONS.map((icon) => `<button class="icon-chip ${meta.icon === icon ? "is-active" : ""}" data-icon="${icon}" title="${icon.replace("i-", "")}"><svg class="ic"><use href="#${icon}"/></svg></button>`).join("")}
                </div>
                <div class="settings-actions" style="margin-top:8px">
                  <button class="btn" id="inst-icon-file"><svg class="ic"><use href="#i-image"/></svg>Иконка из картинки…</button>
                  ${isImageIcon(meta.icon) ? '<button class="btn btn-ghost" id="inst-icon-reset">Сбросить</button>' : ""}
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Память, МБ</div>
                <div class="range">
                  <input type="range" id="inst-memory" min="512" max="32768" step="256" value="${meta.memory_mb ?? ((state.settings && state.settings.memory_mb) || 4096)}">
                  <span class="tag" id="inst-memory-value">${meta.memory_mb ?? ((state.settings && state.settings.memory_mb) || 4096)} МБ</span>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Java для этой сборки</div>
                <div class="flex-row">
                  <select class="select grow" id="inst-java">
                    <option value="" ${!meta.java_path ? "selected" : ""}>автоматически</option>
                    ${javas.map((item) => `<option value="${esc(item.path)}" ${meta.java_path === item.path ? "selected" : ""}>Java ${item.major} — ${esc(item.path)}</option>`).join("")}
                    ${meta.java_path && !javas.some((item) => item.path === meta.java_path) ? `<option value="${esc(meta.java_path)}" selected>${esc(meta.java_path)}</option>` : ""}
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
                <div class="label">Загрузчик</div>
                <div class="muted" style="padding-top:7px">${esc(loaderLabel(meta.loader))} · профиль <span class="kbd">${esc(versionId(meta))}</span></div>
              </div>
              <div class="settings-actions">
                <button class="btn btn-primary" id="inst-save">Сохранить сборку</button>
                <button class="btn" id="inst-folder">Открыть папку</button>
                <button class="btn btn-danger" id="inst-delete">Удалить сборку</button>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><strong>Лаунчер</strong><div class="spacer"></div><span class="muted" style="font-size:11px">общие настройки</span></div>
            <div style="padding:14px">
              <div class="settings-actions">
                <button class="btn" id="open-launcher-prefs">Настройки лаунчера</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    $$("#inst-icons .icon-chip").forEach((chip) => chip.addEventListener("click", () => {
      $$("#inst-icons .icon-chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    $("#open-launcher-prefs").addEventListener("click", () => openPrefs());
    const memorySlider = $("#inst-memory");
    if (memorySlider) memorySlider.addEventListener("input", (event) => {
      $("#inst-memory-value").textContent = `${event.target.value} МБ`;
    });
    const javaPick = $("#inst-java-pick");
    if (javaPick) javaPick.addEventListener("click", async () => {
      const picked = await api.pickFile("Java для сборки", ["exe", ""]).catch(() => null);
      if (!picked) return;
      const select = $("#inst-java");
      const option = document.createElement("option");
      option.value = picked;
      option.textContent = picked;
      option.selected = true;
      select.appendChild(option);
    });
    const iconFile = $("#inst-icon-file");
    if (iconFile) iconFile.addEventListener("click", async () => {
      const path = await api.pickFile("Иконка сборки", ["png", "jpg", "jpeg", "webp"]).catch(() => null);
      if (path) await setIconFromFile(meta, path);
    });
    const iconReset = $("#inst-icon-reset");
    if (iconReset) iconReset.addEventListener("click", async () => {
      try {
        await api.updateInstance({ ...meta, icon: null });
        delete state.iconCache[meta.id];
        await refreshInstances();
        renderSettings();
      } catch (err) { toast(String(err), "err"); }
    });
    $("#inst-save").addEventListener("click", async () => {
      const chip = $("#inst-icons .icon-chip.is-active");
      const next = {
        ...meta,
        name: $("#inst-name").value.trim() || meta.name,
        icon: chip && chip.dataset.icon ? chip.dataset.icon : null,
        memory_mb: $("#inst-memory").value ? Number($("#inst-memory").value) : null,
        java_path: $("#inst-java").value.trim() || null,
        jvm_args: $("#inst-jvm").value.trim() || null,
        notes: $("#inst-notes").value.trim()
      };
      try {
        await api.updateInstance(next);
        await refreshInstances();
        toast("Сборка сохранена", "ok");
      } catch (err) { toast(String(err), "err"); }
    });
    $("#inst-folder").addEventListener("click", () => api.openPath(`${meta.id}/minecraft`).catch((err) => toast(String(err), "err")));
    $("#inst-delete").addEventListener("click", async () => {
      if (!confirm(`Удалить сборку «${meta.name}» вместе с модами и мирами?`)) return;
      try {
        await api.deleteInstance(meta.id);
        state.selectedId = null;
        await refreshInstances();
        renderTab();
        toast("Сборка удалена", "ok");
      } catch (err) { toast(String(err), "err"); }
    });
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
    if (info && info.enabled && info.repo) checkUpdates(true);
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

  function showUpdate(info) {
    state.update.info = info;
    const pill = $("#btn-update");
    if (pill) {
      pill.hidden = false;
      $("#btn-update-text").textContent = `Обновить до ${info.version}`;
    }
    $("#upd-title").textContent = `Доступна версия ${info.version}`;
    $("#upd-versions").textContent = `${info.current_version} → ${info.version}`;
    $("#upd-date").textContent = info.published_at
      ? new Date(info.published_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
      : "";
    $("#upd-asset").textContent = info.asset_name || "";
    $("#upd-notes").textContent = info.notes && info.notes.trim()
      ? info.notes
      : "Описание изменений не указано.";
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
  async function refreshInstances() {
    try {
      state.instances = await api.instances();
      state.running = new Set(await api.running());
    } catch (err) {
      toast(String(err), "err");
    }
    await loadInstanceIcons();
    renderSidebar();
  }

  async function play() {
    const meta = selected();
    if (!meta) return toast("Выбери сборку", "err");
    if (state.running.has(meta.id)) return toast("Сборка уже запущена", "err");
    $("#btn-play").disabled = true;
    pushLog(meta.id, `[omnispec] Подготовка «${meta.name}» (MC ${meta.mc_version}, ${loaderLabel(meta.loader)})`, "dim");
    if (state.tab === "console") renderLogs(meta.id);
    try {
      const plan = await api.launch(meta.id);
      setProgress(null);
      pushLog(meta.id, `[omnispec] Java ${plan.java_major}: ${plan.java}`, "dim");
      pushLog(meta.id, `[omnispec] Память ${plan.memory_mb} МБ, артефактов в classpath: ${plan.classpath_entries}`, "dim");
      state.running.add(meta.id);
      renderSidebar();
      updateStatus();
    } catch (err) {
      setProgress(null);
      pushLog(meta.id, `[omnispec] Ошибка запуска: ${err}`, "err");
      toast(`Не удалось запустить: ${err}`, "err");
      if (state.tab === "console") renderLogs(meta.id);
    } finally {
      $("#btn-play").disabled = false;
    }
  }

  async function stopGame() {
    const meta = selected();
    if (!meta) return;
    try { await api.stop(meta.id); toast("Игра остановлена"); }
    catch (err) { toast(String(err), "err"); }
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
  function openAdd(mode = "modrinth") {
    state.add = { mode, query: "", packs: [], selected: null, path: "", url: "", loading: false };
    $("#modal-add").hidden = false;
    renderAdd();
    if (mode === "modrinth" && !state.add.packs.length) searchAddPacks("");
  }

  function renderAdd() {
    const cfg = state.add;
    $$("#add-tabs .mtab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.amode === cfg.mode));
    const body = $("#add-body");

    if (cfg.mode === "modrinth") {
      body.innerHTML = `
        <div class="form-grid">
          <div class="field">
            <label>Поиск модпака на Modrinth</label>
            <div style="display:flex;gap:8px">
              <input class="input grow" id="add-query" value="${esc(cfg.query)}" placeholder="fabulously optimized, cobblemon, all the mods…" spellcheck="false">
              <button class="btn" id="add-search">Найти</button>
            </div>
          </div>
          <div class="add-list">
            ${cfg.packs.length
              ? cfg.packs.map((pack) => `
                <div class="pack-row ${cfg.selected && cfg.selected.project_id === pack.project_id ? "is-active" : ""}" data-pack="${esc(pack.project_id)}">
                  <div class="card-icon" style="width:34px;height:34px;border-radius:7px">${pack.icon_url ? `<img src="${esc(pack.icon_url)}" alt="">` : "P"}</div>
                  <div style="flex:1;min-width:0">
                    <div class="item-title">${esc(pack.title)}</div>
                    <div class="item-sub">${esc((pack.description || "").slice(0, 92))}</div>
                  </div>
                  <span class="tag">${(pack.downloads || 0).toLocaleString("ru-RU")} ⬇</span>
                </div>`).join("")
              : `<div class="add-empty">${cfg.loading ? "Ищем модпаки…" : "Ничего не найдено — попробуй другой запрос"}</div>`}
          </div>
          <div class="hint" style="color:var(--muted);font-size:11.5px">
            Ставится последняя версия модпака со всеми модами, конфигами и нужной версией загрузчика.
          </div>
        </div>`;
      $("#add-search").addEventListener("click", () => searchAddPacks($("#add-query").value));
      $("#add-query").addEventListener("keydown", (event) => {
        if (event.key === "Enter") searchAddPacks(event.target.value);
      });
      $$("[data-pack]", body).forEach((row) => row.addEventListener("click", () => {
        cfg.selected = cfg.packs.find((pack) => pack.project_id === row.dataset.pack) || null;
        renderAdd();
      }));
    } else if (cfg.mode === "file") {
      body.innerHTML = `
        <div class="form-grid">
          <div class="field">
            <label>Путь к файлу .mrpack</label>
            <div class="flex-row">
              <input class="input grow" id="add-path" value="${esc(cfg.path)}" placeholder="C:\\Users\\Иван\\Downloads\\pack.mrpack" spellcheck="false">
              <button class="btn" id="add-pick"><svg class="ic"><use href="#i-folder"/></svg>Выбрать файл…</button>
            </div>
          </div>
          <div class="settings-note" style="margin:0">
            Можно просто перетащить .mrpack в окно лаунчера — сборка появится сама.
            Файл .mrpack открывается и двойным щелчком в проводнике (после установки через Setup).
          </div>
        </div>`;
      $("#add-path").addEventListener("input", (event) => { cfg.path = event.target.value; });
      $("#add-pick").addEventListener("click", async () => {
        const picked = await api.pickFile("Выбери модпак .mrpack", ["mrpack"]).catch(() => null);
        if (picked) { cfg.path = picked; $("#add-path").value = picked; }
      });
      $("#add-path").addEventListener("keydown", (event) => { if (event.key === "Enter") submitAdd(); });
      setTimeout(() => { const el = $("#add-path"); if (el) el.focus(); }, 30);
    } else {
      body.innerHTML = `
        <div class="form-grid">
          <div class="field">
            <label>Ссылка на модпак</label>
            <input class="input" id="add-url" value="${esc(cfg.url)}" placeholder="https://modrinth.com/modpack/fabulously-optimized или ссылка на .mrpack" spellcheck="false">
          </div>
          <div class="hint" style="color:var(--muted);font-size:11.5px">
            Понимает ссылки на страницу модпака Modrinth и прямые ссылки на файл .mrpack.
          </div>
        </div>`;
      $("#add-url").addEventListener("input", (event) => { cfg.url = event.target.value; });
      $("#add-url").addEventListener("keydown", (event) => { if (event.key === "Enter") submitAdd(); });
      setTimeout(() => { const el = $("#add-url"); if (el) el.focus(); }, 30);
    }

    $("#add-hint").textContent = cfg.mode === "modrinth"
      ? (cfg.selected ? cfg.selected.title : "выбери модпак")
      : (cfg.mode === "file" ? "файл .mrpack" : "ссылка");
    $("#add-submit").textContent = cfg.mode === "modrinth" ? "Установить" : "Добавить";
  }

  async function searchAddPacks(query) {
    const cfg = state.add;
    cfg.query = query || "";
    cfg.loading = true;
    renderAdd();
    try {
      const result = await api.search({ query: cfg.query, projectType: "modpack", mcVersion: null, loader: null, offset: 0 });
      cfg.packs = result.hits || [];
      if (cfg.selected) cfg.selected = cfg.packs.find((pack) => pack.project_id === cfg.selected.project_id) || null;
    } catch (err) {
      cfg.packs = [];
      toast(`Modrinth недоступен: ${err}`, "err");
    } finally {
      cfg.loading = false;
      renderAdd();
    }
  }

  async function submitAdd() {
    const cfg = state.add;
    const submit = $("#add-submit");
    let source = "";
    if (cfg.mode === "modrinth") {
      if (!cfg.selected) return toast("Выбери модпак", "err");
      source = "";
    } else if (cfg.mode === "file") {
      source = cfg.path.trim();
      if (!source) return toast("Укажи путь к файлу .mrpack", "err");
    } else {
      source = cfg.url.trim();
      if (!source) return toast("Вставь ссылку", "err");
    }

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Устанавливаем…";
    try {
      let target = source;
      if (cfg.mode === "modrinth") {
        const versions = await api.modrinthVersions(cfg.selected.project_id, null, null);
        if (!versions.length) throw new Error("у этого модпака нет версий");
        target = versions[0].id;
      }
      const meta = await api.installModpack(target);
      $("#modal-add").hidden = true;
      await refreshInstances();
      selectInstance(meta.id);
      toast(`Сборка «${meta.name}» добавлена`, "ok");
    } catch (err) {
      toast(`Не удалось добавить: ${err}`, "err");
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  }

  /* ==================== МОДАЛКА СОЗДАНИЯ ==================== */
  async function openCreate() {
    state.create = { mode: "manual", name: "", mc: "", loader: "fabric", loaderVersion: "", versions: [], loaderVersionsList: [], packQuery: "", packs: [], selectedPack: null };
    $("#modal-create").hidden = false;
    state.create.versions = await api.versions((state.settings && state.settings.show_snapshots) || false).catch(() => []);
    state.create.mc = (state.create.versions[0] || {}).id || "1.21.4";
    state.create.name = `Сборка ${state.create.mc}`;
    renderCreateModal();
    await loadLoaderVersions();
  }

  function renderCreateModal() {
    const cfg = state.create;
    $$("#create-tabs .mtab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.mode === cfg.mode));
    const body = $("#create-body");

    if (cfg.mode === "manual") {
      body.innerHTML = `
        <div class="form-grid">
          <div class="field">
            <label>Название сборки</label>
            <input class="input" id="c-name" value="${esc(cfg.name)}" spellcheck="false">
          </div>
          <div class="field">
            <label>Версия Minecraft</label>
            <select class="select" id="c-mc">
              ${cfg.versions.map((version) => `<option value="${esc(version.id)}" ${version.id === cfg.mc ? "selected" : ""}>${esc(version.id)}${version.type && version.type !== "release" ? ` (${esc(version.type)})` : ""}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Загрузчик модов</label>
            <div class="chips" id="c-loaders">
              ${Object.entries(LOADER_NAMES).map(([value, label]) => `<button class="chip ${cfg.loader === value ? "is-active" : ""}" data-loader="${value}">${label}</button>`).join("")}
            </div>
          </div>
          <div class="field" id="c-loader-version-field" ${cfg.loader === "vanilla" ? "hidden" : ""}>
            <label>Версия загрузчика</label>
            <select class="select" id="c-loader-version">
              ${cfg.loaderVersionsList.length ? cfg.loaderVersionsList.map((option) => `<option value="${esc(option.version)}" ${option.version === cfg.loaderVersion ? "selected" : ""}>${esc(option.version)}${option.stable ? "" : " (beta)"}</option>`).join("") : `<option value="">загружаем…</option>`}
            </select>
          </div>
          <div class="hint" style="color:var(--muted);font-size:11.5px">
            Сборка создаётся пустой: своя папка, свои моды и миры. Моды можно добавить на вкладке Modrinth.
          </div>
        </div>`;
      $("#c-name").addEventListener("input", (event) => { cfg.name = event.target.value; });
      $("#c-mc").addEventListener("change", async (event) => { cfg.mc = event.target.value; await loadLoaderVersions(); renderCreateModal(); });
      $$("#c-loaders .chip").forEach((chip) => chip.addEventListener("click", async () => {
        cfg.loader = chip.dataset.loader;
        renderCreateModal();
        await loadLoaderVersions();
      }));
      if ($("#c-loader-version")) $("#c-loader-version").addEventListener("change", (event) => { cfg.loaderVersion = event.target.value; });
      $("#create-submit").textContent = "Создать";
      $("#create-hint").textContent = cfg.loader === "vanilla" ? "чистая ваниль" : `${LOADER_NAMES[cfg.loader]} ${cfg.loaderVersion || "—"}`;
    } else {
      body.innerHTML = `
        <div class="form-grid">
          <div class="field">
            <label>Поиск модпака на Modrinth</label>
            <div style="display:flex;gap:8px">
              <input class="input grow" id="c-pack-query" value="${esc(cfg.packQuery)}" placeholder="fabulously optimized, cobblemon, all the mods…" spellcheck="false">
              <button class="btn" id="c-pack-search">Найти</button>
            </div>
          </div>
          <div style="display:grid;gap:6px;max-height:300px;overflow-y:auto">
            ${cfg.packs.length ? cfg.packs.map((pack) => `
              <div class="pack-row ${cfg.selectedPack && cfg.selectedPack.project_id === pack.project_id ? "is-active" : ""}" data-pack="${esc(pack.project_id)}">
                <div class="card-icon" style="width:34px;height:34px;border-radius:7px">${pack.icon_url ? `<img src="${esc(pack.icon_url)}" alt="">` : "P"}</div>
                <div style="flex:1;min-width:0">
                  <div class="item-title">${esc(pack.title)}</div>
                  <div class="item-sub">${esc((pack.description || "").slice(0, 90))}</div>
                </div>
                <span class="tag">${(pack.downloads || 0).toLocaleString("ru-RU")} ⬇</span>
              </div>`).join("") : `<div class="muted" style="font-size:12px">Найди модпак и выбери его из списка</div>`}
          </div>
        </div>`;
      $("#c-pack-search").addEventListener("click", searchPacks);
      $("#c-pack-query").addEventListener("keydown", (event) => { if (event.key === "Enter") searchPacks(); });
      $$("[data-pack]").forEach((row) => row.addEventListener("click", () => {
        cfg.selectedPack = cfg.packs.find((pack) => pack.project_id === row.dataset.pack);
        renderCreateModal();
      }));
      $("#create-submit").textContent = "Установить";
      $("#create-hint").textContent = cfg.selectedPack ? cfg.selectedPack.title : "выбери модпак";
    }
  }

  async function loadLoaderVersions() {
    const cfg = state.create;
    if (cfg.loader === "vanilla") { cfg.loaderVersionsList = []; cfg.loaderVersion = ""; return; }
    cfg.loaderVersionsList = await api.loaderVersions(cfg.loader, cfg.mc).catch(() => []);
    const current = cfg.loaderVersionsList.find((option) => option.stable) || cfg.loaderVersionsList[0];
    cfg.loaderVersion = current ? current.version : "";
    renderCreateModal();
  }

  async function searchPacks() {
    state.create.packQuery = $("#c-pack-query").value;
    const result = await api.search({ query: state.create.packQuery, projectType: "modpack", mcVersion: null, loader: null, offset: 0 }).catch(() => ({ hits: [] }));
    state.create.packs = result.hits || [];
    renderCreateModal();
  }

  async function submitCreate() {
    const cfg = state.create;
    const submit = $("#create-submit");
    submit.disabled = true;
    try {
      if (cfg.mode === "manual") {
        const loader = cfg.loader === "vanilla" ? { type: "vanilla" } : { type: cfg.loader, version: cfg.loaderVersion };
        const meta = await api.createInstance({ name: cfg.name || `Сборка ${cfg.mc}`, mc_version: cfg.mc, loader });
        $("#modal-create").hidden = true;
        await refreshInstances();
        selectInstance(meta.id);
        toast(`Сборка «${meta.name}» создана`, "ok");
      } else {
        if (!cfg.selectedPack) { toast("Выбери модпак", "err"); return; }
        const versions = await api.modrinthVersions(cfg.selectedPack.project_id, null, null);
        if (!versions.length) throw new Error("у модпака нет версий");
        const meta = await api.installModpack(versions[0].id);
        $("#modal-create").hidden = true;
        await refreshInstances();
        selectInstance(meta.id);
        toast(`Модпак «${meta.name}» установлен`, "ok");
      }
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
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => { state.tab = tab.dataset.tab; renderTab(); }));
    on("#btn-play", "click", play);
    on("#btn-stop", "click", stopGame);
    on("#btn-restart", "click", async () => { await stopGame(); setTimeout(play, 800); });
    on("#btn-create", "click", openCreate);
    on("#btn-import", "click", () => openAdd("modrinth"));

    /* аккаунты и настройки лаунчера */
    on("#btn-add-account", "click", openAccounts);
    on("#btn-prefs", "click", () => openPrefs());
    on("#btn-launcher-settings", "click", () => openPrefs());
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
    on("[data-close-prompt]", "click", () => { const modal = $("#modal-prompt"); if (modal) modal.hidden = true; });
    const verModal = $("#modal-versions");
    if (verModal) verModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-versions") verModal.hidden = true; });
    const prefsModal = $("#modal-prefs");
    if (prefsModal) prefsModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-prefs") prefsModal.hidden = true; });
    const accModal = $("#modal-account");
    if (accModal) accModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-account") accModal.hidden = true; });

    on("#btn-folder", "click", () => { const meta = selected(); if (meta) api.openPath(`/instances/${meta.id}/minecraft`).catch(() => {}); });
    on("#btn-grid", "click", () => toast("Сетка появится в следующей версии"));
    on("#btn-sort", "click", () => {
      state.instances.sort((a, b) => a.name.localeCompare(b.name));
      renderSidebar();
    });
    on("#instance-search", "input", renderSidebar);

    $$("[data-win]").forEach((btn) => btn.addEventListener("click", () => api.window(btn.dataset.win).catch(() => {})));
    $$("[data-close-modal]").forEach((btn) => btn.addEventListener("click", () => { $("#modal-create").hidden = true; }));
    $$("[data-close-update]").forEach((btn) => btn.addEventListener("click", () => { $("#modal-update").hidden = true; }));
    $$("[data-close-add]").forEach((btn) => btn.addEventListener("click", () => { $("#modal-add").hidden = true; }));
    $("#add-submit").addEventListener("click", submitAdd);
    $$("#add-tabs .mtab").forEach((tab) => tab.addEventListener("click", () => { state.add.mode = tab.dataset.amode; renderAdd(); }));
    $("#modal-add").addEventListener("mousedown", (event) => { if (event.target.id === "modal-add") $("#modal-add").hidden = true; });
    $("#modal-update").addEventListener("mousedown", (event) => { if (event.target.id === "modal-update") $("#modal-update").hidden = true; });
    $("#btn-update").addEventListener("click", openUpdateModal);
    $("#upd-install").addEventListener("click", installUpdate);
    $("#upd-page").addEventListener("click", () => {
      const url = (state.update.info && state.update.info.page_url) || "https://github.com";
      api.openUrl(url).catch((error) => toast(String(error), "err"));
    });
    $("#modal-create").addEventListener("mousedown", (event) => { if (event.target.id === "modal-create") $("#modal-create").hidden = true; });
    $("#create-submit").addEventListener("click", submitCreate);
    $$("#create-tabs .mtab").forEach((tab) => tab.addEventListener("click", () => { state.create.mode = tab.dataset.mode; renderCreateModal(); }));

    // контекстное меню закрывается кликом мимо, прокруткой и Escape
    document.addEventListener("mousedown", (event) => {
      const menu = $("#ctx-menu");
      if (menu && !menu.hidden && !menu.contains(event.target)) closeCtxMenu();
    });
    window.addEventListener("blur", closeCtxMenu);

    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); refreshInstances(); }
      if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); state.logs[state.selectedId] = []; renderLogs(state.selectedId); }
      if (event.key === "Escape") {
        $("#modal-create").hidden = true;
        $("#modal-add").hidden = true;
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
      if (event.key === "Enter" && !event.target.matches("input, select, textarea") && $("#modal-create").hidden) play();
    });
  }

  async function attachBackendEvents() {
    if (!IS_APP) {
      // демо-режим: показываем «живой» лог
      const demo = DEMO.demoLogs;
      let index = 0;
      const timer = setInterval(() => {
        if (index >= demo.length) { clearInterval(timer); return; }
        pushLog("fabulously-optimized", demo[index], classify(demo[index]));
        index += 1;
      }, 260);
      return;
    }

    await api.onProgress((payload) => setProgress(payload));
    await api.onLog((payload) => {
      pushLog(payload.instance, payload.line, classify(payload.line));
    });
    await api.onExit((payload) => {
      state.running.delete(payload.instance);
      pushLog(payload.instance, `[omnispec] Игра завершилась с кодом ${payload.code}`, payload.code === 0 ? "ok" : "err");
      renderSidebar();
      updateStatus();
      if (payload.code !== 0) toast(`Игра закрылась с ошибкой (код ${payload.code})`, "err");
    });
    await api.onToast((payload) => toast(payload.message, payload.kind || ""));
  }

  async function init() {
    bindEvents();
    initClickFx();
    try {
      state.settings = await api.settings();
    } catch { state.settings = { ...DEMO.settings }; }
    // Оформление из settings.json (как prefs в OmniPanel): тема и эффект клика.
    state.theme = applyTheme((state.settings && state.settings.theme) || "dark");
    state.fx = (state.settings && state.settings.click_fx) || "wave";
    applyClickFx(state.fx);
    applyShape((state.settings && state.settings.shape) || "soft");
    state.sound = {
      on: state.settings && state.settings.sound_fx !== false,
      volume: Number((state.settings && state.settings.sound_volume) ?? 60)
    };
    if (state.settings && state.settings.wallpaper === "custom") {
      state.customWall = await api.customWallpaper().catch(() => null);
    }
    applyWallpaper();
    await loadAccounts();
    bindFileDrop();
    await refreshInstances();
    // ничего не выбираем автоматически: стартовый экран — готовые сборки
    if (!state.selectedId) state.tab = "discover";
    renderTab();
    try {
      await initUpdates();
      await attachBackendEvents();
    } catch (error) {
      // Без разрешений Tauri события недоступны — лаунчер продолжит работать,
      // просто без живого лога (см. capabilities/default.json).
      toast(`Живой лог недоступен: ${error && error.message ? error.message : error}`, "err");
    }
    // .mrpack, с которым запустили лаунчер (двойной щелчок в проводнике)
    if (IS_APP) {
      try {
        const startup = await api.startupFile();
        if (startup) installMrpackPath(startup);
      } catch (error) { /* без аргументов — обычный запуск */ }
    }
    if (!IS_APP) {
      /* демо-режим без бэкенда — тихо */
    }
  }

  init();
})();
