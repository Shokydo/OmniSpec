/* OmniSpec — безопасный визуальный редактор интерфейса.
 *
 * Редактор хранит только данные раскладки и CSS. Пользовательский JavaScript
 * отсутствует: координаты, размеры, отступы и варианты отображения применяются
 * безопасным слоем CSS, а импортируемые темы проходят санитизацию.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "omnispec-customizer-v2";
  const MAX_CSS = 1000000;
  const FULL_CSS_MARKER = "/* OmniSpec: full base stylesheet */\n";
  const DEFAULT_LAYOUT = {
    sidebar_width: 264,
    sidebar_side: "left",
    main_order: ["toolbar", "tabs", "content"],
    hidden: [],
    main_padding: 0,
    main_gap: 0,
    density: "comfortable",
    preset: "omnispec",
    elements: [],
    custom_widgets: []
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
    { id: "build-path", label: "Путь к сборке", description: "Строка расположения и копирование пути", selector: "#build-path", previewX: 246, previewY: 110, previewWidth: 450, previewHeight: 26 },
    { id: "tabs", label: "Вкладки сборки", description: "Консоль, моды, файлы, загрузка и настройки", selector: ".tabs", previewX: 246, previewY: 120, previewWidth: 450, previewHeight: 34 },
    { id: "content", label: "Рабочая область", description: "Содержимое активной вкладки", selector: ".tab-body", previewX: 246, previewY: 162, previewWidth: 450, previewHeight: 238 }
  ];
  // Дополнительные элементы можно скрывать независимо, не перепозиционируя
  // вложенные узлы: они остаются частью своих рабочих страниц.
  const VISIBILITY_ITEMS = [
    { id: "brand", label: "Логотип и название", selector: ".tb-brand" },
    { id: "window-controls", label: "Кнопки окна", selector: ".tb-right" },
    { id: "instance-title", label: "Название сборки", selector: "#tb-name" },
    { id: "instance-status", label: "Статус сборки", selector: ".tb-meta" },
    { id: "action-folder", label: "Кнопка папки", selector: "#btn-folder" },
    { id: "action-restart", label: "Кнопка перезапуска", selector: "#btn-restart" },
    { id: "action-play", label: "Кнопка Играть", selector: "#btn-play" },
    { id: "action-stop", label: "Кнопка Стоп", selector: "#btn-stop" },
    ...[["discover", "Главная"], ["servers", "Серверы"], ["console", "Консоль"], ["server", "Сервер"], ["players", "Игроки"], ["metrics", "Метрики"], ["backups", "Бэкапы"], ["errors", "Ошибки"], ["files", "Файлы"], ["mods", "Моды"], ["resourcepacks", "Ресурспаки"], ["shaders", "Шейдеры"], ["worlds", "Миры"], ["screenshots", "Скриншоты"], ["download", "Загрузить"], ["settings", "Сборка"]]
      .map(([id, label]) => ({ id: `tab-${id}`, label: `Вкладка «${label}»`, selector: `.tabs [data-tab="${id}"]` }))
  ].map(item => ({ ...item, hideOnly: true, description: "Только видимость" }));
  ELEMENTS.push(...VISIBILITY_ITEMS);

  const trustedWidgets = new Map();
  let widgetEditor = null;
  const builtinCount = ELEMENTS.length;
  function widgetSpecs(widgets) {
    ELEMENTS.splice(builtinCount);
    for (const w of widgets) ELEMENTS.push({ id: w.id, label: w.name, description: w.kind === "url" ? "Веб-страница" : "Пользовательский HTML", selector: `[data-custom-widget="${w.id}"]`, previewX: 80, previewY: 80, previewWidth: 400, previewHeight: 240, customWidget: true });
  }
  function normalizeWidgets(value) {
    const used = new Set();
    return (Array.isArray(value) ? value : []).slice(0, 30).filter(w => w && /^widget-[a-z0-9-]{1,80}$/.test(w.id) && !used.has(w.id) && (used.add(w.id), true)).map(w => ({
      id: w.id, name: String(w.name || "Пользовательский элемент").slice(0, 80), kind: w.kind === "url" ? "url" : "html",
      content: String(w.content || "").slice(0, 100000), trusted: w.kind !== "url" && w.trusted === true
    }));
  }
  function validWidgetUrl(value) {
    try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  }
  function syncWidgets() {
    const app = $(".app"); if (!app) return;
    const widgets = layout.custom_widgets;
    for (const node of app.querySelectorAll(":scope > [data-custom-widget]")) if (!widgets.some(w => w.id === node.dataset.customWidget)) node.remove();
    for (const w of widgets) {
      let host = app.querySelector(`:scope > [data-custom-widget="${w.id}"]`);
      if (!host) { host = document.createElement("div"); host.dataset.customWidget = w.id; host.className = "os-custom-widget"; app.appendChild(host); }
      const allowed = w.trusted && trustedWidgets.get(w.id) === w.content;
      const signature = JSON.stringify([w.kind,w.content,w.trusted,allowed]);
      if (host._widgetSignature === signature) continue;
      host._widgetSignature = signature; host.replaceChildren();
      if (w.trusted && !allowed) { host.textContent = "Доверенный код выключен. В редакторе подтвердите запуск."; continue; }
      if (allowed) {
        const template = document.createElement("template"); template.innerHTML = w.content;
        const scripts = [...template.content.querySelectorAll("script")];
        scripts.forEach(script => { const marker = document.createElement("span"); marker.dataset.widgetScript = ""; script.replaceWith(marker); marker._script = script; });
        host.appendChild(template.content);
        for (const marker of host.querySelectorAll("[data-widget-script]")) { const old = marker._script; if (!old) continue; const script = document.createElement("script"); for (const attr of old.attributes) script.setAttribute(attr.name, attr.value); script.textContent = old.textContent; marker.replaceWith(script); }
      } else {
        const frame = document.createElement("iframe"); frame.title = w.name; frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups"); frame.referrerPolicy = "strict-origin-when-cross-origin"; frame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
        if (w.kind === "url") { if (validWidgetUrl(w.content)) frame.src = w.content; else frame.srcdoc = "Некорректный URL"; } else frame.srcdoc = w.content;
        host.appendChild(frame);
      }
    }
  }
  const ELEMENT_VARIANTS = [
    ["default", "Стандартный"],
    ["compact", "Компактный"],
    ["prominent", "Выразительный"],
    ["ghost", "Прозрачный"]
  ];
  const UI_PRESETS = [
    ["omnispec", "OmniSpec", "Тёмный плотный лаунчер с зелёным акцентом"],
    ["prism", "Prism Launcher", "Сборки в рабочей области, вкладки справа"],
    ["modrinth", "Modrinth", "Компактные иконки страниц слева"],
    ["custom", "Полностью кастомный", "Только твои параметры и CSS"]
  ];
  const CSS_PRESETS = {
    clean: {
      label: "Чистый минимализм",
      css: `/* Минималистичная тема OmniSpec */
[data-os="sidebar"] { background: color-mix(in srgb, var(--bg-2) 82%, var(--accent) 18%); }
[data-os="build-card"] { border-radius: var(--r); transition: transform .18s ease, border-color .18s ease, background .18s ease; }
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
[data-os-element-mode="absolute"] { position: fixed !important; box-sizing: border-box; z-index: 3; max-width: none; max-height: none; }
body[data-ui-independent="true"] .app-body > .sidebar, body[data-ui-independent="true"] .app-body > .main { background: transparent; border-color: transparent; }
/* Разделители исходных контейнеров не должны оставлять линии между независимыми блоками. */
body[data-ui-independent="true"] .app :is(.account-chip, .sidebar-foot, .toolbar, .tabs, .build-path) { border-color: transparent; }
body[data-ui-independent="true"] .app .account-chip:hover { border-color: transparent; }
.account-chip.is-avatar-only { justify-content: center; min-width: 0; overflow: hidden; padding-inline: 0; gap: 0; }
.account-chip.is-avatar-only .acc-main, .account-chip.is-avatar-only .chev { display: none; }
[data-os-element-variant="compact"] { --os-element-scale: .94; font-size: calc(100% * var(--os-element-scale)); }
[data-os-element-variant="prominent"] { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 10px 24px color-mix(in srgb, var(--accent) 12%, transparent); }
[data-os-element-variant="ghost"] { background: transparent !important; border-color: transparent !important; box-shadow: none !important; }
/* Навигация и рабочая область — отдельные настоящие DOM-элементы.
   Вертикальный режим оставляет шапку и путь над обеими колонками. */
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) {
  display: grid; grid-template-columns: minmax(112px, 152px) minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr); min-height: 0;
}
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .toolbar { grid-column: 1 / -1; grid-row: 1; }
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .build-path { grid-column: 1 / -1; grid-row: 2; }
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .tabs {
  grid-column: 1; grid-row: 3; width: auto; height: auto; min-height: 0;
  flex-direction: column; align-items: stretch; overflow-x: hidden; overflow-y: auto;
  border-bottom: 0; border-right: 1px solid var(--line); padding: 6px;
}
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .tabs .tab { min-height: 34px; justify-content: flex-start; border-radius: var(--r-sm); }
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .tabs .tab.is-active::after { left: 0; top: 5px; bottom: 5px; right: auto; width: 2px; height: auto; }
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .tabs .tabs-fill { flex: 0 0 4px; }
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .tabs .progress { max-width: 100%; overflow: hidden; }
.main:is([data-tabs-orientation="vertical"], [data-tabs-orientation="vertical-right"]) > .tab-body { grid-column: 2; grid-row: 3; min-width: 0; min-height: 0; }
.main[data-tabs-hidden="true"][data-tabs-orientation="vertical"] { grid-template-columns: 0 minmax(0, 1fr); }
/* Правая панель страниц для Prism и компактная навигация Modrinth. */
.main[data-tabs-orientation="vertical-right"] { grid-template-columns: minmax(0, 1fr) minmax(112px, 152px); }
.main[data-tabs-orientation="vertical-right"] > .tabs { grid-column: 2; border-right: 0; border-left: 1px solid var(--line); }
.main[data-tabs-orientation="vertical-right"] > .tab-body { grid-column: 1; }
.main[data-tabs-hidden="true"][data-tabs-orientation="vertical-right"] { grid-template-columns: minmax(0, 1fr) 0; }
body[data-ui-preset="modrinth"] .main[data-tabs-orientation="vertical"] { grid-template-columns: 58px minmax(0, 1fr); }
body[data-ui-preset="modrinth"] .main[data-tabs-orientation="vertical"] > .tabs .tab { justify-content: center; min-width: 0; padding: 9px; }
body[data-ui-preset="modrinth"] .tabs .tab-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
body[data-ui-preset="modrinth"] .tabs .tab-icon { display: block; width: 19px; height: 19px; }
body[data-ui-preset="modrinth"] .tabs .tab-badge { position: absolute; top: 0; right: 0; }
/* Prism: каталог сборок в центре и выбранная сборка справа.
   Modrinth: навигация слева и широкая страница выбранного профиля. */
body[data-ui-preset="prism"] .app-body > .sidebar {
  order: 1; flex: 1 1 50% !important; width: auto !important; min-width: 0; overflow: hidden; background: #202124;
}
body[data-ui-preset="prism"] .app-body > .main {
  order: 2; flex: 1 1 50%; width: 50%; min-width: 0; border-left: 1px solid var(--line);
}
body[data-ui-preset="prism"] :is(.sidebar, .workspace-library) .cat:not(.cat-running) > .cat-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 4px; padding: 5px; }
body[data-ui-preset="prism"] :is(.sidebar, .workspace-library) .cat:not(.cat-running):not(.is-open) > .cat-items { display: none; }
body[data-ui-preset="prism"] :is(.sidebar, .workspace-library) .cat:not(.cat-running) .instance { display: flex; flex-direction: column; align-items: center; text-align: center; min-height: 86px; padding: 6px; border-radius: var(--r-sm); }
body[data-ui-preset="prism"] :is(.sidebar, .workspace-library) .cat:not(.cat-running) .instance-icon { width: 48px; height: 48px; }
body[data-ui-preset="prism"] :is(.sidebar, .workspace-library) .cat:not(.cat-running) .instance-body { width: 100%; }
body[data-ui-preset="prism"] :is(.sidebar, .workspace-library) .cat:not(.cat-running) .instance-time { display: none; }
body[data-ui-preset="prism"][data-merged-workspace="true"] .app-body > .sidebar { flex: 0 0 220px !important; width: 220px !important; }
body[data-ui-preset="prism"][data-merged-workspace="true"] .app-body > .main { flex: 1 1 0; width: auto; }
body[data-ui-preset="prism"] .main .toolbar { flex-wrap: wrap; height: auto; min-height: 70px; }
body[data-ui-preset="prism"] { --accent: #7fa7ff; }
body[data-ui-preset="modrinth"] { --accent: #1bd96a; }
body[data-ui-preset="modrinth"] .app-body > .sidebar { order: 1; flex: 0 0 240px; width: 240px; min-width: 0; background: #16181c; }
body[data-ui-preset="modrinth"] .app-body > .main { order: 2; flex: 1 1 0; min-width: 0; }
body[data-ui-preset="modrinth"] .sidebar .instance { border-radius: var(--r); background: #25282c; border: 1px solid #35383e; }
body[data-ui-preset="modrinth"] .sidebar .instance-icon { width: 36px; height: 36px; }
body[data-ui-preset="modrinth"] .toolbar { min-height: 62px; background: #1c1e22; }
body[data-ui-preset="modrinth"] .tabs { background: #1c1e22; }
body[data-ui-preset="modrinth"] .tab.is-active { background: #30343a; color: #1bd96a; }
.customizer-box { width: min(1180px, 97vw); height: min(820px, 94vh); }
.customizer-backdrop { place-items: stretch; padding: 12px; box-sizing: border-box; }
.customizer-backdrop .customizer-box { width: 100%; max-width: none; height: 100%; max-height: none; min-height: 0; border-radius: var(--r-lg); }
body[data-customizer-open="true"] { overflow: hidden; }
.customizer-inline-root { display: flex; flex-direction: column; min-height: 0; height: 100%; }
/* Раскладка карточек работает независимо от выбранного пресета. */
body :is(.app, .visual-snapshot) .instance-list[data-build-size="custom"][data-build-view="default"] .instance { min-height: var(--os-build-list-height); }
body :is(.app, .visual-snapshot) .instance-list[data-build-size="custom"][data-build-view="default"] .instance-icon { width: var(--os-build-list-icon); height: var(--os-build-list-icon); }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .cat.is-open > .cat-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--os-build-card-size, 76px)), 1fr)); gap: 5px; padding: 4px; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .cat:not(.is-open) > .cat-items { display: none; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .instance { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: var(--os-build-card-height, 72px); padding: 5px; text-align: center; gap: 4px; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .instance-icon { width: var(--os-build-card-icon, 32px); height: var(--os-build-card-icon, 32px); margin: 0; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .instance-body { width: 100%; flex: none; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .instance-sub, body :is(.app, .visual-snapshot) .instance-list[data-build-view="grid"] .instance-time { display: none; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="list"] .cat.is-open > .cat-items { display: flex; flex-direction: column; gap: 2px; padding: 0 0 0 4px; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="list"] .cat:not(.is-open) > .cat-items { display: none; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="list"] .instance { flex-direction: row; text-align: left; align-items: center; min-height: var(--os-build-list-height, 38px); padding: 5px 7px; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="list"] .instance-icon { width: var(--os-build-list-icon, 28px); height: var(--os-build-list-icon, 28px); }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="list"] .instance-body { width: auto; }
body :is(.app, .visual-snapshot) .instance-list[data-build-view="list"] .instance-time { display: block; }
body :is(.app, .visual-snapshot) .instance-list.is-narrow[data-build-view="list"] .instance-time { display: none; }
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
.ui-preset img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: var(--r-sm); margin-bottom: 7px; }
.ui-preset strong, .ui-preset small { display: block; }
.ui-preset strong { font-size: 11.5px; }
.ui-preset small { margin-top: 5px; color: var(--dim-2); font-size: 9.5px; line-height: 1.3; }
.os-custom-widget { background: var(--bg-2); overflow: hidden; }
.os-custom-widget > iframe { width: 100%; height: 100%; border: 0; display: block; }
.visual-editor { display: grid; grid-template-columns: 190px minmax(360px, 1fr) 235px; gap: 10px; min-height: 440px; }
.visual-panel { min-width: 0; padding: 9px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-2); }
.visual-panel-title { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; color: var(--dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.visual-element-row { display: flex; align-items: center; gap: 3px; }
.visual-element-row .visual-element { flex: 1; min-width: 0; }
.visual-visibility { flex: none; padding: 4px 5px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-3); color: var(--dim); font-size: 9px; cursor: pointer; }
.visual-visibility:hover { color: var(--text); border-color: var(--line-2); }
.visual-add-widget { width: 100%; min-width: 0; padding: 4px 6px; font-size: 10px; white-space: normal; }
.visual-element-list { display: flex; flex-direction: column; gap: 4px; min-height: 0; overflow: visible; }
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
.visual-stage-inner { position: relative; width: 100%; min-width: 0; min-height: 1px; border: 1px dashed var(--line-2); border-radius: var(--r-sm); background-color: var(--bg-2); background-image: linear-gradient(to right, #ffffff19 1px, transparent 1px), linear-gradient(to bottom, #ffffff19 1px, transparent 1px); }
.visual-stage-inner[data-grid="off"] { background-image: none; }
.visual-canvas-item { overflow: hidden; touch-action: none; position: absolute; z-index: 0; display: block; min-width: 0; min-height: 0; padding: 0; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: var(--r-sm); background: transparent; color: var(--text); font-size: 10px; cursor: grab; user-select: none; }
.visual-canvas-item:hover, .visual-canvas-item.is-selected { z-index: 20; border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
.visual-canvas-item.is-selected { z-index: 30; }
.visual-canvas-item:active { cursor: grabbing; }
.visual-canvas-item .visual-snapshot { position: absolute; left: 0; top: 0; transform-origin: top left; pointer-events: none; overflow: hidden; }
.visual-canvas-item .visual-snapshot > * { max-width: 100%; }
.visual-resize { position: absolute; z-index: 30; touch-action: none; }
.visual-resize[data-edge="n"], .visual-resize[data-edge="s"] { left: 8px; right: 8px; height: 8px; cursor: ns-resize; }
.visual-resize[data-edge="e"], .visual-resize[data-edge="w"] { top: 8px; bottom: 8px; width: 8px; cursor: ew-resize; }
.visual-resize[data-edge="n"] { top: 0; } .visual-resize[data-edge="s"] { bottom: 0; }
.visual-resize[data-edge="e"] { right: 0; } .visual-resize[data-edge="w"] { left: 0; }
.visual-resize[data-edge="nw"], .visual-resize[data-edge="ne"], .visual-resize[data-edge="sw"], .visual-resize[data-edge="se"] { width: 12px; height: 12px; }
.visual-resize[data-edge="nw"] { left: 0; top: 0; cursor: nwse-resize; } .visual-resize[data-edge="ne"] { right: 0; top: 0; cursor: nesw-resize; }
.visual-resize[data-edge="sw"] { left: 0; bottom: 0; cursor: nesw-resize; } .visual-resize[data-edge="se"] { right: 0; bottom: 0; cursor: nwse-resize; }
.visual-canvas-item .visual-label { position: absolute; bottom: 0; right: 0; font-size: 9px; background: var(--bg-2); padding: 2px 4px; opacity: .8; }
.visual-canvas-item.is-hidden { opacity: .3; border-style: dashed; }
.visual-canvas-item .ic { width: 13px; height: 13px; flex: none; }
.sidebar-quick.is-icon-only, .sidebar-new.is-icon-only { min-width: 0; overflow: hidden; justify-content: center; padding-inline: 0; }
.sidebar-quick.is-icon-only > span, .sidebar-new.is-icon-only > span { display: none; }
.visual-stage-help { margin-top: 6px; color: var(--dim-2); font-size: 9.5px; line-height: 1.4; }
.visual-properties { display: flex; flex-direction: column; gap: 7px; }
.visual-properties .customizer-control { display: grid; grid-template-columns: 1fr 82px; gap: 6px; padding: 7px; }
/* Компактный список учитывает ширину именно списка, в том числе отдельно от сайдбара. */
.instance-list.is-narrow .instance-body, .instance-list.is-narrow .instance-time { display: none; }
.instance-list.is-narrow .instance { justify-content: center; align-items: center; gap: 0; padding: 4px; min-width: 0; }
.instance-list.is-narrow .instance-icon { margin: 0; }
.instance-list.is-narrow .instance-running { position: absolute; right: 4px; bottom: 4px; }
.instance-list.is-narrow .cat-name, .instance-list.is-narrow .cat-head .spacer, .instance-list.is-narrow .cat-head .cat-act, .instance-list.is-narrow .cat-dynamic-icon { display: none; }
.instance-list.is-narrow .cat-head { justify-content: center; gap: 4px; padding-inline: 1px; }
.instance-list.is-narrow .cat-items { padding-left: 0; }
body .instance-list.is-narrow .cat.is-open:not(.cat-running) > .cat-items { display: flex; flex-direction: column; }
body .instance-list.is-narrow .cat:not(.cat-running) .instance { flex-direction: row; }
body .instance-list.is-narrow .cat:not(.cat-running) .instance-icon { width: 28px; height: 28px; }
.instance-list.is-narrow .instance-dup { overflow: hidden; }
.instance-list.is-narrow .dup-name, .instance-list.is-narrow .dup-sep, .instance-list.is-narrow .dup-account { display: none; }
.visual-properties .customizer-control.visual-select-control { grid-template-columns: minmax(0, 1fr); }
.visual-properties .customizer-control.visual-select-control select { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; }
.visual-properties .customizer-control strong { font-size: 10.5px; }
.visual-properties .customizer-control small { font-size: 9px; }
.visual-properties .customizer-control input[type="range"] { min-width: 0; width: 100%; }
.visual-properties .customizer-control output { min-width: 42px; font-size: 10px; }
.visual-properties .customizer-control input[type="number"] { width: 82px; min-width: 0; background: var(--bg-3); color: var(--text); border: 1px solid var(--line-2); border-radius: 4px; padding: 3px; }
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
@media (max-width: 720px) { .ui-preset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .visual-editor { grid-template-columns: 1fr; } .visual-properties { display: flex; } .visual-stage-inner { min-width: 0; } .customizer-grid { grid-template-columns: 1fr; } }
`;

  let styleEl = null;
  let userStyleEl = null;
  let replacementStyleEl = null;
  let originalCss = null;
  let originalCssPromise = null;
  let cssFullMode = false;
  let modal = null;
  let inlineHost = null;
  let currentTab = "editor";
  let selectedElementId = "toolbar";
  let layout = { ...DEFAULT_LAYOUT };
  let customCss = "";
  let safeMode = false;
  let themeModules = [];
  let folderThemeScan = null;
  let scriptModules = [];
  const scriptSessions = new Map();
  const SCRIPT_APPROVAL_KEY = "omnispec-script-autostart-approvals-v1";
  let autostartInitialized = false;
  const approvedScripts = new Map();
  const trustedScriptRuns = new Set();
  let themeStyleEl = null;
  let effectGuardEl = null;
  let settings = null;
  let saveQueue = Promise.resolve();
  let saveTimer = 0;
  let statusTimer = 0;
  let dragId = null;
  let pointerDrag = null;
  let gridSize = 16;
  let suppressClick = false;
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
      mode: ["free", "absolute"].includes(source.mode) ? source.mode : "flow",
      x: number("x", -32768, 32767, 0),
      y: number("y", -32768, 32767, 0),
      width: optional("width", 0, 65535),
      height: optional("height", 0, 65535),
      margin: number("margin", 0, 40, 0),
      padding: number("padding", 0, 40, 0),
      radius: number("radius", 0, 40, 0),
      variant: ELEMENT_VARIANTS.some(([id]) => id === source.variant) ? source.variant : "default",
      surface_opacity: optional("surface_opacity", 0, 100),
      backdrop_blur: optional("backdrop_blur", 0, 40),
      surface_radius: optional("surface_radius", 0, 80),
      build_card_size: optional("build_card_size", 48, 180),
      tabs_orientation: ["vertical", "vertical-right"].includes(source.tabs_orientation) ? source.tabs_orientation : "horizontal",
      merged_workspace: source.merged_workspace === true,
      list_view: ["list", "grid"].includes(source.list_view) ? source.list_view : "default"
    };
  }

  function normalizeLayout(value) {
    const source = value && typeof value === "object" ? value : {};
    const order = Array.isArray(source.main_order) ? source.main_order : DEFAULT_LAYOUT.main_order;
    const cleanOrder = [...new Set(order.filter((item) => ORDER_ITEMS.some(([id]) => id === item)))];
    for (const [id] of ORDER_ITEMS) if (!cleanOrder.includes(id)) cleanOrder.push(id);
    const hidden = Array.isArray(source.hidden) ? [...new Set(source.hidden.filter((item) => ["sidebar", "toolbar", "tabs"].includes(item)))] : [];
    const density = DENSITIES[source.density] ? source.density : DEFAULT_LAYOUT.density;
    const customWidgets = normalizeWidgets(source.custom_widgets);
    widgetSpecs(customWidgets);
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
      custom_widgets: customWidgets,
      elements: ELEMENTS.map((spec) => normalizeElement(byId.get(spec.id) || (spec.customWidget ? { mode: "absolute", x: 100, y: 100, width: 400, height: 240 } : {}), spec))
    };
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
  }
  function currentSettings() { return appState()?.settings || settings || {}; }

  function confirmChange(text, ok = "Применить") { return window.omnispecDialogs?.confirm({ title: "Подтверждение", text, ok, danger: true }) ?? Promise.resolve(false); }

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

  function isFullCss(css) { return css.startsWith(FULL_CSS_MARKER); }
  async function getOriginalCss() {
    if (originalCss !== null) return originalCss;
    if (!originalCssPromise) originalCssPromise = fetch("styles.css").then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }).then((text) => { originalCss = text; return text; }).catch((error) => {
      originalCssPromise = null; throw error;
    });
    return originalCssPromise;
  }
  // Цвета выбранной темы задаются inline на :root и иначе перекрывают обычный
  // пользовательский CSS. Приоритет даём только тем переменным, которыми
  // управляет движок темы; остальные CSS-правила не меняем.
  const THEME_ROOT_TOKENS = new Set(["--bg","--bg-2","--bg-3","--bg-4","--bg-5","--line","--line-2","--line-3","--text","--dim","--dim-2","--accent","--accent-2","--accent-fg","--accent-soft","--green","--red","--yellow","--blue","--catalog-modrinth","--catalog-curseforge","--console-bg","--bg-elev","--panel","--panel-2","--panel-3","--border","--border-soft","--border-strong","--hover","--text-dim","--muted","--bg-1a","--bg-2a","--bg-3a"]);
  function prioritizeUserRootTokens(style) {
    const walk = rules => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules);
        if (!rule.selectorText || !rule.style || !rule.selectorText.split(",").some(x => [":root", "html"].includes(x.trim()))) continue;
        for (const key of [...rule.style]) if (THEME_ROOT_TOKENS.has(key)) rule.style.setProperty(key, rule.style.getPropertyValue(key), "important");
      }
    };
    try { if (style?.sheet) walk(style.sheet.cssRules); } catch { /* WebView CSSOM */ }
  }
  function injectStyles() {
    if (!styleEl) { styleEl = document.createElement("style"); styleEl.id = "omnispec-customizer-base-style"; document.head.appendChild(styleEl); }
    styleEl.textContent = BASE_CSS;
    if (!userStyleEl) { userStyleEl = document.createElement("style"); userStyleEl.id = "omnispec-custom-css"; document.head.appendChild(userStyleEl); }
    const baseLink = document.querySelector('link[rel="stylesheet"][href="styles.css"]');
    if (baseLink && !replacementStyleEl) {
      replacementStyleEl = document.createElement("style");
      replacementStyleEl.id = "omnispec-replacement-base-css";
      baseLink.after(replacementStyleEl);
    }
    const full = !safeMode && isFullCss(customCss);
    if (baseLink && replacementStyleEl) {
      replacementStyleEl.textContent = full ? sanitizeCss(customCss.slice(FULL_CSS_MARKER.length)) : "";
      baseLink.disabled = full;
    }
    userStyleEl.textContent = safeMode || full ? "" : sanitizeCss(customCss);
    prioritizeUserRootTokens(userStyleEl);
    if (full) prioritizeUserRootTokens(replacementStyleEl);
    if (!themeStyleEl) { themeStyleEl = document.createElement("style"); themeStyleEl.id = "omnispec-theme-modules"; document.head.appendChild(themeStyleEl); }
    themeStyleEl.textContent = (safeMode ? [] : themeModules.filter(m => m.enabled)).map(m => sanitizeCss(m.css)).join("\n");
    prioritizeUserRootTokens(themeStyleEl);
    // Защита слоёв работает также при полной замене базового CSS.
    if (!effectGuardEl) { effectGuardEl = document.createElement("style"); effectGuardEl.id = "omnispec-effect-guard"; document.head.appendChild(effectGuardEl); }
    effectGuardEl.textContent = `
      #css-effect-overlay { position: fixed; inset: 0; z-index: 4998; overflow: hidden; pointer-events: none !important; }
      #css-effect-overlay > .css-effect-layer { position: absolute; inset: 0; pointer-events: none !important; }
      #css-effect-overlay *, #css-effect-overlay *::before, #css-effect-overlay *::after, #css-effect-overlay::before, #css-effect-overlay::after { pointer-events: none !important; }
      body[data-window-hidden="true"] #css-effect-overlay, body[data-window-hidden="true"] #css-effect-overlay *, body[data-window-hidden="true"] #css-effect-overlay::before, body[data-window-hidden="true"] #css-effect-overlay::after, body[data-window-hidden="true"] #css-effect-overlay *::before, body[data-window-hidden="true"] #css-effect-overlay *::after { animation-play-state: paused !important; }
      @media (prefers-reduced-motion: reduce) { #css-effect-overlay, #css-effect-overlay *, #css-effect-overlay::before, #css-effect-overlay::after, #css-effect-overlay *::before, #css-effect-overlay *::after { animation-play-state: paused !important; } }
    `;
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
    if (spec.id === "content") return [$(".tab-body"), $("#workspace-library-body")].filter(Boolean);
    if (spec.id === "build-search") {
      const input = $("#instance-search");
      return input?.parentElement ? [input.parentElement] : [];
    }
    if (spec.id === "account") { const node = $("#account-chip"); return node ? [node] : []; }
    return $$(spec.selector, $(".app"));
  }
  function elementState(id) { return layout.elements.find((item) => item.id === id) || normalizeElement({}, ELEMENTS.find((item) => item.id === id)); }

  const originalSurfaceStyles = new WeakMap();
  const originalBlurStyles = new WeakMap();
  const originalRadiusStyles = new WeakMap();
  function saveInlineStyles(map, element, properties) {
    if (!map.has(element)) map.set(element, properties.map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]));
  }
  function restoreInlineStyles(map, element) {
    const saved = map.get(element);
    if (!saved) return;
    saved.forEach(([name, value, priority]) => value ? element.style.setProperty(name, value, priority) : element.style.removeProperty(name));
    map.delete(element);
  }
  function applyElement(spec, value) {
    elementNodes(spec).forEach((node) => {
      const element = node;
      element.dataset.osElement = spec.id;
      element.dataset.osElementMode = value.mode;
      element.dataset.osElementVariant = value.variant;
      element.dataset.osElementHidden = value.visible ? "false" : "true";
      if (spec.id === "build-list") {
        element.dataset.buildView = value.list_view;
        const n = value.build_card_size;
        element.dataset.buildSize = n ? "custom" : "default";
        for (const [key, v] of Object.entries({"--os-build-card-size": n, "--os-build-card-height": n && Math.round(n * .95), "--os-build-card-icon": n && Math.round(n * .42), "--os-build-list-height": n && Math.round(n * .65), "--os-build-list-icon": n && Math.round(n * .45)})) {
          if (v) element.style.setProperty(key, `${v}px`); else element.style.removeProperty(key);
        }
      }
      if (value.surface_radius !== null) {
        saveInlineStyles(originalRadiusStyles, element, ["border-radius"]);
        element.style.setProperty("border-radius", `${value.surface_radius}px`, "important");
      } else restoreInlineStyles(originalRadiusStyles, element);
      if (value.surface_opacity === null) {
        restoreInlineStyles(originalSurfaceStyles, element);
      } else {
        saveInlineStyles(originalSurfaceStyles, element, ["background-color", "background-image"]);
        element.style.setProperty("background-color", `color-mix(in srgb, var(--bg-2) ${value.surface_opacity}%, transparent)`, "important");
        element.style.setProperty("background-image", "none", "important");
      }
      if (value.backdrop_blur === null) {
        restoreInlineStyles(originalBlurStyles, element);
      } else {
        saveInlineStyles(originalBlurStyles, element, ["backdrop-filter", "-webkit-backdrop-filter"]);
        element.style.setProperty("backdrop-filter", `blur(${value.backdrop_blur}px)`, "important");
        element.style.setProperty("-webkit-backdrop-filter", `blur(${value.backdrop_blur}px)`, "important");
      }
      if (spec.hideOnly) return;
      element.style.width = value.width ? `${value.width}px` : "";
      element.style.height = value.height ? `${value.height}px` : "";
      element.style.flexShrink = value.width || value.height ? "0" : "";
      element.style.margin = value.mode === "absolute" || value.margin ? `${value.margin}px` : "";
      element.style.padding = value.padding ? `${value.padding}px` : "";
      if (value.surface_radius === null) element.style.borderRadius = value.radius ? `${value.radius}px` : "";
      element.style.transform = value.mode === "free" && (value.x || value.y) ? `translate(${value.x}px, ${value.y}px)` : "";
      element.style.left = value.mode === "absolute" ? `${value.x}px` : "";
      element.style.top = value.mode === "absolute" ? `${value.y}px` : "";
    });
  }
  function applyElements() { ELEMENTS.forEach((spec) => applyElement(spec, elementState(spec.id))); }

  function applyLayout(next = layout) {
    layout = normalizeLayout(next);
    const body = document.body;
    const appBody = $(".app-body"); const sidebar = $(".sidebar"); const main = $(".main");
    if (!body || !appBody || !sidebar || !main) return;
    const savedLayout = safeMode ? layout : null;
    if (safeMode) layout = normalizeLayout(DEFAULT_LAYOUT);
    const density = DENSITIES[layout.density] || DENSITIES.comfortable;
    const root = document.documentElement;
    root.style.setProperty("--os-sidebar-width", `${layout.sidebar_width}px`);
    root.style.setProperty("--os-main-gap", `${layout.main_gap}px`);
    root.style.setProperty("--os-card-gap", `${density.gap}px`);
    root.style.setProperty("--os-card-pad", `${density.pad}px`);
    root.style.setProperty("--os-panel-pad", `${density.panel}px`);
    body.dataset.layoutDensity = layout.density;
    body.dataset.uiPreset = layout.preset;
    body.dataset.uiIndependent = String(layout.elements.some((item) => item.mode === "absolute" && !item.id.startsWith("widget-")));
    main.dataset.tabsOrientation = elementState("tabs").tabs_orientation;
    const merged = elementState("build-list").merged_workspace;
    if (body.dataset.mergedWorkspace !== String(merged)) {
      body.dataset.mergedWorkspace = String(merged);
      window.dispatchEvent(new CustomEvent("omnispec-workspace-layout", { detail: { merged } }));
    }
    main.dataset.tabsHidden = String(layout.hidden.includes("tabs") || !elementState("tabs").visible);
    appBody.dataset.customSidebarSide = layout.sidebar_side;
    sidebar.style.width = `${layout.sidebar_width}px`; sidebar.style.flexBasis = `${layout.sidebar_width}px`;
    main.style.padding = `${layout.main_padding}px`; main.style.gap = `${layout.main_gap}px`;
    const order = Object.fromEntries(layout.main_order.map((id, index) => [id, index + 1]));
    const toolbar = $(".toolbar"); const tabs = $(".tabs"); const content = $(".tab-body"); const path = $(".build-path");
    if (toolbar) toolbar.style.order = String(order.toolbar || 1);
    if (path) path.style.order = String((order.toolbar || 1) + 1);
    if (tabs) tabs.style.order = String(order.tabs || 2);
    if (content) content.style.order = String(order.content || 3);
    const library = $("#workspace-library-body"); if (library) library.style.order = String(order.content || 3);
    const hidden = new Set(layout.hidden);
    [[sidebar, "sidebar"], [toolbar, "toolbar"], [tabs, "tabs"]].forEach(([element, id]) => { if (element) element.dataset.customHidden = hidden.has(id) ? "true" : "false"; });
    syncWidgets(); markUi(); applyElements();
    if (savedLayout) layout = normalizeLayout(savedLayout);
  }

  async function loadSettings() {
    const local = readLocal(); const state = appState();
    let loaded = state?.settings || null;
    if (!loaded) {
      try { const invoke = window.__TAURI__?.core?.invoke; loaded = invoke ? await invoke("get_settings") : null; } catch { loaded = null; }
    }
    const source = { ...local, ...(loaded || {}) };
    settings = source || {};
    safeMode = settings.ui_safe_mode === true;
    layout = normalizeLayout(settings.ui_layout || local.ui_layout);
    customCss = String(settings.custom_css ?? local.custom_css ?? "");
    themeModules = normalizeModules(settings.ui_theme_modules ?? local.ui_theme_modules);
    scriptModules = normalizeScripts(settings.ui_script_modules ?? local.ui_script_modules);
    if (state && !state.settings) state.settings = { ...settings };
    injectStyles(); applyLayout(); markUi();
    syncFolderThemes().catch(() => {});
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
    clearTimeout(saveTimer);
    const next = stageSettings(patch);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readLocal(), custom_css: customCss, ui_layout: layout, ui_theme_modules: themeModules, ui_script_modules: scriptModules })); } catch { /* hardened webview */ }
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const invoke = window.__TAURI__?.core?.invoke; if (!invoke) return;
      await invoke("save_settings", { settings: next });
    }).then(() => setStatus("Сохранено", "saved"), (error) => setStatus(`Не удалось сохранить: ${error}`, "error"));
    return saveQueue;
  }
  function queueSaveSoon(patch) {
    stageSettings(patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { queueSave({ custom_css: customCss, ui_layout: layout }); }, 500);
  }

  function editorMarkup(inline = false) {
    return `<div class="customizer-inline-root" data-editor-root data-editor-inline="${inline ? "true" : "false"}">
      <header class="${inline ? "customizer-inline-head" : "modal-head"}">
        <div class="customizer-head-copy"><div class="customizer-kicker">OmniSpec Studio · 0.53</div><h2 id="customizer-title">${inline ? "Визуальный редактор интерфейса" : "Тема и раскладка"}</h2></div>
        <div class="customizer-status" data-customizer-status>Изменения сохраняются автоматически</div>
        ${inline ? "" : '<button class="icon-btn" type="button" data-custom-close title="Закрыть"><svg class="ic"><use href="#i-close"/></svg></button>'}
      </header>
      <div class="customizer-tabs" role="tablist">
        <button class="customizer-tab" data-custom-tab="editor" role="tab">Визуальный редактор</button>
        <button class="customizer-tab" data-custom-tab="presets" role="tab">Пресеты</button>
        <button class="customizer-tab" data-custom-tab="layout" role="tab">Крупные области</button>
        <button class="customizer-tab" data-custom-tab="css" role="tab">CSS-код</button>
      </div>
      <div class="customizer-body" data-customizer-body></div>
      <footer class="customizer-footer"><span class="hint">Перетаскивай элементы мышью.</span><div class="customizer-footer-actions"><button class="btn btn-ghost" type="button" data-custom-reset>Сбросить конструктор</button>${inline ? "" : '<button class="btn btn-primary" type="button" data-custom-close>Готово</button>'}</div></footer>
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

  let visualContextCleanup = null;
  function closeVisualContext() { if (visualContextCleanup) visualContextCleanup(); }
  function showWorkspaceContext(event) {
    closeVisualContext();
    const menu = document.createElement("div");
    menu.className = "visual-context-menu"; menu.setAttribute("role", "menu");
    menu.innerHTML = `<button type="button" role="menuitemcheckbox" aria-checked="${elementState("build-list").merged_workspace}" data-merge-workspace><span class="visual-context-check" aria-hidden="true">${elementState("build-list").merged_workspace ? "✓" : ""}</span><span>Объединить с каталогом сборок</span></button>`;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4))}px`;
    const outside = e => { if (!menu.contains(e.target)) closeVisualContext(); };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeVisualContext(); } };
    visualContextCleanup = () => { menu.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", onKey, true); visualContextCleanup = null; };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    menu.querySelector("button").addEventListener("click", () => {
      const next = !elementState("build-list").merged_workspace;
      selectedElementId = "content";
      closeVisualContext();
      updateElementValues("build-list", { merged_workspace: next }, true);
      setStatus(next ? "Каталог объединён с рабочей областью" : "Каталог снова отдельно", "saved");
    });
    menu.querySelector("button").focus();
  }

  function bindEditorEvents(root) {
    if (!root || root.dataset.editorBound) return;
    root.dataset.editorBound = "true";
    root.addEventListener("contextmenu", event => {
      const item = event.target.closest?.('[data-visual-id="content"]');
      if (!item || !root.contains(item)) return;
      event.preventDefault(); event.stopPropagation();
      showWorkspaceContext(event);
    });
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-custom-tab], [data-custom-close], [data-custom-reset], [data-layout-action], [data-css-action], [data-css-preset], [data-ui-preset], [data-visual-id], [data-element-visibility], [data-align-grid], [data-visual-toggle], [data-surface-reset], [data-card-size-reset], [data-widget-action]");
      if (!target || !root.contains(target)) return;
      if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
      if (target.dataset.widgetAction) { handleWidgetAction(target.dataset.widgetAction, root); return; }
      if (target.dataset.customTab) { currentTab = target.dataset.customTab; renderEditor(); return; }
      if (target.dataset.customClose !== undefined) { closeCustomizer(); return; }
      if (target.dataset.customReset !== undefined) { resetCustomizer(); return; }
      if (target.dataset.layoutAction) { handleLayoutAction(target.dataset.layoutAction, target.dataset.layoutId); return; }
      if (target.dataset.cssAction) { handleCssAction(target.dataset.cssAction); return; }
      if (target.dataset.cssPreset) { applyCssPreset(target.dataset.cssPreset); return; }
      if (target.dataset.uiPreset) { applyUiPreset(target.dataset.uiPreset); return; }
      if (target.dataset.alignGrid !== undefined) { alignAllToGrid(); return; }
      if (target.dataset.cardSizeReset !== undefined) { updateElementValues(selectedElementId, { build_card_size: null }, true); return; }
      if (target.dataset.surfaceReset !== undefined) { updateElementValues(selectedElementId, { surface_opacity: null, backdrop_blur: null, surface_radius: null }, true); return; }
      if (target.dataset.visualToggle) {
        selectedElementId = target.dataset.visualToggle;
        updateElement("visible", !elementState(selectedElementId).visible);
        $(`[data-visual-toggle="${selectedElementId}"]`, root)?.focus({ preventScroll: true }); return;
      }
      if (target.dataset.visualId) {
        selectedElementId = target.dataset.visualId; const onCanvas = target.classList.contains("visual-canvas-item");
        renderEditor(); $(`${onCanvas ? ".visual-canvas-item" : ".visual-element"}[data-visual-id="${selectedElementId}"]`, root)?.focus({ preventScroll: true }); return;
      }
      if (target.dataset.elementVisibility) { updateElement("visible", target.dataset.elementVisibility !== "hide"); return; }
    });
    root.addEventListener("input", (event) => {
      const target = event.target;
      if (target.id === "custom-css-editor") {
        customCss = (cssFullMode ? FULL_CSS_MARKER : "") + target.value.slice(0, MAX_CSS - FULL_CSS_MARKER.length);
        injectStyles(); layout.preset = "custom"; applyLayout(); setStatus("Предпросмотр…");
        queueSaveSoon({ custom_css: customCss, ui_layout: layout }); return;
      }
      if (target.dataset.layoutControl) { updateLayoutControl(target.dataset.layoutControl, target.value); return; }
      if (target.dataset.elementControl) updateElement(target.dataset.elementControl, target.value);
      if (target.dataset.elementNumber && target.value !== "") updateElement(target.dataset.elementNumber, target.value);
    });
    root.addEventListener("keydown", (event) => {
      const focused = event.target.closest?.(".visual-canvas-item[data-visual-id], .visual-element[data-visual-id]");
      if (focused && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const spec = ELEMENTS.find(item => item.id === focused.dataset.visualId);
        if (!spec || spec.hideOnly || !elementState(spec.id).visible) return;
        event.preventDefault(); selectedElementId = spec.id;
        freezeIndependent();
        const current = elementState(spec.id);
        if (current.mode !== "absolute") { setStatus("Элемент сейчас не отображается", "error"); return; }
        const step = gridSize || 1;
        const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
        const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
        updateElementValues(spec.id, { ...current, x: current.x + dx, y: current.y + dy }, true);
        const selector = focused.classList.contains("visual-canvas-item") ? ".visual-canvas-item" : ".visual-element";
        $(`${selector}[data-visual-id="${spec.id}"]`, root)?.focus({ preventScroll: true });
        return;
      }
      if (event.target.id === "custom-css-find" && event.key === "Enter") { event.preventDefault(); findCss(root); return; }
      if (event.target.id !== "custom-css-editor") return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); $("#custom-css-find", root)?.focus({ preventScroll: true });
      } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const input = event.target;
        input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); clearTimeout(saveTimer); queueSave({ custom_css: customCss, ui_layout: layout });
      }
    });
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.snapGrid !== undefined) { gridSize = Number(target.value) || 0; try { localStorage.setItem("omnispec-grid-size", String(gridSize)); } catch {} populateSnapshots(root); return; }
      if (target.dataset.layoutSelect) updateLayoutControl(target.dataset.layoutSelect, target.value);
      if (target.dataset.elementSelect) updateElement(target.dataset.elementSelect, target.value);
    });
    root.addEventListener("pointerdown", (event) => {
      const item = event.target.closest?.(".visual-canvas-item[data-visual-id]");
      if (!item || event.button !== 0) return;
      event.preventDefault(); selectedElementId = item.dataset.visualId;
      pointerDrag = { item, id: selectedElementId, pointer: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        left: Number(item.dataset.logicalLeft), top: Number(item.dataset.logicalTop),
        width: Number(item.dataset.logicalWidth), height: Number(item.dataset.logicalHeight),
        factor: Number(item.dataset.screenFactor), stageScale: Number(item.dataset.stageScale),
        edge: event.target.closest?.("[data-edge]")?.dataset.edge || "", before: layout, moved: false };
      item.setPointerCapture(event.pointerId); item.classList.add("is-dragging");
    });
    root.addEventListener("pointermove", (event) => {
      if (!pointerDrag || pointerDrag.pointer !== event.pointerId) return;
      const drag = pointerDrag;
      const dx = (event.clientX - drag.startX) / drag.factor, dy = (event.clientY - drag.startY) / drag.factor;
      if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 2) {
        if (!drag.moved) { freezeIndependent(); drag.moved = true; }
      }
      if (!drag.moved) return;
      const snap = (n) => gridSize ? Math.round(n / gridSize) * gridSize : Math.round(n);
      let left = drag.left, top = drag.top, width = drag.width, height = drag.height;
      const edge = drag.edge;
      if (!edge) { left = snap(drag.left + dx); top = snap(drag.top + dy); }
      else {
        if (edge.includes("e")) width = Math.max(gridSize || 8, snap(drag.width + dx));
        if (edge.includes("s")) height = Math.max(gridSize || 8, snap(drag.height + dy));
        if (edge.includes("w")) { width = Math.max(gridSize || 8, snap(drag.width - dx)); left = snap(drag.left + drag.width - width); }
        if (edge.includes("n")) { height = Math.max(gridSize || 8, snap(drag.height - dy)); top = snap(drag.top + drag.height - height); }
      }
      Object.assign(drag.item.style, { left: `${left * drag.stageScale}px`, top: `${top * drag.stageScale}px`, width: `${width * drag.stageScale}px`, height: `${height * drag.stageScale}px` });
      updateElementValues(drag.id, { mode: "absolute", x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) });
    });
    const finishPointer = (event) => {
      if (!pointerDrag || pointerDrag.pointer !== event.pointerId) return;
      const drag = pointerDrag; pointerDrag = null; drag.item.classList.remove("is-dragging");
      if (drag.moved) { clearTimeout(saveTimer); queueSave({ ui_layout: layout }); }
      suppressClick = drag.moved; renderEditor();
      $(`.visual-canvas-item[data-visual-id="${drag.id}"]`, root)?.focus({ preventScroll: true });
      setTimeout(() => { suppressClick = false; }, 0);
    };
    root.addEventListener("pointerup", finishPointer);
    root.addEventListener("pointercancel", (event) => {
      if (!pointerDrag || pointerDrag.pointer !== event.pointerId) return;
      const before = pointerDrag.before; pointerDrag = null; clearTimeout(saveTimer);
      layout = normalizeLayout(before); applyLayout(); queueSave({ ui_layout: layout }); renderEditor();
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
    body.innerHTML = currentTab === "editor" ? renderVisualEditor() : currentTab === "presets" ? renderPresets() : currentTab === "layout" ? renderLayout() : renderCss();
    if (currentTab === "editor") populateSnapshots(root);
    if (currentTab === "css") { bindFileImport(root); loadCssEditor(root); }
    if (currentTab === "editor") {
      const list = $(".visual-element-list", root), selected = $(`.visual-element[data-visual-id="${selectedElementId}"]`, root);
      if (list && selected) {
        const a = list.getBoundingClientRect(), b = selected.getBoundingClientRect();
        if (b.top < a.top) list.scrollTop -= a.top - b.top;
        else if (b.bottom > a.bottom) list.scrollTop += b.bottom - a.bottom;
      }
    }
  }

  async function loadCssEditor(root) {
    const input = $("#custom-css-editor", root);
    if (!input) return;
    cssFullMode = !customCss || isFullCss(customCss);
    if (isFullCss(customCss)) { input.value = customCss.slice(FULL_CSS_MARKER.length); return; }
    if (customCss) { input.value = customCss; return; }
    input.value = "Загрузка исходного styles.css…"; input.readOnly = true;
    try {
      const source = await getOriginalCss();
      if (!input.isConnected) return;
      if (customCss) { cssFullMode = isFullCss(customCss); input.value = cssFullMode ? customCss.slice(FULL_CSS_MARKER.length) : customCss; input.readOnly = false; return; }
      input.value = source; input.readOnly = false;
      setStatus("Исходный styles.css загружен");
    } catch (error) {
      if (!input.isConnected) return;
      input.value = ""; input.readOnly = false; cssFullMode = false;
      setStatus(`Не удалось загрузить styles.css: ${error.message || error}`, "error");
    }
  }

  // Размеры и координаты берём из реального окна, а не из фиктивной схемы.
  function populateSnapshots(root) {
    const app = $(".app"), stage = $(".visual-stage-inner", root);
    if (!app || !stage) return;
    const appRect = app.getBoundingClientRect();
    if (!appRect.width || !app.offsetWidth) return;
    const zoom = appRect.width / app.offsetWidth;
    const stageWidth = stage.clientWidth;
    const scale = stageWidth / app.offsetWidth;
    const screenFactor = stage.getBoundingClientRect().width / app.offsetWidth;
    stage.style.height = `${app.offsetHeight * scale}px`;
    stage.style.backgroundSize = `${gridSize * scale}px ${gridSize * scale}px`;
    stage.dataset.grid = gridSize ? "on" : "off";
    $$(".visual-canvas-item[data-visual-id]", root).forEach((item) => {
      const spec = ELEMENTS.find((entry) => entry.id === item.dataset.visualId);
      const original = spec && elementNodes(spec).find(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
      item.querySelector(".visual-snapshot")?.remove();
      if (!original) { item.hidden = true; return; }
      const rect = original.getBoundingClientRect();
      if (!rect.width || !rect.height) { item.hidden = true; return; }
      item.hidden = false;
      const left = (rect.left - appRect.left) / zoom, top = (rect.top - appRect.top) / zoom;
      const width = rect.width / zoom, height = rect.height / zoom;
      Object.assign(item.dataset, { logicalLeft: left, logicalTop: top, logicalWidth: width, logicalHeight: height, screenFactor, stageScale: scale });
      Object.assign(item.style, { left: `${left * scale}px`, top: `${top * scale}px`, width: `${width * scale}px`, height: `${height * scale}px` });
      const copy = original.cloneNode(true);
      if (spec.customWidget) { copy.replaceChildren(); copy.textContent = spec.label; }
      if (spec.id === "build-list") copy.classList.toggle("is-narrow", original.clientWidth < 120);
      if (spec.id === "account") copy.classList.toggle("is-avatar-only", original.clientWidth < 110);
      const originals = original.matches(".sidebar-quick, .sidebar-new") ? [original] : [...original.querySelectorAll(".sidebar-quick, .sidebar-new")];
      const copies = copy.matches(".sidebar-quick, .sidebar-new") ? [copy] : [...copy.querySelectorAll(".sidebar-quick, .sidebar-new")];
      copies.forEach((button, index) => button.classList.toggle("is-icon-only", originals[index].clientWidth < 105));
      copy.removeAttribute("id"); copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      copy.querySelectorAll("[autofocus]").forEach((node) => node.removeAttribute("autofocus"));
      copy.removeAttribute("style");
      for (const node of [copy, ...copy.querySelectorAll("[data-os-element]")]) {
        delete node.dataset.osElement; delete node.dataset.osElementMode;
        delete node.dataset.osElementHidden; delete node.dataset.osElementVariant;
      }
      if (elementState(spec.id).surface_opacity !== null) {
        copy.style.setProperty("background-color", `color-mix(in srgb, var(--bg-2) ${elementState(spec.id).surface_opacity}%, transparent)`, "important");
        copy.style.setProperty("background-image", "none", "important");
      }
      if (elementState(spec.id).backdrop_blur !== null) copy.style.setProperty("backdrop-filter", `blur(${elementState(spec.id).backdrop_blur}px)`, "important");
      copy.style.width = "100%"; copy.style.height = "100%"; copy.style.maxWidth = "none"; copy.style.margin = "0";
      const snapshot = document.createElement("div"); snapshot.className = "visual-snapshot";
      Object.assign(snapshot.style, { width: `${width}px`, height: `${height}px`, transform: `scale(${scale})` });
      snapshot.appendChild(copy); item.prepend(snapshot);
    });
  }

  // Сохраняем измеренные геометрии сразу всех видимых областей до перевода
  // в независимое позиционирование: их DOM и обработчики остаются на месте.
  function freezeIndependent() {
    const app = $(".app"), rect = app.getBoundingClientRect(), zoom = rect.width / app.offsetWidth;
    const measured = new Map();
    for (const spec of ELEMENTS) {
      if (spec.hideOnly || elementState(spec.id).mode === "absolute") continue;
      const node = elementNodes(spec).find(el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; }); if (!node) continue;
      const box = node.getBoundingClientRect(); if (!box.width || !box.height) continue;
      measured.set(spec.id, { mode: "absolute", x: Math.round(box.left / zoom), y: Math.round(box.top / zoom),
        width: Math.round(box.width / zoom), height: Math.round(box.height / zoom), margin: 0 });
    }
    layout = normalizeLayout({ ...layout, preset: "custom", elements: layout.elements.map(item => ({ ...item, ...(measured.get(item.id) || {}) })) });
    applyLayout();
  }
  function alignAllToGrid() {
    if (!gridSize) { setStatus("Сначала выбери шаг сетки", "error"); return; }
    freezeIndependent();
    const snap = n => Math.round(n / gridSize) * gridSize;
    layout = normalizeLayout({ ...layout, elements: layout.elements.map(item => item.mode !== "absolute" ? item : ({
      ...item, x: snap(item.x), y: snap(item.y), width: Math.max(gridSize, snap(item.width)), height: Math.max(gridSize, snap(item.height))
    })) });
    applyLayout(); queueSave({ ui_layout: layout }); renderEditor();
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
    if (key === "mode" && rawValue === "absolute") freezeIndependent();
    const current = elementState(selectedElementId); let value = rawValue;
    if (["x", "y", "width", "height", "margin", "padding", "radius", "surface_opacity", "backdrop_blur", "surface_radius", "build_card_size"].includes(key)) value = Number(rawValue);
    if (key === "width" || key === "height") value = Number(rawValue) <= 0 ? null : Number(rawValue);
    if (key === "visible") value = Boolean(rawValue);
    if (key === "merged_workspace") value = rawValue === "true";
    const next = { ...current, [key]: value };
    if ((key === "x" || key === "y") && current.mode !== "absolute") next.mode = "free";
    updateElementValues(selectedElementId, next);
    const modeSelect = $("[data-element-select='mode']", editorRoot());
    if (modeSelect && (key === "x" || key === "y")) modeSelect.value = next.mode;
    const output = $(`#element-value-${key}`, editorRoot()); if (output) output.textContent = key === "width" || key === "height" ? (value ? `${value}px` : "auto") : `${value}${key === "surface_opacity" ? "%" : "px"}`;
    const numeric = $(`[data-element-number="${key}"]`, editorRoot());
    if (numeric && document.activeElement !== numeric) numeric.value = elementState(selectedElementId)[key] ?? 0;
    const slider = $(`[data-element-control="${key}"]`, editorRoot());
    if (slider && document.activeElement !== slider) slider.value = elementState(selectedElementId)[key] ?? 0;
    if (key === "mode" || key === "variant" || key === "visible" || key === "list_view" || key === "tabs_orientation" || key === "merged_workspace") renderEditor();
    else populateSnapshots(editorRoot());
  }

  function applyUiPreset(id) {
    if (!UI_PRESETS.some(([preset]) => preset === id)) return;
    if (id === "custom") layout = normalizeLayout({ ...layout, preset: id });
    else layout = normalizeLayout({ ...DEFAULT_LAYOUT, custom_widgets: layout.custom_widgets, preset: id, density: id === "prism" ? "compact" : "comfortable", elements: [...layout.elements.filter(e => e.id.startsWith("widget-")), { id: "tabs", tabs_orientation: id === "prism" ? "vertical-right" : id === "modrinth" ? "vertical" : "horizontal" }, ...(id === "prism" ? [{ id: "build-list", merged_workspace: true, list_view: "grid" }] : [])] });
    applyLayout(); const saved = queueSave({ ui_layout: layout }); renderEditor();
    setStatus(`Применена раскладка «${UI_PRESETS.find(([preset]) => preset === id)?.[1]}»`, "saved");
    return saved;
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
    clearTimeout(saveTimer); cssFullMode = false; customCss = preset.css; layout.preset = "custom"; injectStyles(); applyLayout(); queueSave({ custom_css: customCss, ui_layout: layout }); renderEditor(); setStatus(`Применена тема «${preset.label}»`, "saved");
  }
  function findCss(root) {
    const input = $("#custom-css-editor", root), search = $("#custom-css-find", root);
    if (!input || !search || !search.value) return;
    const haystack = input.value.toLocaleLowerCase(), needle = search.value.toLocaleLowerCase();
    let index = haystack.indexOf(needle, input.selectionEnd);
    if (index < 0) index = haystack.indexOf(needle);
    if (index < 0) { setStatus("Совпадений нет"); return; }
    input.focus(); input.setSelectionRange(index, index + search.value.length);
    const line = input.value.slice(0, index).split("\n").length;
    input.scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(input).lineHeight));
    setStatus(`Найдено: строка ${line}`);
  }
  async function handleCssAction(action) {
    if (action === "find") { findCss(editorRoot()); return; }
    if (action === "clear") {
      if (!(await confirmChange("Удалить изменения CSS и восстановить исходный стиль?", "Восстановить"))) return;
      clearTimeout(saveTimer); customCss = ""; cssFullMode = true; injectStyles(); queueSave({ custom_css: "" }); renderEditor(); return;
    }
    if (action === "base") {
      if (customCss && !(await confirmChange("Заменить текущий CSS исходным styles.css? Сначала экспортируйте тему, если хотите сохранить изменения.", "Заменить"))) return;
      try {
        const text = await getOriginalCss();
        clearTimeout(saveTimer); cssFullMode = true; customCss = FULL_CSS_MARKER + text;
        injectStyles(); queueSave({ custom_css: customCss }); renderEditor();
      } catch (error) { setStatus(`Не удалось загрузить styles.css: ${error.message || error}`, "error"); }
      return;
    }
    if (action === "download-css") {
      const contents = $("#custom-css-editor", editorRoot())?.value || "";
      const text = cssFullMode ? FULL_CSS_MARKER + contents : contents;
      const url = URL.createObjectURL(new Blob([text], { type: "text/css;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = "omnispec-theme.css"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if (action === "copy") { try { await navigator.clipboard.writeText($("#custom-css-editor", editorRoot())?.value || ""); setStatus("CSS скопирован", "saved"); } catch { setStatus("Не удалось скопировать CSS", "error"); } return; }
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
        const text = await file.text();
        if (text.length > MAX_CSS * 2) throw new Error("файл слишком большой");
        const isCss = /\.css$/i.test(file.name);
        const data = isCss ? { css: text, layout } : JSON.parse(text);
        const incoming = String(data.css ?? data.custom_css ?? "");
        if (incoming.length > MAX_CSS) throw new Error("CSS превышает допустимый размер");
        clearTimeout(saveTimer); customCss = sanitizeCss(incoming); cssFullMode = isFullCss(customCss);
        layout = normalizeLayout(data.layout || data.ui_layout || DEFAULT_LAYOUT); injectStyles(); applyLayout(); queueSave({ custom_css: customCss, ui_layout: layout }); renderEditor(); setStatus(`Тема «${data.name || file.name}» импортирована`, "saved");
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

  async function handleWidgetAction(action, root) {
    const current = layout.custom_widgets.find(w => w.id === selectedElementId);
    if (action === "add") { widgetEditor = { id: "", name: "", kind: "url", content: "", trusted: false }; renderEditor(); return; }
    if (action === "edit" && current) { widgetEditor = { ...current }; renderEditor(); return; }
    if (action === "cancel") { widgetEditor = null; renderEditor(); return; }
    if (action === "delete" && current) {
      if (!await confirmChange("Удалить пользовательский элемент? Исполнявшийся код может продолжать работать до перезапуска приложения.", "Удалить")) return;
      trustedWidgets.delete(current.id); layout = normalizeLayout({ ...layout, custom_widgets: layout.custom_widgets.filter(w => w.id !== current.id), elements: layout.elements.filter(e => e.id !== current.id) }); selectedElementId = "toolbar"; widgetEditor = null; applyLayout(); queueSave({ui_layout: layout}); renderEditor(); return;
    }
    if (action === "save" && widgetEditor) {
      const name = $("[data-widget-name]", root).value.trim().slice(0,80) || "Пользовательский элемент";
      const kind = $("[data-widget-kind]", root).value; const content = $("[data-widget-content]", root).value.trim();
      const trusted = kind === "html" && $("[data-widget-trusted]", root).checked;
      if (!content || content.length > 100000 || (kind === "url" && !validWidgetUrl(content))) { setStatus("Введите HTML или корректный HTTP(S) URL (не более 100 000 символов)", "error"); return; }
      if (trusted && !await confirmChange("ОПАСНО: этот HTML и JavaScript выполняется с полным доступом к интерфейсу и командам лаунчера, может читать или изменять данные и отправлять их в сеть. Даже удаление не останавливает уже запущенный код до перезапуска. Доверяете этому коду? Подтверждение требуется после перезапуска и изменения кода.", "Доверяю и запускаю")) return;
      const id = widgetEditor.id || `widget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
      const w = {id,name,kind,content,trusted}; trustedWidgets.delete(id); if (trusted) trustedWidgets.set(id,content);
      const widgets = layout.custom_widgets.filter(x => x.id !== id); widgets.push(w);
      layout = normalizeLayout({ ...layout, custom_widgets: widgets }); selectedElementId = id; widgetEditor = null; applyLayout(); queueSave({ui_layout: layout}); renderEditor();
    }
  }
  function widgetForm() {
    if (!widgetEditor) return "";
    const w = widgetEditor;
    return `<div class="customizer-note"><strong>${w.id ? "Изменить элемент" : "Добавить пользовательский элемент"}</strong><p>URL или HTML. Сайты могут запрещать встраивание. Код из неизвестных источников опасен.</p><label>Название <input class="input" data-widget-name maxlength="80" value="${esc(w.name)}"></label><label>Тип <select class="select" data-widget-kind><option value="url" ${w.kind === "url" ? "selected" : ""}>URL</option><option value="html" ${w.kind === "html" ? "selected" : ""}>HTML-код</option></select></label><textarea class="customizer-code" style="min-height:150px;width:100%" data-widget-content maxlength="100000" placeholder="https://… или HTML-код">${esc(w.content)}</textarea><label><input type="checkbox" data-widget-trusted ${w.trusted ? "checked" : ""}> Доверенный HTML/JS с полным доступом (опасно)</label><div><button class="btn btn-primary" type="button" data-widget-action="save">Сохранить</button> <button class="btn btn-small" type="button" data-widget-action="cancel">Отмена</button></div></div>`;
  }

  function renderPresets() {
    return `<section class="customizer-section"><div class="customizer-section-head"><svg class="ic"><use href="#i-sliders"/></svg><div><h3>Пресеты</h3><p>Выберите готовую компоновку интерфейса.</p></div></div><div class="ui-preset-grid">${UI_PRESETS.map(([id, label, description]) => `<button type="button" class="ui-preset ${layout.preset === id ? "is-active" : ""}" data-ui-preset="${id}">${id === "custom" ? "" : `<img src="assets/preset-previews/${id}.png" alt="" loading="lazy">`}<strong>${label}</strong><small>${description}</small></button>`).join("")}</div></section>`;
  }

  function renderVisualEditor() {
    const selected = ELEMENTS.find((item) => item.id === selectedElementId) || ELEMENTS[0];
    selectedElementId = selected.id;
    const value = elementState(selected.id);
    const controls = (key, title, description, min, max, unit = "px", raw = value[key] ?? 0) => `<label class="customizer-control"><span><strong>${title}</strong><small>${description}</small></span><input type="range" min="${min}" max="${max}" value="${raw || 0}" data-element-control="${key}"><output id="element-value-${key}">${["surface_opacity", "backdrop_blur", "surface_radius", "build_card_size"].includes(key) && value[key] === null ? "тема" : key === "width" || key === "height" ? (raw ? `${raw}${unit}` : "auto") : `${raw || 0}${unit}`}</output>${["x", "y", "width", "height"].includes(key) ? `<input type="number" data-element-number="${key}" aria-label="${title}, точное значение" min="${key === "x" || key === "y" ? -32768 : 0}" max="${key === "x" || key === "y" ? 32767 : 65535}" value="${raw || 0}">` : ""}</label>`;
    return `<section class="customizer-section"><div class="visual-editor"><div class="visual-panel"><div class="visual-panel-title"><svg class="ic"><use href="#i-list"/></svg>Элементы</div><button class="btn btn-small visual-add-widget" type="button" data-widget-action="add" title="Добавить пользовательский элемент" aria-label="Добавить пользовательский элемент">+ Добавить</button><div class="visual-element-list">${ELEMENTS.map((item) => { const state = elementState(item.id); return `<div class="visual-element-row"><button type="button" class="visual-element ${selected.id === item.id ? "is-selected" : ""} ${state.visible ? "" : "is-hidden"}" data-visual-id="${item.id}"><svg class="ic"><use href="#i-dots"/></svg><span class="visual-element-copy"><strong>${esc(item.label)}</strong><small>${esc(state.visible ? item.description : "скрыт")}</small></span></button><button class="visual-visibility" type="button" data-visual-toggle="${item.id}" aria-label="${state.visible ? "Скрыть" : "Показать"} ${esc(item.label)}" title="${state.visible ? "Скрыть" : "Показать"}">${state.visible ? "Скрыть" : "Показать"}</button></div>`; }).join("")}</div></div><div class="visual-panel"><div class="visual-panel-title"><svg class="ic"><use href="#i-grid"/></svg>Холст · перетащи блоки <label style="margin-left:auto">Сетка <select class="select" data-snap-grid aria-label="Привязка к сетке"><option value="0" ${gridSize === 0 ? "selected" : ""}>Выключена</option>${[8,16,32].map(n => `<option value="${n}" ${gridSize === n ? "selected" : ""}>${n} px</option>`).join("")}</select></label><button class="btn btn-small" type="button" data-align-grid>Выровнять всё</button></div><div class="visual-stage"><div class="visual-stage-inner">${ELEMENTS.filter(item => !item.hideOnly).map((item) => { const state = elementState(item.id); const left = Math.max(3, item.previewX + state.x); const top = Math.max(3, item.previewY + state.y); const width = state.width || item.previewWidth; const height = state.height || item.previewHeight; return `<div class="visual-canvas-item ${selected.id === item.id ? "is-selected" : ""} ${state.visible ? "" : "is-hidden"}" tabindex="0" role="button" aria-label="${esc(item.label)}: переместить стрелками" data-visual-id="${item.id}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px"><span class="visual-label">${esc(item.label)}</span>${["n","s","e","w","nw","ne","sw","se"].map(edge => `<span class="visual-resize" data-edge="${edge}" title="Изменить размер"></span>`).join("")}</div>`; }).join("")}</div><div class="visual-stage-help">Координаты и размеры соответствуют окну лаунчера. «Выровнять всё» привязывает видимые области к сетке; зажми край для изменения размера.</div></div></div><div class="visual-panel visual-properties"><div class="visual-panel-title"><svg class="ic"><use href="#i-pencil"/></svg>Свойства</div><div class="customizer-note"><strong>${esc(selected.label)}</strong><br>${esc(selected.description)}</div>${selected.customWidget ? `<div><button class="btn btn-small" type="button" data-widget-action="edit">Изменить / подтвердить код</button> <button class="btn btn-small" type="button" data-widget-action="delete">Удалить</button></div>` : ""}${widgetForm()}<label class="customizer-control"><span><strong>Видимость</strong><small>Показывать элемент в лаунчере</small></span><button class="switch ${value.visible ? "on" : ""}" type="button" data-element-visibility="${value.visible ? "hide" : "show"}" aria-pressed="${value.visible}"></button></label>${controls("surface_opacity", "Непрозрачность фона", "0% — прозрачный фон, текст остаётся видимым", 0, 100, "%", value.surface_opacity ?? 100)}${controls("backdrop_blur", "Размытие подложки", "Размывает то, что находится за элементом", 0, 40, "px", value.backdrop_blur ?? 0)}${controls("surface_radius", "Закругление фона", "Радиус подложки, 0 — прямые углы", 0, 80, "px", value.surface_radius ?? 0)}<button class="btn btn-small" type="button" data-surface-reset>Вернуть фон темы</button>${selected.hideOnly ? `<div class="customizer-note">Этот элемент вложен в страницу: положение доступно во вкладке CSS.</div>` : `<label class="customizer-control visual-select-control"><span><strong>Режим расположения</strong><small>Адаптивный поток или свободные координаты</small></span><select class="select" data-element-select="mode"><option value="flow" ${value.mode === "flow" ? "selected" : ""}>В потоке</option><option value="free" ${value.mode === "free" ? "selected" : ""}>Смещение (старое)</option><option value="absolute" ${value.mode === "absolute" ? "selected" : ""}>Независимо</option></select></label><label class="customizer-control visual-select-control"><span><strong>Вариант</strong><small>Размер и визуальный акцент</small></span><select class="select" data-element-select="variant">${ELEMENT_VARIANTS.map(([id, label]) => `<option value="${id}" ${value.variant === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>${selected.id === "tabs" ? `<label class="customizer-control visual-select-control"><span><strong>Направление вкладок</strong><small>Отдельная панель рядом с рабочей областью</small></span><select class="select" data-element-select="tabs_orientation"><option value="horizontal" ${value.tabs_orientation === "horizontal" ? "selected" : ""}>Горизонтально</option><option value="vertical" ${value.tabs_orientation === "vertical" ? "selected" : ""}>Вертикально слева</option><option value="vertical-right" ${value.tabs_orientation === "vertical-right" ? "selected" : ""}>Вертикально справа</option></select></label>` : ""}${selected.id === "build-list" ? `<label class="customizer-control visual-select-control"><span><strong>Список и рабочая область</strong><small>Список в рабочей области или в боковой панели</small></span><select class="select" data-element-select="merged_workspace"><option value="false" ${!value.merged_workspace ? "selected" : ""}>Раздельно</option><option value="true" ${value.merged_workspace ? "selected" : ""}>Объединить</option></select></label>${controls("build_card_size", "Размер сборок", "Масштаб карточек в списке и сетке", 48, 180, "px", value.build_card_size ?? 76)}<button class="btn btn-small" type="button" data-card-size-reset>Размер темы</button><label class="customizer-control visual-select-control"><span><strong>Вид сборок</strong><small>Выберите расположение карточек</small></span><select class="select" data-element-select="list_view"><option value="default" ${value.list_view === "default" ? "selected" : ""}>Как в пресете</option><option value="list" ${value.list_view === "list" ? "selected" : ""}>Список</option><option value="grid" ${value.list_view === "grid" ? "selected" : ""}>Компактные плитки</option></select></label>` : ""}${controls("x", "X", "Горизонтальное смещение", -4096, 4096)}${controls("y", "Y", "Вертикальное смещение", -4096, 4096)}${controls("width", "Ширина", "0 — автоматически", 0, 4096)}${controls("height", "Высота", "0 — автоматически", 0, 4096)}${controls("margin", "Отступ снаружи", "Свободное пространство", 0, 40)}${controls("padding", "Внутренний отступ", "Пространство внутри", 0, 40)}${controls("radius", "Закругление", "Радиус углов", 0, 40)}`}</div></div></section>`;
  }

  function renderCss() {
    return `<section class="customizer-section customizer-code-wrap"><div class="customizer-section-head"><svg class="ic"><use href="#i-code"/></svg><div><h3>Базовый CSS и переопределения</h3><p>Исходный styles.css или ранее сохранённые переопределения. Изменения применяются и сохраняются автоматически. Курсор, экранные слои и пример своей анимации описаны в исходном CSS. Canvas-частицы стилизуются только целым слоем; эффекты клика живут до 700 мс. Tab — отступ, Ctrl+S — сохранить. @import отключён.</p></div></div><div class="customizer-actions"><input id="custom-css-find" class="input" type="search" placeholder="Найти в CSS" aria-label="Поиск в CSS"><button class="btn btn-small" type="button" data-css-action="find">Найти далее</button><span class="hint">Ctrl+F — поиск · Ctrl+Shift+Backspace — аварийно восстановить интерфейс</span></div><textarea id="custom-css-editor" class="customizer-code" maxlength="${MAX_CSS - FULL_CSS_MARKER.length}" spellcheck="false" autocomplete="off" aria-label="Базовый CSS и переопределения">${esc(isFullCss(customCss) ? customCss.slice(FULL_CSS_MARKER.length) : customCss)}</textarea><div class="customizer-preset-row"><button class="btn btn-small" type="button" data-css-action="base">Загрузить исходный CSS</button><button class="btn btn-small" type="button" data-css-action="clear">Восстановить стиль</button><button class="btn btn-small" type="button" data-css-action="download-css">Скачать .css</button><span class="label"></span></div><div class="customizer-code-help"><code>[data-os="sidebar"]</code><code>[data-os-element="toolbar"]</code><code>[data-os="tabs"]</code><code>[data-os="build-card"]</code><code>#ambient</code><code>#trail</code><code>#fx-layer .cfx</code><code>#css-effect-1</code><code>#css-effect-2</code><code>#css-effect-3</code><code>cursor</code><code>@keyframes</code><code>--accent</code><code>--r</code></div><div class="customizer-actions"><button class="btn btn-small" type="button" data-css-action="export">Экспорт темы</button><button class="btn btn-small" type="button" data-css-action="import">Импорт темы / CSS</button><button class="btn btn-small btn-ghost" type="button" data-css-action="copy">Скопировать CSS</button><span class="hint">Файл темы содержит CSS и раскладку — им можно делиться.</span></div><input id="custom-theme-file" type="file" accept=".json,.omtheme,.css,application/json,text/css" hidden></section>`;
  }

  function normalizeModules(value) {
    const list = Array.isArray(value) ? value : [];
    const builtins = Object.entries(CSS_PRESETS).map(([id, item]) => ({ id: `builtin-${id}`, name: item.label, css: item.css, enabled: false }));
    const clean = list.filter(m => m && typeof m.id === "string" && typeof m.css === "string").map(m => ({ id: m.id.slice(0, 120), name: String(m.name || "Тема").slice(0, 120), css: m.css.slice(0, MAX_CSS), source_file: typeof m.source_file === "string" && m.source_file.length <= 255 ? m.source_file : null, enabled: m.enabled === true }));
    for (const b of builtins) if (!clean.some(m => m.id === b.id)) clean.push(b);
    return clean;
  }
  function syncFolderThemes() {
    if (folderThemeScan) return folderThemeScan;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return Promise.resolve(false);
    folderThemeScan = (async () => {
      const files = await invoke("list_folder_themes");
      if (!Array.isArray(files)) return false;
      const safe = files.filter(f => f && typeof f.name === "string" && f.name.length <= 255 && typeof f.css === "string" && f.css.length <= MAX_CSS);
      if (safe.length !== files.length) throw new Error("Некорректный ответ при чтении папки тем");
      const byName = new Map(safe.map(f => [f.name, f]));
      const updated = themeModules.filter(m => !m.source_file || byName.has(m.source_file)).map(m => {
        if (!m.source_file) return m;
        const file = byName.get(m.source_file); if (!file) return m;
        byName.delete(m.source_file);
        return { ...m, name: file.name, css: file.css };
      });
      for (const file of byName.values()) updated.push({ id: `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`, name: file.name, css: file.css, source_file: file.name, enabled: false });
      if (JSON.stringify(updated) === JSON.stringify(themeModules)) return false;
      themeModules = updated; injectStyles(); queueSave({ ui_theme_modules: themeModules }); return true;
    })().finally(() => { folderThemeScan = null; });
    return folderThemeScan;
  }

  // Автозапуск требует отдельного локального подтверждения именно этого кода.
  function normalizeScripts(value) {
    const ids = new Set();
    return (Array.isArray(value) ? value : []).slice(0, 50).filter(m => m && /^script-[a-z0-9-]{1,80}$/.test(m.id) && !ids.has(m.id) && (ids.add(m.id), true) && typeof m.code === "string" && m.code.length <= MAX_CSS).map(m => ({ id: m.id, name: String(m.name || "Скрипт").slice(0, 120), code: m.code, mode: m.mode === "trusted" ? "trusted" : "isolated", auto_start: m.auto_start === true }));
  }
  function readScriptApprovals() {
    try { const value = JSON.parse(localStorage.getItem(SCRIPT_APPROVAL_KEY) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function writeScriptApproval(id, fingerprint) {
    const approvals = readScriptApprovals();
    if (fingerprint) approvals[id] = fingerprint; else delete approvals[id];
    localStorage.setItem(SCRIPT_APPROVAL_KEY, JSON.stringify(approvals));
  }
  async function scriptFingerprint(m) {
    const payload = JSON.stringify([m.id, m.mode, m.code]);
    if (window.crypto?.subtle) {
      const hash = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
      return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,"0")).join("");
    }
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("SHA-256 недоступен");
    const hash = await invoke("script_autostart_fingerprint", {id:m.id, mode:m.mode, code:m.code});
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("SHA-256 недоступен");
    return hash;
  }
  function startScript(m) {
    if (safeMode || currentSettings().ui_safe_mode === true || scriptSessions.has(m.id) || trustedScriptRuns.has(m.id)) return false;
    if (m.mode === "trusted") {
      trustedScriptRuns.add(m.id);
      const script=document.createElement("script"); script.textContent=m.code; scriptSessions.set(m.id,script); document.head.appendChild(script);
    } else {
      const frame=document.createElement("iframe"); frame.hidden=true; frame.title=`Изолированный скрипт ${m.name}`; frame.setAttribute("sandbox","allow-scripts");
      const encoded=JSON.stringify(m.code).replace(/</g,"\\u003c");
      frame.srcdoc=`<!doctype html><meta charset="utf-8"><body><script>const s=document.createElement('script');s.textContent=${encoded};document.body.appendChild(s);<\/script>`;
      scriptSessions.set(m.id,frame); document.body.appendChild(frame);
    }
    return true;
  }
  async function startApprovedScripts() {
    if (autostartInitialized) return;
    autostartInitialized = true;
    const current = currentSettings(); safeMode = current.ui_safe_mode === true;
    if (safeMode) return;
    scriptModules = normalizeScripts(current.ui_script_modules || []);
    const approvals = readScriptApprovals();
    for (const m of scriptModules) {
      if (!m.auto_start || !approvals[m.id]) continue;
      try {
        const original = { ...m }; const hash = await scriptFingerprint(original);
        if (hash === approvals[m.id] && readScriptApprovals()[m.id] === hash && scriptModules.includes(m) && m.auto_start && m.mode === original.mode && m.code === original.code && !safeMode) { approvedScripts.set(m.id,hash); startScript(m); }
      } catch { /* Без проверки не запускаем. */ }
    }
    window.dispatchEvent(new Event("omnispec-scripts-state"));
  }
  function renderScripts(host) {
    if (!host) return;
    let dragging = null;
    function draw() {
      host.innerHTML = `<h3 style="margin-top:24px">Пользовательские JS-скрипты</h3><p class="muted">Импортированные файлы сначала выключены. Изолированный режим не может изменять интерфейс; для этого нужен доверенный режим. Для запуска после перезапуска включите «Автозапуск» отдельно для каждого скрипта. Автозапуск действует только на этом устройстве и отключается при аварийном восстановлении. Запуск начинается по порядку списка; изолированные скрипты выполняются асинхронно. Userscript-метаданные и API расширений браузера не поддерживаются.</p><div data-script-list>${scriptModules.map((m,i) => {
        const active = scriptSessions.has(m.id), ran = trustedScriptRuns.has(m.id);
        return `<div draggable="true" data-script-row="${esc(m.id)}" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px;border-bottom:1px solid var(--line)"><span aria-hidden="true">⋮⋮</span><span style="flex:1;min-width:120px"><strong>${esc(m.name)}</strong><br><small>${m.auto_start && !approvedScripts.has(m.id) ? "Автозапуск требует подтверждения для этого кода" : ran && !active ? "Код уже выполнен — для полной остановки перезапустите лаунчер" : active ? "Запущен в этой сессии" : "Выключен"}</small></span><select class="select" data-script-mode="${esc(m.id)}" aria-label="Режим ${esc(m.name)}" ${active || ran ? "disabled" : ""}><option value="isolated" ${m.mode === "isolated" ? "selected" : ""}>Изолированный</option><option value="trusted" ${m.mode === "trusted" ? "selected" : ""}>Доверенный</option></select><button type="button" class="switch ${active ? "on" : ""}" role="switch" aria-label="Запуск ${esc(m.name)}" aria-checked="${active}" data-script-toggle="${esc(m.id)}" ${ran && !active ? "disabled" : ""}></button><label style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-script-autostart="${esc(m.id)}" ${m.auto_start && approvedScripts.has(m.id) ? "checked" : ""}> Автозапуск</label><button class="btn btn-small" type="button" data-script-move="-1" data-id="${esc(m.id)}" ${i === 0 ? "disabled" : ""} aria-label="Поднять ${esc(m.name)}">↑</button><button class="btn btn-small" type="button" data-script-move="1" data-id="${esc(m.id)}" ${i === scriptModules.length-1 ? "disabled" : ""} aria-label="Опустить ${esc(m.name)}">↓</button><button class="btn btn-small" type="button" data-script-delete="${esc(m.id)}" aria-label="Удалить ${esc(m.name)}">✕</button></div>`;
      }).join("")}</div><div data-script-drop style="margin-top:16px;padding:16px;border:1px dashed var(--line);border-radius:var(--r)"><p>Перетащите сюда файлы .js или выберите их.</p><button class="btn btn-small" type="button" data-script-import>Импорт JS</button> <button class="btn btn-small" type="button" data-script-folder>Открыть папку скриптов</button><input type="file" accept=".js,text/javascript,application/javascript" multiple hidden data-script-file></div><p class="muted" data-script-status role="status" aria-live="polite"></p>`;
    }
    function save() { queueSave({ ui_script_modules: scriptModules }); draw(); }
    async function addFiles(files) {
      const rejected = [];
      for (const file of files) {
        if (!/\.js$/i.test(file.name) || file.size > MAX_CSS || scriptModules.length >= 50) { rejected.push(file.name); continue; }
        try { const code = await file.text(); if (code.length > MAX_CSS) { rejected.push(file.name); continue; }
          scriptModules.push({ id: `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`, name: file.name.slice(0,120), code, mode: "isolated" });
        } catch { rejected.push(file.name); }
      }
      save(); if (rejected.length) $("[data-script-status]",host).textContent = `Пропущены: ${rejected.join(", ")}. Нужны .js файлы до 1 МБ; не более 50 скриптов.`;
    }
    host.addEventListener("change", e => {
      if (e.target.matches("[data-script-file]")) { const files = [...e.target.files]; e.target.value = ""; addFiles(files); return; }
      if (e.target.dataset.scriptMode) { const m=scriptModules.find(x => x.id===e.target.dataset.scriptMode); if (m && !scriptSessions.has(m.id) && !trustedScriptRuns.has(m.id)) { m.mode = e.target.value === "trusted" ? "trusted" : "isolated"; m.auto_start = false; approvedScripts.delete(m.id); try { writeScriptApproval(m.id, null); } catch {} save(); } }
    });
    host.addEventListener("change", async e => {
      const id = e.target.dataset.scriptAutostart; if (!id) return;
      const m = scriptModules.find(x => x.id === id); if (!m) return;
      const requested = e.target.checked; const original = { ...m };
      if (!requested) { m.auto_start=false; approvedScripts.delete(id); try { writeScriptApproval(id,null); } catch {} save(); return; }
      if (safeMode) { e.target.checked=false; $("[data-script-status]",host).textContent="В аварийном режиме автозапуск отключён."; return; }
      if (m.mode === "trusted" && !await confirmChange(`«${m.name}» будет запускаться автоматически при каждом запуске и получит полный доступ к лаунчеру, данным и сети. Доверяйте только проверенному коду. При ошибке используйте Ctrl+Shift+Backspace.`, "Разрешить автозапуск")) { e.target.checked=false; return; }
      try {
        const hash = await scriptFingerprint(original);
        if (!scriptModules.includes(m) || safeMode || !e.target.isConnected || !e.target.checked || m.mode !== original.mode || m.code !== original.code) return;
        writeScriptApproval(id,hash); approvedScripts.set(id,hash); m.auto_start=true; save();
      } catch (error) { e.target.checked=false; $("[data-script-status]",host).textContent=`Не удалось разрешить автозапуск: ${error}`; }
    });
    host.addEventListener("click", async e => {
      const b=e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-script-folder")) { await openCustomizationFolder("scripts", $("[data-script-status]",host)); return; }
      if (b.hasAttribute("data-script-import")) { $("[data-script-file]",host)?.click(); return; }
      if (b.dataset.scriptToggle) {
        const m=scriptModules.find(x => x.id===b.dataset.scriptToggle); if (!m) return;
        if (scriptSessions.has(m.id)) {
          if (m.mode === "trusted" && !await confirmChange("Скрипт уже выполнился в лаунчере. Выключение не удалит его обработчики, таймеры и изменения. Для полной остановки перезапустите приложение.", "Понятно")) return;
          scriptSessions.get(m.id)?.remove(); scriptSessions.delete(m.id); m.auto_start=false; approvedScripts.delete(m.id); try { writeScriptApproval(m.id,null); } catch {} save(); return;
        }
        if (trustedScriptRuns.has(m.id)) return;
        if (m.mode === "trusted" && !await confirmChange(`ОПАСНО: «${m.name}» получит доступ к интерфейсу, командам лаунчера, данным и сети. Код может изменить или отправить ваши данные. Выключение не остановит уже запущенные действия до перезапуска. Запускать только известный и проверенный код.`, "Доверяю и запускаю")) return;
        if (!scriptModules.includes(m) || scriptSessions.has(m.id) || trustedScriptRuns.has(m.id)) return;
        if (safeMode) { $("[data-script-status]",host).textContent="В аварийном режиме запуск скриптов отключён."; return; }
        startScript(m);
        draw(); return;
      }
      if (b.dataset.scriptDelete) {
        const m=scriptModules.find(x=>x.id===b.dataset.scriptDelete); if (!m || !await confirmChange(trustedScriptRuns.has(m.id) ? "Удалить скрипт? Его действия могут продолжаться до перезапуска приложения." : "Удалить импортированный скрипт?", "Удалить")) return;
        scriptSessions.get(m.id)?.remove(); scriptSessions.delete(m.id); approvedScripts.delete(m.id); try { writeScriptApproval(m.id,null); } catch {} scriptModules=scriptModules.filter(x=>x.id!==m.id); save(); return;
      }
      if (b.dataset.scriptMove) { const i=scriptModules.findIndex(x=>x.id===b.dataset.id), j=i+Number(b.dataset.scriptMove); if (i>=0 && j>=0 && j<scriptModules.length) { [scriptModules[i],scriptModules[j]]=[scriptModules[j],scriptModules[i]]; save(); } }
    });
    host.addEventListener("dragstart",e=>{const row=e.target.closest("[data-script-row]"); if(row){e.stopPropagation();dragging=row.dataset.scriptRow;e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",dragging);}});
    host.addEventListener("dragover",e=>{if(e.target.closest("[data-script-row], [data-script-drop]")){e.preventDefault();e.stopPropagation();}});
    host.addEventListener("drop",e=>{ e.preventDefault();e.stopPropagation(); if(e.dataTransfer.files.length){addFiles([...e.dataTransfer.files]);return;} const row=e.target.closest("[data-script-row]");const i=scriptModules.findIndex(x=>x.id===dragging),j=scriptModules.findIndex(x=>x.id===row?.dataset.scriptRow); if(i>=0 && j>=0 && i!==j){const [m]=scriptModules.splice(i,1);scriptModules.splice(j,0,m);save();} dragging=null; });
    const refresh = () => { if (!host.isConnected) { window.removeEventListener("omnispec-scripts-state", refresh); return; } draw(); };
    window.addEventListener("omnispec-scripts-state", refresh);
    draw();
  }
  async function openCustomizationFolder(kind, status) {
    try {
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error("открытие папки доступно в приложении");
      await invoke("open_customization_folder", { kind });
      if (status) status.textContent = kind === "themes" ? "Папка открыта. Вернитесь в лаунчер или нажмите «Обновить из папки»." : "Папка открыта. Скрипты нужно импортировать вручную; содержимое папки не запускается автоматически.";
    } catch (error) { if (status) status.textContent = `Не удалось открыть папку: ${error}`; }
  }
  function renderThemes(host) {
    if (!host) return;
    themeModules = normalizeModules(currentSettings().ui_theme_modules ?? themeModules);
    scriptModules = normalizeScripts(currentSettings().ui_script_modules ?? scriptModules);
    let dragging = null;
    function draw() {
      host.innerHTML = `${safeMode ? `<div class="customizer-note" data-safe-notice><strong>Аварийный режим</strong><p>Пользовательский CSS, темы и раскладка временно отключены; автозапуск скриптов выключен; настройки и файлы сохранены. При необходимости выключите проблемную тему, затем верните оформление. После возврата кнопки могут снова исчезнуть: Ctrl+Shift+Backspace снова включит восстановление.</p><button class="btn btn-small" type="button" data-safe-restore>Вернуть оформление</button></div>` : ""}<h3 style="margin-top:24px">Готовые компоновки</h3><p class="muted">Выбор компоновки сбрасывает пользовательское расположение элементов.</p><div class="preset-preview-grid">${UI_PRESETS.filter(([id]) => id !== "custom").map(([id, label, description]) => `<label class="preset-preview ${layout.preset === id ? "is-active" : ""}"><input type="radio" name="interface-layout-preset" data-theme-layout="${id}" ${layout.preset === id ? "checked" : ""}><img src="assets/preset-previews/${id}.png" alt="" loading="lazy"><strong>${esc(label)}</strong><small>${esc(description)}</small></label>`).join("")}</div><h3 style="margin-top:24px">Темы и заготовки</h3><p class="muted">Включайте и сочетайте CSS-заготовки. Нижние стили применяются позже; порядок можно менять мышью или кнопками. @import отключён.</p><div data-theme-list>${themeModules.map((m, i) => `<div draggable="true" data-theme-row="${esc(m.id)}" style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--line)"><span title="Перетащить" aria-hidden="true">⋮⋮</span><span style="flex:1;min-width:0">${esc(m.name)}${m.source_file ? " <small class=\"muted\">· из папки</small>" : ""}</span><button type="button" class="switch ${m.enabled ? "on" : ""}" role="switch" aria-label="${esc(m.name)}" aria-checked="${m.enabled}" data-theme-toggle="${esc(m.id)}"></button><button class="btn btn-small" type="button" data-theme-move="-1" data-id="${esc(m.id)}" ${i === 0 ? "disabled" : ""} aria-label="Поднять ${esc(m.name)}">↑</button><button class="btn btn-small" type="button" data-theme-move="1" data-id="${esc(m.id)}" ${i === themeModules.length-1 ? "disabled" : ""} aria-label="Опустить ${esc(m.name)}">↓</button>${m.id.startsWith("builtin-") || m.source_file ? "" : `<button class="btn btn-small" type="button" data-theme-delete="${esc(m.id)}" aria-label="Удалить ${esc(m.name)}">✕</button>`}</div>`).join("")}</div><div data-theme-drop style="margin-top:16px;padding:16px;border:1px dashed var(--line);border-radius:var(--r)"><p>Перетащите сюда CSS-файлы или выберите их.</p><button type="button" class="btn btn-small" data-theme-import>Импорт CSS</button> <button type="button" class="btn btn-small" data-theme-folder>Открыть папку тем</button> <button type="button" class="btn btn-small" data-theme-refresh>Обновить из папки</button><input type="file" accept=".css,text/css" multiple hidden data-theme-file></div><p class="muted" data-theme-status aria-live="polite">Новые темы сначала выключены. Файлы из папки можно удалить через проводник.</p><div data-script-host></div>`;
      renderScripts($("[data-script-host]", host));
    }
    function save() { injectStyles(); queueSave({ ui_theme_modules: themeModules }); draw(); }
    async function addFiles(files) {
      const rejected = [];
      for (const file of files) {
        if (!/\.css$/i.test(file.name) || file.size > MAX_CSS) { rejected.push(file.name); continue; }
        const css = await file.text();
        themeModules.push({ id: `import-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name, css, enabled: false });
      }
      save();
      if (rejected.length) $("[data-theme-status]", host).textContent = `Пропущены: ${rejected.join(", ")}. Нужны CSS-файлы не более ${MAX_CSS} байт.`;
    }
    host.addEventListener("change", async e => {
      if (e.target.matches("[data-theme-layout]")) { if (await confirmChange("Применить компоновку? Текущее расположение элементов будет сброшено.")) { applyUiPreset(e.target.dataset.themeLayout); draw(); } else draw(); return; }
      if (e.target.matches("[data-theme-file]")) addFiles(Array.from(e.target.files || []));
    });
    host.addEventListener("click", async e => {
      const button = e.target.closest("button"); if (!button) return;
      if (button.hasAttribute("data-safe-restore")) { if (await confirmChange("Вернуть пользовательский CSS и раскладку? Проблемная тема может снова скрыть кнопки.", "Вернуть")) await activateSafeMode(false); return; }
      if (button.hasAttribute("data-theme-toggle")) { const m = themeModules.find(x => x.id === button.dataset.themeToggle); if (m) { m.enabled = !m.enabled; save(); } return; }
      if (button.hasAttribute("data-theme-refresh")) { await refreshFolder(); return; }
      if (button.hasAttribute("data-theme-folder")) { await openCustomizationFolder("themes", $("[data-theme-status]",host)); return; }
      if (button.hasAttribute("data-theme-import")) $("[data-theme-file]", host)?.click();
      if (button.dataset.themeDelete && await confirmChange("Удалить импортированную тему?", "Удалить")) { themeModules = themeModules.filter(m => m.id !== button.dataset.themeDelete); save(); }
      if (button.dataset.themeMove) { const i = themeModules.findIndex(m => m.id === button.dataset.id), j = i + Number(button.dataset.themeMove); if (i >= 0 && j >= 0 && j < themeModules.length) { [themeModules[i], themeModules[j]] = [themeModules[j], themeModules[i]]; save(); } }
    });
    host.addEventListener("dragstart", e => { const row = e.target.closest("[data-theme-row]"); if (row) { dragging = row.dataset.themeRow; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragging); } });
    host.addEventListener("dragover", e => { if (e.target.closest("[data-theme-row], [data-theme-drop]")) e.preventDefault(); });
    host.addEventListener("drop", e => {
      e.preventDefault();
      if (e.dataTransfer.files.length) { addFiles(Array.from(e.dataTransfer.files)); return; }
      const row = e.target.closest("[data-theme-row]"); const i = themeModules.findIndex(m => m.id === dragging), j = themeModules.findIndex(m => m.id === row?.dataset.themeRow);
      if (i >= 0 && j >= 0 && i !== j) { const [m] = themeModules.splice(i, 1); themeModules.splice(j, 0, m); save(); } dragging = null;
    });
    async function refreshFolder() {
      try { const changed = await syncFolderThemes(); if (host.isConnected) { if (changed) draw(); $("[data-theme-status]",host).textContent = "Папка тем обновлена. Новые темы выключены."; } }
      catch (error) { if (host.isConnected) $("[data-theme-status]",host).textContent = `Не удалось прочитать папку тем: ${error}`; }
    }
    const onFocus = () => { if (!host.isConnected) { window.removeEventListener("focus", onFocus); return; } refreshFolder(); };
    if (host._folderThemeFocus) window.removeEventListener("focus", host._folderThemeFocus);
    host._folderThemeFocus = onFocus; window.addEventListener("focus", onFocus);
    draw(); refreshFolder();
  }

  function openCustomizer() {
    inlineHost = null; createModal();
    const prefs = document.getElementById("modal-prefs");
    if (prefs) prefs.hidden = true;
    const current = currentSettings(); layout = normalizeLayout(current.ui_layout || layout); customCss = String(current.custom_css ?? customCss ?? "");
    injectStyles(); applyLayout(); currentTab = "editor";
    modal.hidden = false; document.body.dataset.customizerOpen = "true";
    renderEditor(); bindFileImport(editorRoot()); setStatus("Изменения сохраняются автоматически");
    setTimeout(() => $("[data-custom-tab='editor']", editorRoot())?.focus(), 0);
  }
  function closeCustomizer() {
    closeVisualContext(); if (!modal) return; modal.hidden = true; document.body.dataset.customizerOpen = "false"; }
  function renderInline(host) {
    if (!host) return;
    inlineHost = host;
    const current = currentSettings(); layout = normalizeLayout(current.ui_layout || layout); customCss = String(current.custom_css ?? customCss ?? "");
    injectStyles(); applyLayout();
    host.innerHTML = editorMarkup(true); const root = $("[data-editor-root]", host); bindEditorEvents(root); bindFileImport(root); renderEditor();
  }
  async function resetCustomizer() {
    if (!(await confirmChange("Вернуть стандартную раскладку и удалить пользовательский CSS?", "Сбросить"))) return;
    clearTimeout(saveTimer); layout = normalizeLayout(DEFAULT_LAYOUT); customCss = ""; injectStyles(); applyLayout(); queueSave({ custom_css: "", ui_layout: layout }); renderEditor(); setStatus("Конструктор сброшен", "saved");
  }

  async function activateSafeMode(enabled) {
    clearTimeout(saveTimer);
    try {
      await saveQueue.catch(() => {});
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) throw new Error("Команда доступна только в приложении");
      await invoke("set_ui_safe_mode", { enabled });
      window.location.reload();
    } catch (error) {
      if (enabled) { safeMode = true; injectStyles(); applyLayout(); }
      window.omnispecDialogs?.confirm({ title:"Ошибка восстановления", text:`Не удалось сохранить аварийный режим: ${error}`, ok:"Понятно" });
    }
  }

  function observeUi() {
    markUi();
    const app = $(".app");
    if (app) {
      const observer = new MutationObserver(() => { markUi(); if (!safeMode) applyElements(); });
      observer.observe(app, { childList: true, subtree: true });
    }
  }
  function start() {
    if (started) return; started = true; try { const savedGrid = localStorage.getItem("omnispec-grid-size"); if (["0", "8", "16", "32"].includes(savedGrid)) gridSize = Number(savedGrid); } catch {} injectStyles(); observeUi(); loadSettings().catch(() => {});
    let attempts = 0;
    const wait = setInterval(() => {
      attempts += 1; const state = appState();
      if (state?.settings) {
        const next = state.settings; const local = readLocal(); const nextCss = next.custom_css ?? local.custom_css ?? ""; const nextLayout = next.ui_layout ?? local.ui_layout ?? DEFAULT_LAYOUT;
        if ((next.ui_safe_mode === true) !== safeMode || nextCss !== customCss || JSON.stringify(normalizeLayout(nextLayout)) !== JSON.stringify(layout)) {
          settings = next; safeMode = next.ui_safe_mode === true; customCss = String(nextCss); layout = normalizeLayout(nextLayout); injectStyles(); applyLayout();
          if (inlineHost?.isConnected && inlineHost.dataset.prefCategory === "interface") renderInline(inlineHost);
        }
      }
      if (attempts > 30) clearInterval(wait);
    }, 250);
    window.addEventListener("omnispec-ui-ready", startApprovedScripts, { once: true });
    if (window.__omniInterfaceReady) startApprovedScripts();
    window.addEventListener("resize", () => { if (currentTab === "editor" && editorRoot()) populateSnapshots(editorRoot()); });
    document.addEventListener("keydown", async (event) => {
      if (event.ctrlKey && event.shiftKey && event.key === "Backspace") {
        event.preventDefault(); event.stopImmediatePropagation();
        activateSafeMode(true); return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") { event.preventDefault(); if (modal?.hidden === false) closeCustomizer(); else openCustomizer(); }
      if (event.key === "Escape" && modal && !modal.hidden) closeCustomizer();
    });
  }

  window.omnispecCustomizer = { open: openCustomizer, close: closeCustomizer, renderInline, renderThemes, render: renderEditor, applyLayout, applyUiPreset, markUi };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
