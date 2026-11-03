// Plugin UI localization (docs/architecture.md, Localization). iframe UI only: tool output for the agent is not localized.

export type Lang = 'en' | 'ru';
export type LangPref = 'auto' | Lang;

/** 'auto' follows the system/Figma language (navigator.language): Russian for ru-*, English otherwise. */
export function resolveLang(pref: LangPref, navigatorLang: string | undefined): Lang {
  if (pref === 'en' || pref === 'ru') return pref;
  return (navigatorLang || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

const ru = {
  // static markup (data-i18n / data-i18n-title / data-i18n-aria)
  settings: 'Настройки моста',
  collapse: 'Свернуть',
  expand: 'Развернуть',
  connectionLabel: 'Статус подключения',
  bridgeAddress: 'Адрес bridge',
  autoConnect: 'Подключаться автоматически',
  language: 'Язык',
  langAuto: 'Авто',
  benchButton: 'Сравнить токены (dev)',
  benchTitle: 'Сравнить токены REST JSON и DSL для выделенных узлов; отчёт копируется в буфер',
  selectionLabel: 'Контекст выделения',
  quickActions: 'Быстрые действия',
  copySlice: 'Скопировать срез для AI',
  logLabel: 'Лог запросов',
  clearLog: 'Очистить лог',
  logEmpty: 'Нет запросов от агента',
  // status
  connected: (port: string) => `Подключено (${port})`,
  connecting: 'Подключение…',
  retrying: (wait: number, attempt: number, max: number) => `Повтор через ${wait} с (попытка ${attempt}/${max})`,
  notFound: (wait: number) => `Нет подключения — bridge не найден, проверка через ${wait} с`,
  startBridge: 'запустите MCP bridge',
  disconnected: 'Отключено',
  btnConnect: 'Подключить',
  btnDisconnect: 'Отключить',
  btnReconnect: 'Переподключить',
  // log
  manualDisconnect: 'Отключено вручную',
  connectedTo: (url: string) => `Подключено к ${url}`,
  closed: (code: number) => `Соединение закрыто (код ${code})`,
  unreachable: 'Bridge недоступен: проверка каждые 30 с',
  sendFailed: (msg: string) => `Отправка не удалась: ${msg}`,
  invalidJson: '← невалидный JSON от bridge',
  notDelivered: ' (не доставлено)',
  stylesInvalidated: 'стили изменены → кэш bridge сброшен',
  // selection
  nothingSelected: 'Ничего не выделено',
  selectedOne: (desc: string) => `🔲 Выделено: ${desc}`,
  selectedMany: (n: number, first: string) => `🔲 Выделено: ${n} узл. — ${first}, …`,
  // slice and benchmark
  moreNodes: (n: number) => `# … ещё ${n} узл. не включены`,
  sliceCopied: (lines: number, tokens: number) => `Срез скопирован: ${lines} строк, ~${tokens} токенов`,
  sliceFailed: (msg: string) => `Срез не скопирован: ${msg}`,
  clipboardUnavailable: 'буфер обмена недоступен',
  benchSelect: 'Замер: выделите 1–5 фреймов на холсте',
  benchStart: (n: number) => `Замер ${n} узл.: экспорт REST JSON…`,
  benchFirst: (n: number, total: number) => `Замер: учтены первые ${n} из ${total}`,
  benchCopied: 'Отчёт замера скопирован в буфер',
  benchNotCopied: 'Отчёт не скопирован: буфер недоступен',
  benchFailed: (msg: string) => `Замер не удался: ${msg}`,
  // benchmark report (shared/bench.ts)
  reportTitle: '# Замер токенов: REST JSON (exportAsync JSON_REST_V1) vs DSL плагина',
  reportEstimate: '# оценка: символы / 4',
  tokens: 'ток.',
  restUnavailable: 'REST JSON недоступен',
  noData: 'нет данных',
  total: 'ИТОГО',
};

export type Strings = typeof ru;

const en: Strings = {
  settings: 'Bridge settings',
  collapse: 'Collapse',
  expand: 'Expand',
  connectionLabel: 'Connection',
  bridgeAddress: 'Bridge address',
  autoConnect: 'Connect automatically',
  language: 'Language',
  langAuto: 'Auto',
  benchButton: 'Compare tokens (dev)',
  benchTitle: 'Compare REST JSON vs DSL tokens for the selected nodes; the report is copied to the clipboard',
  selectionLabel: 'Selection',
  quickActions: 'Quick actions',
  copySlice: 'Copy slice for AI',
  logLabel: 'Request log',
  clearLog: 'Clear log',
  logEmpty: 'No agent requests yet',
  connected: (port) => `Connected (${port})`,
  connecting: 'Connecting…',
  retrying: (wait, attempt, max) => `Retrying in ${wait}s (attempt ${attempt}/${max})`,
  notFound: (wait) => `Disconnected — bridge not found, next check in ${wait}s`,
  startBridge: 'start the MCP bridge',
  disconnected: 'Disconnected',
  btnConnect: 'Connect',
  btnDisconnect: 'Disconnect',
  btnReconnect: 'Reconnect',
  manualDisconnect: 'Disconnected manually',
  connectedTo: (url) => `Connected to ${url}`,
  closed: (code) => `Connection closed (code ${code})`,
  unreachable: 'Bridge unreachable: checking every 30s',
  sendFailed: (msg) => `Send failed: ${msg}`,
  invalidJson: '← invalid JSON from bridge',
  notDelivered: ' (not delivered)',
  stylesInvalidated: 'styles changed → bridge cache reset',
  nothingSelected: 'Nothing selected',
  selectedOne: (desc) => `🔲 Selected: ${desc}`,
  selectedMany: (n, first) => `🔲 Selected: ${n} nodes — ${first}, …`,
  moreNodes: (n) => `# … ${n} more nodes not included`,
  sliceCopied: (lines, tokens) => `Slice copied: ${lines} lines, ~${tokens} tokens`,
  sliceFailed: (msg) => `Slice not copied: ${msg}`,
  clipboardUnavailable: 'clipboard unavailable',
  benchSelect: 'Benchmark: select 1–5 frames on the canvas',
  benchStart: (n) => `Benchmark of ${n} nodes: exporting REST JSON…`,
  benchFirst: (n, total) => `Benchmark: first ${n} of ${total} measured`,
  benchCopied: 'Benchmark report copied to clipboard',
  benchNotCopied: 'Report not copied: clipboard unavailable',
  benchFailed: (msg) => `Benchmark failed: ${msg}`,
  reportTitle: '# Token benchmark: REST JSON (exportAsync JSON_REST_V1) vs plugin DSL',
  reportEstimate: '# estimate: characters / 4',
  tokens: 'tok.',
  restUnavailable: 'REST JSON unavailable',
  noData: 'no data',
  total: 'TOTAL',
};

export const STRINGS: Record<Lang, Strings> = { en, ru };

/** Keys of static (parameterless) strings, used by data-i18n in ui.html. */
export type StaticKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings];
