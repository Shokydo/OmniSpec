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
  /* Своя тема («кастом»): пользователь задаёт три цвета, остальные поверхности
   * движок выводит сам — ровно как для пресетов. */
  const CUSTOM_THEME_DEFAULT = { bg: "#0b0d12", accent: "#7aa2f7", text: "#e6e9ef" };
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

  function applyTheme(name) {
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
    const valid = name === "custom" || Boolean(THEMES[name]);
    document.body.dataset.theme = valid ? name : "dark";
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
    const letter = !isImageIcon(meta.icon) && !(meta.icon && INSTANCE_ICONS.includes(meta.icon));
    box.classList.toggle("is-letter", letter);
    box.innerHTML = letter ? `<span class="tb-letter">${esc(html)}</span>` : html;
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

  /** Общее контекстное меню: html + обработчик по data-act. */
  function fillCtxMenu(x, y, html, handler) {
    const el = $("#ctx-menu");
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
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
      <div class="ctx-caption">${esc(meta.name)} · MC ${esc(meta.mc_version)}</div>
      <button class="ctx-item" data-act="play"><svg class="ic"><use href="#${running ? "i-stop" : "i-play"}"/></svg>${running ? "Остановить" : "Играть"}</button>
      <button class="ctx-item" data-act="dup"><svg class="ic"><use href="#i-copy"/></svg>Запустить дубликат…</button>
      <button class="ctx-item" data-act="settings"><svg class="ic"><use href="#i-sliders"/></svg>Настройки сборки</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-act="icon"><svg class="ic"><use href="#i-image"/></svg>Иконка из картинки…</button>
      ${isImageIcon(meta.icon) ? `<button class="ctx-item" data-act="icon-reset"><svg class="ic"><use href="#i-close"/></svg>Вернуть обычную иконку</button>` : ""}
      <button class="ctx-item" data-act="rename"><svg class="ic"><use href="#i-pencil"/></svg>Переименовать</button>
      ${categoriesOf().length ? `<div class="ctx-sep"></div>
      <div class="ctx-caption">Переместить в</div>
      ${categoriesOf().map((category) => `<button class="ctx-item" data-act="move:${esc(category.id)}">
        <svg class="ic"><use href="#${meta.category === category.id ? "i-check" : "i-folder"}"/></svg>${esc(category.name)}</button>`).join("")}
      <button class="ctx-item" data-act="move:" ${meta.category ? "" : "disabled"}><svg class="ic"><use href="#i-close"/></svg>Без категории</button>` : ""}
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
    if (action.startsWith("move:")) {
      const target = action.slice(5) || null;
      await moveInstanceToCategory(fresh.id, target);
      return;
    }
    if (action === "play") {
      state.selectedId = fresh.id;
      renderSidebar();
      if (state.running.has(fresh.id)) await stopGame();
      else play();
      return;
    }
    if (action === "dup") {
      openDupLaunch(fresh);
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
            <span class="acc-name">${esc(account.username)}</span>
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
    try {
      const plan = await api.launch(meta.id, accountUuid);
      addSession(meta.id, plan && plan.run_id, plan && plan.account);
      renderSidebar();
      updateStatus();
      const who = (plan && plan.account) ? ` · ${plan.account}` : "";
      toast(`Дубликат запущен${who}`, "ok");
      pushLog(meta.id, `[omnispec] дубликат запущен${who}`, "dim");
    } catch (err) {
      toast(`Не удалось запустить дубликат: ${err}`, "err");
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
    settings: { categories: [{ id: "cat-mods", name: "Моды", collapsed: false }, { id: "cat-perf", name: "Производительность", collapsed: false }], username: "Player", java_path: null, memory_mb: 4096, jvm_args: "-XX:+UseG1GC", game_args: "", auto_java: true, show_snapshots: false, verify_hashes: false, language: "ru", keep_console_open: false, enable_modrinth: true, hide_on_launch: false, last_instance: null, update_repo: "Shokydo/OmniSpec", update_enabled: true, update_token: null, update_prerelease: false, theme: "dark", click_fx: "wave" },
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
    launch: (id, accountUuid = null) => invoke("launch_instance", { instanceId: id, accountUuid }),
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
    modIcons: (instanceId) => invoke("mod_icons", { instanceId }),
    scanExternal: () => invoke("scan_external_launchers"),
    importExternal: (payload) => invoke("import_external", payload),
    exportInstance: (instanceId, path, format) => invoke("export_instance", { instanceId, path, format }),
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
    accountRename: (uuid, username) => invoke("account_rename", { uuid, username }),
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
    modrinthProject: (projectId) => invoke("modrinth_project", { projectId }),
    accountSkin: () => invoke("account_skin"),
    applySkin: (path, variant) => invoke("apply_skin", { path, variant }),
    saveSkinPng: (dataUrl, name) => invoke("save_skin_png", { dataUrl, name }),
    imageDataUrl: (path) => invoke("image_data_url", { path }),
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
    modrinthProject: async (projectId) => demoProject(projectId),
    accountSkin: async () => {
      const active = DEMO.accounts.find((a) => a.uuid === DEMO.active);
      return { licensed: Boolean(active && active.kind === "microsoft"), variant: "classic", data_url: null };
    },
    applySkin: async () => ({ ok: true }),
    saveSkinPng: async () => "demo/skins/preset.png",
    imageDataUrl: async () => null,
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
    search: async (q) => {
      const type = (q && q.projectType) || "mod";
      // демо-выдача никогда не смешивает типы: ресурспаки отдельно, шейдеры отдельно
      const base = demoSearch({ query: q && q.query, projectType: type }).hits;
      const SEEDS = {
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
    installModVersion: async () => ({ installed: ["mod.jar"], skipped: [] }),
    installModpack: async () => DEMO.instances[0],
    listDir: async (_id, sub) => {
      const tree = {
        "": [
          { name: "mods", is_dir: true, size: 0, path: "mods" },
          { name: "config", is_dir: true, size: 0, path: "config" },
          { name: "saves", is_dir: true, size: 0, path: "saves" },
          { name: "resourcepacks", is_dir: true, size: 0, path: "resourcepacks" },
          { name: "shaderpacks", is_dir: true, size: 0, path: "shaderpacks" },
          { name: "options.txt", is_dir: false, size: 2048, path: "options.txt" },
          { name: "logs", is_dir: true, size: 0, path: "logs" }
        ],
        resourcepacks: [
          { name: "Stay_True_1.21.zip", is_dir: false, size: 4_204_800, path: "resourcepacks/Stay_True_1.21.zip" },
          { name: "FreshAnimations_v1.9.zip", is_dir: false, size: 1_986_560, path: "resourcepacks/FreshAnimations_v1.9.zip" }
        ],
        shaderpacks: [
          { name: "ComplementaryReimagined_r5.3.zip", is_dir: false, size: 3_112_960, path: "shaderpacks/ComplementaryReimagined_r5.3.zip" },
          { name: "BSL_v8.2.04.zip", is_dir: false, size: 2_781_184, path: "shaderpacks/BSL_v8.2.04.zip" }
        ],
        saves: [
          { name: "Мир выживания", is_dir: true, size: 0, path: "saves/Мир выживания" },
          { name: "Тест редстоуна", is_dir: true, size: 0, path: "saves/Тест редстоуна" }
        ]
      };
      return tree[sub || ""] || [];
    },
    readFile: async () => "fov:0.0\nlang:ru_ru\nrenderDistance:12\nnarrator:0\n",
    deleteFile: async () => null,
    mods: async () => demoMods.map((m) => ({ ...m })),
    // Иконки модов в демо-режиме — те же картинки, что отдал бы Modrinth.
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
      { launcher: "modrinth", name: "Cobblemon Official", path: "C:\\Users\\Vanya\\AppData\\Roaming\\com.modrinth.theseus\\profiles\\cobblemon", mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.5", icon: null }
    ]),
    importExternal: async (payload) => {
      const meta = { ...DEMO.instances[0], id: "demo-" + Date.now(), name: payload.name || "Imported", mc_version: payload.mcVersion, loader: payload.loader ? { type: payload.loader, version: payload.loaderVersion } : { type: "vanilla" } };
      DEMO.instances.unshift(meta);
      return meta;
    },
    exportInstance: async (_id, path) => path,
    installZip: async (payload) => {
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
    sessions: new Map(),
    compact: false,
    logs: {},
    files: { path: "", entries: [], selected: null },
    mods: [],
    modIcons: {},
    mcver: null,
    modsView: "list",
    external: { list: null, loading: false, error: null },
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
    customTheme: { ...CUSTOM_THEME_DEFAULT },
    fx: "wave",
    shape: "soft",
    customWall: null,
    sound: { on: true, volume: 60 },
    home: {
      extOpen: false, external: null, extLoading: false, extSelected: new Set(),
      zipPath: "", versions: [], zipMc: "", zipLoader: "vanilla",
      zipLoaderVersion: "", zipLoaderVersions: [], url: "", busy: false, status: "", open: false
    },
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
  /** Сессии запуска: у сборки может работать несколько окон (дубликаты). */
  function addSession(instanceId, runId, account) {
    if (!state.sessions) state.sessions = new Map();
    if (!state.sessions.has(instanceId)) state.sessions.set(instanceId, new Map());
    const key = runId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    state.sessions.get(instanceId).set(key, { account: account || "" });
    state.running.add(instanceId);
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
          <div class="instance-dup" data-dup-of="${esc(item.id)}" title="Дубликат сборки${session.account ? ` · ${esc(session.account)}` : ""}">
            <span class="dup-branch"></span>
            <span class="dup-name">дубликат</span>
            ${session.account ? `<span class="dup-sep">·</span><span class="dup-account">${esc(session.account)}</span>` : ""}
          </div>`).join("")}</div>`
      : "";
    return `<div class="instance-wrap">
      <div class="instance ${item.id === state.selectedId ? "is-active" : ""}" data-id="${esc(item.id)}">
        <div class="instance-icon">${instanceIconHtml(item)}</div>
        <div class="instance-body">
          <div class="instance-name">${esc(item.name)}</div>
          <div class="instance-sub">MC ${esc(item.mc_version)} · ${esc(loaderLabel(item.loader))}${sessions.length > 1 ? ` · <span class="dup-count">${sessions.length} окна</span>` : ""}</div>
        </div>
        <span class="instance-time" title="Время игры">${esc(playtimeLabel(item.playtime_secs))}</span>
        ${running ? '<div class="instance-running" title="Запущена"></div>' : ""}
      </div>
      ${dupsHtml}
    </div>`;
  }


  function catGroupHtml({ id, name, items, open, running }) {
    return `<div class="cat ${open ? "is-open" : ""}" data-cat="${esc(id || "")}">
      <div class="cat-head ${running ? "cat-run" : ""}" data-cat-head="${esc(id || "")}">
        <svg class="ic cat-chev"><use href="#i-chev"/></svg>
        <span class="cat-name">${esc(name)}</span>
        <span class="cat-count">${items.length}</span>
      </div>
      <div class="cat-items">${items.map((item) => instanceRowHtml(item, { dups: Boolean(running) })).join("")}</div>
    </div>`;
  }

  function renderSidebar() {
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
        open: true
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
        selectInstance(el.dataset.id);
      });
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const meta = state.instances.find((item) => item.id === el.dataset.id);
        if (meta) openInstanceMenu(event.clientX, event.clientY, meta);
      });
      el.addEventListener("mousedown", (event) => beginInstanceDrag(event, el));
    });

    $$(".instance-dup", list).forEach((el) => {
      el.addEventListener("click", () => {
        if (el.dataset.dupOf) selectInstance(el.dataset.dupOf);
      });
    });

    // папка-категория: клик по заголовку сворачивает, drag переносит сборку
    $$(".cat", list).forEach((group) => {
      const id = group.dataset.cat;
      const head = group.querySelector(".cat-head");
      if (!head || id === "__running") return;
      if (id) head.addEventListener("click", () => toggleCategory(id));
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
      ghost.innerHTML = `<span class="drag-ghost-name">${esc(meta ? meta.name : "сборка")}</span>`;
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
    dragClickGuard = true;
    if (drag.target === undefined) return;
    await moveInstanceToCategory(drag.id, drag.target === "__none" ? null : drag.target);
  }

  async function toggleCategory(id) {
    const categories = categoriesOf().map((category) =>
      category.id === id ? { ...category, collapsed: !category.collapsed } : category);
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

  /** ПКМ по пустому месту списка сборок. */
  function openListMenu(x, y) {
    fillCtxMenu(x, y, `
      <div class="ctx-caption">Сборки</div>
      <button class="ctx-item" data-act="create"><svg class="ic"><use href="#i-plus"/></svg>Создать сборку</button>
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
      <div class="ctx-caption">${esc(category.name)}</div>
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
        if (!confirm(`Удалить категорию «${category.name}»? Сборки останутся в списке.`)) return;
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
  async function importFromExplorer() {
    const path = await api.pickFile("Загрузить сборку", ["mrpack", "zip"]).catch(() => null);
    if (!path) return;
    await installMrpackPath(path);
  }

  function selectInstance(id) {
    closeAccountPopover();
    state.selectedId = id;
    const meta = selected();
    renderSidebar();
    $("#tb-name").textContent = meta ? meta.name : "OmniSpec";
    $("#tb-version").textContent = meta ? `MC ${meta.mc_version} · ${loaderLabel(meta.loader)}` : "—";
    const pill = $("#loader-pill");
    pill.hidden = !meta;
    pill.textContent = meta ? loaderLabel(meta.loader) : "";
    const menu = $("#btn-build-menu");
    if (menu) menu.hidden = !meta;
    renderBuildIcon(meta);
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
    const toolbar = document.querySelector(".toolbar");
    if (toolbar) toolbar.classList.toggle("is-idle", !meta);
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
  /** Какие вкладки показывать: без сборки — только лента, со сборкой — всё остальное. */
  function applyTabs(meta) {
    $$(".tab").forEach((tab) => {
      const id = tab.dataset.tab;
      tab.hidden = meta ? id === "discover" : id !== "discover";
    });
  }

  function renderTab() {
    const body = $("#tab-body");
    const meta = selected();
    applyTabs(meta);
    // без сборки показываем ленту готовых сборок, со сборкой — её вкладки
    if (!meta) state.tab = "discover";
    else if (state.tab === "discover") state.tab = "console";
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
      case "shaders": return renderAssetsList("shaderpacks", "Шейдеры", "shader");
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
  /** Иконка мода: картинка с Modrinth, иначе нейтральный значок. */
  function modIconHtml(mod) {
    const url = state.modIcons[mod.name];
    if (url) return `<span class="mod-icon"><img src="${esc(url)}" alt="" loading="lazy"></span>`;
    return `<span class="mod-icon"><svg class="ic"><use href="#i-mod"/></svg></span>`;
  }

  async function renderMods() {
    const meta = selected();
    const mods = await api.mods(meta.id).catch(() => []);
    state.mods = mods;
    $("#badge-mods").hidden = !mods.length;
    $("#badge-mods").textContent = String(mods.length);
    const enabled = mods.filter((mod) => mod.enabled).length;
    const grid = state.modsView === "grid";

    // иконки подтягиваем один раз и перерисовываем, когда придут
    if (!Object.keys(state.modIcons).length) {
      api.modIcons(meta.id).then((map) => {
        if (!map || !Object.keys(map).length) return;
        state.modIcons = map;
        if (state.tab === "mods" && state.selectedId === meta.id) renderMods();
      }).catch(() => {});
    }

    const body = grid
      ? `<div class="mods-grid">${mods.map((mod) => `
          <div class="mod-card ${mod.enabled ? "" : "is-off"}">
            ${modIconHtml(mod)}
            <div class="mod-card-name" title="${esc(mod.name)}">${esc(mod.name)}</div>
            <div class="mod-card-sub">${humanSize(mod.size)}</div>
            <div class="mod-card-actions">
              <button class="switch ${mod.enabled ? "on" : ""}" data-toggle="${esc(mod.name)}"></button>
              <button class="icon-btn" data-delete="${esc(mod.name)}" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
            </div>
          </div>`).join("")}</div>`
      : mods.map((mod) => `
          <div class="item-row">
            ${modIconHtml(mod)}
            <div class="item-main">
              <div class="item-title">${esc(mod.name)}</div>
              <div class="item-sub">${humanSize(mod.size)} · ${mod.enabled ? "включён" : "выключен"}</div>
            </div>
            <button class="switch ${mod.enabled ? "on" : ""}" data-toggle="${esc(mod.name)}" title="Включить/выключить"></button>
            <button class="icon-btn" data-delete="${esc(mod.name)}" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
          </div>`).join("");

    $("#tab-body").innerHTML = `
      <div class="list-wrap">
        <div class="panel">
          <div class="panel-head">
            <strong>Моды сборки</strong>
            <span class="badge">${enabled} вкл. / ${mods.length}</span>
            <div class="spacer"></div>
            <div class="mr-view" title="Вид">
              <button class="${grid ? "" : "is-active"}" data-mods-view="list"><svg class="ic"><use href="#i-list"/></svg>Список</button>
              <button class="${grid ? "is-active" : ""}" data-mods-view="grid"><svg class="ic"><use href="#i-grid"/></svg>Плитка</button>
            </div>
            <button class="btn btn-small" id="mods-open">Открыть папку</button>
            <button class="btn btn-small btn-primary" id="mods-add">Добавить с Modrinth</button>
          </div>
          ${mods.length ? body : `<div class="item-row"><div class="item-main muted">Модов нет</div></div>`}
        </div>
      </div>`;

    $$("#tab-body [data-mods-view]").forEach((btn) => btn.addEventListener("click", () => {
      state.modsView = btn.dataset.modsView;
      renderMods();
    }));
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
    // Внутри сборки модпаки не нужны — они ставятся только при создании сборки.
    const types = [["mod", "Моды"], ["resourcepack", "Ресурспаки"], ["shader", "Шейдеры"]];
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
          ${cfg.type === "mod" ? `<div class="field">
            <label>Загрузчик</label>
            <select class="select" id="mr-loader">
              <option value="">любой</option>
              ${Object.entries(LOADER_NAMES).map(([value, label]) => `<option value="${value}" ${cfg.loader === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>` : ""}
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
    const loaderSelect = $("#mr-loader");
    if (loaderSelect) loaderSelect.addEventListener("change", (event) => { state.modrinth.loader = event.target.value; runSearch(); });
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
    return `<button class="home-card ${meta.id === state.selectedId ? "is-active" : ""}" data-home-id="${esc(meta.id)}">
      <span class="home-card-icon ${letter ? "is-letter" : ""}">${letter ? `<span class="card-letter">${esc(icon)}</span>` : icon}</span>
      <span class="home-card-body">
        <span class="home-card-name">${esc(meta.name)}</span>
        <span class="home-card-sub">MC ${esc(meta.mc_version)} · ${esc(loaderLabel(meta.loader))}</span>
      </span>
      <span class="home-card-time" title="Время игры">${esc(playtimeLabel(meta.playtime_secs))}</span>
      ${running ? '<span class="home-card-dot" title="Запущена"></span>' : ""}
    </button>`;
  }

  /** Панель импорта на главной: файл .mrpack/.zip, лаунчеры (с галочками), ссылка. */
  function homeImportHtml() {
    const cfg = state.home;
    const parts = [];
    parts.push(`<div class="imp-row">
      <button class="btn" id="imp-file"><svg class="ic"><use href="#i-download"/></svg>Файл .mrpack / .zip…</button>
      <button class="btn ${cfg.extOpen ? "is-pressed" : ""}" id="imp-ext"><svg class="ic"><use href="#i-grid"/></svg>Из лаунчера</button>
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
              ${cfg.zipLoaderVersions.length ? cfg.zipLoaderVersions.map((option) => `<option value="${esc(option.version)}" ${option.version === cfg.zipLoaderVersion ? "selected" : ""}>${esc(option.version)}</option>`).join("") : `<option value="">загружаем…</option>`}
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
      const launchers = { prism: "Prism", multimc: "MultiMC", modrinth: "Modrinth App" };
      parts.push(`<div class="imp-block">
        <div class="imp-block-head">
          <strong>Найдено сборок: ${list.length}</strong>
          <div class="spacer"></div>
          <button class="btn btn-small" id="imp-ext-all">Выбрать все</button>
          <button class="btn btn-small" id="imp-ext-rescan">Обновить</button>
          <button class="btn btn-small" id="imp-ext-close">Свернуть</button>
        </div>
        ${cfg.extLoading
          ? `<div class="add-empty">Смотрим Prism Launcher, MultiMC и Modrinth App…</div>`
          : list.length
            ? `<div class="imp-list">${list.map((item) => `
                <label class="imp-item ${picked.has(item.path) ? "is-picked" : ""}">
                  <input type="checkbox" class="imp-check" data-ext="${esc(item.path)}" ${picked.has(item.path) ? "checked" : ""}>
                  <span class="ext-icon">${item.icon ? `<img src="file://${esc(item.icon)}" alt="">` : `<svg class="ic"><use href="#i-grid"/></svg>`}</span>
                  <span class="ext-main">
                    <span class="ext-name">${esc(item.name)}</span>
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
    return `<section class="home-import ${cfg.busy ? "is-busy" : ""} ${open ? "is-open" : ""}">
      <button class="imp-head imp-toggle" id="imp-toggle" aria-expanded="${open ? "true" : "false"}">
        <svg class="ic imp-chev"><use href="#i-chev"/></svg>
        <span class="home-title">Добавить сборку</span>
        <span class="home-sub">${esc(cfg.status || "файл модпака, другой лаунчер или ссылка")}</span>
      </button>
      <div class="imp-body">${parts.join("")}</div>
    </section>`;
  }

  function renderDiscover() {
    const cfg = state.discover;
    const view = cfg.view || "grid";
    // «Недавнее» — сборки по времени последнего запуска
    const instances = (state.instances || []).slice().sort((a, b) => (b.last_played || b.created || 0) - (a.last_played || a.created || 0));
    $("#tab-body").innerHTML = `
      <div class="home">
        <div class="home-head">
          <div class="home-titles">
            <div class="home-title">Сборки</div>
            <div class="home-sub">${instances.length ? `${instances.length} ${instances.length === 1 ? "сборка" : instances.length < 5 ? "сборки" : "сборок"} — своя папка, моды, миры` : "Пока пусто: создай сборку или добавь готовую"}</div>
          </div>
          <div class="home-actions">
            <button class="btn btn-primary" id="home-create"><svg class="ic"><use href="#i-plus"/></svg>Создать сборку</button>
          </div>
        </div>
        <div class="home-scroll" id="home-scroll">
          ${instances.length ? `<div class="home-section-title">Недавнее</div><div class="home-grid">${instances.map(homeInstanceHtml).join("")}</div>` : ""}
          ${homeImportHtml()}
          <div class="home-feed-head">
            <div class="home-title">Готовые сборки</div>
            <div class="home-tools">
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
        </div>
      </div>`;

    $$("#tab-body [data-home-id]").forEach((card) => card.addEventListener("click", () => {
      selectInstance(card.dataset.homeId);
      state.tab = "console";
      renderTab();
    }));
    $("#home-create").addEventListener("click", openCreate);
    $("#dv-query").addEventListener("keydown", (event) => { if (event.key === "Enter") dvReset(); });
    $$("#tab-body [data-dv-view]").forEach((btn) => btn.addEventListener("click", () => {
      state.discover.view = btn.dataset.dvView;
      renderDiscover();
    }));
    bindHomeImport();
    const retry = $("#dv-retry");
    if (retry) retry.addEventListener("click", () => dvReset());
    bindResultEvents();
    dvWatch();
    if (!cfg.tried && !cfg.loading && !cfg.error) dvReset();
  }

  /* ---------- импорт на главной ---------- */
  function bindHomeImport() {
    const cfg = state.home;
    const toggle = $("#imp-toggle");
    if (toggle) toggle.addEventListener("click", () => {
      cfg.open = !cfg.open;
      renderDiscover();
    });
    const file = $("#imp-file");
    if (file) file.addEventListener("click", async () => {
      const picked = await api.pickFile("Модпак .mrpack или .zip", ["mrpack", "zip"]).catch(() => null);
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
    });

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
        const meta = await api.installModpack(url);
        cfg.url = "";
        cfg.status = "";
        await refreshInstances();
        selectInstance(meta.id);
        state.tab = "console";
        renderTab();
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
        : await api.installModpack(path);
      cfg.zipPath = "";
      cfg.status = "";
      await refreshInstances();
      selectInstance(meta.id);
      state.tab = "console";
      renderTab();
      toast(`Сборка «${meta.name}» добавлена`, "ok");
    } catch (err) {
      toast(`Не удалось импортировать: ${err}`, "err");
      cfg.status = "";
    } finally {
      cfg.busy = false;
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
        last = await api.importExternal({
          path: item.path,
          name: item.name,
          mcVersion: item.mc_version,
          loader: item.loader === "vanilla" ? null : item.loader,
          loaderVersion: item.loader_version || null,
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
      selectInstance(last.id);
      state.tab = "console";
      renderTab();
      return;
    }
    if (state.tab === "discover") renderDiscover();
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
      // у ресурспаков и шейдеров нет тега загрузчика — иначе Modrinth
      // возвращал моды с категорией fabric
      loader: cfg.type === "mod" ? (cfg.loader || (meta && meta.loader ? meta.loader.type : null)) : null,
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
    });
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
    return `<div class="card" data-project="${esc(hit.project_id)}" data-kind="${isPack ? "pack" : "mod"}" data-slug="${esc(hit.slug || hit.project_id)}" data-title="${esc(hit.title)}">
      <div class="card-icon">${hit.icon_url ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy">` : `<span class="card-letter">${esc(String(hit.title || "?").trim().charAt(0).toUpperCase())}</span>`}</div>
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

  async function openProjectModal(projectId, kind, slug, title) {
    const modal = $("#modal-project");
    if (!modal) return;
    const isPack = kind === "pack";
    $("#proj-title").textContent = title || "Проект";
    const body = $("#proj-body");
    body.innerHTML = `<div class="empty-state">Загружаем сведения с Modrinth…</div>`;
    modal.hidden = false;

    let project = null;
    try {
      project = await api.modrinthProject(projectId);
    } catch (err) {
      body.innerHTML = `<div class="proj-empty" style="color:var(--red)">Не удалось получить сведения: ${esc(String(err))}</div>`;
    }

    const projectType = (project && project.project_type) || (isPack ? "modpack" : "mod");
    const slugOrId = (project && (project.slug || project.id)) || slug || projectId;
    const siteUrl = `https://modrinth.com/${projectType === "modpack" ? "modpack" : projectType}/${slugOrId}`;

    if (project) {
      const shots = (project.gallery || [])
        .map((shot) => (typeof shot === "string" ? shot : shot && shot.url))
        .filter(Boolean);
      const tags = (project.categories || []).slice(0, 8);
      const loads = (project.downloads || 0).toLocaleString("ru-RU");
      const desc = plainDescription(project.body) || project.description || "";
      body.innerHTML = `
        <div class="proj-top">
          <div class="proj-icon">${project.icon_url
            ? `<img src="${esc(project.icon_url)}" alt="" />`
            : `<span class="card-letter">${esc(String(project.title || title || "?").charAt(0).toUpperCase())}</span>`}</div>
          <div class="proj-head">
            <div class="proj-title">${esc(project.title || title || "")}</div>
            <div class="proj-sub">${esc(project.description || "")}</div>
            <div class="proj-sub">${loads} загрузок${project.license && project.license.name ? ` · ${esc(project.license.name)}` : ""}</div>
          </div>
        </div>
        ${tags.length ? `<div class="proj-tags">${tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</div>` : ""}
        ${shots.length ? `<div class="proj-gallery">${shots.slice(0, 6).map((url) => `
          <div class="proj-shot"><img src="${esc(url)}" alt="" loading="lazy" /></div>`).join("")}</div>` : ""}
        ${desc ? `<div class="proj-desc">${esc(desc)}</div>` : `<div class="proj-empty">Описание пустое — смотри страницу проекта.</div>`}`;
    }

    $("#proj-site").onclick = () => api.openUrl(siteUrl).catch((error) => toast(String(error), "err"));
    $("#proj-versions").onclick = () => {
      modal.hidden = true;
      openVersions(projectId, isPack ? "pack" : "mod", title || (project && project.title) || "Версии");
    };
    const installBtn = $("#proj-install");
    installBtn.disabled = !project;
    installBtn.onclick = () => {
      modal.hidden = true;
      installFromModrinth(projectId, isPack ? "pack" : "mod");
    };
  }

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

  /** Скин аккаунта: у лицензии голова по UUID, у офлайна — по нику. */
  function skinUrl(account) {
    if (!account) return "";
    const key = account.kind === "microsoft" ? (account.uuid || account.username) : account.username;
    if (!key) return "";
    return `https://mc-heads.net/avatar/${encodeURIComponent(key)}/64`;
  }

  /** Аватар: буква + скин поверх. Если скин не загрузился — остаётся буква. */
  function avatarHtml(account, extra = "") {
    const letter = String((account && account.username) || "?").charAt(0).toUpperCase();
    const url = skinUrl(account);
    return `<span class="acc-avatar ${extra}">` +
      `<span class="acc-letter">${esc(letter)}</span>` +
      (url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
      `</span>`;
  }

  function accountRowHtml(account, activeId) {
    const active = account.uuid === activeId;
    return `
      <div class="acc-row ${active ? "is-active" : ""}" data-uuid="${esc(account.uuid)}">
        ${avatarHtml(account)}
        <span class="acc-main">
          <span class="acc-name">${esc(account.username)}</span>
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
      name.textContent = "Нет аккаунта";
      kind.textContent = "добавить";
      return;
    }
    avatar.outerHTML = avatarHtml(account).replace('class="acc-avatar', 'id="account-chip-avatar" class="acc-avatar has-skin');
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
            <div class="pop-active-name">${esc(active.username)}</div>
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
      <div class="ctx-caption">${esc(account.username)} · ${esc(kindLabel(account.kind))}</div>
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
      if (!confirm(`Удалить аккаунт «${account.username}»?`)) return;
      try {
        state.accounts = await api.accountRemove(account.uuid);
        renderAccounts();
        toast("Аккаунт удалён", "ok");
      } catch (err) { toast(String(err), "err"); }
    }
  }

  /** Обновляет чип, поповер, карточку в настройках и экран профиля. */
  function renderAccounts() {
    renderAccountChip();
    const pop = $("#account-pop");
    if (pop && !pop.hidden) renderAccountPopover();
    renderPrefsAccountCard();
    if (prefsCategory === "profile" && !$("#modal-prefs").hidden) renderPrefs();
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
        <span class="acc-name">${esc(account.username)}</span>
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
              <span class="acc-name">${esc(account.username)}</span>
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
    { id: "profile", label: "Профиль" },
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
    skinState();
    if (state.skin.licensed === undefined) refreshAccountSkin().then(() => {
      if (!$("#modal-prefs").hidden && prefsCategory === "profile") renderPrefs();
    });
    modal.hidden = false;
    renderPrefsAccountCard();
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
    renderPrefsAccountCard();
    if (prefsCategory === "profile") body.innerHTML = prefsProfile();
    if (prefsCategory === "look") body.innerHTML = prefsLook(settings);
    if (prefsCategory === "wall") body.innerHTML = prefsWall(settings);
    if (prefsCategory === "fx") body.innerHTML = prefsFx();
    if (prefsCategory === "game") body.innerHTML = prefsGame(settings);
    if (prefsCategory === "net") body.innerHTML = prefsNet(settings);
    if (prefsCategory === "updates") body.innerHTML = prefsUpdates(settings);
    if (prefsCategory === "sound") body.innerHTML = prefsSound(settings);
    bindPrefs();
    if (prefsCategory === "profile") {
      bindPrefsProfile();
      bindSkin();
    }
  }

  /** Профиль: слева список аккаунтов, справа — активный. */
  function prefsProfile() {
    const accounts = (state.accounts && state.accounts.accounts) || [];
    const activeId = (state.accounts && state.accounts.active) || (accounts[0] && accounts[0].uuid);
    const active = accounts.find((item) => item.uuid === activeId) || null;
    return `
      <div class="profile-grid">
        <section class="prefs-section">
          <div class="prefs-label-row">
            <span class="prefs-label">Аккаунты</span>
            <div class="spacer"></div>
            <button class="btn btn-small" data-acc="add-offline">Пиратка</button>
            <button class="btn btn-small btn-primary" data-acc="add-ms">Лицензия</button>
          </div>
          <div class="profile-list">
            ${accounts.map((account) => `
              <div class="profile-row ${account.uuid === activeId ? "is-active" : ""}" data-uuid="${esc(account.uuid)}">
                ${avatarHtml(account)}
                <div class="acc-main">
                  <div class="acc-name">${esc(account.username)}</div>
                  <div class="acc-sub">${esc(kindLabel(account.kind))}</div>
                </div>
                ${account.uuid === activeId
                  ? '<span class="tag green">активный</span>'
                  : '<button class="btn btn-small" data-acc="pick">Выбрать</button>'}
                ${account.kind === "microsoft" ? "" : `<button class="icon-btn" data-acc="rename-one" title="Изменить ник"><svg class="ic"><use href="#i-pencil"/></svg></button>`}
                <button class="icon-btn" data-acc="remove-one" title="Удалить"><svg class="ic"><use href="#i-trash"/></svg></button>
              </div>`).join("")}
            <button class="profile-row profile-row-add" data-acc="add-any">
              <span class="acc-avatar"><svg class="ic"><use href="#i-plus"/></svg></span>
              <span class="acc-main">
                <span class="acc-name">Добавить аккаунт</span>
                <span class="acc-sub">лицензия или офлайн-ник</span>
              </span>
            </button>
          </div>
        </section>

        <section class="prefs-section profile-active">
          <div class="prefs-label">Аккаунт</div>
          ${active ? `
            <div class="profile-card">
              ${avatarHtml(active, "lg")}
              <div class="profile-card-main">
                <div class="profile-card-name">${esc(active.username)}</div>
                <div class="profile-card-sub">${esc(kindLabel(active.kind))}</div>
              </div>
              <div class="profile-card-actions">
                ${active.kind === "microsoft" ? "" : `<button class="btn btn-small" data-acc="rename">Изменить ник</button>`}
                <button class="btn btn-small" data-acc="remove">Выйти</button>
              </div>
            </div>
            <div class="muted profile-note">${active.kind === "microsoft"
              ? "Лицензия: скин и ник приходят с серверов Mojang."
              : "Офлайн-аккаунт: подходит для серверов без проверки лицензии."}</div>`
            : `<div class="profile-card is-empty"><span class="muted">Аккаунта пока нет</span></div>`}
        </section>
      </div>
      ${skinSectionHtml()}`;
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
        <div class="prefs-label">Своя тема</div>
        ${colorRow({ id: "theme-bg", label: "Фон", value: own.bg })}
        ${colorRow({ id: "theme-accent", label: "Акцент", value: own.accent })}
        ${colorRow({ id: "theme-text", label: "Текст", value: own.text })}
        <div class="settings-note">Остальные поверхности, рамки и приглушённый текст выводятся из этих трёх цветов.</div>
      </div>` : ""}
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
      renderPrefs();
    }));
    // свои цвета: ползунки цвета + пипетка
    const bindColor = (key, id) => {
      const input = $(`#${id}`);
      if (!input) return;
      const apply = (value) => {
        state.customTheme[key] = value;
        input.value = value;
        const hex = $(`#${id}-hex`);
        if (hex) hex.textContent = value;
        applyTheme("custom");
      };
      input.addEventListener("input", () => apply(input.value));
      const pick = $(`#${id}-pick`);
      if (pick) pick.addEventListener("click", async () => {
        if (!window.EyeDropper) { input.click(); return; }
        try {
          const result = await new window.EyeDropper().open();
          apply(String(result.sRGBHex || "").toLowerCase());
        } catch (error) { /* отменили выбор */ }
      });
    };
    bindColor("bg", "theme-bg");
    bindColor("accent", "theme-accent");
    bindColor("text", "theme-text");
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

    $$("#prefs-body [data-wall]").forEach((chip) => chip.addEventListener("click", async () => {
      const picked = chip.dataset.wall || null;
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
      theme_bg: state.customTheme.bg,
      theme_accent: state.customTheme.accent,
      theme_text: state.customTheme.text,
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
    try { await api.saveSettings(next); } catch (error) { /* не критично */ }
  }

  /** История обоев: свежие впереди, без повторов, не длиннее шести. */
  function rememberWallpaper(recent, current) {
    const list = Array.isArray(recent) ? recent.slice() : [];
    if (!current) return list.filter((id) => id !== current);
    return [current, ...list.filter((id) => id !== current)].slice(0, 6);
  }

  /* ==================== СКИН: ПРЕСЕТЫ И РЕНДЕР ==================== */

  /** Пресеты: цвет кожи, волос, одежды + акцент. Из них собирается PNG 64×64. */
  const SKIN_PRESETS = [
    { id: "classic", name: "Стив", skin: "#c49a76", hair: "#3b2a1c", shirt: "#2f8faf", pants: "#3a3f8f", shoe: "#3b3b44", accent: "#8fd6e8" },
    { id: "shadow", name: "Тень", skin: "#7d6b5d", hair: "#181a1f", shirt: "#22252c", pants: "#191b21", shoe: "#111318", accent: "#79c0ff" },
    { id: "neon", name: "Неон", skin: "#d8d3c8", hair: "#2a1f3d", shirt: "#1a1030", pants: "#101a2e", shoe: "#0b0d14", accent: "#7ee787" },
    { id: "forest", name: "Лес", skin: "#c9a077", hair: "#2f2418", shirt: "#2f5d3a", pants: "#3b4a2f", shoe: "#2a2a22", accent: "#9ad36b" },
    { id: "sand", name: "Пустыня", skin: "#d9b489", hair: "#5b4227", shirt: "#c8a25c", pants: "#8d6b3f", shoe: "#4a3a26", accent: "#f2d98c" },
    { id: "ice", name: "Лёд", skin: "#e0d6cc", hair: "#9ec8e0", shirt: "#4f7fa8", pants: "#2f4a63", shoe: "#24303d", accent: "#bfe6ff" },
    { id: "ember", name: "Уголь", skin: "#bf9670", hair: "#241a14", shirt: "#8f2f2f", pants: "#3a2a26", shoe: "#22201e", accent: "#ff7b72" },
    { id: "mono", name: "Монохром", skin: "#cfcfcf", hair: "#4a4a4a", shirt: "#e8e8e8", pants: "#6a6a6a", shoe: "#3a3a3a", accent: "#ffffff" }
  ];

  /** UV-разметка частей скина 64×64 (как в ванильном формате). */
  function skinBoxes(variant) {
    const aw = variant === "slim" ? 3 : 4;
    return [
      {
        name: "head", x0: -4, x1: 4, y0: 24, y1: 32, z0: -4, z1: 4,
        base: { front: [8, 8, 8, 8], back: [24, 8, 8, 8], left: [16, 8, 8, 8], right: [0, 8, 8, 8], top: [8, 0, 8, 8], bottom: [16, 0, 8, 8] },
        over: { front: [40, 8, 8, 8], back: [56, 8, 8, 8], left: [48, 8, 8, 8], right: [32, 8, 8, 8], top: [40, 0, 8, 8], bottom: [48, 0, 8, 8] }
      },
      {
        name: "body", x0: -4, x1: 4, y0: 12, y1: 24, z0: -2, z1: 2,
        base: { front: [20, 20, 8, 12], back: [32, 20, 8, 12], left: [28, 20, 4, 12], right: [16, 20, 4, 12], top: [20, 16, 8, 4], bottom: [28, 16, 8, 4] },
        over: { front: [20, 36, 8, 12], back: [32, 36, 8, 12], left: [28, 36, 4, 12], right: [16, 36, 4, 12], top: [20, 32, 8, 4], bottom: [28, 32, 8, 4] }
      },
      {
        name: "armR", x0: -4 - aw, x1: -4, y0: 12, y1: 24, z0: -2, z1: 2,
        base: { front: [44, 20, aw, 12], back: [52, 20, aw, 12], left: [48, 20, aw, 12], right: [40, 20, aw, 12], top: [44, 16, aw, 4], bottom: [48, 16, aw, 4] },
        over: { front: [44, 36, aw, 12], back: [52, 36, aw, 12], left: [48, 36, aw, 12], right: [40, 36, aw, 12], top: [44, 32, aw, 4], bottom: [48, 32, aw, 4] }
      },
      {
        name: "armL", x0: 4, x1: 4 + aw, y0: 12, y1: 24, z0: -2, z1: 2,
        base: { front: [36, 52, aw, 12], back: [44, 52, aw, 12], left: [40, 52, aw, 12], right: [32, 52, aw, 12], top: [36, 48, aw, 4], bottom: [40, 48, aw, 4] },
        over: { front: [52, 52, aw, 12], back: [60, 52, aw, 12], left: [56, 52, aw, 12], right: [48, 52, aw, 12], top: [52, 48, aw, 4], bottom: [56, 48, aw, 4] }
      },
      {
        name: "legR", x0: -4, x1: 0, y0: 0, y1: 12, z0: -2, z1: 2,
        base: { front: [4, 20, 4, 12], back: [12, 20, 4, 12], left: [8, 20, 4, 12], right: [0, 20, 4, 12], top: [4, 16, 4, 4], bottom: [8, 16, 4, 4] },
        over: { front: [4, 36, 4, 12], back: [12, 36, 4, 12], left: [8, 36, 4, 12], right: [0, 36, 4, 12], top: [4, 32, 4, 4], bottom: [8, 32, 4, 4] }
      },
      {
        name: "legL", x0: 0, x1: 4, y0: 0, y1: 12, z0: -2, z1: 2,
        base: { front: [20, 52, 4, 12], back: [28, 52, 4, 12], left: [24, 52, 4, 12], right: [16, 52, 4, 12], top: [20, 48, 4, 4], bottom: [24, 48, 4, 4] },
        over: { front: [4, 52, 4, 12], back: [12, 52, 4, 12], left: [8, 52, 4, 12], right: [0, 52, 4, 12], top: [4, 48, 4, 4], bottom: [8, 48, 4, 4] }
      }
    ];
  }

  /** Затемнение/осветление цвета для объёма. */
  function shadeColor(hex, amount) {
    const value = parseInt(String(hex).replace("#", ""), 16);
    const mix = (channel) => {
      const next = amount < 0
        ? channel * (1 + amount)
        : channel + (255 - channel) * amount;
      return Math.max(0, Math.min(255, Math.round(next)));
    };
    const r = mix((value >> 16) & 255);
    const g = mix((value >> 8) & 255);
    const b = mix(value & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }

  /** Текстура 64×64 из пресета: грани с разным светом + второй слой. */
  function buildSkinTexture(preset) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const fill = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    const faces = (uv, front, side, back, top, bottom) => {
      fill(uv.front[0], uv.front[1], uv.front[2], uv.front[3], front);
      fill(uv.left[0], uv.left[1], uv.left[2], uv.left[3], side);
      fill(uv.right[0], uv.right[1], uv.right[2], uv.right[3], shadeColor(side, -0.08));
      fill(uv.back[0], uv.back[1], uv.back[2], uv.back[3], back);
      fill(uv.top[0], uv.top[1], uv.top[2], uv.top[3], top);
      fill(uv.bottom[0], uv.bottom[1], uv.bottom[2], uv.bottom[3], bottom);
    };

    const boxes = skinBoxes("classic");
    const byName = {};
    boxes.forEach((box) => { byName[box.name] = box; });

    // ── база: голова ──
    const head = byName.head;
    faces(head.base, preset.skin, shadeColor(preset.skin, -0.16), preset.hair, preset.hair, shadeColor(preset.skin, -0.34));
    fill(8, 8, 8, 2, preset.hair);                       // чёлка
    fill(8, 10, 1, 2, preset.hair);
    fill(15, 10, 1, 2, preset.hair);
    fill(9, 12, 1, 1, "#1b1b1f");                        // глаза
    fill(14, 12, 1, 1, "#1b1b1f");
    fill(9, 11, 1, 1, "#ffffff");                        // блики
    fill(14, 11, 1, 1, "#ffffff");
    fill(11, 14, 2, 1, shadeColor(preset.skin, -0.34));  // рот

    // ── база: тело ──
    const body = byName.body;
    faces(body.base,
      preset.shirt,
      shadeColor(preset.shirt, -0.14),
      shadeColor(preset.shirt, -0.24),
      shadeColor(preset.shirt, 0.10),
      shadeColor(preset.shirt, -0.34));
    fill(20, 20, 8, 1, preset.accent);                   // воротник
    fill(20, 21, 1, 8, preset.accent);                   // молния
    fill(27, 21, 1, 8, shadeColor(preset.accent, -0.2));
    fill(20, 30, 8, 2, preset.pants);                    // ремень
    fill(23, 30, 2, 2, preset.accent);                   // пряжка

    // ── база: руки ──
    ["armR", "armL"].forEach((name) => {
      faces(byName[name].base,
        preset.shirt,
        shadeColor(preset.shirt, -0.14),
        shadeColor(preset.shirt, -0.24),
        shadeColor(preset.shirt, 0.10),
        shadeColor(preset.shirt, -0.3));
    });
    // кисти: нижние 3 пикселя рукавов
    [[44, 29], [40, 29], [48, 29], [52, 29]].forEach(([x, y]) => fill(x, y, 4, 3, preset.skin));
    [[36, 61], [32, 61], [40, 61], [44, 61]].forEach(([x, y]) => fill(x, y, 4, 3, preset.skin));
    fill(48, 16, 4, 4, preset.skin);
    fill(40, 48, 4, 4, preset.skin);

    // ── база: ноги ──
    ["legR", "legL"].forEach((name) => {
      faces(byName[name].base,
        preset.pants,
        shadeColor(preset.pants, -0.14),
        shadeColor(preset.pants, -0.24),
        shadeColor(preset.pants, 0.10),
        preset.shoe);
    });
    // обувь: нижние 4 пикселя
    fill(4, 28, 4, 4, preset.shoe);
    fill(0, 28, 4, 4, shadeColor(preset.shoe, -0.14));
    fill(8, 28, 4, 4, shadeColor(preset.shoe, -0.2));
    fill(12, 28, 4, 4, shadeColor(preset.shoe, -0.24));
    fill(20, 60, 4, 4, preset.shoe);
    fill(16, 60, 4, 4, shadeColor(preset.shoe, -0.14));
    fill(24, 60, 4, 4, shadeColor(preset.shoe, -0.2));
    fill(28, 60, 4, 4, shadeColor(preset.shoe, -0.24));

    // ── второй слой: кепка ──
    fill(40, 0, 8, 8, preset.accent);
    fill(32, 8, 8, 8, shadeColor(preset.accent, -0.14));
    fill(48, 8, 8, 8, shadeColor(preset.accent, -0.22));
    fill(56, 8, 8, 8, shadeColor(preset.accent, -0.3));
    fill(40, 8, 8, 2, shadeColor(preset.accent, 0.08));  // козырёк

    // ── второй слой: жилет по бокам ──
    fill(20, 36, 2, 10, preset.accent);
    fill(26, 36, 2, 10, preset.accent);
    fill(32, 36, 2, 10, shadeColor(preset.accent, -0.24));
    fill(38, 36, 2, 10, shadeColor(preset.accent, -0.24));
    fill(16, 36, 4, 10, shadeColor(preset.accent, -0.14));
    fill(28, 36, 4, 10, shadeColor(preset.accent, -0.2));
    return canvas;
  }

  /** Трёхмерный предпросмотр: обрезка повёрнута на угол, второй слой сверху. */
  function drawSkinPreview(canvas, texture, variant, angleDeg) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!texture) return;

    const th = (angleDeg * Math.PI) / 180;
    const pitch = 0.14;
    const cosT = Math.cos(th);
    const sinT = Math.sin(th);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    // точка → экранные координаты (ось Y вверх, камера смотрит вдоль +Z)
    const project = (x, y, z) => {
      const x1 = x * cosT + z * sinT;
      const z1 = -x * sinT + z * cosT;
      const y2 = y * cosP - z1 * sinP;
      const z2 = y * sinP + z1 * cosP;
      return [x1, -y2, z2];
    };

    const faces = [];
    const pushFace = (box, uvs, scale) => {
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      const cz = (box.z0 + box.z1) / 2;
      const grow = (value, center) => center + (value - center) * scale;
      const x0 = grow(box.x0, cx), x1 = grow(box.x1, cx);
      const y0 = grow(box.y0, cy), y1 = grow(box.y1, cy);
      const z0 = grow(box.z0, cz), z1 = grow(box.z1, cz);
      const quads = [
        { uv: uvs.front, n: [0, 0, 1], p: [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]] },
        { uv: uvs.back, n: [0, 0, -1], p: [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]] },
        { uv: uvs.left, n: [-1, 0, 0], p: [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]] },
        { uv: uvs.right, n: [1, 0, 0], p: [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]] },
        { uv: uvs.top, n: [0, 1, 0], p: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] },
        { uv: uvs.bottom, n: [0, -1, 0], p: [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]] }
      ];
      quads.forEach((quad) => {
        const [nx1, nz1] = [quad.n[0] * cosT + quad.n[2] * sinT, -quad.n[0] * sinT + quad.n[2] * cosT];
        const nz2 = quad.n[1] * sinP + nz1 * cosP;
        if (nz2 <= 0.001) return; // отвёрнуто от камеры
        const pts = quad.p.map(([x, y, z]) => project(x, y, z));
        const depth = pts.reduce((sum, point) => sum + point[2], 0) / 4;
        faces.push({ uv: quad.uv, pts, depth });
      });
    };

    skinBoxes(variant).forEach((box) => {
      pushFace(box, box.base, 1);
      pushFace(box, box.over, 1.06); // второй слой чуть сверху
    });

    // масштаб и центрирование по всем вершинам
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    faces.forEach((face) => face.pts.forEach(([x, y]) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }));
    if (!Number.isFinite(minX)) return;
    const pad = 12;
    const unit = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
    const offsetX = (W - (maxX - minX) * unit) / 2 - minX * unit;
    const offsetY = (H - (maxY - minY) * unit) / 2 - minY * unit;

    faces.sort((a, b) => a.depth - b.depth);
    ctx.imageSmoothingEnabled = false;
    faces.forEach((face) => {
      const [u0, v0, uw, vh] = face.uv;
      const [p0, p1, , p3] = face.pts.map(([x, y]) => [x * unit + offsetX, y * unit + offsetY]);
      // путь-квад в экранных координатах
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      face.pts.forEach(([x, y]) => ctx.lineTo(x * unit + offsetX, y * unit + offsetY));
      ctx.closePath();
      ctx.clip();
      if (uw > 0 && vh > 0) {
        const a = (p1[0] - p0[0]) / uw;
        const b = (p1[1] - p0[1]) / uw;
        const c = (p3[0] - p0[0]) / vh;
        const d = (p3[1] - p0[1]) / vh;
        const e = p0[0] - a * u0 - c * v0;
        const f = p0[1] - b * u0 - d * v0;
        ctx.setTransform(a, b, c, d, e, f);
        ctx.drawImage(texture, 0, 0);
      }
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    });
  }

  /** Состояние раздела «Скин» (лежит в профиле). */
  function skinState() {
    if (!state.skin) {
      const base = SKIN_PRESETS[0];
      state.skin = { preset: base.id, variant: "classic", angle: -18, mode: "preset", colors: colorsOfPreset(base) };
    }
    if (!state.skin.colors) state.skin.colors = colorsOfPreset(SKIN_PRESETS[0]);
    return state.skin;
  }

  /** Сохранённые пользователем пресеты (сколько угодно). */
  function userSkinPresets() {
    const list = state.settings && Array.isArray(state.settings.skin_presets) ? state.settings.skin_presets : [];
    return list.filter((item) => item && item.id);
  }

  function colorsOfPreset(preset) {
    return {
      skin: preset.skin || "#c49a76",
      hair: preset.hair || "#3b2a1c",
      shirt: preset.shirt || "#2f8faf",
      pants: preset.pants || "#3a3f8f",
      shoe: preset.shoe || "#3b3b44",
      accent: preset.accent || "#8fd6e8"
    };
  }

  function allSkinPresets() {
    return [...SKIN_PRESETS, ...userSkinPresets()];
  }

  function findSkinPreset(id) {
    return allSkinPresets().find((preset) => preset.id === id) || null;
  }

  const SKIN_COLOR_FIELDS = [
    ["skin", "кожа"], ["hair", "волосы"], ["shirt", "рубашка"],
    ["pants", "штаны"], ["shoe", "обувь"], ["accent", "акцент"]
  ];

  function skinSectionHtml() {
    const skin = skinState();
    const licensed = Boolean(skin.licensed);
    const variant = skin.variant || "classic";
    const presetButton = (preset, isUser) => `
      <button class="skin-preset ${isUser ? "is-user" : ""} ${preset.id === skin.preset ? "is-active" : ""}"
              data-preset="${esc(preset.id)}" ${isUser ? 'data-user="1"' : ""} title="${esc(preset.name)}">
        <canvas data-preset-thumb="${esc(preset.id)}" width="64" height="64"></canvas>
        <span>${esc(preset.name)}</span>
        ${isUser ? `<span class="preset-del" data-del-preset="${esc(preset.id)}" title="Удалить пресет">×</span>` : ""}
      </button>`;
    return `
      <section class="prefs-section skin-section">
        <div class="prefs-label-row">
          <span class="prefs-label">Скин аккаунта</span>
          <div class="spacer"></div>
          <span class="tag ${licensed ? "green" : ""}">${licensed ? "лицензия" : "только лицензия"}</span>
        </div>
        <div class="skin-grid">
          <div class="skin-stage"><canvas id="skin-canvas" width="640" height="900"></canvas></div>
          <div class="skin-ctrl">
            <div class="chips" id="skin-variant">
              <button class="chip ${variant === "classic" ? "is-active" : ""}" data-variant="classic">Wide (4 px)</button>
              <button class="chip ${variant === "slim" ? "is-active" : ""}" data-variant="slim">Slim (3 px)</button>
            </div>
            <div class="skin-colors">
              ${SKIN_COLOR_FIELDS.map(([field, label]) => `
                <label class="skin-color" title="${label}">
                  <input type="color" data-skin-color="${field}" value="${skin.colors[field] || "#000000"}" />
                  <span>${label}</span>
                </label>`).join("")}
            </div>
            <div class="skin-angle">
              <span class="prefs-label" style="margin:0">Поворот</span>
              <input type="range" id="skin-angle" min="-35" max="35" step="1" value="${Number(skin.angle ?? -18)}" />
              <span class="val" id="skin-angle-value">${Number(skin.angle ?? -18)}°</span>
            </div>
            <div class="prefs-label-row" style="margin:2px 0 0">
              <span class="prefs-label">Пресеты</span>
              <div class="spacer"></div>
              <button class="btn btn-small" id="skin-save-preset">
                <svg class="ic"><use href="#i-plus"/></svg>Сохранить пресет
              </button>
            </div>
            <div class="skin-presets" id="skin-presets">
              ${SKIN_PRESETS.map((preset) => presetButton(preset, false)).join("")}
              ${userSkinPresets().map((preset) => presetButton(preset, true)).join("")}
            </div>
            <div class="skin-row">
              <button class="btn" id="skin-custom">Свой PNG…</button>
              <button class="btn btn-primary" id="skin-apply" ${licensed ? "" : "disabled"}>Применить к аккаунту</button>
            </div>
            <div class="skin-note ${licensed ? "" : "warn"}" id="skin-status">${licensed
              ? "Второй слой — кепка и жилет; скин уйдёт в лицензионный аккаунт."
              : "Смена скина только для лицензионного аккаунта. Пресеты можно посмотреть и сохранить."}</div>
          </div>
        </div>
      </section>`;
  }

  function currentSkinTexture() {
    const skin = skinState();
    if (skin.mode === "account" && skin.accountTex) return skin.accountTex;
    if (!skin.textures) skin.textures = {};
    const key = `${skin.variant || "classic"}|${Object.values(skin.colors).join("-")}`;
    if (!skin.textures[key]) skin.textures[key] = buildSkinTexture(skin.colors);
    return skin.textures[key];
  }

  function redrawSkinPreview() {
    const canvas = $("#skin-canvas");
    if (!canvas) return;
    const skin = skinState();
    drawSkinPreview(canvas, currentSkinTexture(), skin.variant || "classic", Number(skin.angle ?? -18));
  }

  function bindSkin() {
    const skin = skinState();
    if ($("#skin-canvas")) redrawSkinPreview();

    $$("[data-preset-thumb]").forEach((thumb) => {
      const preset = findSkinPreset(thumb.dataset.presetThumb);
      if (!preset) return;
      const ctx = thumb.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buildSkinTexture(colorsOfPreset(preset)), 8, 8, 8, 8, 0, 0, 64, 64);
    });

    $$("#skin-presets .skin-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = findSkinPreset(btn.dataset.preset);
        if (!preset) return;
        skin.preset = preset.id;
        skin.mode = "preset";
        skin.colors = colorsOfPreset(preset);
        if (preset.variant === "classic" || preset.variant === "slim") skin.variant = preset.variant;
        if (Number.isFinite(Number(preset.angle))) skin.angle = Number(preset.angle);
        renderPrefs();
      });
      const del = btn.querySelector("[data-del-preset]");
      if (del) del.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSkinPreset(del.dataset.delPreset);
      });
    });

    $$("#skin-variant .chip").forEach((chip) => chip.addEventListener("click", () => {
      skin.variant = chip.dataset.variant;
      $$("#skin-variant .chip").forEach((el) => el.classList.toggle("is-active", el === chip));
      redrawSkinPreview();
    }));

    $$("[data-skin-color]").forEach((input) => input.addEventListener("input", () => {
      skin.colors = { ...skin.colors, [input.dataset.skinColor]: input.value };
      skin.mode = "preset";
      $$("#skin-presets .skin-preset").forEach((el) => el.classList.remove("is-active"));
      redrawSkinPreview();
    }));

    const angle = $("#skin-angle");
    if (angle) angle.addEventListener("input", () => {
      skin.angle = Number(angle.value);
      const label = $("#skin-angle-value");
      if (label) label.textContent = `${angle.value}°`;
      redrawSkinPreview();
    });

    const savePreset = $("#skin-save-preset");
    if (savePreset) savePreset.addEventListener("click", saveSkinPreset);
    const apply = $("#skin-apply");
    if (apply) apply.addEventListener("click", applySkinPreset);
    const custom = $("#skin-custom");
    if (custom) custom.addEventListener("click", applyCustomSkin);
  }

  async function saveSkinPreset() {
    const skin = skinState();
    const name = await promptModal({
      title: "Сохранить пресет скина",
      label: "Название",
      value: `Пресет ${userSkinPresets().length + 1}`
    });
    if (!name) return;
    const preset = {
      id: `skin-${Date.now().toString(36)}`,
      name,
      variant: skin.variant || "classic",
      angle: Number(skin.angle ?? -18),
      ...skin.colors
    };
    const next = { ...(state.settings || {}), skin_presets: [...userSkinPresets(), preset] };
    state.settings = next;
    try {
      await api.saveSettings(next);
    } catch (error) {
      toast(String(error), "err");
      return;
    }
    skin.preset = preset.id;
    skin.mode = "preset";
    toast(`Пресет «${name}» сохранён`, "ok");
    renderPrefs();
  }

  async function deleteSkinPreset(id) {
    const preset = userSkinPresets().find((item) => item.id === id);
    if (!preset) return;
    if (!confirm(`Удалить пресет «${preset.name}»?`)) return;
    const next = { ...(state.settings || {}), skin_presets: userSkinPresets().filter((item) => item.id !== id) };
    state.settings = next;
    try {
      await api.saveSettings(next);
    } catch (error) {
      toast(String(error), "err");
      return;
    }
    const skin = skinState();
    if (skin.preset === id) {
      skin.preset = SKIN_PRESETS[0].id;
      skin.colors = colorsOfPreset(SKIN_PRESETS[0]);
    }
    toast("Пресет удалён", "ok");
    renderPrefs();
  }

  async function applySkinPreset() {
    const skin = skinState();
    if (!skin.licensed) return toast("Смена скина только для лицензии", "err");
    const preset = findSkinPreset(skin.preset);
    const name = preset ? preset.name : "свой";
    const texture = buildSkinTexture(skin.colors);
    const button = $("#skin-apply");
    if (button) button.disabled = true;
    try {
      const path = await api.saveSkinPng(texture.toDataURL("image/png"), `preset-${skin.preset || "custom"}`);
      await api.applySkin(path, skin.variant || "classic");
      const status = $("#skin-status");
      if (status) status.textContent = `Скин «${name}» загружен в аккаунт.`;
      toast(`Скин «${name}» обновлён`, "ok");
      await refreshAccountSkin();
      redrawSkinPreview();
    } catch (err) {
      toast(String(err), "err");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function applyCustomSkin() {
    const skin = skinState();
    const path = await api.pickFile("Скин 64×64 PNG", ["png"]).catch(() => null);
    if (!path) return;
    if (!skin.licensed) return toast("Смена скина только для лицензии", "err");
    try {
      await api.applySkin(path, skin.variant || "classic");
      toast("Скин загружен", "ok");
      const dataUrl = await api.imageDataUrl(path).catch(() => null);
      if (dataUrl) await useSkinImage(dataUrl);
      redrawSkinPreview();
    } catch (err) { toast(String(err), "err"); }
  }

  /** Картинка-скин → offscreen-канвас (для предпросмотра реального скина). */
  function useSkinImage(dataUrl) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        canvas.getContext("2d").drawImage(image, 0, 0, 64, 64);
        const skin = skinState();
        skin.accountTex = canvas;
        skin.mode = "account";
        resolve(true);
      };
      image.onerror = () => resolve(false);
      image.src = dataUrl;
    });
  }

  async function refreshAccountSkin() {
    const info = await api.accountSkin().catch(() => null);
    const skin = skinState();
    if (!info) return;
    skin.licensed = Boolean(info.licensed);
    if (info.variant && !skin.touchedVariant) skin.variant = info.variant === "slim" ? "slim" : "classic";
    if (info.data_url) {
      const shown = await useSkinImage(info.data_url);
      if (!shown) skin.mode = "preset";
    } else if (!skin.preset) {
      skin.preset = SKIN_PRESETS[0].id;
    }
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
                <div class="label">Версия игры</div>
                <div class="flex-row">
                  <div class="muted grow" style="padding-top:7px">MC ${esc(meta.mc_version)} · ${esc(loaderLabel(meta.loader))} <span class="kbd">${esc(versionId(meta))}</span></div>
                  <button class="btn" id="inst-change-version">Сменить версию</button>
                </div>
              </div>
              <div class="settings-row">
                <div class="label">Наиграно</div>
                <div class="muted" style="padding-top:7px">${esc(playtimeLabel(meta.playtime_secs))}${meta.last_played ? ` · последний запуск ${esc(relativeWhen(meta.last_played))}` : ""}</div>
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
    $("#inst-change-version").addEventListener("click", () => openVersionChange());
    $("#inst-export-mrpack").addEventListener("click", () => exportBuild(meta, "mrpack"));
    $("#inst-export-zip").addEventListener("click", () => exportBuild(meta, "zip"));
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

  /** Экспорт сборки: выбираем куда сохранить и отдаём архиву ядру. */
  async function exportBuild(meta, format) {
    const safeName = String(meta.name).replace(/[\\/:*?"<>|]/g, "_").trim() || "build";
    const path = await api.pickSave(
      format === "zip" ? "Экспорт сборки в .zip" : "Экспорт сборки в .mrpack",
      `${safeName}.${format}`,
      [format]
    ).catch(() => null);
    if (!path) return;
    toast(`Собираем архив «${meta.name}»…`, "info");
    try {
      const saved = await api.exportInstance(meta.id, path, format);
      toast(`Готово: ${saved}`, "ok");
    } catch (err) {
      toast(`Не удалось экспортировать: ${err}`, "err");
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
    renderBuildIcon(selected());
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
      addSession(meta.id, plan && plan.run_id, plan && plan.account);
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
    try {
      await api.stop(meta.id);
      if (state.sessions) state.sessions.delete(meta.id);
      state.running.delete(meta.id);
      renderSidebar();
      updateStatus();
      toast("Игра остановлена");
    }
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
    const meta = cfg.meta;
    const loader = cfg.loader === "vanilla" || !cfg.loader
      ? { type: "vanilla" }
      : { type: cfg.loader, version: cfg.loaderVersion };
    if (loader.type !== "vanilla" && !loader.version) return toast("Выбери версию загрузчика", "err");
    const button = $("#mcver-apply");
    button.disabled = true;
    try {
      await api.updateInstance({ ...meta, mc_version: cfg.mc, loader, version_override: null });
      $("#modal-mcver").hidden = true;
      await refreshInstances();
      selectInstance(meta.id);
      toast(`Версия сборки — MC ${cfg.mc}`, "ok");
    } catch (err) {
      toast(String(err), "err");
    } finally {
      button.disabled = false;
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
    $$("[data-close-project]").forEach((el) => el.addEventListener("click", () => { $("#modal-project").hidden = true; }));
    const projectModal = $("#modal-project");
    if (projectModal) projectModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-project") projectModal.hidden = true; });
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
    // Версия в шапке кликабельна и ведёт на смену версии.
    on("#loader-pill", "click", () => { if (selected()) openVersionChange(); });
    on("#btn-build-menu", "click", (event) => {
      const meta = selected();
      if (!meta) return;
      const rect = event.currentTarget.getBoundingClientRect();
      openInstanceMenu(rect.left, rect.bottom + 4, meta);
    });
    on("#tb-version", "click", () => { if (selected()) openVersionChange(); });
    on("#mcver-apply", "click", () => applyVersionChange());
    $$("[data-close-mcver]").forEach((el) => el.addEventListener("click", () => { $("#modal-mcver").hidden = true; }));
    const mcverModal = $("#modal-mcver");
    if (mcverModal) mcverModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-mcver") mcverModal.hidden = true; });
    on("[data-close-prompt]", "click", () => { const modal = $("#modal-prompt"); if (modal) modal.hidden = true; });
    const verModal = $("#modal-versions");
    if (verModal) verModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-versions") verModal.hidden = true; });
    const prefsModal = $("#modal-prefs");
    if (prefsModal) prefsModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-prefs") prefsModal.hidden = true; });
    const accModal = $("#modal-account");
    if (accModal) accModal.addEventListener("mousedown", (event) => { if (event.target.id === "modal-account") accModal.hidden = true; });

    on("#btn-folder", "click", () => { const meta = selected(); if (meta) api.openPath(`/instances/${meta.id}/minecraft`).catch(() => {}); });
    on("#btn-grid", "click", () => {
      state.compact = !state.compact;
      const list = $("#instance-list");
      if (list) list.classList.toggle("is-compact", state.compact);
      toast(state.compact ? "Компактный список" : "Обычный список");
    });
    on("#btn-sort", "click", () => {
      state.instances.sort((a, b) => a.name.localeCompare(b.name));
      renderSidebar();
    });
    on("#instance-search", "input", renderSidebar);

    $$("[data-win]").forEach((btn) => btn.addEventListener("click", () => api.window(btn.dataset.win).catch(() => {})));
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
    await api.onExit(async (payload) => {
      dropSession(payload.instance, payload.run_id);
      pushLog(payload.instance, `[omnispec] Игра завершилась с кодом ${payload.code}`, payload.code === 0 ? "ok" : "err");
      // время игры пишется в мету сборки на стороне ядра — подтягиваем его
      await refreshInstances();
      if (state.tab === "discover") renderDiscover();
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
    state.customTheme = {
      bg: (state.settings && state.settings.theme_bg) || CUSTOM_THEME_DEFAULT.bg,
      accent: (state.settings && state.settings.theme_accent) || CUSTOM_THEME_DEFAULT.accent,
      text: (state.settings && state.settings.theme_text) || CUSTOM_THEME_DEFAULT.text
    };
    state.theme = applyTheme((state.settings && state.settings.theme) || "dark");
    state.fx = (state.settings && state.settings.click_fx) || "wave";
    applyClickFx(state.fx);
    applyShape((state.settings && state.settings.shape) || "soft");
    state.sound = {
      on: state.settings && state.settings.sound_fx !== false,
      volume: Number((state.settings && state.settings.sound_volume) ?? 60)
    };
    // обои: тот же выбор, что был в прошлый раз (иначе каждый старт — «свой фон»)
    state.wall = {
      wallpaper: (state.settings && state.settings.wallpaper) || null,
      fit: (state.settings && state.settings.wallpaper_fit) || "cover",
      blur: Number((state.settings && state.settings.wallpaper_blur) ?? 0),
      dim: Number((state.settings && state.settings.wallpaper_dim) ?? 40),
      recent: (state.settings && Array.isArray(state.settings.wallpaper_recent))
        ? state.settings.wallpaper_recent.slice(0, 6)
        : []
    };
    state.customWall = await api.customWallpaper().catch(() => null);
    applyWallpaper();
    await loadAccounts();
    bindFileDrop();
    await refreshInstances();
    // ничего не выбираем автоматически: стартовый экран — готовые сборки
    if (!state.selectedId) state.tab = "discover";
    updateStatus();
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
