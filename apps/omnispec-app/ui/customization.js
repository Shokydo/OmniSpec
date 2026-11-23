/* OmniSpec — безопасный визуальный редактор интерфейса.
 *
 * Редактор хранит только данные раскладки и CSS. Пользовательский JavaScript
 * отсутствует: координаты, размеры, отступы и варианты отображения применяются
 * безопасным слоем CSS, а импортируемые темы проходят санитизацию.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "omnispec-customizer-v2";
  const MAX_CSS = 120000;
  const DEFAULT_LAYOUT = {
    sidebar_width: 264,
    sidebar_side: "left",
    main_order: ["toolbar", "tabs", "content"],
    hidden: [],
    main_padding: 0,
    main_gap: 0,
    density: "comfortable",
    preset: "omnispec",
    elements: []
  };
  const ORDER_ITEMS = [
    ["toolbar", "Панель действий", "Играть, папка и управление сборкой"],
    ["tabs", "Вкладки", "Главная, консоль, моды, файлы и остальные разделы"],
    ["content", "Рабочая область", "Содержимое выбранной вкладки"]
  ];
  const DENSITIES = {
    compact: { label: "Компактная", pad: 3, gap: 1, panel: 8 },
    comfortable: { label: "Удобная", pad: 5, gap: 2, panel: 10 },
    airy: { label: "Воздушная", pad: 9, gap: 5, panel: 14 }
  };

  /* Все элементы, доступные в визуальном редакторе. Селекторы остаются
   * семантическими и устойчивыми к перерисовке отдельных вкладок. */
  const ELEMENTS = [
    { id: "titlebar", label: "Заголовок окна", description: "Логотип, название и кнопки окна", selector: ".titlebar", previewX: 8, previewY: 8, previewWidth: 420, previewHeight: 36 },
    { id: "account", label: "Профиль аккаунта", description: "Активный аккаунт и список профилей", selector: "#account-chip", previewX: 8, previewY: 54, previewWidth: 224, previewHeight: 42 },
    { id: "build-tools", label: "Панель сборок", description: "Заголовок списка и действия", selector: ".sidebar-section", previewX: 8, previewY: 106, previewWidth: 224, previewHeight: 34 },
    { id: "new-build", label: "Создать сборку", description: "Быстрое создание новой сборки", selector: ".sidebar-new", previewX: 8, previewY: 148, previewWidth: 224, previewHeight: 32 },
    { id: "build-search", label: "Поиск сборки", description: "Фильтр списка слева", selector: "#instance-search", previewX: 8, previewY: 188, previewWidth: 224, previewHeight: 30 },
    { id: "build-list", label: "Список сборок", description: "Категории, карточки и «Запущенные»", selector: "#instance-list", previewX: 8, previewY: 226, previewWidth: 224, previewHeight: 118 },
    { id: "sidebar-actions", label: "Действия лаунчера", description: "Обновления и настройки", selector: ".sidebar-foot", previewX: 8, previewY: 352, previewWidth: 224, previewHeight: 48 },
    { id: "toolbar", label: "Панель выбранной сборки", description: "Имя, статус и кнопки запуска", selector: ".toolbar", previewX: 246, previewY: 54, previewWidth: 450, previewHeight: 58 },
    { id: "tabs", label: "Вкладки сборки", description: "Консоль, моды, файлы, загрузка и настройки", selector: ".tabs", previewX: 246, previewY: 120, previewWidth: 450, previewHeight: 34 },
    { id: "content", label: "Рабочая область", description: "Содержимое активной вкладки", selector: ".tab-body", previewX: 246, previewY: 162, previewWidth: 450, previewHeight: 238 }
  ];
  const ELEMENT_VARIANTS = [
    ["default", "Стандартный"],
    ["compact", "Компактный"],
    ["prominent", "Выразительный"],
    ["ghost", "Прозрачный"]
  ];
  const UI_PRESETS = [
    ["omnispec", "OmniSpec", "Тёмный плотный лаунчер с зелёным акцентом"],
    ["prism", "Prism Launcher", "Компактная панель и строгие карточки"],
    ["modrinth", "Modrinth", "Мягкие панели и зелёный каталог"],
    ["custom", "Полностью кастомный", "Только твои параметры и CSS"]
  ];
  const CSS_PRESETS = {
    clean: {
      label: "Чистый минимализм",
      css: `/* Минималистичная тема OmniSpec */
[data-os="sidebar"] { background: color-mix(in srgb, var(--bg-2) 82%, var(--accent) 18%); }
[data-os="build-card"] { border-radius: 12px; transition: transform .18s ease, border-color .18s ease, background .18s ease; }
[data-os="build-card"]:hover { transform: translateX(3px); border-color: var(--accent); }
[data-os="tabs"] .tab.is-active::after { height: 3px; border-radius: 999px; }`
    },
    glass: {
      label: "Стекло",
      css: `/* Полупрозрачное стекло */
[data-os="titlebar"], [data-os="sidebar"], [data-os="toolbar"], [data-os="tabs"], [data-os="panel"] {
  background: color-mix(in srgb, var(--bg-2) 72%, transparent);
  backdrop-filter: blur(18px) saturate(125%);
}
[data-os="build-card"], .panel { background: color-mix(in srgb, var(--bg-3) 76%, transparent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); }`
    },
    neon: {
      label: "Неон",
      css: `/* Неоновый акцент */
[data-os="titlebar"] { box-shadow: 0 1px 0 color-mix(in srgb, var(--accent) 50%, transparent), 0 8px 30px color-mix(in srgb, var(--accent) 12%, transparent); }
[data-os="build-card"], [data-os="panel"] { border-color: color-mix(in srgb, var(--accent) 24%, var(--line)); }
[data-os="build-card"].is-active, [data-os="build-card"]:focus-within { box-shadow: 0 0 0 1px var(--accent), 0 0 24px color-mix(in srgb, var(--accent) 22%, transparent); }
.btn-primary, .btn-play { box-shadow: 0 0 22px color-mix(in srgb, var(--accent) 24%, transparent); }`
    }
  };

  const BASE_CSS = `
/* Слой конструктора */
.app-body[data-custom-sidebar-side="right"] > .sidebar { order: 2; border-right: 0; border-left: 1px solid var(--line); }
.app-body[data-custom-sidebar-side="right"] > .main { order: 1; }
.app-body[data-custom-sidebar-side="left"] > .sidebar { order: 1; }
.app-body[data-custom-sidebar-side="left"] > .main { order: 2; }
[data-custom-hidden="true"] { display: none !important; }
[data-os="main"] { row-gap: var(--os-main-gap, 0px); }
[data-os="instance-list"] { gap: var(--os-card-gap, 2px); }
[data-os="build-card"] { padding-top: var(--os-card-pad, 5px); padding-bottom: var(--os-card-pad, 5px); }
[data-os="panel"] { padding-top: var(--os-panel-pad, 10px); }
[data-os-element-hidden="true"] { display: none !important; }
[data-os-element-mode="free"] { position: relative; z-index: 2; }
[data-os-element-variant="compact"] { --os-element-scale: .94; font-size: calc(100% * var(--os-element-scale)); }
[data-os-element-variant="prominent"] { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 10px 24px color-mix(in srgb, var(--accent) 12%, transparent); }
[data-os-element-variant="ghost"] { background: transparent !important; border-color: transparent !important; box-shadow: none !important; }
body[data-ui-preset="prism"] { --accent: #7fa7ff; }
body[data-ui-preset="prism"] .sidebar { background: #20242b; }
body[data-ui-preset="prism"] .card, body[data-ui-preset="prism"] .instance { border-radius: 4px; }
body[data-ui-preset="modrinth"] { --accent: #65d391; }
body[data-ui-preset="modrinth"] .sidebar, body[data-ui-preset="modrinth"] .toolbar { background: color-mix(in srgb, var(--bg-2) 78%, #65d391 22%); }
body[data-ui-preset="modrinth"] .card, body[data-ui-preset="modrinth"] .panel { border-radius: 14px; }
body[data-ui-preset="custom"] .app { filter: saturate(1.08); }
.customizer-box { width: min(1180px, 97vw); height: min(820px, 94vh); }
.customizer-backdrop { place-items: stretch; padding: 12px; box-sizing: border-box; }
.customizer-backdrop .customizer-box { width: 100%; max-width: none; height: 100%; max-height: none; min-height: 0; border-radius: var(--r-lg); }
body[data-customizer-open="true"] { overflow: hidden; }
.customizer-inline-root { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.customizer-inline-root .customizer-body { min-height: 520px; }
.customizer-head-copy { min-width: 0; flex: 1; }
.customizer-kicker { color: var(--accent); font-size: 9px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
.customizer-head-copy h2 { margin-top: 3px; }
.customizer-status { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim-2); font-size: 10.5px; }
.customizer-tabs { display: flex; align-items: center; gap: 3px; padding: 8px 14px 0; border-top: 1px solid var(--line); }
.customizer-tab { height: 30px; padding: 0 11px; border: 1px solid transparent; border-radius: var(--r-sm); color: var(--dim); background: transparent; font-size: 11.5px; cursor: pointer; }
.customizer-tab:hover { color: var(--text); background: var(--bg-3); }
.customizer-tab.is-active { color: var(--text); background: var(--bg-4); border-color: var(--line-2); }
.customizer-body { flex: 1; min-height: 0; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.customizer-section { padding: 13px 14px 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-3); }
.customizer-section-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
.customizer-section-head h3 { margin: 0; font-size: 13px; }
.customizer-section-head p { margin: 3px 0 0; color: var(--dim-2); font-size: 10.5px; line-height: 1.45; }
.customizer-section-head .ic { flex: none; width: 17px; height: 17px; color: var(--accent); }
.customizer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.customizer-control { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-2); }
.customizer-control > span { min-width: 0; }
.customizer-control strong { display: block; color: var(--text); font-size: 11.5px; font-weight: 600; }
.customizer-control small { display: block; margin-top: 2px; color: var(--dim-2); font-size: 10px; line-height: 1.35; }
.customizer-control input[type="range"] { min-width: 100px; max-width: 180px; }
.customizer-control output { min-width: 48px; color: var(--text); font: 11px/1 Consolas, monospace; text-align: right; }
.customizer-control select { min-width: 126px; max-width: 190px; }
.customizer-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
.customizer-actions .hint { flex: 1 1 220px; color: var(--dim-2); font-size: 10.5px; line-height: 1.45; }
.customizer-note { padding: 9px 10px; border: 1px dashed var(--line-2); border-radius: var(--r-sm); color: var(--dim-2); font-size: 10.5px; line-height: 1.55; }
.customizer-note strong { color: var(--text); }
.ui-preset-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.ui-preset { min-height: 74px; padding: 9px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-2); color: var(--dim); text-align: left; cursor: pointer; }
.ui-preset:hover { border-color: var(--line-2); color: var(--text); background: var(--bg-3); }
.ui-preset.is-active { border-color: var(--accent); color: var(--text); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
.ui-preset strong, .ui-preset small { display: block; }
.ui-preset strong { font-size: 11.5px; }
.ui-preset small { margin-top: 5px; color: var(--dim-2); font-size: 9.5px; line-height: 1.3; }
.visual-editor { display: grid; grid-template-columns: 190px minmax(360px, 1fr) 235px; gap: 10px; min-height: 440px; }
.visual-panel { min-width: 0; padding: 9px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-2); }
.visual-panel-title { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; color: var(--dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.visual-element-list { display: flex; flex-direction: column; gap: 4px; max-height: 390px; overflow: auto; }
.visual-element { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; padding: 5px 6px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--dim); text-align: left; cursor: pointer; }
.visual-element:hover { background: var(--bg-3); color: var(--text); }
.visual-element.is-selected { border-color: var(--accent); background: var(--bg-4); color: var(--text); }
.visual-element.is-hidden { opacity: .5; }
.visual-element .ic { width: 14px; height: 14px; flex: none; }
.visual-element-copy { min-width: 0; overflow: hidden; }
.visual-element-copy strong, .visual-element-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visual-element-copy strong { font-size: 10.5px; }
.visual-element-copy small { margin-top: 2px; color: var(--dim-2); font-size: 9px; }
.visual-stage { position: relative; min-height: 430px; overflow: auto; padding: 8px; border: 1px solid var(--line-2); border-radius: var(--r); background: linear-gradient(145deg, color-mix(in srgb, var(--bg-4) 90%, var(--accent) 10%), var(--bg-2)); }
.visual-stage-inner { position: relative; min-width: 720px; min-height: 410px; border: 1px dashed var(--line-2); border-radius: var(--r-sm); background: color-mix(in srgb, var(--bg-2) 86%, transparent); }
.visual-canvas-item { position: absolute; display: flex; align-items: center; gap: 6px; min-width: 60px; min-height: 24px; padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: var(--r-sm); background: color-mix(in srgb, var(--bg-3) 88%, var(--accent) 12%); color: var(--text); font-size: 10px; cursor: grab; user-select: none; }
.visual-canvas-item:hover, .visual-canvas-item.is-selected { z-index: 20; border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
.visual-canvas-item:active { cursor: grabbing; }
.visual-canvas-item.is-hidden { opacity: .3; border-style: dashed; }
.visual-canvas-item .ic { width: 13px; height: 13px; flex: none; }
.visual-stage-help { margin-top: 6px; color: var(--dim-2); font-size: 9.5px; line-height: 1.4; }
.visual-properties { display: flex; flex-direction: column; gap: 7px; }
.visual-properties .customizer-control { display: grid; grid-template-columns: 1fr 82px; gap: 6px; padding: 7px; }
.visual-properties .customizer-control strong { font-size: 10.5px; }
.visual-properties .customizer-control small { font-size: 9px; }
.visual-properties .customizer-control input[type="range"] { min-width: 0; width: 100%; }
.visual-properties .customizer-control output { min-width: 42px; font-size: 10px; }
.layout-order { display: grid; gap: 6px; }
.layout-item { display: flex; align-items: center; gap: 8px; min-height: 47px; padding: 7px 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-2); cursor: grab; user-select: none; }
.layout-item:active { cursor: grabbing; }
.layout-item.is-dragging { opacity: .42; border-style: dashed; }
.layout-item.is-hidden { opacity: .58; }
.layout-grip { color: var(--dim-2); font-size: 15px; letter-spacing: -3px; width: 14px; }
.layout-item-copy { min-width: 0; flex: 1; }
.layout-item-copy strong { display: block; font-size: 11.5px; }
.layout-item-copy small { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim-2); font-size: 10px; }
.layout-item-actions { display: flex; align-items: center; gap: 3px; }
.layout-item-actions .icon-btn { width: 25px; height: 25px; }
.customizer-code-wrap { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; }
.customizer-code { width: 100%; min-height: 280px; flex: 1; resize: vertical; tab-size: 2; padding: 13px; border: 1px solid var(--line-2); border-radius: var(--r-sm); outline: none; background: var(--console-bg); color: var(--text); font: 12px/1.6 Consolas, "Cascadia Code", monospace; white-space: pre; }
.customizer-code:focus { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent); }
.customizer-code-help { display: flex; flex-wrap: wrap; gap: 5px; }
.customizer-code-help code { padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--r-xs); background: var(--bg-2); color: var(--dim); font: 10px/1.2 Consolas, monospace; }
.customizer-preset-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.customizer-preset-row .label { color: var(--dim-2); font-size: 10.5px; }
.customizer-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--bg-2); }
.customizer-footer .hint { min-width: 0; color: var(--dim-2); font-size: 10.5px; }
.customizer-footer-actions { display: flex; gap: 6px; }
@media (max-width: 980px) { .visual-editor { grid-template-columns: 170px minmax(300px, 1fr); } .visual-properties { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .ui-preset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .visual-editor { grid-template-columns: 1fr; } .visual-properties { display: flex; } .visual-stage-inner { min-width: 680px; } .customizer-grid { grid-template-columns: 1fr; } }
`;

  let styleEl = null;
  let userStyleEl = null;
  let modal = null;
  let inlineHost = null;
  let currentTab = "editor";
  let selectedElementId = "toolbar";
  let layout = { ...DEFAULT_LAYOUT };
  let customCss = "";
  let settings = null;
  let saveQueue = Promise.resolve();
  let saveTimer = 0;
  let statusTimer = 0;
  let dragId = null;
  let layoutDragId = null;
  let started = false;

  const $ = (selector, root = document) => root?.querySelector?.(selector) || null;
  const $$ = (selector, root = document) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const appState = () => window.omnispecDebug?.state || null;
  const editorRoot = () => {
    if (inlineHost?.isConnected) return $("[data-editor-root]", inlineHost);
    return modal ? $("[data-editor-root]", modal) : null;
  };

  function normalizeElement(value, spec) {
    const source = value && typeof value === "object" ? value : {};
    const number = (key, min, max, fallback) => {
      const n = Number(source[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
    };
    const optional = (key, min, max) => {
      if (source[key] === null || source[key] === "" || source[key] === undefined) return null;
      const n = Number(source[key]);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null;
    };
    return {
      id: spec.id,
      visible: source.visible !== false,
      mode: source.mode === "free" ? "free" : "flow",
      x: number("x", -240, 720, 0),
      y: number("y", -180, 480, 0),
      width: optional("width", 0, 900),
      height: optional("height", 0, 420),
      margin: number("margin", 0, 40, 0),
      padding: number("padding", 0, 40, 0),
      radius: number("radius", 0, 40, 0),
      variant: ELEMENT_VARIANTS.some(([id]) => id === source.variant) ? source.variant : "default"
    };
  }

  function normalizeLayout(value) {
    const source = value && typeof value === "object" ? value : {};
    const order = Array.isArray(source.main_order) ? source.main_order : DEFAULT_LAYOUT.main_order;
    const cleanOrder = [...new Set(order.filter((item) => ORDER_ITEMS.some(([id]) => id === item)))];
    for (const [id] of ORDER_ITEMS) if (!cleanOrder.includes(id)) cleanOrder.push(id);
    const hidden = Array.isArray(source.hidden) ? [...new Set(source.hidden.filter((item) => ["sidebar", "toolbar", "tabs"].includes(item)))] : [];
    const density = DENSITIES[source.density] ? source.density : DEFAULT_LAYOUT.density;
    const rawElements = Array.isArray(source.elements) ? source.elements : [];
    const byId = new Map(rawElements.filter((item) => item && item.id).map((item) => [String(item.id), item]));
    return {
      sidebar_width: Math.max(190, Math.min(420, Number(source.sidebar_width) || DEFAULT_LAYOUT.sidebar_width)),
      sidebar_side: source.sidebar_side === "right" ? "right" : "left",
      main_order: cleanOrder,
      hidden,
      main_padding: Math.max(0, Math.min(28, Number(source.main_padding) || 0)),
      main_gap: Math.max(0, Math.min(24, Number(source.main_gap) || 0)),
      density,
      preset: UI_PRESETS.some(([id]) => id === source.preset) ? source.preset : DEFAULT_LAYOUT.preset,
      elements: ELEMENTS.map((spec) => normalizeElement(byId.get(spec.id), spec))
    };
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
  }
  function currentSettings() { return appState()?.settings || settings || {}; }

  function sanitizeCss(value) {
    let css = String(value || "").slice(0, MAX_CSS);
    css = css.replace(/@import\s+(?:url\([^)]*\)|[^;]+);?/gi, "/* @import отключён конструктором */");
    css = css.replace(/expression\s*\(/gi, "/* expression отключён */(");
    css = css.replace(/-moz-binding\s*:/gi, "/* binding отключён */:");
    css = css.replace(/javascript\s*:/gi, "");
    return css;
  }

  function setStatus(text, kind = "") {
    const el = $("[data-customizer-status]", editorRoot());
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    clearTimeout(statusTimer);
    if (kind === "saved") statusTimer = setTimeout(() => { if (el.isConnected) el.textContent = "Изменения сохраняются автоматически"; }, 2600);
  }

  function injectStyles() {
    if (!styleEl) { styleEl = document.createElement("style"); styleEl.id = "omnispec-customizer-base-style"; document.head.appendChild(styleEl); }
    styleEl.textContent = BASE_CSS;
    if (!userStyleEl) { userStyleEl = document.createElement("style"); userStyleEl.id = "omnispec-custom-css"; document.head.appendChild(userStyleEl); }
    userStyleEl.textContent = sanitizeCss(customCss);
  }

  function markElement(selector, name) {
    document.querySelectorAll(selector).forEach((element) => { if (element.dataset.os !== name) element.dataset.os = name; });
  }
  function markUi() {
    markElement(".app", "app"); markElement(".titlebar", "titlebar"); markElement(".app-body", "app-body");
    markElement(".sidebar", "sidebar"); markElement(".main", "main"); markElement(".toolbar", "toolbar");
    markElement(".tabs", "tabs"); markElement(".tab-body", "content"); markElement(".instance-list", "instance-list");
    markElement(".instance", "build-card"); markElement(".panel", "panel"); markElement(".server-card", "server-card"); markElement(".home-card", "home-card");
    ELEMENTS.forEach((spec) => elementNodes(spec).forEach((node) => { node.dataset.osElement = spec.id; }));
  }

  function elementNodes(spec) {
    if (spec.id === "build-search") {
      const input = $("#instance-search");
      return input?.parentElement ? [input.parentElement] : [];
    }
    if (spec.id === "account") { const node = $("#account-chip"); return node ? [node] : []; }
    return $$(spec.selector);
  }
  function elementState(id) { return layout.elements.find((item) => item.id === id) || normalizeElement({}, ELEMENTS.find((item) => item.id === id)); }

  function applyElement(spec, value) {
    elementNodes(spec).forEach((node) => {
      const element = node;
      element.dataset.osElement = spec.id;
      element.dataset.osElementMode = value.mode;
      element.dataset.osElementVariant = value.variant;
      element.dataset.osElementHidden = value.visible ? "false" : "true";
      element.style.width = value.width ? `${value.width}px` : "";
      element.style.height = value.height ? `${value.height}px` : "";
      element.style.margin = value.margin ? `${value.margin}px` : "";
      element.style.padding = value.padding ? `${value.padding}px` : "";
      element.style.borderRadius = value.radius ? `${value.radius}px` : "";
      element.style.transform = value.mode === "free" && (value.x || value.y) ? `translate(${value.x}px, ${value.y}px)` : "";
    });
  }
  function applyElements() { ELEMENTS.forEach((spec) => applyElement(spec, elementState(spec.id))); }

  function applyLayout(next = layout) {
    layout = normalizeLayout(next);
    const body = document.body;
    const appBody = $(".app-body"); const sidebar = $(".sidebar"); const main = $(".main");
    if (!body || !appBody || !sidebar || !main) return;
    const density = DENSITIES[layout.density] || DENSITIES.comfortable;
    const root = document.documentElement;
    root.style.setProperty("--os-sidebar-width", `${layout.sidebar_width}px`);
    root.style.setProperty("--os-main-gap", `${layout.main_gap}px`);
    root.style.setProperty("--os-card-gap", `${density.gap}px`);
    root.style.setProperty("--os-card-pad", `${density.pad}px`);
    root.style.setProperty("--os-panel-pad", `${density.panel}px`);
    body.dataset.layoutDensity = layout.density;
    body.dataset.uiPreset = layout.preset;
    appBody.dataset.customSidebarSide = layout.sidebar_side;
    sidebar.style.width = `${layout.sidebar_width}px`; sidebar.style.flexBasis = `${layout.sidebar_width}px`;
    main.style.padding = `${layout.main_padding}px`; main.style.gap = `${layout.main_gap}px`;
    const order = Object.fromEntries(layout.main_order.map((id, index) => [id, index + 1]));
    const toolbar = $(".toolbar"); const tabs = $(".tabs"); const content = $(".tab-body"); const path = $(".build-path");
    if (toolbar) toolbar.style.order = String(order.toolbar || 1);
    if (path) path.style.order = String((order.toolbar || 1) + 1);
    if (tabs) tabs.style.order = String(order.tabs || 2);
    if (content) content.style.order = String(order.content || 3);
    const hidden = new Set(layout.hidden);
    [[sidebar, "sidebar"], [toolbar, "toolbar"], [tabs, "tabs"]].forEach(([element, id]) => { if (element) element.dataset.customHidden = hidden.has(id) ? "true" : "false"; });
    markUi(); applyElements();
  }

  async function loadSettings() {
    const local = readLocal(); const state = appState();
    let loaded = state?.settings || null;
    if (!loaded) {
      try { const invoke = window.__TAURI__?.core?.invoke; loaded = invoke ? await invoke("get_settings") : null; } catch { loaded = null; }
    }
    const source = { ...local, ...(loaded || {}) };
    settings = source || {};
    layout = normalizeLayout(settings.ui_layout || local.ui_layout);
    customCss = String(settings.custom_css ?? local.custom_css ?? "");
    if (state && !state.settings) state.settings = { ...settings };
    injectStyles(); applyLayout(); markUi();
  }

  function stageSettings(patch = {}) {
    const state = appState();
    const savedLayout = patch.ui_layout ? normalizeLayout(patch.ui_layout) : normalizeLayout(layout);
    const next = { ...currentSettings(), ...patch, ui_layout: savedLayout };
    if (state) state.settings = next;
    settings = next;
    return next;
  }

  function queueSave(patch) {
    const next = stageSettings(patch);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readLocal(), custom_css: customCss, ui_layout: layout })); } catch { /* hardened webview */ }
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const invoke = window.__TAURI__?.core?.invoke; if (!invoke) return;
      await invoke("save_settings", { settings: next });
    }).then(() => setStatus("Сохранено", "saved"), (error) => setStatus(`Не удалось сохранить: ${error}`, "error"));
    return saveQueue;
  }
  function queueSaveSoon(patch) {
    stageSettings(patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { queueSave(patch); }, 500);
  }

  function editorMarkup(inline = false) {
    return `<div class="customizer-inline-root" data-editor-root data-editor-inline="${inline ? "true" : "false"}">
      <header class="${inline ? "customizer-inline-head" : "modal-head"}">
        <div class="customizer-head-copy"><div class="customizer-kicker">OmniSpec Studio · 0.52</div><h2 id="customizer-title">${inline ? "Визуальный редактор интерфейса" : "Тема и раскладка"}</h2></div>
        <div class="customizer-status" data-customizer-status>Изменения сохраняются автоматически</div>
        ${inline ? "" : '<button class="icon-btn" type="button" data-custom-close title="Закрыть"><svg class="ic"><use href="#i-close"/></svg></button>'}
      </header>
      <div class="customizer-tabs" role="tablist">
        <button class="customizer-tab" data-custom-tab="editor" role="tab">Визуальный редактор</button>
        <button class="customizer-tab" data-custom-tab="layout" role="tab">Крупные области</button>
        <button class="customizer-tab" data-custom-tab="css" role="tab">CSS-код</button>
      </div>
      <div class="customizer-body" data-customizer-body></div>
      <footer class="customizer-footer"><span class="hint">Перетаскивай элементы мышью. JavaScript темам не нужен.</span><div class="customizer-footer-actions"><button class="btn btn-ghost" type="button" data-custom-reset>Сбросить конструктор</button>${inline ? "" : '<button class="btn btn-primary" type="button" data-custom-close>Готово</button>'}</div></footer>
    </div>`;
  }

  function createModal() {
    if (modal) return modal;
    modal = document.createElement("div"); modal.className = "modal-backdrop customizer-backdrop"; modal.id = "modal-customizer"; modal.hidden = true;
    modal.innerHTML = `<div class="modal customizer-box" role="dialog" aria-modal="true" aria-labelledby="customizer-title">${editorMarkup(false)}</div>`;
    document.body.appendChild(modal); bindEditorEvents($("[data-editor-root]", modal));
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeCustomizer(); });
    return modal;
  }

  function bindEditorEvents(root) {
    if (!root || root.dataset.editorBound) return;
    root.dataset.editorBound = "true";
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-custom-tab], [data-custom-close], [data-custom-reset], [data-layout-action], [data-css-action], [data-css-preset], [data-ui-preset], [data-visual-id], [data-element-visibility]");
      if (!target || !root.contains(target)) return;
      if (target.dataset.customTab) { currentTab = target.dataset.customTab; renderEditor(); return; }
      if (target.dataset.customClose !== undefined) { closeCustomizer(); return; }
      if (target.dataset.customReset !== undefined) { resetCustomizer(); return; }
      if (target.dataset.layoutAction) { handleLayoutAction(target.dataset.layoutAction, target.dataset.layoutId); return; }
      if (target.dataset.cssAction) { handleCssAction(target.dataset.cssAction); return; }
      if (target.dataset.cssPreset) { applyCssPreset(target.dataset.cssPreset); return; }
      if (target.dataset.uiPreset) { applyUiPreset(target.dataset.uiPreset); return; }
      if (target.dataset.visualId) { selectedElementId = target.dataset.visualId; renderEditor(); return; }
      if (target.dataset.elementVisibility) { updateElement("visible", target.dataset.elementVisibility !== "hide"); return; }
    });
    root.addEventListener("input", (event) => {
      const target = event.target;
      if (target.id === "custom-css-editor") { customCss = target.value.slice(0, MAX_CSS); injectStyles(); layout.preset = "custom"; applyLayout(); setStatus("Предпросмотр…"); queueSaveSoon({ custom_css: customCss, ui_layout: layout }); return; }
      if (target.dataset.layoutControl) { updateLayoutControl(target.dataset.layoutControl, target.value); return; }
      if (target.dataset.elementControl) updateElement(target.dataset.elementControl, target.value);
    });
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.layoutSelect) updateLayoutControl(target.dataset.layoutSelect, target.value);
      if (target.dataset.elementSelect) updateElement(target.dataset.elementSelect, target.value);
    });
    root.addEventListener("dragstart", (event) => {
      const visual = event.target.closest?.(".visual-canvas-item[data-visual-id]");
      if (visual && root.contains(visual)) {
        dragId = visual.dataset.visualId;
        selectedElementId = dragId;
        visual.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragId);
        return;
      }
      const layoutItem = event.target.closest?.(".layout-item[data-layout-id]");
      if (layoutItem && root.contains(layoutItem)) {
        layoutDragId = layoutItem.dataset.layoutId;
        layoutItem.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `layout:${layoutDragId}`);
      }
    });
    root.addEventListener("dragend", (event) => {
      event.target.closest?.(".visual-canvas-item[data-visual-id]")?.classList.remove("is-dragging");
      event.target.closest?.(".layout-item[data-layout-id]")?.classList.remove("is-dragging");
      dragId = null;
      layoutDragId = null;
    });
    root.addEventListener("dragover", (event) => {
      const stage = event.target.closest?.(".visual-stage-inner");
      const order = event.target.closest?.(".layout-order");
      if ((stage && dragId) || (order && layoutDragId)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
    });
    root.addEventListener("drop", (event) => {
      const stage = event.target.closest?.(".visual-stage-inner");
      if (stage && dragId) {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        const spec = ELEMENTS.find((item) => item.id === dragId) || ELEMENTS[0];
        const value = {
          ...elementState(dragId),
          mode: "free",
          x: Math.round(event.clientX - rect.left - spec.previewX),
          y: Math.round(event.clientY - rect.top - spec.previewY)
        };
        updateElementValues(dragId, value, true);
        dragId = null;
        return;
      }
      const order = event.target.closest?.(".layout-order");
      if (!order || !layoutDragId) return;
      event.preventDefault();
      const target = event.target.closest?.(".layout-item[data-layout-id]");
      const sourceIndex = layout.main_order.indexOf(layoutDragId);
      if (sourceIndex < 0) { layoutDragId = null; return; }
      const nextOrder = layout.main_order.filter((id) => id !== layoutDragId);
      const targetId = target?.dataset.layoutId;
      let targetIndex = targetId ? nextOrder.indexOf(targetId) : nextOrder.length;
      if (targetIndex < 0) targetIndex = nextOrder.length;
      if (target && event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2) targetIndex += 1;
      nextOrder.splice(Math.min(targetIndex, nextOrder.length), 0, layoutDragId);
      layout = normalizeLayout({ ...layout, main_order: nextOrder });
      layoutDragId = null;
      applyLayout();
      queueSave({ ui_layout: layout });
      renderEditor();
    });
  }

  function renderEditor() {
    const root = editorRoot(); if (!root) return;
    $$("[data-custom-tab]", root).forEach((tab) => { tab.classList.toggle("is-active", tab.dataset.customTab === currentTab); tab.setAttribute("aria-selected", String(tab.dataset.customTab === currentTab)); });
    const body = $("[data-customizer-body]", root); if (!body) return;
    body.innerHTML = currentTab === "editor" ? renderVisualEditor() : currentTab === "layout" ? renderLayout() : renderCss();
    if (currentTab === "editor") setTimeout(() => $("[data-visual-id='${selectedElementId}']", root)?.scrollIntoView?.({ block: "nearest" }), 0);
  }

  function updateLayoutControl(key, rawValue) {
    const next = { ...layout };
    if (["sidebar_width", "main_padding", "main_gap"].includes(key)) next[key] = Number(rawValue);
    else if (key === "sidebar_side") next.sidebar_side = rawValue === "right" ? "right" : "left";
    else if (key === "density") next.density = DENSITIES[rawValue] ? rawValue : "comfortable";
    layout = normalizeLayout(next); applyLayout();
    const output = $(`#custom-value-${key}`, editorRoot()); if (output) output.textContent = `${layout[key]}${key === "density" || key === "sidebar_side" ? "" : "px"}`;
    setStatus("Предпросмотр…"); queueSaveSoon({ ui_layout: layout });
  }

  function updateElementValues(id, value, immediate = false) {
    layout = normalizeLayout({ ...layout, elements: layout.elements.map((item) => item.id === id ? normalizeElement({ ...item, ...value }, ELEMENTS.find((spec) => spec.id === id)) : item) });
    layout.preset = "custom"; applyLayout();
    setStatus("Предпросмотр…");
    if (immediate) { queueSave({ ui_layout: layout }); renderEditor(); } else queueSaveSoon({ ui_layout: layout });
  }
  function updateElement(key, rawValue) {
    const current = elementState(selectedElementId); let value = rawValue;
    if (["x", "y", "width", "height", "margin", "padding", "radius"].includes(key)) value = Number(rawValue);
    if (key === "width" || key === "height") value = Number(rawValue) <= 0 ? null : Number(rawValue);
    if (key === "visible") value = Boolean(rawValue);
    updateElementValues(selectedElementId, { ...current, [key]: value });
    const output = $(`#element-value-${key}`, editorRoot()); if (output) output.textContent = key === "width" || key === "height" ? (value ? `${value}px` : "auto") : `${value}px`;
    if (key === "mode" || key === "variant" || key === "visible") renderEditor();
  }

  function applyUiPreset(id) {
    if (!UI_PRESETS.some(([preset]) => preset === id)) return;
    const variant = id === "prism" ? "compact" : id === "modrinth" ? "prominent" : "default";
    layout = normalizeLayout({ ...layout, preset: id, density: id === "prism" ? "compact" : id === "modrinth" ? "comfortable" : "comfortable", elements: layout.elements.map((item) => ({ ...item, variant })) });
    applyLayout(); queueSave({ ui_layout: layout }); renderEditor(); setStatus(`Применён стиль «${UI_PRESETS.find(([preset]) => preset === id)?.[1]}»`, "saved");
  }

  function moveLayout(id, direction) {
    const index = layout.main_order.indexOf(id); const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= layout.main_order.length) return;
    const order = [...layout.main_order]; [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    layout = normalizeLayout({ ...layout, main_order: order }); applyLayout(); queueSave({ ui_layout: layout }); renderEditor();
  }
  function toggleHidden(id) {
    const hidden = new Set(layout.hidden); if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    layout = normalizeLayout({ ...layout, hidden: [...hidden] }); applyLayout(); queueSave({ ui_layout: layout }); renderEditor();
  }
  function handleLayoutAction(action, id) {
    if (action === "up") return moveLayout(id, -1);
    if (action === "down") return moveLayout(id, 1);
    if (action === "toggle") return toggleHidden(id);
    if (action === "preset-default") layout = normalizeLayout(DEFAULT_LAYOUT);
    if (action === "preset-focus") layout = normalizeLayout({ ...DEFAULT_LAYOUT, hidden: ["toolbar"], main_padding: 10, density: "airy" });
    if (action === "preset-right") layout = normalizeLayout({ ...DEFAULT_LAYOUT, sidebar_side: "right", sidebar_width: 292 });
    if (["preset-default", "preset-focus", "preset-right"].includes(action)) { applyLayout(); queueSave({ ui_layout: layout }); renderEditor(); }
  }

  function applyCssPreset(id) {
    const preset = CSS_PRESETS[id]; if (!preset) return;
    customCss = preset.css; layout.preset = "custom"; injectStyles(); applyLayout(); queueSave({ custom_css: customCss, ui_layout: layout }); renderEditor(); setStatus(`Применена тема «${preset.label}»`, "saved");
  }
  async function handleCssAction(action) {
    if (action === "clear") { customCss = ""; injectStyles(); queueSave({ custom_css: "" }); renderEditor(); return; }
    if (action === "copy") { try { await navigator.clipboard.writeText(customCss); setStatus("CSS скопирован", "saved"); } catch { setStatus("Не удалось скопировать CSS", "error"); } return; }
    if (action === "export") {
      const payload = { format: "omnispec-theme", version: 2, name: "Моя тема OmniSpec", css: customCss, layout };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "omnispec-theme.omtheme"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setStatus("Тема экспортирована", "saved"); return;
    }
    if (action === "import") $("#custom-theme-file", editorRoot())?.click();
  }
  function bindFileImport(root) {
    const input = $("#custom-theme-file", root); if (!input || input.dataset.bound) return;
    input.dataset.bound = "true";
    input.addEventListener("change", async () => {
      const file = input.files?.[0]; input.value = ""; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        customCss = sanitizeCss(data.css || data.custom_css || ""); layout = normalizeLayout(data.layout || data.ui_layout || DEFAULT_LAYOUT); injectStyles(); applyLayout(); queueSave({ custom_css: customCss, ui_layout: layout }); renderEditor(); setStatus(`Тема «${data.name || file.name}» импортирована`, "saved");
      } catch (error) { setStatus(`Не удалось импортировать тему: ${error.message || error}`, "error"); }
    });
  }

  function rangeControl(id, title, description, value, min, max, unit = "px") {
    return `<label class="customizer-control"><span><strong>${title}</strong><small>${description}</small></span><input type="range" min="${min}" max="${max}" value="${value}" data-layout-control="${id}"><output id="custom-value-${id}">${value}${unit}</output></label>`;
  }
  function layoutItemHtml([id, label, description]) {
    const hidden = layout.hidden.includes(id);
    return `<div class="layout-item ${hidden ? "is-hidden" : ""}" draggable="true" data-layout-id="${id}"><span class="layout-grip" aria-hidden="true">⋮⋮</span><div class="layout-item-copy"><strong>${esc(label)}</strong><small>${esc(description)}</small></div><div class="layout-item-actions"><button class="icon-btn" type="button" data-layout-action="up" data-layout-id="${id}" title="Выше">↑</button><button class="icon-btn" type="button" data-layout-action="down" data-layout-id="${id}" title="Ниже">↓</button><button class="icon-btn" type="button" data-layout-action="toggle" data-layout-id="${id}" title="${hidden ? "Показать" : "Скрыть"}">${hidden ? "◌" : "◉"}</button></div></div>`;
  }
  function renderLayout() {
    const hidden = layout.hidden.includes("sidebar");
    return `<section class="customizer-section"><div class="customizer-section-head"><svg class="ic"><use href="#i-grid"/></svg><div><h3>Крупные области лаунчера</h3><p>Порядок меняется перетаскиванием, а результат применяется сразу.</p></div></div><div class="layout-order">${layout.main_order.map((id) => ORDER_ITEMS.find((item) => item[0] === id)).filter(Boolean).map(layoutItemHtml).join("")}</div></section><section class="customizer-section"><div class="customizer-section-head"><svg class="ic"><use href="#i-sliders"/></svg><div><h3>Размеры и плотность</h3><p>Ограничения сохраняют адаптивность окна на разных мониторах.</p></div></div><div class="customizer-grid">${rangeControl("sidebar_width", "Ширина сайдбара", "Список сборок и быстрые действия", layout.sidebar_width, 190, 420)}${rangeControl("main_padding", "Отступ рабочей области", "Свободное пространство вокруг контента", layout.main_padding, 0, 28)}${rangeControl("main_gap", "Расстояние блоков", "Промежуток между панелью, вкладками и контентом", layout.main_gap, 0, 24)}<label class="customizer-control"><span><strong>Боковая панель</strong><small>С какой стороны закрепить список сборок</small></span><select class="select" data-layout-select="sidebar_side"><option value="left" ${layout.sidebar_side === "left" ? "selected" : ""}>Слева</option><option value="right" ${layout.sidebar_side === "right" ? "selected" : ""}>Справа</option></select></label><label class="customizer-control"><span><strong>Плотность карточек</strong><small>Размеры сборок и панелей</small></span><select class="select" data-layout-select="density">${Object.entries(DENSITIES).map(([id, item]) => `<option value="${id}" ${layout.density === id ? "selected" : ""}>${item.label}</option>`).join("")}</select></label><label class="customizer-control"><span><strong>Сайдбар на экране</strong><small>${hidden ? "Скрыт" : "Виден и доступен"}</small></span><button class="switch ${hidden ? "" : "on"}" type="button" data-layout-action="toggle" data-layout-id="sidebar" aria-pressed="${!hidden}"></button></label></div><div class="customizer-actions"><button class="btn btn-small" type="button" data-layout-action="preset-default">Стандарт</button><button class="btn btn-small" type="button" data-layout-action="preset-focus">Фокус на контенте</button><button class="btn btn-small" type="button" data-layout-action="preset-right">Сайдбар справа</button></div></section>`;
  }

  function renderVisualEditor() {
    const selected = ELEMENTS.find((item) => item.id === selectedElementId) || ELEMENTS[0];
    selectedElementId = selected.id;
    const value = elementState(selected.id);
    const controls = (key, title, description, min, max, unit = "px", raw = value[key] ?? 0) => `<label class="customizer-control"><span><strong>${title}</strong><small>${description}</small></span><input type="range" min="${min}" max="${max}" value="${raw || 0}" data-element-control="${key}"><output id="element-value-${key}">${key === "width" || key === "height" ? (raw ? `${raw}${unit}` : "auto") : `${raw || 0}${unit}`}</output></label>`;
    return `<section class="customizer-section"><div class="customizer-section-head"><svg class="ic"><use href="#i-sliders"/></svg><div><h3>Собери интерфейс как в OmniSpec, Prism Launcher, Modrinth или полностью по-своему</h3><p>Выбери пресет, затем перетащи отдельные элементы на холсте. Для каждого элемента доступны свободная позиция, размер, отступы, радиус, стиль и видимость.</p></div></div><div class="ui-preset-grid">${UI_PRESETS.map(([id, label, description]) => `<button type="button" class="ui-preset ${layout.preset === id ? "is-active" : ""}" data-ui-preset="${id}"><strong>${label}</strong><small>${description}</small></button>`).join("")}</div></section><section class="customizer-section"><div class="visual-editor"><div class="visual-panel"><div class="visual-panel-title"><svg class="ic"><use href="#i-list"/></svg>Элементы</div><div class="visual-element-list">${ELEMENTS.map((item) => { const state = elementState(item.id); return `<button type="button" class="visual-element ${selected.id === item.id ? "is-selected" : ""} ${state.visible ? "" : "is-hidden"}" data-visual-id="${item.id}"><svg class="ic"><use href="#i-dots"/></svg><span class="visual-element-copy"><strong>${item.label}</strong><small>${state.visible ? item.description : "скрыт"}</small></span></button>`; }).join("")}</div></div><div class="visual-panel"><div class="visual-panel-title"><svg class="ic"><use href="#i-grid"/></svg>Холст · перетащи блоки</div><div class="visual-stage"><div class="visual-stage-inner">${ELEMENTS.map((item) => { const state = elementState(item.id); const left = Math.max(3, item.previewX + state.x); const top = Math.max(3, item.previewY + state.y); const width = state.width || item.previewWidth; const height = state.height || item.previewHeight; return `<div class="visual-canvas-item ${selected.id === item.id ? "is-selected" : ""} ${state.visible ? "" : "is-hidden"}" draggable="true" data-visual-id="${item.id}" style="left:${left}px;top:${top}px;width:${width}px;min-height:${height}px"><svg class="ic"><use href="#i-dots"/></svg>${item.label}</div>`; }).join("")}</div><div class="visual-stage-help">Перетаскивание переводит элемент в режим «Свободно» и записывает координаты в профиль. Это не пользовательский JavaScript.</div></div></div><div class="visual-panel visual-properties"><div class="visual-panel-title"><svg class="ic"><use href="#i-pencil"/></svg>Свойства</div><div class="customizer-note"><strong>${selected.label}</strong><br>${selected.description}</div><label class="customizer-control"><span><strong>Видимость</strong><small>Показывать элемент в лаунчере</small></span><button class="switch ${value.visible ? "on" : ""}" type="button" data-element-visibility="${value.visible ? "hide" : "show"}" aria-pressed="${value.visible}"></button></label><label class="customizer-control"><span><strong>Режим расположения</strong><small>Адаптивный поток или свободные координаты</small></span><select class="select" data-element-select="mode"><option value="flow" ${value.mode === "flow" ? "selected" : ""}>В потоке</option><option value="free" ${value.mode === "free" ? "selected" : ""}>Свободно</option></select></label><label class="customizer-control"><span><strong>Вариант</strong><small>Размер и визуальный акцент</small></span><select class="select" data-element-select="variant">${ELEMENT_VARIANTS.map(([id, label]) => `<option value="${id}" ${value.variant === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>${controls("x", "X", "Горизонтальное смещение", -240, 720)}${controls("y", "Y", "Вертикальное смещение", -180, 480)}${controls("width", "Ширина", "0 — автоматически", 0, 900)}${controls("height", "Высота", "0 — автоматически", 0, 420)}${controls("margin", "Отступ снаружи", "Свободное пространство", 0, 40)}${controls("padding", "Внутренний отступ", "Пространство внутри", 0, 40)}${controls("radius", "Закругление", "Радиус углов", 0, 40)}</div></div></section>`;
  }

  function renderCss() {
    return `<section class="customizer-section customizer-code-wrap"><div class="customizer-section-head"><svg class="ic"><use href="#i-code"/></svg><div><h3>Базовый CSS и переопределения</h3><p>Редактируй CSS прямо здесь: изменения применяются живьём и сохраняются автоматически. JavaScript и @import отключены.</p></div></div><textarea id="custom-css-editor" class="customizer-code" spellcheck="false" autocomplete="off" aria-label="Базовый CSS и переопределения">${esc(customCss)}</textarea><div class="customizer-preset-row"><span class="label">Пресеты:</span>${Object.entries(CSS_PRESETS).map(([id, item]) => `<button class="btn btn-small" type="button" data-css-preset="${id}">${item.label}</button>`).join("")}</div><div class="customizer-code-help"><code>[data-os="sidebar"]</code><code>[data-os-element="toolbar"]</code><code>[data-os="tabs"]</code><code>[data-os="build-card"]</code><code>--accent</code><code>--r</code></div><div class="customizer-actions"><button class="btn btn-small" type="button" data-css-action="export">Экспорт темы</button><button class="btn btn-small" type="button" data-css-action="import">Импорт темы</button><button class="btn btn-small btn-ghost" type="button" data-css-action="copy">Скопировать CSS</button><span class="hint">Файл темы содержит CSS и раскладку — им можно делиться.</span></div><input id="custom-theme-file" type="file" accept=".json,.omtheme,application/json" hidden></section>`;
  }

  function openCustomizer() {
    inlineHost = null; createModal();
    const prefs = document.getElementById("modal-prefs");
    if (prefs) prefs.hidden = true;
    const current = currentSettings(); layout = normalizeLayout(current.ui_layout || layout); customCss = String(current.custom_css ?? customCss ?? "");
    injectStyles(); applyLayout(); currentTab = "editor"; renderEditor(); bindFileImport(editorRoot());
    modal.hidden = false; document.body.dataset.customizerOpen = "true"; setStatus("Изменения сохраняются автоматически");
    setTimeout(() => $("[data-custom-tab='editor']", editorRoot())?.focus(), 0);
  }
  function closeCustomizer() { if (!modal) return; modal.hidden = true; document.body.dataset.customizerOpen = "false"; }
  function renderInline(host) {
    if (!host) return;
    inlineHost = host;
    const current = currentSettings(); layout = normalizeLayout(current.ui_layout || layout); customCss = String(current.custom_css ?? customCss ?? "");
    injectStyles(); applyLayout();
    host.innerHTML = editorMarkup(true); const root = $("[data-editor-root]", host); bindEditorEvents(root); bindFileImport(root); renderEditor();
  }
  async function resetCustomizer() {
    if (!window.confirm("Вернуть стандартную раскладку и удалить пользовательский CSS?")) return;
    layout = normalizeLayout(DEFAULT_LAYOUT); customCss = ""; injectStyles(); applyLayout(); queueSave({ custom_css: "", ui_layout: layout }); renderEditor(); setStatus("Конструктор сброшен", "saved");
  }

  function observeUi() {
    markUi();
    const app = $(".app");
    if (app) {
      const observer = new MutationObserver(() => { markUi(); applyElements(); });
      observer.observe(app, { childList: true, subtree: true });
    }
  }
  function start() {
    if (started) return; started = true; injectStyles(); observeUi(); loadSettings().catch(() => {});
    let attempts = 0;
    const wait = setInterval(() => {
      attempts += 1; const state = appState();
      if (state?.settings) {
        const next = state.settings; const local = readLocal(); const nextCss = next.custom_css ?? local.custom_css ?? ""; const nextLayout = next.ui_layout ?? local.ui_layout ?? DEFAULT_LAYOUT;
        if (nextCss !== customCss || JSON.stringify(normalizeLayout(nextLayout)) !== JSON.stringify(layout)) {
          settings = next; customCss = String(nextCss); layout = normalizeLayout(nextLayout); injectStyles(); applyLayout();
          if (inlineHost?.isConnected && inlineHost.dataset.prefCategory === "interface") renderInline(inlineHost);
        }
      }
      if (attempts > 30) clearInterval(wait);
    }, 250);
    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") { event.preventDefault(); if (modal?.hidden === false) closeCustomizer(); else openCustomizer(); }
      if (event.key === "Escape" && modal && !modal.hidden) closeCustomizer();
    });
  }

  window.omnispecCustomizer = { open: openCustomizer, close: closeCustomizer, renderInline, render: renderEditor, applyLayout, markUi };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
