<p align="center">
  <img src="docs/assets/logo-128.png" width="96" height="96" alt="Логотип Figma MCP Compact">
</p>

<h1 align="center">Figma MCP Compact</h1>

<p align="center">
  Макет из Figma для AI-агентов (Claude Code, Cursor, Claude Desktop) —<br>
  в компактном строчном формате, который тратит <b>примерно на 94% меньше токенов</b>, чем сырой JSON Figma.
</p>

<p align="center">
  <a href="https://github.com/PavelDemyanenko/figma-mcp-compact/actions/workflows/ci.yml"><img src="https://github.com/PavelDemyanenko/figma-mcp-compact/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Лицензия MIT"></a>
</p>

<p align="center"><a href="README.md">English</a></p>

---

## Зачем

Обычно макет отдают модели целиком в виде JSON из Figma REST API: десятки тысяч токенов на один экран, и большая часть из них — шум. Figma MCP Compact отвечает на вопросы агента самым дешёвым инструментом, который может на них ответить:

```text
0:768|Mobile|FRAME|3
  0:769|screen|GROUP|5
    0:772|app bar|GROUP|7
    0:784|status bar|GROUP|2
```

На реальном файле: **55 708 токенов REST JSON → 3 188 токенов** (−94%) для тех же двух фреймов, включая всё дерево, все тексты и детальную инспекцию. Подробнее — [docs/benchmark.md](docs/benchmark.md).

## Как устроено

```text
MCP-хост ──stdio──▶ bridge (Spring AI, :3055) ◀──WebSocket── UI плагина ◀─postMessage─▶ песочница плагина ─▶ Figma Plugin API
```

- **Плагин** (`mcp-bridge-plugin/`) работает в Figma Desktop, читает документ через асинхронный Plugin API и отвечает на JSON-RPC-запросы. Только чтение: файл он не меняет.
- **Bridge** (`bridge/`) — локальный MCP-сервер на Spring Boot и Spring AI, его запускает MCP-хост через stdio. С плагином он общается по WebSocket на `localhost:3055` и кэширует данные дизайн-системы.

## Инструменты (от дешёвых к дорогим)

| Инструмент | Параметры | Что возвращает |
|---|---|---|
| `figma_get_selection` | — | Выделенные узлы: `id\|name\|type` по строке, `[]` если ничего не выделено |
| `figma_get_tree` | `nodeId?`, `maxDepth=2`, `pages?` | Иерархию `<отступ><id>\|<name>\|<type>\|<childCount>[\|truncated:N]`; `pages:true` — список всех страниц |
| `figma_get_text` | `nodeId?` | Текстовые слои `<id>\|<path>\|<text>` (до 500 строк) + `skippedInstances: N` |
| `figma_get_styles` | `prefix?` | Имена стилей и переменных; больше 100 — сводку групп для спуска по `prefix` |
| `figma_inspect_node` | `nodeId`, `level=0..2`, `svg?` | Компактный JSON: границы, auto-layout, цвета с именами стилей, текст, тени, изменения инстансов, дети; `svg:true` для иконок |
| `figma_get_screenshot` | `nodeId`, `scale=1` | PNG как картинку MCP (лимит 5 МБ) |

Форматы ответов: [docs/protocol.md](docs/protocol.md) (на английском).

## Быстрый старт

Нужны: Figma Desktop (подойдёт бесплатный тариф), Node.js 20+, Java 25 + Maven, MCP-хост (Claude Code, Cursor или Claude Desktop). Если работаете в WSL — Docker Desktop (см. ниже).

1. **Собрать плагин:**
   ```bash
   cd mcp-bridge-plugin && npm install && npm run build
   ```
2. **Импортировать в Figma:** открыть любой дизайн-файл → Plugins → Development → Import plugin from manifest… → `mcp-bridge-plugin/manifest.json`. Публиковать плагин не нужно: плагинам в разработке разрешено подключаться к `localhost:3055`.
3. **Собрать bridge:**
   ```bash
   cd bridge && mvn package
   ```
4. **Подключить MCP-сервер** (bridge хост запускает сам):
   ```bash
   claude mcp add -s user figma-compact -- java -jar /ABS/PATH/bridge/target/figma-mcp-bridge-0.1.0.jar
   ```
   Cursor / Claude Desktop (`mcp.json` / `claude_desktop_config.json`):
   ```json
   { "mcpServers": { "figma-compact": { "command": "java", "args": ["-jar", "/ABS/PATH/bridge/target/figma-mcp-bridge-0.1.0.jar"] } } }
   ```
5. **Запустить плагин** (Plugins → Development → Figma MCP Compact). Индикатор станет зелёным: «Подключено (:3055)». Выделите фрейм и спросите агента: «что у меня выделено в Figma?»

### WSL: Figma в Windows, разработка в WSL

В WSL2 в режиме NAT Windows не видит сервисы, которые слушают `127.0.0.1` внутри WSL, и плагин будет бесконечно переподключаться. Поэтому bridge запускают в Docker: Docker Desktop публикует порт в Windows.

```bash
cd bridge && mvn package && docker build -t figma-mcp-bridge .
claude mcp add -s user figma-compact -- docker run -i --rm -p 127.0.0.1:3055:3055 figma-mcp-bridge
```

Проверка из PowerShell: `Test-NetConnection localhost -Port 3055`.

## Интерфейс плагина

Небольшая диагностическая панель: статус подключения, выделение, которое сейчас видит агент, лог запросов и быстрые действия — **«Скопировать срез для AI»** (компактный снимок для вставки в любой чат) и замер токенов. Английский и русский, переключение в ⚙ → Язык.

## Безопасность

Всё, что возвращают инструменты (имена слоёв, тексты, имена стилей, SVG), — **недоверенные данные** автора файла Figma, в том числе файлов из Community. MCP-сервер указывает модели воспринимать это только как содержимое дизайна и не выполнять найденные там инструкции. Bridge слушает только loopback и отклоняет чужие `Origin`/`Host`. Подробнее: [SECURITY.md](SECURITY.md).

## Разработка

```bash
cd mcp-bridge-plugin && npm run typecheck && npm test && npm run build   # плагин: unit-тесты
cd bridge && mvn package                                                 # bridge: unit-тесты + jar
node e2e/smoke.mjs                                                       # сквозной тест: bridge + эмулятор плагина + MCP-клиент
node e2e/smoke.mjs --docker                                              # то же против Docker-образа
```

Сквозной тест не запустится, пока порт 3055 занят другим bridge: иначе он забрал бы порт себе. См. [CONTRIBUTING.md](CONTRIBUTING.md) и [docs/architecture.md](docs/architecture.md).

## Частые проблемы

| Симптом | Что делать |
|---|---|
| Индикатор жёлтый или красный, «bridge не найден» | Bridge не запущен: проверьте `/mcp` в хосте (в WSL — что запущен Docker Desktop). |
| `Manifest error … must be a valid URL` | Старый манифест с `127.0.0.1`: Figma принимает только имена хостов. Переимпортируйте. |
| Агент получает `PLUGIN_NOT_CONNECTED` | Окно плагина закрыто — он работает, только пока открыт. |
| Изменения не видны | Плагин: `npm run build` и перезапуск плагина. Bridge: пересборка и перезапуск MCP-хоста. |

## Лицензия

[MIT](LICENSE)
