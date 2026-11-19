const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { analyzeLine, DiagnosticsStore } = require('../../apps/omnispec-app/ui/diagnostics.js');

const screenshot = 'java.lang.module.ResolutionException: Modules minecraft and customskinloader export package net.minecraft.client.renderer to module ftblibrary';
const conflict = analyzeLine(screenshot);
assert.equal(conflict.id, 'java-modules');
assert.match(conflict.description, /minecraft и customskinloader/);
assert.match(conflict.description, /ftblibrary читает этот пакет и не обязательно/);
assert.match(conflict.steps.join(' '), /копию/);
assert.doesNotMatch(conflict.steps.join(' '), /удали(?:те)?\s+ftblibrary/i);
const alternate = analyzeLine('java.lang.module.ResolutionException: Module ftblibrary reads package net.minecraft.client.renderer from both minecraft and customskinloader');
assert.equal(alternate.id, 'java-modules');
assert.match(alternate.description, /minecraft и customskinloader/);
assert.match(alternate.description, /ftblibrary читает/);
assert.equal(analyzeLine('Java finished with exit code 1'), null, 'код выхода не диагноз');
assert.equal(analyzeLine('[INFO] Everything loaded correctly'), null);

const cases = [
  ['UnsupportedClassVersionError: Test has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0', 'java-version'],
  ['не хватает Java: указанный в настройках путь к Java не работает: C:\\java.exe', 'java-missing'],
  ['java.lang.OutOfMemoryError: Java heap space', 'memory-heap'],
  ['Error occurred during initialization of VM: Could not reserve enough space for object heap', 'memory-reserve'],
  ['java.io.IOException: No space left on device', 'disk-space'],
  ['Duplicate Mods found: example', 'duplicate-mods'],
  ['net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!', 'mod-dependencies'],
  ['org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: critical error', 'mixin'],
  ['GLFW error 65542: WGL: The driver does not appear to support OpenGL', 'graphics'],
  ['java.nio.file.AccessDeniedException: C:\\Games\\mods', 'access'],
  ['Версия Quilt 66.1.8 не найдена для Minecraft 26.3. Выберите другую версию загрузчика.', 'loader-version'],
  ['Error: Could not find or load main class net.minecraft.client.main.Main', 'main-class'],
  ['HTTP 404 Not Found: file missing', 'download-404', {preparation:true}],
  ['нет связи с meta.fabricmc.net: error sending request', 'network'],
  ['Error: Could not create the Java Virtual Machine.', 'jvm'],
  ['эта сборка уже запущена или подготавливается', 'already-running', {preparation:true}]
];
for (const [line, expected, options] of cases) {
  assert.equal(analyzeLine(line, options)?.id, expected, `${expected}: ${line}`);
}
assert.match(analyzeLine(cases[0][0]).description, /Java 21.*Java 17/);
assert.equal(analyzeLine('HTTP 404 Not Found', {preparation:false}), null);
assert.equal(analyzeLine('\x1b[31m' + screenshot + '\x1b[0m').id, 'java-modules');
assert.ok(analyzeLine(screenshot + 'x'.repeat(20000)).evidence.length <= 501, 'ограничен размер сохранённой строки');

const bounded = new DiagnosticsStore();
bounded.begin('pack', 'priority');
for (const [line] of cases.slice(0,12)) bounded.log({instance:'pack',attempt_id:'priority',run_id:'pack#1',line});
assert.equal(bounded.selected('pack').findings.size,12);
bounded.log({instance:'pack',attempt_id:'priority',run_id:'pack#1',line:screenshot});
assert.equal(bounded.selected('pack').findings.size,12);
assert(bounded.selected('pack').findings.has('java-modules'),'более важный сигнал не теряется из-за лимита');
assert(bounded.selected('pack').findingsLimited);
bounded.log({instance:'pack',attempt_id:'priority',run_id:'pack#1',line:'нет связи с meta.fabricmc.net: error sending request'});
assert(bounded.selected('pack').findings.has('java-modules'),'второстепенный сигнал не вытесняет важный');

