/* OmniSpec — пользовательские темы и конструктор интерфейса.
 *
 * Это отдельный слой поверх основного UI: базовая разметка лаунчера остаётся
 * стабильной, а пользователь получает CSS, семантические селекторы и
 * переносимую раскладку. Произвольный JavaScript темам не разрешается.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "omnispec-customizer-v1";
  const MAX_CSS = 120000;
  const DEFAULT_LAYOUT = {
    sidebar_width: 264,
    sidebar_side: "left",
    main_order: ["toolbar", "tabs", "content"],
    hidden: [],
    main_padding: 0,
    main_gap: 0,
    density: "comfortable"
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
  const CSS_PRESETS = {
    clean: {
      label: "Чистый минимализм",
      css: `/* Минималистичная тема OmniSpec */
[data-os="sidebar"] {
  background: color-mix(in srgb, var(--bg-2) 82%, var(--accent) 18%);
}
[data-os="build-card"] {
  border-radius: 12px;
  transition: transform .18s ease, border-color .18s ease, background .18s ease;
}
[data-os="build-card"]:hover {
  transform: translateX(3px);
  border-color: var(--accent);
}
[data-os="tabs"] .tab.is-active::after {
  height: 3px;
  border-radius: 999px;
}`
    },
    glass: {
      label: "Стекло",
      css: `/* Полупрозрачное стекло */
