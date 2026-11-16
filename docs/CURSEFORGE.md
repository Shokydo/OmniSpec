# CurseForge: как это устроено

CurseForge работает вторым источником рядом с Modrinth: та же вкладка в сборке,
те же карточки и панели, тот же выбор версии и автодокачка зависимостей.
Отличие одно — запросы идут с ключом, поэтому клиент живёт в отдельном модуле.

## Ключ

* По умолчанию используется ключ из константы `DEFAULT_API_KEY`
  (`crates/omnispec-core/src/curseforge/mod.rs`).
* Переопределить можно переменной окружения `CURSEFORGE_API_KEY` — она важнее
  встроенного значения:

```bash
CURSEFORGE_API_KEY=... cargo run -p omnispec-app
```

Без ключа вкладка не падает: запросы возвращают понятную ошибку «не задан
API-ключ», а `curseforge_ready` честно отвечает `false`.

## Запросы

| Задача | Запрос |
|---|---|
| Поиск | `GET /v1/mods/search?gameId=432&classId=6&searchFilter=create&gameVersion=1.21.1&modLoaderType=6&index=0&pageSize=24&sortField=6&sortOrder=desc` |
| Проект | `GET /v1/mods/{modId}` |
| Файлы (версии) | `GET /v1/mods/{modId}/files?gameVersion=1.21.1&modLoaderType=6&pageSize=50` |
| Один файл | `GET /v1/mods/{modId}/files/{fileId}` |
| Ссылка на файл | `GET /v1/mods/{modId}/files/{fileId}/download-url` |

Заголовки: `x-api-key`, `Accept: application/json`.

* `gameId` = 432 — Minecraft.
* `classId`: 6 — моды, 4471 — модпаки, 12 — ресурспаки, 6552 — шейдеры.
* `modLoaderType`: 1 — Forge, 4 — Fabric, 5 — Quilt, 6 — NeoForge.
* `sortField`: 2 — популярность, 3 — обновлено, 6 — загрузки, 11 — новое.

Часть авторов запрещает скачивание через лаунчеры: у таких файлов
`downloadUrl` пустой, а `download-url` отвечает отказом. Лаунчер показывает это
как «автор запретил скачивание этого файла через лаунчеры».

## Код

```
crates/omnispec-core/src/curseforge/
├── mod.rs      клиент + преобразование ответов в типы Modrinth
├── install.rs  установка файла в сборку вместе с обязательными зависимостями
└── modpack.rs  модпак как отдельная сборка: manifest.json, файлы, overrides
```

Типы на выходе — те же, что у Modrinth (`modrinth::SearchHit`, `Project`,
`Version`), поэтому интерфейс рисует обе площадки одинаковыми карточками:
источник — это только набор полей рядом с `project_id`.

Команды Tauri: `search_curseforge`, `curseforge_versions`, `curseforge_project`,
`curseforge_ready`, `install_curseforge` (файл в текущую сборку),
`install_curseforge_modpack` (модпак отдельной сборкой).

## Ограничения

* Модпак ставится только из каталога (`install_curseforge_modpack`): внутри
  архива читается `manifest.json`, из него берутся версия игры, загрузчик,
  `overrides/` и список файлов по `projectID` + `fileID`. Ссылок на файлы в
  манифесте нет — каждая версия запрашивается через API, поэтому установка
  модпака на 200–300 модов идёт заметно дольше установки одного мода.
* Необязательные файлы манифеста (`required: false`) не ставятся.
* Зависимости CurseForge ссылаются на `modId` без номера файла, поэтому для
  каждой берётся самый свежий файл под версию игры и загрузчик сборки.