let changes = 0, time = 0;
const store = new DiagnosticsStore({onChange: () => { changes++; }, now: () => ++time, maxRuns: 3});
store.begin('pack', 'attempt-1');
store.begin('pack', 'attempt-2');
store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', line:'ordinary'});
store.log({instance:'pack', attempt_id:'attempt-2', run_id:'pack#2', line:'java.lang.OutOfMemoryError: Java heap space'});
store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', line:'java.lang.module.ResolutionException'});
store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', line:screenshot});
assert.equal(store.list('pack')[0].findings.has('memory-heap'), true);
const first = store.list('pack').find(r => r.id === 'attempt-1');
assert.equal(first.findings.size, 1, 'общая сигнатура уточняется, а не дублируется');
assert.match(first.findings.get('java-modules').description, /ftblibrary читает/);
const second = store.list('pack').find(r => r.id === 'attempt-2');
assert.equal(second.findings.has('java-modules'), false, 'вывод параллельных окон не смешивается');
assert.equal(first.findings.has('memory-heap'), false);
assert.equal(store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#2', line:'OutOfMemoryError: Java heap space'}), null, 'несовместимые id не объединяют окна');

const before = changes;
const start = performance.now();
for (let i = 0; i < 30000; i++) {
  store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', line:'[INFO] Ordinary game output without errors'});
  if (i % 100 === 0) store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', line:screenshot});
}
assert.equal(changes, before, 'обычные и повторные строки не вызывают перерисовку');
assert(performance.now() - start < 10000, 'инкрементальная проверка должна быть быстрой');

store.requestStop('pack', 'pack#2');
store.exit({instance:'pack', attempt_id:'attempt-2', run_id:'pack#2', code:-1});
assert.equal(second.status, 'stopped');
store.exit({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', code:1});
assert.equal(first.status, 'exited');
store.started('pack', 'attempt-1', 'pack#1', 'Steve');
assert.equal(first.status, 'exited', 'опоздавший ответ launch не оживляет процесс');
store.log({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', line:'java.lang.OutOfMemoryError: Java heap space'});
assert.equal(first.status, 'exited', 'опоздавший stderr не оживляет процесс');
assert(first.findings.has('memory-heap'), 'поздняя строка всё равно анализируется');
store.exit({instance:'pack', attempt_id:'attempt-1', run_id:'pack#1', code:0});
assert.equal(first.code, 1, 'повторное событие выхода не заменяет код');
assert.equal(store.log({instance:'pack', line:screenshot}), null, 'строки без id не приписываются случайной сессии');

store.begin('other', 'unknown');
store.exit({instance:'other', attempt_id:'unknown', run_id:'other#1', code:1});
assert.equal(store.selected('other').findings.size, 0, 'код 1 не превращается в подсказку о модах или Java');
store.begin('other', 'missing-code');
store.exit({instance:'other', attempt_id:'missing-code', run_id:'other#2', code:null});
assert.equal(store.selected('other').code, null);
store.begin('other', 'cancel');
store.fail('other', 'cancel', 'загрузка отменена пользователем');
assert.equal(store.selected('other').status, 'cancelled');
store.begin('other', 'prep-error');
store.fail('other', 'prep-error', 'Версия Quilt 66.1.8 не найдена для Minecraft 26.3. Выберите другую версию загрузчика.');
assert.equal(store.selected('other').status, 'failed');
assert(store.selected('other').findings.has('loader-version'));
assert(store.list('other').length <= 3, 'история завершённых попыток ограничена');
assert.equal(store.log({instance:'other',attempt_id:'unknown',run_id:'other#1',line:screenshot}),null);
assert.equal(store.latest('other').id,'prep-error','поздняя строка вытесненного запуска не подменяет последний запуск');

const active = new DiagnosticsStore({maxRuns:1});
active.begin('p','a'); active.started('p','a','p#1','');
active.begin('p','b'); active.started('p','b','p#2','');
assert.equal(active.list('p').length, 2, 'активные окна не вытесняются лимитом истории');
const marked = active.requestStop('p','p#1');
active.undoStop('p', marked);
active.exit({instance:'p',attempt_id:'a',run_id:'p#1',code:1});
assert.equal(active.list('p').length, 1);
assert.equal(active.selected('p').id, 'b');
const authoritative = new DiagnosticsStore();
authoritative.begin('p','a'); authoritative.started('p','a','p#1','');
authoritative.requestStop('p','p#1');
authoritative.exit({instance:'p',attempt_id:'a',run_id:'p#1',code:1,stopped:false});
assert.equal(authoritative.selected('p').status,'exited', 'естественный выход до kill не маскируется как ручная остановка');
authoritative.exit({instance:'p',attempt_id:'reloaded',run_id:'p#2',code:-1,stopped:true});
assert.equal(authoritative.selected('p').status,'stopped', 'подтверждение backend работает после перезагрузки интерфейса');
console.log('DIAGNOSTICS_UNIT: signatures, per-run isolation, exit races, stops, memory bounds, no per-line renders — OK');
