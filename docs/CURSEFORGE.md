# CurseForge: как добавить вторым источником модов

Сейчас в OmniSpec есть только Modrinth — у него открытый API без ключа.
CurseForge требует ключ и подпись запросов, поэтому интеграция вынесена в отдельный шаг.

## 1. Ключ

1. Зайди на <https://console.curseforge.com/> под аккаунтом CurseForge.
2. Создай API-ключ (бесплатно, но нужно заполнить заявку).
3. Ключ кладётся в настройки лаунчера или в переменную окружения
   `CURSEFORGE_API_KEY` (в открытый репозиторий ключ не коммить!).

## 2. Endpoints, которые нужны

| Задача | Запрос |
|---|---|
| Поиск | `GET https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&searchFilter=sodium&gameVersion=1.21.4&modLoaderType=4` |
| Мод | `GET /v1/mods/{modId}` |
| Файлы мода | `GET /v1/mods/{modId}/files?gameVersion=1.21.4&modLoaderType=4` |
| Скачать файл | `GET /v1/mods/{modId}/files/{fileId}/download-url` |
| Модпак | `GET /v1/mods/{modId}` → `latestFiles` (`.zip` формата CurseForge) |

Заголовок: `x-api-key: <ключ>`, `Accept: application/json`.
`classId`: 6 — моды, 4471 — модпаки, 12 — ресурспаки, 6552 — шейдеры.
`modLoaderType`: 1=Forge, 4=Fabric, 5=Quilt, 6=NeoForge.

## 3. Куда встраивать в коде

Интерфейс ядра уже готов к «второму источнику»: ищи `crates/omnispec-core/src/modrinth/`
и повтори структуру:

```
crates/omnispec-core/src/curseforge/
├── mod.rs        клиент + типы (SearchHit, Project, File)
├── install.rs    установка файла в сборку (mods/, resourcepacks/…)
└── modpack.rs    импорт zip-модпака: manifest.json + overrides/
```

Что переиспользуется как есть:

* `net::Http::download` — скачивание с прогрессом;
* `instances::create` — создание сборки под модпак;
* `modrinth::install::target_dir` — выбор папки по типу проекта;
* (для zip-модпака CurseForge) распаковка `overrides/` — логика в
  `modrinth/mrpack.rs::extract_overrides`, файл `manifest.json` имеет похожую
  структуру (`minecraft.version`, `modLoaders`, `files[].projectID/fileID`).

Единственное принципиальное отличие: **файлы CurseForge нельзя скачивать по прямой
ссылке без ключа**, поэтому URL каждого файла берётся через `/download-url`.

## 4. Что учесть в UI

* В фильтрах вкладки «Modrinth» добавить переключатель источника
  (`Modrinth | CurseForge`) — поле `state.modrinth.source` в `ui/app.js`.
* В настройках — поле «CurseForge API-ключ» (хранить в `settings.json`,
  в репозиторий не попадает).
* Если ключа нет — источник просто скрыт, ошибок не показывать.