[data-os="titlebar"],
[data-os="sidebar"],
[data-os="toolbar"],
[data-os="tabs"],
[data-os="panel"] {
  background: color-mix(in srgb, var(--bg-2) 72%, transparent);
  backdrop-filter: blur(18px) saturate(125%);
}
[data-os="build-card"],
.panel {
  background: color-mix(in srgb, var(--bg-3) 76%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
}`
    },
    neon: {
      label: "Неон",
      css: `/* Неоновый акцент */
[data-os="titlebar"] {
  box-shadow: 0 1px 0 color-mix(in srgb, var(--accent) 50%, transparent), 0 8px 30px color-mix(in srgb, var(--accent) 12%, transparent);
}
[data-os="build-card"],
[data-os="panel"] {
  border-color: color-mix(in srgb, var(--accent) 24%, var(--line));
}
[data-os="build-card"].is-active,
[data-os="build-card"]:focus-within {
  box-shadow: 0 0 0 1px var(--accent), 0 0 24px color-mix(in srgb, var(--accent) 22%, transparent);
}
.btn-primary, .btn-play {
  box-shadow: 0 0 22px color-mix(in srgb, var(--accent) 24%, transparent);
}`
    }
  };

  const BASE_CSS = `
/* Слой конструктора */
.app-body[data-custom-sidebar-side="right"] > .sidebar {
  order: 2;
  border-right: 0;
  border-left: 1px solid var(--line);
}
.app-body[data-custom-sidebar-side="right"] > .main { order: 1; }
.app-body[data-custom-sidebar-side="left"] > .sidebar { order: 1; }
.app-body[data-custom-sidebar-side="left"] > .main { order: 2; }
[data-custom-hidden="true"] { display: none !important; }
[data-os="main"] {
  row-gap: var(--os-main-gap, 0px);
}
[data-os="instance-list"] { gap: var(--os-card-gap, 2px); }
[data-os="build-card"] { padding-top: var(--os-card-pad, 5px); padding-bottom: var(--os-card-pad, 5px); }
[data-os="panel"] { padding-top: var(--os-panel-pad, 10px); }
.customizer-box {
  width: min(1040px, 96vw);
  height: min(760px, 92vh);
}
.customizer-head-copy { min-width: 0; flex: 1; }
.customizer-kicker {
  color: var(--accent); font-size: 9px; font-weight: 750;
  letter-spacing: .13em; text-transform: uppercase;
}
.customizer-head-copy h2 { margin-top: 3px; }
.customizer-status {
  max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dim-2); font-size: 10.5px;
}
.customizer-tabs {
  display: flex; align-items: center; gap: 3px; padding: 8px 14px 0;
  border-top: 1px solid var(--line);
}
.customizer-tab {
  height: 30px; padding: 0 11px; border: 1px solid transparent;
  border-radius: var(--r-sm); color: var(--dim); background: transparent;
  font-size: 11.5px; cursor: pointer;
}
.customizer-tab:hover { color: var(--text); background: var(--bg-3); }
.customizer-tab.is-active { color: var(--text); background: var(--bg-4); border-color: var(--line-2); }
.customizer-body {
  flex: 1; min-height: 0; overflow: auto; padding: 14px;
  display: flex; flex-direction: column; gap: 12px;
}
.customizer-section {
  padding: 13px 14px 14px; border: 1px solid var(--line);
  border-radius: var(--r); background: var(--bg-3);
}
.customizer-section + .customizer-section { margin-top: 0; }
.customizer-section-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
.customizer-section-head h3 { margin: 0; font-size: 13px; }
.customizer-section-head p { margin: 3px 0 0; color: var(--dim-2); font-size: 10.5px; line-height: 1.45; }
.customizer-section-head .ic { flex: none; width: 17px; height: 17px; color: var(--accent); }
.customizer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.customizer-control {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-width: 0; padding: 9px 10px; border: 1px solid var(--line);
  border-radius: var(--r-sm); background: var(--bg-2);
}
.customizer-control > span { min-width: 0; }
.customizer-control strong { display: block; color: var(--text); font-size: 11.5px; font-weight: 600; }
.customizer-control small { display: block; margin-top: 2px; color: var(--dim-2); font-size: 10px; line-height: 1.35; }
.customizer-control input[type="range"] { min-width: 120px; max-width: 190px; }
.customizer-control output { min-width: 48px; color: var(--text); font: 11px/1 Consolas, monospace; text-align: right; }
.customizer-control select { min-width: 126px; max-width: 190px; }
.customizer-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
.customizer-actions .hint { flex: 1 1 220px; color: var(--dim-2); font-size: 10.5px; line-height: 1.45; }
.layout-order { display: grid; gap: 6px; }
.layout-item {
  display: flex; align-items: center; gap: 8px; min-height: 47px; padding: 7px 8px;
  border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-2);
  cursor: grab; user-select: none;
}
.layout-item:active { cursor: grabbing; }
.layout-item.is-dragging { opacity: .42; border-style: dashed; }
.layout-item.is-hidden { opacity: .58; }
.layout-grip { color: var(--dim-2); font-size: 15px; letter-spacing: -3px; width: 14px; }
.layout-item-copy { min-width: 0; flex: 1; }
.layout-item-copy strong { display: block; font-size: 11.5px; }
.layout-item-copy small { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim-2); font-size: 10px; }
.layout-item-actions { display: flex; align-items: center; gap: 3px; }
.layout-item-actions .icon-btn { width: 25px; height: 25px; }
.customizer-note {
  padding: 9px 10px; border: 1px dashed var(--line-2); border-radius: var(--r-sm);
  color: var(--dim-2); font-size: 10.5px; line-height: 1.55;
}
.customizer-note strong { color: var(--text); }
.customizer-code-wrap { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; }
.customizer-code {
  width: 100%; min-height: 280px; flex: 1; resize: vertical; tab-size: 2;
  padding: 13px; border: 1px solid var(--line-2); border-radius: var(--r-sm);
  outline: none; background: var(--console-bg); color: var(--text);
  font: 12px/1.6 Consolas, "Cascadia Code", monospace; white-space: pre;
}
.customizer-code:focus { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent); }
.customizer-code-help { display: flex; flex-wrap: wrap; gap: 5px; }
.customizer-code-help code {
  padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--r-xs);
  background: var(--bg-2); color: var(--dim); font: 10px/1.2 Consolas, monospace;
}
.customizer-preset-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.customizer-preset-row .label { color: var(--dim-2); font-size: 10.5px; }
.customizer-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--line); background: var(--bg-2);
}
.customizer-footer .hint { min-width: 0; color: var(--dim-2); font-size: 10.5px; }
.customizer-footer-actions { display: flex; gap: 6px; }
.customizer-launcher-btn { border-color: color-mix(in srgb, var(--accent) 34%, var(--line)); }
.customizer-launcher-btn .ic { color: var(--accent); }
body[data-customizer-open="true"] .customizer-launcher-btn { background: var(--bg-4); }
@media (max-width: 720px) {
  .customizer-box { width: 96vw; height: 92vh; }
  .customizer-grid { grid-template-columns: 1fr; }
  .customizer-tabs { overflow-x: auto; }
  .customizer-control input[type="range"] { max-width: 130px; }
}
`;

  let styleEl = null;
  let userStyleEl = null;
  let modal = null;
  let currentTab = "layout";
  let layout = { ...DEFAULT_LAYOUT };
  let customCss = "";
  let settings = null;
  let saveQueue = Promise.resolve();
  let saveTimer = 0;
  let statusTimer = 0;
  let dragId = null;
  let started = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));

  function appState() {
    return window.omnispecDebug?.state || null;
  }

  function normalizeLayout(value) {
    const source = value && typeof value === "object" ? value : {};
    const order = Array.isArray(source.main_order) ? source.main_order : DEFAULT_LAYOUT.main_order;
    const cleanOrder = [...new Set(order.filter((item) => ORDER_ITEMS.some(([id]) => id === item)))];
    for (const [id] of ORDER_ITEMS) if (!cleanOrder.includes(id)) cleanOrder.push(id);
    const hidden = Array.isArray(source.hidden)
      ? [...new Set(source.hidden.filter((item) => ["sidebar", "toolbar", "tabs"].includes(item)))] : [];
    const density = DENSITIES[source.density] ? source.density : DEFAULT_LAYOUT.density;
    return {
      sidebar_width: Math.max(190, Math.min(420, Number(source.sidebar_width) || DEFAULT_LAYOUT.sidebar_width)),
      sidebar_side: source.sidebar_side === "right" ? "right" : "left",
      main_order: cleanOrder,
      hidden,
      main_padding: Math.max(0, Math.min(28, Number(source.main_padding) || 0)),
      main_gap: Math.max(0, Math.min(24, Number(source.main_gap) || 0)),
      density
    };
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
  }

  function currentSettings() {
    return appState()?.settings || settings || {};
  }

  function sanitizeCss(value) {
    let css = String(value || "").slice(0, MAX_CSS);
    // CSS-темы не получают доступ к JS и не могут подключать каскадом другой CSS.
    css = css.replace(/@import\s+(?:url\([^)]*\)|[^;]+);?/gi, "/* @import отключён конструктором */");
    css = css.replace(/expression\s*\(/gi, "/* expression отключён */(");
    css = css.replace(/-moz-binding\s*:/gi, "/* binding отключён */:");
    css = css.replace(/javascript\s*:/gi, "");
    return css;
  }

  function setStatus(text, kind = "") {
    const el = $("#customizer-status");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    clearTimeout(statusTimer);
    if (kind === "saved") statusTimer = setTimeout(() => { if (el.isConnected) el.textContent = "Изменения сохраняются автоматически"; }, 2600);
  }

  function injectStyles() {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "omnispec-customizer-base-style";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = BASE_CSS;
    if (!userStyleEl) {
      userStyleEl = document.createElement("style");
      userStyleEl.id = "omnispec-custom-css";
      document.head.appendChild(userStyleEl);
    }
    userStyleEl.textContent = sanitizeCss(customCss);
  }

  function markElement(selector, name) {
    document.querySelectorAll(selector).forEach((element) => {
      if (element.dataset.os !== name) element.dataset.os = name;
    });
  }

  function markUi() {
    markElement(".app", "app");
    markElement(".titlebar", "titlebar");
    markElement(".app-body", "app-body");
    markElement(".sidebar", "sidebar");
    markElement(".main", "main");
    markElement(".toolbar", "toolbar");
    markElement(".tabs", "tabs");
    markElement(".tab-body", "content");
    markElement(".instance-list", "instance-list");
    markElement(".instance", "build-card");
    markElement(".panel", "panel");
    markElement(".server-card", "server-card");
    markElement(".home-card", "home-card");
  }

  function applyLayout(next = layout) {
    layout = normalizeLayout(next);
    const body = document.body;
    const appBody = $(".app-body");
    const sidebar = $(".sidebar");
    const main = $(".main");
    if (!body || !appBody || !sidebar || !main) return;
    const density = DENSITIES[layout.density] || DENSITIES.comfortable;
    const root = document.documentElement;
    root.style.setProperty("--os-sidebar-width", `${layout.sidebar_width}px`);
    root.style.setProperty("--os-main-gap", `${layout.main_gap}px`);
    root.style.setProperty("--os-card-gap", `${density.gap}px`);
    root.style.setProperty("--os-card-pad", `${density.pad}px`);
    root.style.setProperty("--os-panel-pad", `${density.panel}px`);
    body.dataset.layoutDensity = layout.density;
    appBody.dataset.customSidebarSide = layout.sidebar_side;
    sidebar.style.width = `${layout.sidebar_width}px`;
    sidebar.style.flexBasis = `${layout.sidebar_width}px`;
    main.style.padding = `${layout.main_padding}px`;
    main.style.gap = `${layout.main_gap}px`;

    const order = Object.fromEntries(layout.main_order.map((id, index) => [id, index + 1]));
    const toolbar = $(".toolbar");
    const tabs = $(".tabs");
    const content = $(".tab-body");
    const path = $(".build-path");
    if (toolbar) toolbar.style.order = String(order.toolbar || 1);
    if (path) path.style.order = String((order.toolbar || 1) + 1);
    if (tabs) tabs.style.order = String(order.tabs || 2);
    if (content) content.style.order = String(order.content || 3);

    const hidden = new Set(layout.hidden);
    const hiddenTargets = [[sidebar, "sidebar"], [toolbar, "toolbar"], [tabs, "tabs"]];
    hiddenTargets.forEach(([element, id]) => {
      if (element) element.dataset.customHidden = hidden.has(id) ? "true" : "false";
    });
    markUi();
  }

  async function loadSettings() {
    const local = readLocal();
    const state = appState();
    let loaded = state?.settings || null;
    if (!loaded) {
      try {
        const invoke = window.__TAURI__?.core?.invoke;
        loaded = invoke ? await invoke("get_settings") : null;
      } catch { loaded = null; }
    }
    const source = { ...local, ...(loaded || {}) };
    settings = source || {};
    layout = normalizeLayout(settings.ui_layout || local.ui_layout);
    customCss = String(settings.custom_css ?? local.custom_css ?? "");
    if (state && !state.settings) state.settings = { ...settings };
    injectStyles();
    applyLayout();
    markUi();
  }

  function queueSave(patch) {
    const state = appState();
    const next = { ...currentSettings(), ...patch };
    if (state) state.settings = next;
    settings = next;
    try {
      const local = { ...readLocal(), custom_css: customCss, ui_layout: layout };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    } catch { /* localStorage may be disabled in a hardened WebView */ }
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) return;
      await invoke("save_settings", { settings: next });
    }).then(() => setStatus("Сохранено", "saved"), (error) => setStatus(`Не удалось сохранить: ${error}`, "error"));
    return saveQueue;
  }

  function queueSaveSoon(patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { queueSave(patch); }, 500);
  }

  function createModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.id = "modal-customizer";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal customizer-box" role="dialog" aria-modal="true" aria-labelledby="customizer-title">
        <header class="modal-head">
          <div class="customizer-head-copy">
            <div class="customizer-kicker">OmniSpec Studio</div>
            <h2 id="customizer-title">Тема и раскладка</h2>
          </div>
          <div class="customizer-status" id="customizer-status">Изменения сохраняются автоматически</div>
          <button class="icon-btn" type="button" data-custom-close title="Закрыть"><svg class="ic"><use href="#i-close"/></svg></button>
        </header>
        <div class="customizer-tabs" role="tablist">
          <button class="customizer-tab" data-custom-tab="layout" role="tab">Расположение</button>
          <button class="customizer-tab" data-custom-tab="visual" role="tab">Внешний вид</button>
          <button class="customizer-tab" data-custom-tab="css" role="tab">CSS-код</button>
        </div>
        <div class="customizer-body" id="customizer-body"></div>
        <footer class="customizer-footer">
          <span class="hint">Горячая клавиша: Ctrl + Shift + E</span>
          <div class="customizer-footer-actions">
            <button class="btn btn-ghost" type="button" data-custom-reset>Сбросить конструктор</button>
            <button class="btn btn-primary" type="button" data-custom-close>Готово</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-custom-tab], [data-custom-close], [data-custom-reset], [data-layout-action], [data-css-action], [data-css-preset]");
      if (!target) return;
      if (target.dataset.customTab) { currentTab = target.dataset.customTab; renderModal(); return; }
      if (target.dataset.customClose !== undefined) { closeCustomizer(); return; }
      if (target.dataset.customReset !== undefined) { resetCustomizer(); return; }
      if (target.dataset.layoutAction) { handleLayoutAction(target.dataset.layoutAction, target.dataset.layoutId); return; }
      if (target.dataset.cssAction) { handleCssAction(target.dataset.cssAction); return; }
      if (target.dataset.cssPreset) { applyPreset(target.dataset.cssPreset); }
    });
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeCustomizer(); });
    modal.addEventListener("input", (event) => {
      const target = event.target;
      if (target.id === "custom-css-editor") {
        customCss = target.value.slice(0, MAX_CSS);
        injectStyles();
        setStatus("Предпросмотр…");
        queueSaveSoon({ custom_css: customCss });
        return;
      }
      if (target.dataset.layoutControl) {
        updateLayoutControl(target.dataset.layoutControl, target.value);
      }
    });
    modal.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.layoutSelect) updateLayoutControl(target.dataset.layoutSelect, target.value);
    });
    modal.addEventListener("dragstart", (event) => {
      const item = event.target.closest?.("[data-layout-id]");
      if (!item) return;
      dragId = item.dataset.layoutId;
      item.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", dragId);
    });
    modal.addEventListener("dragend", (event) => event.target.closest?.("[data-layout-id]")?.classList.remove("is-dragging"));
    modal.addEventListener("dragover", (event) => {
      const item = event.target.closest?.("[data-layout-id]");
      if (!item || !dragId || item.dataset.layoutId === dragId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    modal.addEventListener("drop", (event) => {
      const item = event.target.closest?.("[data-layout-id]");
      if (!item || !dragId || item.dataset.layoutId === dragId) return;
      event.preventDefault();
      const from = layout.main_order.indexOf(dragId);
      const to = layout.main_order.indexOf(item.dataset.layoutId);
      if (from < 0 || to < 0) return;
      const next = [...layout.main_order];
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      layout = normalizeLayout({ ...layout, main_order: next });
      dragId = null;
      applyLayout();
      queueSave({ ui_layout: layout });
      renderModal();
    });
    return modal;
  }

  function layoutItemHtml([id, label, description]) {
    const hidden = layout.hidden.includes(id);
    return `<div class="layout-item ${hidden ? "is-hidden" : ""}" draggable="true" data-layout-id="${id}">
      <span class="layout-grip" aria-hidden="true">⋮⋮</span>
      <div class="layout-item-copy"><strong>${esc(label)}</strong><small>${esc(description)}</small></div>
      <div class="layout-item-actions">
        <button class="icon-btn" type="button" data-layout-action="up" data-layout-id="${id}" title="Выше">↑</button>
        <button class="icon-btn" type="button" data-layout-action="down" data-layout-id="${id}" title="Ниже">↓</button>
        <button class="icon-btn" type="button" data-layout-action="toggle" data-layout-id="${id}" title="${hidden ? "Показать" : "Скрыть"}">${hidden ? "◌" : "◉"}</button>
      </div>
    </div>`;
  }

  function rangeControl(id, title, description, value, min, max, unit = "px") {
    return `<label class="customizer-control"><span><strong>${title}</strong><small>${description}</small></span><input type="range" min="${min}" max="${max}" value="${value}" data-layout-control="${id}"><output id="custom-value-${id}">${value}${unit}</output></label>`;
  }

  function renderLayout() {
    const hidden = layout.hidden.includes("sidebar");
    return `<section class="customizer-section">
      <div class="customizer-section-head"><svg class="ic"><use href="#i-grid"/></svg><div><h3>Собери интерфейс под себя</h3><p>Перетащи блоки в нужный порядок. Изменения применяются сразу, без перезапуска.</p></div></div>
      <div class="layout-order">${layout.main_order.map((id) => ORDER_ITEMS.find((item) => item[0] === id)).filter(Boolean).map(layoutItemHtml).join("")}</div>
      <div class="customizer-note" style="margin-top:9px"><strong>Подсказка:</strong> порядок влияет на рабочую область справа. Например, можно поставить вкладки под содержимое или спрятать их и управлять разделами через CSS.</div>
    </section>
    <section class="customizer-section">
      <div class="customizer-section-head"><svg class="ic"><use href="#i-sliders"/></svg><div><h3>Размеры и плотность</h3><p>Это безопасные ограничения: окно остаётся адаптивным на любом мониторе.</p></div></div>
      <div class="customizer-grid">
        ${rangeControl("sidebar_width", "Ширина сайдбара", "Список сборок и быстрые действия", layout.sidebar_width, 190, 420)}
        ${rangeControl("main_padding", "Отступ рабочей области", "Свободное пространство вокруг контента", layout.main_padding, 0, 28)}
        ${rangeControl("main_gap", "Расстояние блоков", "Промежуток между панелью, вкладками и контентом", layout.main_gap, 0, 24)}
        <label class="customizer-control"><span><strong>Боковая панель</strong><small>С какой стороны закрепить список сборок</small></span><select data-layout-select="sidebar_side"><option value="left" ${layout.sidebar_side === "left" ? "selected" : ""}>Слева</option><option value="right" ${layout.sidebar_side === "right" ? "selected" : ""}>Справа</option></select></label>
        <label class="customizer-control"><span><strong>Плотность карточек</strong><small>Размеры сборок, панелей и промежутков</small></span><select data-layout-select="density">${Object.entries(DENSITIES).map(([id, item]) => `<option value="${id}" ${layout.density === id ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
        <label class="customizer-control"><span><strong>Сайдбар на экране</strong><small>${hidden ? "Скрыт. Верни его здесь или через Ctrl + Shift + E" : "Виден и доступен всегда"}</small></span><button class="switch ${hidden ? "" : "on"}" type="button" data-layout-action="toggle" data-layout-id="sidebar" aria-pressed="${!hidden}"></button></label>
      </div>
      <div class="customizer-actions"><button class="btn btn-small" type="button" data-layout-action="preset-default">Стандарт</button><button class="btn btn-small" type="button" data-layout-action="preset-focus">Фокус на контенте</button><button class="btn btn-small" type="button" data-layout-action="preset-right">Сайдбар справа</button><span class="hint">Положение и размеры сохраняются в профиле лаунчера.</span></div>
    </section>`;
  }

  function renderVisual() {
    return `<section class="customizer-section">
      <div class="customizer-section-head"><svg class="ic"><use href="#i-eyedrop"/></svg><div><h3>Визуальный слой</h3><p>Готовые цвета, форма элементов и фон уже находятся в разделе «Оформление». Здесь — быстрые идеи для CSS-тем.</p></div></div>
      <div class="customizer-note"><strong>Как это работает:</strong> сначала выбери базовую палитру в «Настройки → Оформление», затем добавь поверх неё собственный CSS. Конструктор не заменяет стандартные настройки — он расширяет их.</div>
      <div class="customizer-actions"><button class="btn" type="button" data-css-preset="clean">Чистый минимализм</button><button class="btn" type="button" data-css-preset="glass">Стекло</button><button class="btn" type="button" data-css-preset="neon">Неон</button><button class="btn btn-ghost" type="button" data-css-action="clear">Очистить CSS</button></div>
    </section>
    <section class="customizer-section">
      <div class="customizer-section-head"><svg class="ic"><use href="#i-image"/></svg><div><h3>Точки расширения</h3><p>Пользовательские селекторы не завязаны на случайные классы интерфейса.</p></div></div>
      <div class="customizer-code-help">
        <code>[data-os="titlebar"]</code><code>[data-os="sidebar"]</code><code>[data-os="toolbar"]</code><code>[data-os="tabs"]</code><code>[data-os="content"]</code><code>[data-os="build-card"]</code><code>[data-os="panel"]</code>
      </div>
    </section>`;
  }

  function renderCss() {
    return `<section class="customizer-section customizer-code-wrap">
      <div class="customizer-section-head"><svg class="ic"><use href="#i-code"/></svg><div><h3>CSS-код темы</h3><p>Пиши обычный CSS. Предпросмотр живой, сохранение автоматическое. JavaScript и @import отключены.</p></div></div>
      <textarea id="custom-css-editor" class="customizer-code" spellcheck="false" autocomplete="off" aria-label="CSS-код темы">${esc(customCss)}</textarea>
      <div class="customizer-preset-row"><span class="label">Пресеты:</span><button class="btn btn-small" type="button" data-css-preset="clean">Минимализм</button><button class="btn btn-small" type="button" data-css-preset="glass">Стекло</button><button class="btn btn-small" type="button" data-css-preset="neon">Неон</button></div>
      <div class="customizer-code-help"><code>--bg</code><code>--bg-2</code><code>--bg-3</code><code>--text</code><code>--dim</code><code>--accent</code><code>--r</code><code>--pad</code></div>
      <div class="customizer-actions"><button class="btn btn-small" type="button" data-css-action="export">Экспорт темы</button><button class="btn btn-small" type="button" data-css-action="import">Импорт темы</button><button class="btn btn-small btn-ghost" type="button" data-css-action="copy">Скопировать CSS</button><span class="hint">Файл темы содержит CSS и раскладку — им можно делиться.</span></div>
      <input id="custom-theme-file" type="file" accept=".json,.omtheme,application/json" hidden>
    </section>`;
  }

  function renderModal() {
    createModal();
    $$("[data-custom-tab]", modal).forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.customTab === currentTab);
      tab.setAttribute("aria-selected", String(tab.dataset.customTab === currentTab));
    });
    const body = $("#customizer-body", modal);
    if (!body) return;
    body.innerHTML = currentTab === "layout" ? renderLayout() : currentTab === "visual" ? renderVisual() : renderCss();
    bindFileImport();
    markUi();
  }

  function updateLayoutControl(key, rawValue) {
    const next = { ...layout };
    if (["sidebar_width", "main_padding", "main_gap"].includes(key)) next[key] = Number(rawValue);
    else if (key === "sidebar_side") next.sidebar_side = rawValue === "right" ? "right" : "left";
    else if (key === "density") next.density = DENSITIES[rawValue] ? rawValue : "comfortable";
    layout = normalizeLayout(next);
    applyLayout();
    const output = $(`#custom-value-${key}`);
    if (output) output.textContent = `${layout[key]}px`;
    setStatus("Предпросмотр…");
    queueSaveSoon({ ui_layout: layout });
  }

  function moveLayout(id, direction) {
    const index = layout.main_order.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= layout.main_order.length) return;
    const order = [...layout.main_order];
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    layout = normalizeLayout({ ...layout, main_order: order });
    applyLayout();
    queueSave({ ui_layout: layout });
    renderModal();
  }

  function toggleHidden(id) {
    const hidden = new Set(layout.hidden);
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    layout = normalizeLayout({ ...layout, hidden: [...hidden] });
    applyLayout();
    queueSave({ ui_layout: layout });
    renderModal();
  }

  function handleLayoutAction(action, id) {
    if (action === "up") return moveLayout(id, -1);
    if (action === "down") return moveLayout(id, 1);
    if (action === "toggle") return toggleHidden(id);
    if (action === "preset-default") layout = normalizeLayout(DEFAULT_LAYOUT);
    if (action === "preset-focus") layout = normalizeLayout({ ...DEFAULT_LAYOUT, hidden: ["toolbar"], main_padding: 10, density: "airy" });
    if (action === "preset-right") layout = normalizeLayout({ ...DEFAULT_LAYOUT, sidebar_side: "right", sidebar_width: 292 });
    if (["preset-default", "preset-focus", "preset-right"].includes(action)) {
      applyLayout();
      queueSave({ ui_layout: layout });
      renderModal();
    }
  }

  function applyPreset(id) {
    const preset = CSS_PRESETS[id];
    if (!preset) return;
    customCss = preset.css;
    injectStyles();
    setStatus(`Применена тема «${preset.label}»`);
    queueSave({ custom_css: customCss });
    if (currentTab !== "css") renderModal();
  }

  async function handleCssAction(action) {
    if (action === "clear") {
      customCss = "";
      injectStyles();
      queueSave({ custom_css: customCss });
      renderModal();
      return;
    }
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(customCss);
        setStatus("CSS скопирован", "saved");
      } catch { setStatus("Не удалось скопировать CSS", "error"); }
      return;
    }
    if (action === "export") {
      const payload = {
        format: "omnispec-theme",
        version: 1,
        name: "Моя тема OmniSpec",
        css: customCss,
        layout
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "omnispec-theme.omtheme";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Тема экспортирована", "saved");
      return;
    }
    if (action === "import") {
      $("#custom-theme-file", modal)?.click();
    }
  }

  function bindFileImport() {
    const input = $("#custom-theme-file", modal);
    if (!input || input.dataset.bound) return;
    input.dataset.bound = "true";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        customCss = sanitizeCss(data.css || data.custom_css || "");
        layout = normalizeLayout(data.layout || data.ui_layout || DEFAULT_LAYOUT);
        injectStyles();
        applyLayout();
        queueSave({ custom_css: customCss, ui_layout: layout });
        renderModal();
        setStatus(`Тема «${data.name || file.name}» импортирована`, "saved");
      } catch (error) { setStatus(`Не удалось импортировать тему: ${error.message || error}`, "error"); }
    });
  }

  function openCustomizer() {
    createModal();
    const current = currentSettings();
    layout = normalizeLayout(current.ui_layout || layout);
    customCss = String(current.custom_css ?? customCss ?? "");
    injectStyles();
    applyLayout();
    currentTab = "layout";
    renderModal();
    bindFileImport();
    modal.hidden = false;
    document.body.dataset.customizerOpen = "true";
    setStatus("Изменения сохраняются автоматически");
    $("[data-custom-tab='layout']", modal)?.focus();
  }

  function closeCustomizer() {
    if (!modal) return;
    modal.hidden = true;
    document.body.dataset.customizerOpen = "false";
  }

  async function resetCustomizer() {
    if (!window.confirm("Вернуть стандартную раскладку и удалить пользовательский CSS?")) return;
    layout = normalizeLayout(DEFAULT_LAYOUT);
    customCss = "";
    injectStyles();
    applyLayout();
    queueSave({ custom_css: "", ui_layout: layout });
    renderModal();
    bindFileImport();
    setStatus("Конструктор сброшен", "saved");
  }

  function addSidebarButton() {
    const foot = $(".sidebar-foot");
    if (!foot || foot.querySelector("[data-open-customizer]")) return;
    const button = document.createElement("button");
    button.className = "btn btn-small customizer-launcher-btn";
    button.type = "button";
    button.dataset.openCustomizer = "true";
    button.title = "Настроить расположение и CSS темы";
    button.innerHTML = '<svg class="ic"><use href="#i-sliders"/></svg><span>Настроить UI</span>';
    foot.appendChild(button);
    button.addEventListener("click", openCustomizer);
  }

  function addPrefsButton() {
    const nav = $("#prefs-nav");
    if (!nav || nav.querySelector("[data-open-customizer]")) return;
    const button = document.createElement("button");
    button.className = "prefs-tab";
    button.type = "button";
    button.dataset.openCustomizer = "true";
    button.innerHTML = '<svg class="ic" style="margin-right:7px;vertical-align:-3px"><use href="#i-sliders"/></svg>Тема и раскладка';
    nav.appendChild(button);
    button.addEventListener("click", openCustomizer);
  }

  function observeUi() {
    addSidebarButton();
    addPrefsButton();
    const app = $(".app");
    if (app) {
      const observer = new MutationObserver(() => { markUi(); addSidebarButton(); addPrefsButton(); });
      observer.observe(app, { childList: true, subtree: true });
    }
    const prefs = $("#modal-prefs");
    if (prefs) {
      const observer = new MutationObserver(addPrefsButton);
      observer.observe(prefs, { childList: true, subtree: true });
    }
  }

  function start() {
    if (started) return;
    started = true;
    injectStyles();
    observeUi();
    loadSettings().catch(() => {});
    // app.js загружает settings асинхронно. Повторно применяем слой после его
    // завершения, но не трогаем пользовательские изменения, сделанные позже.
    let attempts = 0;
    const wait = setInterval(() => {
      attempts += 1;
      const state = appState();
      if (state?.settings) {
        const next = state.settings;
        const local = readLocal();
        const nextCss = next.custom_css ?? local.custom_css ?? "";
        const nextLayout = next.ui_layout ?? local.ui_layout ?? DEFAULT_LAYOUT;
        const nextLayoutKey = JSON.stringify(normalizeLayout(nextLayout));
        const layoutKey = JSON.stringify(normalizeLayout(layout));
        const changed = nextCss !== customCss || nextLayoutKey !== layoutKey;
        if (changed && !modal?.matches(":not([hidden])")) {
          settings = next;
          customCss = String(nextCss);
          layout = normalizeLayout(nextLayout);
          injectStyles();
          applyLayout();
        }
      }
      if (attempts > 30) clearInterval(wait);
    }, 250);
    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        if (modal?.hidden === false) closeCustomizer(); else openCustomizer();
      }
      if (event.key === "Escape" && modal && !modal.hidden) closeCustomizer();
    });
  }

  window.omnispecCustomizer = { open: openCustomizer, close: closeCustomizer, applyLayout, markUi };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
