/* Локальные словари интерфейса. Никаких сетевых запросов при работе.
 * Переводим только текстовые узлы и доступные подписи — не innerHTML, не поля
 * ввода, файлы, ники, логи и не содержимое внешних проектов. При переключении
 * сохраняем исходный текст каждого узла, поэтому состояние форм не теряется. */
(() => {
  "use strict";
  const dictionaries = window.OMNISPEC_LOCALES || {};
  const locales = { ru: "ru-RU", be: "be-BY", kk: "kk-KZ", uk: "uk-UA", en: "en-US" };
  let language = "ru";
  const textRecords = new WeakMap();
  const attributeRecords = new WeakMap();
  const attributes = ["title", "placeholder", "aria-label", "alt"];
  const placeholder = /\{(\d+)\}/g;
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = new Map();
  const noTranslate = 'script,style,textarea,pre,code,[contenteditable="true"],[translate="no"],[data-i18n-skip],.log-text,.fm-row .nm,.fm-item .nm,#shot-title,#proj-title';
  // Some attributes are filenames, author-provided text or user-defined names.
  const attributeSkips = {
    title: '.build-tile,.fav-slot,.skin-library-select,.cape-card[data-cape-id]:not(.cape-off),.shot-tile,.instance,.fm-item,.fm-row,.home-card-name',
    'aria-label': '.card[role="group"]',
    alt: '.proj-shot img'
  };

  function compilePatterns() {
    const keys = new Set(Object.values(dictionaries).flatMap(dict => Object.keys(dict)));
    for (const key of keys) {
      const parts = [...key.matchAll(placeholder)];
      if (!parts.length) continue;
      const fixedLength = key.replace(placeholder, "").length;
      if (fixedLength < 2) continue;
      const positions = new Map();
      let source = "^", cursor = 0, group = 0;
      const fixed = text => text.split(" ").map(escapeRegex).join("\\s+");
      for (const part of parts) {
        source += fixed(key.slice(cursor, part.index));
        const number = part[1];
        if (positions.has(number)) source += `\\${positions.get(number)}`;
        else { positions.set(number, ++group); source += "([\\s\\S]*?)"; }
        cursor = part.index + part[0].length;
      }
      source += fixed(key.slice(cursor)) + "$";
      let re;
      try { re = new RegExp(source); } catch (_) { continue; }
      const prefix = key.slice(0, parts[0].index);
      const bucket = prefix ? prefix[0] : "";
      if (!patterns.has(bucket)) patterns.set(bucket, []);
      patterns.get(bucket).push({ key, re, positions, fixedLength });
    }
    // Prefix and leading-placeholder buckets can overlap. Merge once so the
    // pattern with the most literal context wins without sorting every node.
    const generic = patterns.get("") || [];
    generic.sort((a, b) => b.fixedLength - a.fixedLength);
    for (const [bucket, list] of patterns) {
      if (bucket) patterns.set(bucket, [...list, ...generic].sort((a, b) => b.fixedLength - a.fixedLength));
    }
  }
  compilePatterns();

  function translateSingle(raw) {
    if (language === "ru" || typeof raw !== "string" || !raw.trim() || !/[А-Яа-яЁё]/.test(raw)) return raw;
    const dict = dictionaries[language];
    if (!dict) return raw;
    const lead = (raw.match(/^\s*/) || [""])[0];
    const trail = (raw.match(/\s*$/) || [""])[0];
    const end = raw.length - trail.length;
    const body = raw.slice(lead.length, end);
    if (!body) return raw;
    const normalized = body.replace(/\s+/g, " ");
    if (Object.prototype.hasOwnProperty.call(dict, normalized)) return lead + dict[normalized] + trail;
    const candidates = patterns.get(body[0]) || patterns.get("") || [];
    for (const entry of candidates) {
      const translation = dict[entry.key];
      if (!translation) continue;
      const match = entry.re.exec(body);
      if (!match) continue;
      const localCaptures = {
        "Выбран скин «{0}» · {1}.{2}": ["1", "2"],
        "Выбран скин аккаунта · {0}.{1}": ["0", "1"],
        "{0} · последний запуск {1}": ["0", "1"],
        "Путь к звуку: {0}": ["0"],
        "Громкость: {0}": ["0"]
      };
      const result = translation.replace(placeholder, (whole, index) => {
        const group = entry.positions.get(index);
        if (!group) return whole;
        const value = match[group];
        return localCaptures[entry.key]?.includes(index) ? translateSingle(value) : value;
      });
      return lead + result + trail;
    }
    return raw;
  }

  // Составные диагностические фразы формируются из нескольких независимых
  // предложений. Имена модов и показанные логи остаются в исходном виде.
  function translateText(raw, parent) {
    let translated = translateSingle(raw);
    if (language === "en" && parent?.closest('.sz,.fsize,.item-sub,.shot-sub,#create-hint')) {
      const units = { "Б": "B", "КБ": "KB", "МБ": "MB", "ГБ": "GB" };
      translated = translated.replace(/(\d(?:[\d.,]*\d)?)\s*(КБ|МБ|ГБ|Б)(?![A-Za-zА-Яа-яЁё])/g,
        (_, number, unit) => `${number} ${units[unit]}`);
    }
    if (language === "en" && parent?.closest('.instance-time,.home-card-time,.instance-playtime')) {
      translated = translated.replace(/\b(\d+),(\d+)(?=\s*h\b)/g, "$1.$2");
    }
    if (translated !== raw || !parent?.closest('.errors-card-head p,.errors-status-text,#skin-status,.toast')) return translated;
    const pieces = raw.split(/([.!?…]\s+)/);
    if (pieces.length < 3) return raw;
    let output = "";
    for (let i = 0; i < pieces.length; i += 2) {
      const separator = pieces[i + 1] || "";
      const punctuation = separator.slice(0, 1);
      const spaces = separator.slice(1);
      output += translateSingle(pieces[i] + punctuation) + spaces;
    }
    return output;
  }

  function skipped(element) { return !element || Boolean(element.closest(noTranslate)); }
  function processText(node) {
    const parent = node.parentElement;
    // The letter is derived from a user's instance name; only its tooltip is UI.
    if (skipped(parent) || parent.matches('.icon-chip.letter')) return;
    const current = node.nodeValue || "";
    const record = textRecords.get(node);
    const original = record && current === record.last ? record.original : current;
    const next = translateText(original, parent);
    textRecords.set(node, { original, last: next });
    if (next !== current) node.nodeValue = next;
  }
  function processAttribute(element, attr) {
    if (!element.hasAttribute(attr) || skipped(element) || (attributeSkips[attr] && element.matches(attributeSkips[attr]))) return;
    const current = element.getAttribute(attr);
    let record = attributeRecords.get(element);
    if (!record) { record = new Map(); attributeRecords.set(element, record); }
    const previous = record.get(attr);
    const original = previous && current === previous.last ? previous.original : current;
    const next = translateSingle(original);
    record.set(attr, { original, last: next });
    if (next !== current) element.setAttribute(attr, next);
  }
  function processTree(root) {
    if (!root || !root.isConnected) return;
    if (root.nodeType === Node.TEXT_NODE) { processText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = root;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) processText(node);
      else for (const attr of attributes) processAttribute(node, attr);
      node = walker.nextNode();
    }
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData") processText(record.target);
      else if (record.type === "attributes") processAttribute(record.target, record.attributeName);
      else for (const node of record.addedNodes) processTree(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: attributes });

  window.OmniI18n = {
    setLanguage(value) {
      language = Object.prototype.hasOwnProperty.call(locales, value) ? value : "ru";
      document.documentElement.lang = language;
      processTree(document.documentElement);
    },
    translate: translateSingle,
    locale: () => locales[language],
    language: () => language
  };
})();
