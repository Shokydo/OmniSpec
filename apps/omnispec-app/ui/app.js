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
    const known = name && WALLS.some(([id]) => id === name);
    if (!known) {
      layer.hidden = true;
      layer.style.backgroundImage = "";
      document.body.classList.remove("has-wall");
      return;
    }
    layer.hidden = false;
    layer.style.backgroundImage = `url("${wallUrl(name)}")`;
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

  function instanceIconHtml(meta) {
    const icon = meta && meta.icon;
    if (!icon) return esc(String((meta && meta.name) || "?").trim().charAt(0).toUpperCase());
    if (INSTANCE_ICONS.includes(icon)) return `<svg class="ic"><use href="#${icon}"/></svg>`;
    return `<img src="${esc(icon)}" alt="">`;
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
    search: async () => { throw new Error("нет связи с api.modrinth.com: error sending request (dns error) ← попытка подключиться к серверу не удалась"); },
    modrinthVersions: async () => [{ id: "v1", name: "1.0.0", version_number: "1.0.0", game_versions: ["1.21.4"], loaders: ["fabric"], files: [], dependencies: [] }],
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
    tab: "console",
    running: new Set(),
    logs: {},
    files: { path: "", entries: [], selected: null },
    mods: [],
    modrinth: { query: "", type: "mod", results: [], loading: false, error: null, tried: false },
    wall: { wallpaper: null, fit: "cover", blur: 0, dim: 40 },
    update: { info: null, version: "0.1.0", repo: null, enabled: true, checking: false, installing: false },
    theme: "dark",
    fx: "wave",
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
      consoleEl.innerHTML = `<div class="empty-state">Выбери сборку и нажми «Играть» — лог появится здесь</div>`;
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
        <div class="instance-icon">${instanceIconHtml(item) || esc(letter)}</div>
        <div class="instance-body">
          <div class="instance-name">${esc(item.name)}</div>
          <div class="instance-sub">MC ${esc(item.mc_version)} · ${esc(loaderLabel(item.loader))}</div>
        </div>
        ${running ? '<div class="instance-running" title="Запущена"></div>' : ""}
      </div>`;
    }).join("");

    $$(".instance", list).forEach((el) => el.addEventListener("click", () => selectInstance(el.dataset.id)));
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
    $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.tab));
    const meta = selected();

    if (!meta && !["settings", "about", "modrinth"].includes(state.tab)) {
      body.innerHTML = `<div class="empty-state">Выбери сборку слева или создай новую</div>`;
      return;
    }

    switch (state.tab) {
      case "console": return renderConsole();
      case "files": return renderFiles();
      case "mods": return renderMods();
      case "resourcepacks": return renderAssetsList("resourcepacks", "Ресурспаки", "resourcepack");
      case "worlds": return renderWorlds();
      case "modrinth": return renderModrinth();
      case "settings": return renderSettings();
      case "about": return renderAbout();
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
  function renderModrinth() {
    const meta = selected();
    const cfg = state.modrinth;
    const types = [["mod", "Моды"], ["modpack", "Модпаки"], ["resourcepack", "Ресурспаки"], ["shader", "Шейдеры"]];
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
              ${(meta ? [meta.mc_version] : []).concat([]).map((v) => `<option value="${esc(v)}" selected>${esc(v)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Загрузчик</label>
            <select class="select" id="mr-loader">
              <option value="">любой</option>
              ${Object.entries(LOADER_NAMES).map(([value, label]) => `<option value="${value}" ${meta && meta.loader && meta.loader.type === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>
          <button class="btn" id="mr-search" style="align-self:flex-end">Найти</button>
        </div>
        <div class="modrinth-results" id="mr-results">
          ${cfg.loading
            ? `<div class="empty-state">Ищем…</div>`
            : cfg.error
              ? `<div class="empty-state" style="display:flex;flex-direction:column;align-items:center;gap:10px">
                   <div style="max-width:640px;text-align:left;white-space:pre-wrap;font-size:12px;color:var(--red)">${esc(cfg.error)}</div>
                   <button class="btn" id="mr-retry">Повторить</button>
                 </div>`
              : cfg.results.length
                ? cfg.results.map(cardHtml).join("")
                : `<div class="empty-state">Введи запрос и нажми «Найти»</div>`}
        </div>
      </div>`;

    $("#mr-search").addEventListener("click", runSearch);
    $("#mr-query").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
    $("#mr-type").addEventListener("change", (event) => { state.modrinth.type = event.target.value; runSearch(); });
    const retry = $("#mr-retry");
    if (retry) retry.addEventListener("click", () => runSearch());
    $$("[data-install]").forEach((btn) => btn.addEventListener("click", () => installFromModrinth(btn.dataset.install, btn.dataset.kind)));
    $$("[data-open-page]").forEach((btn) => btn.addEventListener("click", () => {
      const type = state.modrinth.type || "mod";
      const url = type === "modpack" ? `https://modrinth.com/modpack/${btn.dataset.openPage}` : `https://modrinth.com/${type}/${btn.dataset.openPage}`;
      api.openUrl(url).catch((error) => toast(String(error), "err"));
    }));
    if (!cfg.tried && !cfg.loading && !cfg.error) runSearch();
  }

  function cardHtml(hit) {
    const isPack = state.modrinth.type === "modpack";
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
            ${isPack ? "Установить сборку" : "Установить"}
          </button>
          <button class="btn btn-ghost" data-open-page="${esc(hit.slug || hit.project_id)}">Страница</button>
        </div>
      </div>
    </div>`;
  }

  async function runSearch() {
    state.modrinth.query = $("#mr-query") ? $("#mr-query").value : "";
    state.modrinth.loading = true;
    state.modrinth.tried = true;
    state.modrinth.error = null;
    renderModrinth();
    const meta = selected();
    try {
      const result = await api.search({
        query: state.modrinth.query,
        projectType: state.modrinth.type,
        mcVersion: meta && state.modrinth.type !== "modpack" ? meta.mc_version : null,
        loader: meta && meta.loader ? meta.loader.type : null,
        offset: 0
      });
      state.modrinth.results = result.hits || [];
      state.modrinth.error = null;
    } catch (err) {
      state.modrinth.results = [];
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

  /* ---------- настройки ---------- */
  async function renderSettings() {
    const settings = state.settings || {};
    const meta = selected();
    state.wall = {
      wallpaper: settings.wallpaper || null,
      fit: settings.wallpaper_fit || "cover",
      blur: Number(settings.wallpaper_blur ?? 0),
      dim: Number(settings.wallpaper_dim ?? 40)
    };
    const javas = await api.javas().catch(() => []);
    const info = await api.appInfo().catch(() => ({ home: "", version: "" }));
    $("#tab-body").innerHTML = `
      <div class="settings-wrap">
        <div class="settings-grid">
          <div class="panel">
            <div class="panel-head"><strong>Аккаунт</strong><span class="badge">офлайн</span></div>
            <div style="padding:14px">
              <div class="field" style="max-width:320px">
                <label>Ник в игре (3–16 символов, латиница)</label>
                <input class="input" id="set-username" value="${esc(settings.username || "")}" spellcheck="false">
              </div>
              <div class="hint" style="margin-top:8px;color:var(--muted);font-size:11px">
                Лицензия не нужна. UUID считается из ника — скины через сторонние сервисы работают,
                вход на серверы с online-mode нет.
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <strong>Оформление</strong>
              <span class="badge" id="theme-badge">${esc((THEMES[state.theme] || THEMES.dark).label)}</span>
              <div class="spacer"></div>
              <span class="muted" style="font-size:11px">как в OmniPanel</span>
            </div>
            <div style="padding:14px;display:grid;gap:14px">
              <div class="theme-grid" id="theme-grid">
                ${Object.entries(THEMES).map(([id, theme]) => `
                  <button class="theme-chip ${state.theme === id ? "is-active" : ""}" data-theme-id="${id}" title="${esc(theme.label)}">
                    <span class="theme-swatch" style="background:${theme.bg};border-color:${theme.panel}">
                      <span style="position:absolute;left:3px;top:3px;width:12px;height:12px;border-radius:4px;background:${theme.accent}"></span>
                    </span>
                    <span class="theme-name">${esc(theme.label)}</span>
                  </button>`).join("")}
              </div>
              <div class="settings-row">
                <div class="label">Эффект от клика</div>
                <div class="chips" id="fx-chips">
                  ${Object.entries(FX_STYLES).map(([id, label]) => `<button class="chip ${state.fx === id ? "is-active" : ""}" data-fx="${id}">${label}</button>`).join("")}
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Обои</div>
                <div>
                  <div class="wall-grid" id="wall-grid">
                    <button class="wall-chip none ${!state.wall.wallpaper ? "is-active" : ""}" data-wall="">нет</button>
                    ${WALLS.map(([id, label]) => `
                      <button class="wall-chip ${state.wall.wallpaper === id ? "is-active" : ""}" data-wall="${id}" style="background-image:url('${wallUrl(id)}')" title="${esc(label)}"><span>${esc(label)}</span></button>`).join("")}
                  </div>
                  <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px">
                    <div class="field">
                      <label>Как показывать</label>
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
                </div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><strong>Java и память</strong></div>
            <div style="padding:14px;display:grid;gap:14px">
              <div class="settings-row">
                <div class="label">Память, МБ</div>
                <div>
                  <div class="range">
                    <input type="range" id="set-memory" min="1024" max="16384" step="512" value="${settings.memory_mb || 4096}">
                    <span class="tag" id="set-memory-value">${settings.memory_mb || 4096} МБ</span>
                  </div>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Путь к Java</div>
                <div>
                  <input class="input" style="width:100%" id="set-java" placeholder="автоматически (рекомендуется)" value="${esc(settings.java_path || "")}" spellcheck="false">
                  <div class="hint">Найдено: ${javas.length ? javas.map((j) => `Java ${j.major}`).join(", ") : "нет — лаунчер скачает рантайм Mojang"}</div>
                </div>
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
          </div>

          ${meta ? `<div class="panel">
            <div class="panel-head"><strong>Сборка «${esc(meta.name)}»</strong><span class="badge">MC ${esc(meta.mc_version)}</span></div>
            <div style="padding:14px;display:grid;gap:14px">
              <div class="settings-row">
                <div class="label">Память этой сборки, МБ</div>
                <div><input class="input" id="set-inst-memory" type="number" min="512" step="256" style="width:160px" placeholder="как в общих" value="${meta.memory_mb ?? ""}"></div>
              </div>
              <div class="settings-row">
                <div class="label">Иконка сборки</div>
                <div class="icon-grid" id="inst-icons">
                  <button class="icon-chip letter ${!meta.icon ? "is-active" : ""}" data-icon="" title="Первая буква">${esc(String(meta.name).trim().charAt(0).toUpperCase())}</button>
                  ${INSTANCE_ICONS.map((icon) => `<button class="icon-chip ${meta.icon === icon ? "is-active" : ""}" data-icon="${icon}" title="${icon.replace("i-", "")}"><svg class="ic"><use href="#${icon}"/></svg></button>`).join("")}
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Загрузчик</div>
                <div class="muted" style="padding-top:7px">${esc(loaderLabel(meta.loader))} · профиль <span class="kbd">${esc(versionId(meta))}</span></div>
              </div>
              <div class="settings-actions">
                <button class="btn" id="inst-folder">Открыть папку сборки</button>
                <button class="btn btn-danger" id="inst-delete">Удалить сборку</button>
              </div>
            </div>
          </div>` : ""}

          <div class="panel">
            <div class="panel-head"><strong>Сеть и прокси</strong><span class="spacer"></span><span class="muted" style="font-size:11px">Modrinth · Mojang</span></div>
            <div style="padding:14px;display:grid;gap:14px">
              <div class="settings-row">
                <div class="label">Прокси</div>
                <div>
                  <input class="input" style="width:100%" id="set-proxy" placeholder="http://127.0.0.1:8080 или socks5://…" value="${esc(settings.proxy || "")}" spellcheck="false">
                  <div class="hint">Применяется после перезапуска лаунчера. Пусто — подключаться напрямую.</div>
                </div>
              </div>
              <div class="settings-actions">
                <button class="btn" id="net-check">Проверить связь с Modrinth</button>
                <span class="muted" id="net-check-result" style="font-size:11px;align-self:center;max-width:520px"></span>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <strong>Обновления</strong>
              <span class="badge">v${esc(state.update.version)}</span>
              <div class="spacer"></div>
              <button class="btn btn-small" id="upd-check-now">Проверить сейчас</button>
            </div>
            <div style="padding:14px;display:grid;gap:14px">
              <div class="settings-row">
                <div class="label">Репозиторий обновлений</div>
                <div>
                  <input class="input" style="width:100%" id="set-upd-repo" placeholder="владелец/репозиторий" value="${esc(settings.update_repo || "")}" spellcheck="false">
                  <div class="settings-note">Релизы берутся из GitHub Releases по тегу <span class="kbd">vX.Y.Z</span>. Публичный репозиторий токен не требует.</div>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Проверять при запуске</div>
                <div>
                  <div class="switch-row"><button class="switch ${settings.update_enabled ? "on" : ""}" id="set-upd-enabled"></button><span class="muted">тихая проверка, обновление — по кнопке</span></div>
                  <div class="switch-row" style="margin-top:8px"><button class="switch ${settings.update_prerelease ? "on" : ""}" id="set-upd-pre"></button><span class="muted">учитывать бета-версии (prerelease)</span></div>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Токен GitHub</div>
                <div>
                  <input class="input" style="width:100%" id="set-upd-token" type="password" placeholder="не требуется для публичного репозитория" value="${esc(settings.update_token || "")}" spellcheck="false">
                  <div class="settings-note warn">Нужен только для приватного репозитория. Не публикуй сборку с токеном внутри: его можно вытащить из файла.</div>
                </div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><strong>Лаунчер</strong></div>
            <div style="padding:14px;display:grid;gap:10px">
              <div class="settings-row"><div class="label">Папка данных</div><div class="muted" style="padding-top:7px;word-break:break-all">${esc(info.home)} <span class="kbd">${esc(info.version)}</span></div></div>
              <div class="settings-actions">
                <button class="btn" id="set-open-data">Открыть папку данных</button>
                <button class="btn btn-primary" id="set-save">Сохранить настройки</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    $("#set-memory").addEventListener("input", (event) => { $("#set-memory-value").textContent = `${event.target.value} МБ`; });
    $("#set-auto-java").addEventListener("click", (event) => event.target.classList.toggle("on"));
    $("#set-open-data").addEventListener("click", () => api.openPath("").catch(() => {}));
    $$("#theme-grid .theme-chip").forEach((chip) => chip.addEventListener("click", () => {
      state.theme = applyTheme(chip.dataset.themeId);
      $$("#theme-grid .theme-chip").forEach((el) => el.classList.toggle("is-active", el === chip));
      const badge = $("#theme-badge");
      if (badge) badge.textContent = (THEMES[state.theme] || THEMES.dark).label;
    }));
    $$("#fx-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
      state.fx = chip.dataset.fx;
      applyClickFx(state.fx);
      $$("#fx-chips .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
    }));
    // ---------- обои ----------
    const redrawWallChips = () => {
      $$("#wall-grid .wall-chip").forEach((chip) => chip.classList.toggle("is-active", (chip.dataset.wall || null) === state.wall.wallpaper));
    };
    $$("#wall-grid .wall-chip").forEach((chip) => chip.addEventListener("click", () => {
      state.wall.wallpaper = chip.dataset.wall || null;
      redrawWallChips();
      applyWallpaper(state.wall);
    }));
    $("#wall-fit").addEventListener("change", (event) => { state.wall.fit = event.target.value; applyWallpaper(state.wall); });
    $("#wall-blur").addEventListener("input", (event) => {
      state.wall.blur = Number(event.target.value);
      $("#wall-blur-value").textContent = String(state.wall.blur);
      applyWallpaper(state.wall);
    });
    $("#wall-dim").addEventListener("input", (event) => {
      state.wall.dim = Number(event.target.value);
      $("#wall-dim-value").textContent = `${state.wall.dim}%`;
      applyWallpaper(state.wall);
    });

    // ---------- проверка связи ----------
    $("#net-check").addEventListener("click", async () => {
      const box = $("#net-check-result");
      box.className = "muted";
      box.textContent = "Проверяем…";
      try {
        box.textContent = await api.netCheck();
      } catch (err) {
        box.textContent = String(err);
        box.className = "settings-note warn";
      }
    });

    $("#set-upd-enabled").addEventListener("click", (event) => event.target.classList.toggle("on"));
    $("#set-upd-pre").addEventListener("click", (event) => event.target.classList.toggle("on"));
    $("#upd-check-now").addEventListener("click", async () => {
      const info = await checkUpdates(false);
      if (info) $("#modal-update").hidden = false;
    });
    $("#set-save").addEventListener("click", async () => {
      const next = {
        ...settings,
        username: $("#set-username").value.trim(),
        memory_mb: Number($("#set-memory").value),
        java_path: $("#set-java").value.trim() || null,
        jvm_args: $("#set-jvm").value,
        auto_java: $("#set-auto-java").classList.contains("on"),
        update_repo: ($("#set-upd-repo").value || "").trim() || null,
        update_enabled: $("#set-upd-enabled").classList.contains("on"),
        update_prerelease: $("#set-upd-pre").classList.contains("on"),
        update_token: ($("#set-upd-token").value || "").trim() || null,
        theme: state.theme,
        click_fx: state.fx,
        proxy: ($("#set-proxy").value || "").trim() || null,
        wallpaper: state.wall.wallpaper,
        wallpaper_fit: state.wall.fit,
        wallpaper_blur: state.wall.blur,
        wallpaper_dim: state.wall.dim
      };
      try { await api.saveSettings(next); state.settings = next; toast("Настройки сохранены", "ok"); }
      catch (err) { toast(String(err), "err"); }
    });
    if (meta) {
      $("#inst-folder").addEventListener("click", () => api.openPath(`${meta.id}/minecraft`).catch(() => {}));
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
      $$("#inst-icons .icon-chip").forEach((chip) => chip.addEventListener("click", async () => {
        const icon = chip.dataset.icon || null;
        $$("#inst-icons .icon-chip").forEach((el) => el.classList.toggle("is-active", el === chip));
        try {
          await api.updateInstance({ ...meta, icon });
          await refreshInstances();
          toast(icon ? "Иконка сборки обновлена" : "Иконка сброшена к букве", "ok");
        } catch (err) { toast(String(err), "err"); }
      }));
      $("#set-inst-memory").addEventListener("change", async (event) => {
        const value = event.target.value ? Number(event.target.value) : null;
        await api.updateInstance({ ...meta, memory_mb: value }).catch((err) => toast(String(err), "err"));
        await refreshInstances();
      });
    }
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

  function renderAbout() {
    $("#tab-body").innerHTML = `
      <div class="about-wrap">
        <div class="about-card">
          <h3>OmniSpec 0.1.0</h3>
          <p>Лаунчер Minecraft для нелицензионных аккаунтов: свои сборки, моды и модпаки с Modrinth, автоматическая Java и запуск «в один клик». Написан на Rust (ядро) + Tauri (интерфейс).</p>
          <ul class="about-list">
            <li>Офлайн-аккаунты, UUID как в игре</li>
            <li>Vanilla, Fabric, Quilt, Forge, NeoForge</li>
            <li>Установка модов и модпаков (.mrpack) с Modrinth</li>
            <li>Скачивание рантайма Java с серверов Mojang</li>
            <li>Отдельная папка и настройки для каждой сборки</li>
          </ul>
          <p style="margin-top:12px">
            <span class="kbd">Ctrl+R</span> обновить список · <span class="kbd">Ctrl+L</span> очистить консоль · <span class="kbd">Enter</span> играть
          </p>
        </div>
      </div>`;
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
    renderSidebar();
    if (!state.selectedId && state.instances.length) selectInstance(state.instances[0].id);
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
            <input class="input" id="add-path" value="${esc(cfg.path)}" placeholder="C:\\Users\\Иван\\Downloads\\pack.mrpack" spellcheck="false">
          </div>
          <div class="hint" style="color:var(--muted);font-size:11.5px">
            Подойдёт любой модпак в формате Modrinth (.mrpack) — лаунчер развернёт его в отдельную сборку.
          </div>
        </div>`;
      $("#add-path").addEventListener("input", (event) => { cfg.path = event.target.value; });
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

  function bindEvents() {
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => { state.tab = tab.dataset.tab; renderTab(); }));
    $("#btn-play").addEventListener("click", play);
    $("#btn-stop").addEventListener("click", stopGame);
    $("#btn-restart").addEventListener("click", async () => { await stopGame(); setTimeout(play, 800); });
    $("#btn-start-all").addEventListener("click", play);
    $("#btn-create").addEventListener("click", openCreate);
    $("#btn-import").addEventListener("click", () => openAdd("modrinth"));
    // кнопка Modrinth убрана из тулбара — она живёт в модалке «Добавить существующую»
    $("#btn-folder").addEventListener("click", () => { const meta = selected(); if (meta) api.openPath(`/instances/${meta.id}/minecraft`).catch(() => {}); });
    $("#btn-tab-settings").addEventListener("click", () => { state.tab = "settings"; renderTab(); });
    $("#btn-global-settings").addEventListener("click", () => { state.tab = "settings"; renderTab(); });
    $("#btn-settings-short").addEventListener("click", () => { state.tab = "settings"; renderTab(); });
    $("#btn-grid").addEventListener("click", () => toast("Сетка появится в следующей версии"));
    $("#btn-sort").addEventListener("click", () => {
      state.instances.sort((a, b) => a.name.localeCompare(b.name));
      renderSidebar();
    });
    $("#instance-search").addEventListener("input", renderSidebar);

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

    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); refreshInstances(); }
      if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); state.logs[state.selectedId] = []; renderLogs(state.selectedId); }
      if (event.key === "Escape") { $("#modal-create").hidden = true; $("#modal-add").hidden = true; }
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
    applyWallpaper();
    await refreshInstances();
    if (state.instances.length) selectInstance(state.instances[0].id);
    else renderTab();
    try {
      await initUpdates();
      await attachBackendEvents();
    } catch (error) {
      // Без разрешений Tauri события недоступны — лаунчер продолжит работать,
      // просто без живого лога (см. capabilities/default.json).
      toast(`Живой лог недоступен: ${error && error.message ? error.message : error}`, "err");
    }
    if (!IS_APP) {
      toast("Демо-режим: интерфейс без бэкенда. Запусти cargo run — заработает всё.", "");
    }
  }

  init();
})();
