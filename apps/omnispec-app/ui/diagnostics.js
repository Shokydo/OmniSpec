/* Локальная диагностика запуска. На вход поступают только новые строки одного
 * процесса; полные логи повторно не перечитываются и никуда не отправляются.
 * Модуль не зависит от DOM, поэтому правила и гонки можно тестировать отдельно. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OmniDiagnostics = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_LINE = 8192;
  const MAX_EVIDENCE = 500;
  const MAX_FINDINGS = 12;
  const MODULE_NAME = "[A-Za-z0-9_.$-]{1,120}";
  const EXPORT_CONFLICT = new RegExp(
    `\\bModules\\s+(${MODULE_NAME})\\s+and\\s+(${MODULE_NAME})\\s+export\\s+package\\s+(${MODULE_NAME})\\s+to\\s+module\\s+(${MODULE_NAME})`, "i"
  );
  const READ_CONFLICT = new RegExp(
    `\\bModule\\s+(${MODULE_NAME})\\s+reads\\s+package\\s+(${MODULE_NAME})\\s+from\\s+both\\s+(${MODULE_NAME})\\s+and\\s+(${MODULE_NAME})`, "i"
  );

  function cleanLine(value) {
    return String(value ?? "").slice(0, MAX_LINE)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim();
  }

  function evidence(line) {
    return line.length > MAX_EVIDENCE ? line.slice(0, MAX_EVIDENCE) + "…" : line;
  }

  function finding(id, title, description, steps, line, priority = 50, quality = 1) {
    return { id, title, description, steps, evidence: evidence(line), priority, quality };
  }

  // Fabric Loader печатает отдельно общее решение и затем требования модов.
  // Ищем именно fabric-api, а не fabric-loader или отдельный модуль API.
  const FABRIC_VERSION = "[0-9][A-Za-z0-9._+~-]{0,79}";
  const FABRIC_SOLUTION = new RegExp(
    `\\bInstall\\s+fabric-api,\\s*(?:version\\s+(${FABRIC_VERSION})\\s+or\\s+later|any\\s+version)[.!]?\\s*$`, "i"
  );
  // Только простые, полностью сформулированные решения Fabric Loader. Сложные
  // интервалы и «that is compatible with …» не сводим к одному минимуму.
  const FABRIC_OTHER_INSTALL = new RegExp(
    `\\bInstall\\s+([A-Za-z][A-Za-z0-9_-]{0,79}),\\s*(?:version\\s+(${FABRIC_VERSION})\\s+or\\s+later|any\\s+version)[.!]?\\s*$`, "i"
  );
  const FABRIC_REPLACE = new RegExp(
    `\\bReplace\\s+mod\\s+'([^'\\r\\n]{1,100})'\\s+\\(([A-Za-z][A-Za-z0-9_-]{0,79})\\)\\s+${FABRIC_VERSION}\\s+with\\s+version\\s+(${FABRIC_VERSION})\\s+or\\s+later[.!]?\\s*$`, "i"
  );
  const FABRIC_BUILTINS = new Set(["minecraft", "java", "fabricloader", "quilt_loader"]);
  const FABRIC_DETAIL = new RegExp(
    `\\bMod\\s+'([^\\r\\n]{1,100}?)'\\s+\\(([A-Za-z0-9_.-]{1,120})\\)\\s+([A-Za-z0-9._+~-]{1,80})\\s+requires\\s+(?:version\\s+(${FABRIC_VERSION})\\s+or\\s+later|any\\s+version)\\s+of\\s+fabric-api,\\s+which\\s+is\\s+missing\\b`, "i"
  );
  const MAX_FABRIC_DEPENDENTS = 8;

  function fabricFinding(line, minimum, dependents = [], quality = 2, source = "detail", uncertain = false) {
    const requirement = minimum ? ` Требуется версия ${minimum} или новее.` : " Версия в этой строке не уточняется.";
    const names = dependents.length ? ` В логе её требуют: ${dependents.map((item) => `${item.name} ${item.version}`).join(", ")}.` : "";
    const replacement = source === "replace";
    const item = finding("mod-dependencies", replacement ? "Нужна другая версия Fabric API" : "Не найден Fabric API",
      (replacement ? "Fabric предлагает заменить установленную версию fabric-api." : "Fabric сообщает, что необходимая зависимость fabric-api не найдена.")
        + requirement + names + " Файл может отсутствовать, быть выключенным или не подходить этой сборке.",
      ["Останови все окна этой сборки и сохрани резервную копию важных миров и модов.",
        "Проверь папку mods: Fabric API может уже находиться там или быть выключен с окончанием .disabled. Не добавляй вторую копию.",
        "Подбери совместимую версию в лаунчере и проверь остальные требования лога.",
        "Запусти сборку снова. Если ошибка останется, проверь полный лог: могут быть и другие недостающие зависимости."],
      line, 92, quality);
    item.fabricApi = { minimum, dependents, source, uncertain };
    return item;
  }

  function otherFabricFinding(line, id, minimum, source, name = id, uncertain = false) {
    const replacement = source === "replace";
    const requirement = minimum ? ` Требуется версия ${minimum} или новее.` : " Версия в этой строке не уточняется.";
    const item = finding(`fabric-mod:${id}`, replacement ? `Нужна другая версия ${name}` : `Не найден мод ${name}`,
      (replacement ? `Fabric предлагает заменить мод ${id}.` : `Fabric предлагает установить отсутствующую зависимость ${id}.`) + requirement,
      ["Останови все окна этой сборки и сохрани резервную копию важных миров и модов.",
        "Лаунчер проверит существующие и выключенные файлы перед изменением.",
        "Подбери совместимую версию в лаунчере и проверь остальные требования лога.",
        "Запусти сборку снова: у мода могут быть дополнительные зависимости."], line, 91, minimum ? 4 : 2);
    item.fabricDependency = { id, name, minimum, source, uncertain };
    return item;
  }

  // Числовые части сравниваем как строки, чтобы не потерять точность больших
  // чисел; +build — метаданные. Неизвестный формат не сравниваем наугад.
  function compareFabricMinimum(a, b) {
    const parts = (value) => {
      const match = String(value).match(/^(\d+(?:\.\d+)*)(?:\+[A-Za-z0-9.-]+)?$/);
      return match ? match[1].split(".") : null;
    };
    const left = parts(a), right = parts(b);
    if (!left || !right) return null;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const l = (left[i] || "0").replace(/^0+(?=\d)/, "");
      const r = (right[i] || "0").replace(/^0+(?=\d)/, "");
      if (l.length !== r.length) return l.length > r.length ? 1 : -1;
      if (l !== r) return l > r ? 1 : -1;
    }
    return 0;
  }

  function mergeFabricFindings(previous, candidate) {
    const old = previous.fabricApi, next = candidate.fabricApi;
    let useCandidate = false;
    let uncertain = old.uncertain || next.uncertain;
    if (next.minimum && !old.minimum) useCandidate = true;
    else if (next.minimum && old.minimum) {
      const comparison = compareFabricMinimum(next.minimum, old.minimum);
      if (comparison === null && next.minimum !== old.minimum) uncertain = true;
      useCandidate = comparison === 1 || ((comparison === 0 || comparison === null) && candidate.quality > previous.quality);
    } else if (!next.minimum && !old.minimum && candidate.quality > previous.quality) useCandidate = true;
    const dependents = old.dependents.slice();
    for (const dep of next.dependents) {
      if (dependents.length >= MAX_FABRIC_DEPENDENTS) break;
      if (!dependents.some((item) => item.id.toLowerCase() === dep.id.toLowerCase())) dependents.push(dep);
    }
    if (!useCandidate && dependents.length === old.dependents.length && uncertain === old.uncertain) return null;
    const chosen = useCandidate ? candidate : previous;
    return fabricFinding(chosen.evidence, chosen.fabricApi.minimum, dependents,
      Math.max(previous.quality, candidate.quality), chosen.fabricApi.source, uncertain);
  }

  function mergeOtherFabric(previous, candidate) {
    const old = previous.fabricDependency, next = candidate.fabricDependency;
    const comparison = old.minimum && next.minimum ? compareFabricMinimum(next.minimum, old.minimum) : null;
    const uncertain = old.uncertain || next.uncertain || Boolean(old.minimum && next.minimum && old.minimum !== next.minimum && comparison === null);
    const chosen = (!old.minimum && next.minimum) || comparison === 1 ? candidate : previous;
    if (chosen === previous && uncertain === old.uncertain) return null;
    const data = chosen.fabricDependency;
    return otherFabricFinding(chosen.evidence, data.id, data.minimum, data.source, data.name, uncertain);
  }

  /** Вернуть подтверждённый сигнатурой признак, но не делать вывод по самому коду выхода. */
  function analyzeLine(value, options = {}) {
    const line = cleanLine(value);
    if (!line) return null;
    let match = line.match(EXPORT_CONFLICT);
    let modules = match ? { first: match[1], second: match[2], pkg: match[3], reader: match[4] } : null;
    if (!modules) {
      match = line.match(READ_CONFLICT);
      if (match) modules = { first: match[3], second: match[4], pkg: match[2], reader: match[1] };
    }
    if (modules) {
      const { first, second, pkg, reader } = modules;
      return finding("java-modules", "Конфликт модулей Java",
        `Модули ${first} и ${second} предоставляют пакет ${pkg} модулю ${reader}. ${reader} читает этот пакет и не обязательно является источником конфликта.`,
        ["Сначала сделай резервную копию сборки и миров.",
          `Проверь, нет ли дубликатов модов и библиотек, связанных с ${first} и ${second}; сравни их версии и загрузчик с требованиями сборки.`,
          "В копии сборки проверяй совместимость по одному изменению за раз. Не удаляй названные модули наугад — один из них может быть частью самой игры.",
          "Если причина неясна, попроси автора сборки проверить полный лог и краш-отчёт."], line, 100, 2);
    }
    if (/\b(?:java\.lang\.module\.)?ResolutionException\b/i.test(line)) {
      return finding("java-modules", "Не удалось разрешить модули Java",
        "В логе есть ResolutionException. Конкретный конфликт лучше определить по полной строке ошибки и краш-отчёту.",
        ["Сделай резервную копию сборки и миров.",
          "Проверь совместимость Minecraft, загрузчика, модов и отсутствие дубликатов библиотек в копии сборки.",
          "Не удаляй моды по одному названию в стеке: сначала посмотри полный лог или обратись к автору сборки."], line, 95, 1);
    }
    if (/UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime/i.test(line)) {
      const requiredClass = Number((line.match(/class file version\s+(\d+)/i) || [])[1]);
      const supportedClass = Number((line.match(/(?:up to|recognizes class file versions? up to)\s+(\d+)/i) || [])[1]);
      const javaFor = (n) => n >= 49 && n <= 80 ? n - 44 : 0;
      const required = javaFor(requiredClass), supported = javaFor(supportedClass);
      const detail = required ? ` По сообщению файл требует как минимум Java ${required}${supported ? `, а текущий рантайм поддерживает классы до Java ${supported}` : ""}.` : "";
      return finding("java-version", "Не подходит версия Java",
        "Один из файлов собран для более новой Java, чем используемый рантайм." + detail,
        ["В «Сборка» проверь пункт «Java для этой сборки» и требования автора модпака.",
          "Выбери совместимую Java для версии Minecraft и модов либо верни автоматический выбор; проверь и общие настройки Java.",
          "Перезапусти сборку. Не меняй версию Minecraft или модов только из-за этого сообщения."], line, 90);
    }
    if (/не хватает java|указанный в настройках путь к java не работает|нужна java\s+\d+|no java runtime present|java (?:runtime )?(?:was )?not found|cannot run program[^\n]{0,160}java(?:w|\.exe)?/i.test(line)) {
      return finding("java-missing", "Java не найдена или не запускается",
        "В сообщении указано, что Java не удалось найти или запустить.",
        ["В настройках сборки проверь выбранный путь к Java; если путь неверный, выбери «автоматически».",
          "В общих настройках игры проверь автозагрузку Java и подключение к интернету или укажи совместимую установленную Java.",
          "Сверь требуемую версию Java с требованиями сборки и повтори запуск."], line, 90);
    }
    if (/\b(?:outofmemoryerror:\s*(?:java heap space|gc overhead limit exceeded)|java heap space)\b/i.test(line)) {
      return finding("memory-heap", "Игре не хватило памяти Java",
        "Java сообщила, что память кучи закончилась; это не обязательно означает, что нужно выделить всю память компьютера.",
        ["В «Сборка» проверь объём памяти и рекомендации автора модпака.",
          "При наличии свободной оперативной памяти увеличь значение постепенно; оставь память самой системе и другим программам.",
          "Если ошибка повторяется, приложи полный лог: причиной может быть и мод с утечкой памяти."], line, 90);
    }
    if (/could not reserve enough space|invalid maximum heap size|initial heap size set to a larger value|unable to allocate.*(?:heap|memory)|не удалось выделить.*памят/i.test(line)) {
      return finding("memory-reserve", "Java не смогла выделить память",
        "Запрошенный объём памяти или параметры кучи не подошли текущей системе и Java.",
        ["В «Сборка» проверь объём памяти и JVM-аргументы, особенно -Xmx и -Xms.",
          "Попробуй уменьшить выделенную память, закрой тяжёлые программы и оставь запас системе.",
          "Проверь, что установлена подходящая 64-битная Java, затем повтори запуск."], line, 90);
    }
    if (/no space left on device|there is not enough space on the disk|disk full|недостаточно (?:свободного )?места на диске|на устройстве не осталось свободного места|os error 112\b/i.test(line)) {
      return finding("disk-space", "Недостаточно места на диске",
        "Операционная система сообщила, что на диске не хватает свободного места.",
        ["Проверь свободное место на диске с данными OmniSpec и на системном диске.",
          "Освободи место безопасным способом и повтори запуск. Миры и файлы сборки не удаляй без резервной копии."], line, 85);
    }
    if (/duplicate\s+mods?\s*(?:found|id|:)|duplicatemodsfoundexception|found (?:a )?duplicate mod|mod\s+[^\s]+\s+is duplicated/i.test(line)) {
      return finding("duplicate-mods", "Похоже, установлены дубликаты модов",
        "Загрузчик сообщает о повторяющемся моде или его идентификаторе.",
        ["Сохрани резервную копию сборки и миров.",
          "В полном логе найди названия повторяющихся файлов и проверь папку mods.",
          "В копии сборки отключи только подтверждённый дубликат и убедись, что оставшаяся версия подходит Minecraft и загрузчику."], line, 85);
    }
    const solution = line.match(FABRIC_SOLUTION);
    if (solution) return fabricFinding(line, solution[1] || null, [], solution[1] ? 4 : 2, "solution");
    const detail = line.match(FABRIC_DETAIL);
    if (detail) {
      const dependent = { name: detail[1], id: detail[2], version: detail[3] };
      return fabricFinding(line, detail[4] || null, [dependent], detail[4] ? 3 : 2, "detail");
    }
    const replacement = line.match(FABRIC_REPLACE);
    if (replacement) {
      const id = replacement[2].toLowerCase();
      if (!FABRIC_BUILTINS.has(id)) {
        if (id === "fabric-api") return fabricFinding(line, replacement[3], [], 4, "replace");
        return otherFabricFinding(line, id, replacement[3], "replace", replacement[1]);
      }
    }
    const otherInstall = line.match(FABRIC_OTHER_INSTALL);
    if (otherInstall) {
      const id = otherInstall[1].toLowerCase();
      if (!FABRIC_BUILTINS.has(id) && id !== "fabric-api") return otherFabricFinding(line, id, otherInstall[2] || null, "install");
    }
    if (/incompatible mods found|some of your mods are incompatible|modresolutionexception|missing (?:or unsupported )?mandatory dependenc|mod\s+[^\n]{0,140}\s+requires\s+[^\n]{1,160}/i.test(line)) {
      return finding("mod-dependencies", "Несовместимые моды или зависимости",
        "Загрузчик сообщает о несовместимости или недостающей зависимости. Конкретные имена и нужные версии обычно находятся рядом в логе.",
        ["Открой консоль или краш-отчёт и найди строки с названием мода и требуемой зависимостью.",
          "Проверь, что моды и зависимости предназначены для версии Minecraft и загрузчика этой сборки.",
          "Сначала сделай резервную копию; в копии установи недостающую совместимую зависимость или замени только подтверждённую несовместимую версию."], line, 85);
    }
    if (/mixin(?:[^\n]{0,100})(?:apply|injection|transform)(?:[^\n]{0,100})(?:failed|error)|mixintransformererror|mixin apply failed|injectionerror/i.test(line)) {
      return finding("mixin", "Ошибка загрузки модификации (Mixin)",
        "Одна из модификаций не смогла применить изменения к игре. Указанный рядом мод не всегда первопричина.",
        ["Сохрани резервную копию сборки и миров.",
          "Посмотри соседние строки и раздел Caused by в полном логе или краш-отчёте.",
          "Сверь версии затронутых модов, их зависимостей, Minecraft и загрузчика; проверяй изменения по одному в копии сборки."], line, 80);
    }
    if (/glfw error 65542|driver does not appear to support opengl|failed to create (?:an? )?opengl (?:context|window)|opengl.*(?:not supported|не поддерживается)/i.test(line)) {
      return finding("graphics", "Не удалось запустить графику OpenGL",
        "Игра сообщила о проблеме с графическим драйвером или поддержкой OpenGL.",
        ["Проверь, что установлены актуальные драйверы видеокарты с сайта её производителя.",
          "На ноутбуке проверь, какую видеокарту использует Java; при удалённом рабочем столе попробуй обычный вход в систему.",
          "Убедись, что видеокарта и драйвер поддерживают требования выбранной версии игры."], line, 75);
    }
    if (/accessdeniedexception|permission denied|access is denied|отказано в доступе|недостаточно прав для/i.test(line)) {
      return finding("access", "Нет доступа к файлу или папке",
        "В логе есть сообщение об отказе в доступе; оно может относиться к конкретному файлу, указанному рядом.",
        ["Посмотри путь и подробности в полном логе.",
          "Проверь права на папку сборки и не заблокирован ли файл другой программой или защитой системы.",
          "Повтори запуск. Не отключай защиту целиком и не запускай лаунчер от администратора без необходимости."], line, 75);
    }
    if (/версия\s+(?:quilt|fabric|forge|neoforge)\s+[^\n]{1,120}не найдена для minecraft/i.test(line)) {
      return finding("loader-version", "Версия загрузчика не найдена для этой игры",
        "Лаунчер не нашёл указанную версию загрузчика для выбранной версии Minecraft.",
        ["В «Сборка» открой смену версии и проверь Minecraft и загрузчик по списку доступных версий.",
          "Сверь выбор с требованиями автора модпака; не меняй версии вслепую в сборке с важными мирами.",
          "Сохрани копию перед изменением и повтори запуск после выбора совместимой версии."], line, 85);
    }
    if (/could not find or load main class/i.test(line)) {
      return finding("main-class", "Не найден главный класс игры",
        "Java не нашла класс запуска. Это может быть связано с неполной установкой игры или профиля загрузчика.",
        ["Проверь подключение к интернету и повтори запуск, чтобы лаунчер мог завершить подготовку файлов.",
          "Проверь версию игры и загрузчика в настройках сборки; не удаляй папки с мирами.",
          "Если ошибка осталась, передай полный лог разработчику или автору сборки."], line, 75);
    }
    if (options.preparation && /(?:http(?:\s+status)?\s*[:→-]?\s*404\b|\b404\s+not found\b)/i.test(line)) {
      return finding("download-404", "Файл загрузки не найден (HTTP 404)",
        "Сервер ответил, что запрошенный файл или адрес не найден. По одному коду нельзя точно определить, что именно неверно.",
        ["Повтори запуск и проверь доступность источника загрузки.",
          "Сверь выбранные версии игры и загрузчика с доступными для этой сборки, не меняя их наугад.",
          "Если ошибка повторяется, приложи сообщение об ошибке и полный лог к обращению."], line, 65);
    }
    if (/нет связи с |сетевая ошибка:|error sending request|unknownhostexception|(?:connectexception[^\n]{0,80}(?:timed out|connection refused))|connection timed out|failed to download|не удалось скачать/i.test(line)) {
      return finding("network", "Сетевая ошибка или сбой загрузки",
        "Встретилось сообщение о подключении или загрузке файла. Если игра продолжает работать, ошибка может быть временной и не связанной со сбоем.",
        ["Проверь интернет и доступность сервиса, затем повтори попытку.",
          "Если используешь VPN или прокси, проверь его настройки в OmniSpec и при необходимости попробуй другое подключение.",
          "При повторении сохрани полный текст ошибки: проблемы сервера и неверный адрес требуют разных решений."], line, 55);
    }
    if (/could not create the java virtual machine/i.test(line)) {
      return finding("jvm", "Java не запустилась",
        "Виртуальная машина Java не смогла запуститься. Причина обычно указана строкой выше.",
        ["Посмотри соседние строки лога и проверь путь к Java и JVM-аргументы в настройках сборки.",
          "Если указана ошибка выделения памяти, проверь её объём и оставь запас системе.",
          "Если причина неясна, приложи полный лог; один код завершения её не объясняет."], line, 45);
    }
    if (options.preparation && /эта сборка уже запущена/i.test(line)) {
      return finding("already-running", "Сборка уже запущена",
        "Лаунчер обнаружил уже работающее окно этой сборки.",
        ["Переключись на уже открытое окно игры или запусти дубликат через меню сборки.",
          "Если окна не видно, проверь список запущенных сборок и повтори попытку после завершения игры."], line, 55);
    }
    return null;
  }

  class DiagnosticsStore {
    constructor(options = {}) {
      this.groups = new Map();
      this.onChange = options.onChange || (() => {});
      this.now = options.now || (() => Date.now());
      this.maxRuns = Math.max(1, Number(options.maxRuns) || 12);
    }

    group(instance, create = false) {
      if (!instance) return null;
      let group = this.groups.get(instance);
      if (!group && create) {
        group = { runs: [], selected: null, retired: new Set() };
        this.groups.set(instance, group);
      }
      return group || null;
    }

    begin(instance, attemptId, context = null) {
      if (!instance || !attemptId) return null;
      const group = this.group(instance, true);
      const existing = group.runs.find((run) => run.id === attemptId);
      if (existing) return existing;
      // Сохраняем настройки именно этой попытки: позже пользователь может
      // сменить версию игры/загрузчик, и старую подсказку нельзя применять к новой.
      const snapshot = context && typeof context === "object" ? {
        mcVersion: String(context.mcVersion || "").slice(0, 80),
        loader: String(context.loader || "").slice(0, 30),
        loaderVersion: String(context.loaderVersion || "").slice(0, 80)
      } : null;
      const run = {
        id: attemptId, runId: null, account: "", startedAt: this.now(), endedAt: null,
        status: "preparing", code: null, error: "", stopRequested: false, context: snapshot,
        findings: new Map(), findingsLimited: false
      };
      group.runs.push(run);
      group.selected = run.id;
      this.prune(group);
      this.onChange(instance);
      return run;
    }

    prune(group) {
      while (group.runs.length > this.maxRuns) {
        const index = group.runs.findIndex((run) => !["preparing", "running"].includes(run.status));
        if (index < 0) break; // активные окна нельзя потерять, даже если их больше лимита
        const removed = group.runs.splice(index, 1)[0];
        group.retired.add(`attempt:${removed.id}`);
        if (removed.runId) group.retired.add(`run:${removed.runId}`);
        while (group.retired.size > 64) group.retired.delete(group.retired.values().next().value);
        if (group.selected === removed.id) group.selected = (group.runs[group.runs.length - 1] || {}).id || null;
      }
    }

    list(instance) {
      const group = this.group(instance);
      return group ? group.runs.slice().reverse() : [];
    }

    selected(instance) {
      const group = this.group(instance);
      return group ? (group.runs.find((run) => run.id === group.selected) || group.runs[group.runs.length - 1] || null) : null;
    }

    latest(instance) {
      const group = this.group(instance);
      return group ? (group.runs[group.runs.length - 1] || null) : null;
    }

    select(instance, attemptId) {
      const group = this.group(instance);
      if (!group || !group.runs.some((run) => run.id === attemptId)) return;
      group.selected = attemptId;
      this.onChange(instance);
    }

    /** Сопоставляем только по id попытки или процесса; строки без id не смешиваем. */
    fromEvent(payload) {
      const instance = payload && payload.instance;
      const attemptId = payload && payload.attempt_id;
      const runId = payload && payload.run_id;
      if (!instance || (!attemptId && !runId)) return null;
      const group = this.group(instance, true);
      const byAttempt = attemptId ? group.runs.find((item) => item.id === attemptId) : null;
      const byRun = runId ? group.runs.find((item) => item.runId === runId) : null;
      // Не объединяем несовместимые идентификаторы даже при ошибочном событии.
      if ((byAttempt && byRun && byAttempt !== byRun)
        || (byAttempt && byAttempt.runId && runId && byAttempt.runId !== runId)
        || (byRun && attemptId && byRun.id !== attemptId)) return null;
      let run = byAttempt || byRun;
      if (!run && ((attemptId && group.retired.has(`attempt:${attemptId}`))
        || (runId && group.retired.has(`run:${runId}`)))) return null;
      if (!run) run = this.begin(instance, attemptId || `run:${runId}`);
      if (runId && !run.runId) { run.runId = runId; this.onChange(instance); }
      return run;
    }

    addFinding(run, candidate) {
      if (!candidate) return false;
      const previous = run.findings.get(candidate.id);
      if (previous && previous.fabricApi && candidate.fabricApi) {
        const merged = mergeFabricFindings(previous, candidate);
        if (!merged) return false;
        run.findings.set(candidate.id, merged);
        return true;
      }
      if (previous && previous.fabricDependency && candidate.fabricDependency) {
        const merged = mergeOtherFabric(previous, candidate);
        if (!merged) return false;
        run.findings.set(candidate.id, merged);
        return true;
      }
      if (previous && previous.quality >= candidate.quality) return false;
      if (!previous && run.findings.size >= MAX_FINDINGS) {
        // В ограниченной истории оставляем более важные сигналы, даже если
        // перед ними встретилось много второстепенных предупреждений.
        let lowest = null;
        for (const item of run.findings.values()) {
          if (!lowest || item.priority < lowest.priority) lowest = item;
        }
        const newlyLimited = !run.findingsLimited;
        run.findingsLimited = true;
        if (lowest && candidate.priority > lowest.priority) {
          run.findings.delete(lowest.id);
          run.findings.set(candidate.id, candidate);
          return true;
        }
        return newlyLimited;
      }
      run.findings.set(candidate.id, candidate);
      return true;
    }

    log(payload) {
      const run = this.fromEvent(payload);
      if (!run) return null;
      let changed = false;
      if (run.status === "preparing") { run.status = "running"; changed = true; }
      // Завершение никогда не откатывается поздней строкой stdout/stderr.
      if (this.addFinding(run, analyzeLine(payload.line))) changed = true;
      if (changed) this.onChange(payload.instance);
      return run;
    }

    started(instance, attemptId, runId, account) {
      const run = this.fromEvent({ instance, attempt_id: attemptId, run_id: runId });
      if (!run) return null;
      let changed = false;
      if (run.status === "preparing") { run.status = "running"; changed = true; }
      if (account && run.account !== account) { run.account = String(account).slice(0, 100); changed = true; }
      if (changed) this.onChange(instance);
      return run;
    }

    fail(instance, attemptId, error) {
      const run = this.fromEvent({ instance, attempt_id: attemptId });
      if (!run || !["preparing", "running"].includes(run.status)) return run;
      const text = String(error && error.message ? error.message : error || "Неизвестная ошибка").slice(0, 8192);
      run.status = /загрузка отменена пользователем/i.test(text) ? "cancelled" : "failed";
      run.error = text;
      run.endedAt = this.now();
      for (const line of text.split(/\r?\n/).slice(0, 40)) this.addFinding(run, analyzeLine(line, { preparation: true }));
      this.prune(this.group(instance));
      this.onChange(instance);
      return run;
    }

    requestStop(instance, runId = null) {
      const group = this.group(instance);
      if (!group) return [];
      const marked = [];
      for (const run of group.runs) {
        if (run.status === "running" && run.runId && (!runId || run.runId === runId)) {
          if (!run.stopRequested) { run.stopRequested = true; marked.push(run.id); }
        }
      }
      return marked;
    }

    undoStop(instance, marked) {
      const group = this.group(instance);
      if (!group) return;
      for (const run of group.runs) {
        if (marked.includes(run.id) && run.status === "running") run.stopRequested = false;
      }
    }

    exit(payload) {
      const run = this.fromEvent(payload);
      if (!run || !["preparing", "running"].includes(run.status)) return run;
      run.code = payload.code != null && Number.isFinite(Number(payload.code)) ? Number(payload.code) : null;
      // Новое ядро сообщает, был ли kill принят ОС; для старого события
      // оставляем локальную отметку намерения пользователя как запасной вариант.
      const stopped = typeof payload.stopped === "boolean" ? payload.stopped : run.stopRequested;
      run.status = stopped ? "stopped" : "exited";
      run.endedAt = this.now();
      this.prune(this.group(payload.instance));
      this.onChange(payload.instance);
      return run;
    }

    rename(from, to) {
      if (!from || !to || from === to || this.groups.has(to)) return;
      const group = this.groups.get(from);
      if (!group) return;
      this.groups.set(to, group);
      this.groups.delete(from);
      this.onChange(to);
    }

    forget(instance) { this.groups.delete(instance); }
  }

  return { analyzeLine, DiagnosticsStore };
});
