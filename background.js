const SEARCHES_KEY = "findfullSearches";
const LAST_CONFIG_KEY = "findfullLastConfig";
const ERROR_LOGS_KEY = "findfullErrorLog";
const MAX_ERROR_LOGS = 200;
const ALARM_PREFIX = "findfull-scan-";
let errorLogQueue = Promise.resolve();

function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/#?\b\d{6,20}\b/g, "#…")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[e-mail]")
    .slice(0, 400);
}

function appendErrorLog({ source = "extension", stage = "", message = "Falha sem detalhes.", severity = "error" }) {
  const entry = {
    timestamp: new Date().toISOString(),
    severity: severity === "warning" ? "warning" : "error",
    source: sanitizeDiagnostic(source).slice(0, 60),
    stage: sanitizeDiagnostic(stage).slice(0, 80),
    message: sanitizeDiagnostic(message),
    version: chrome.runtime.getManifest().version
  };
  errorLogQueue = errorLogQueue.catch(() => {}).then(async () => {
    const data = await chrome.storage.local.get(ERROR_LOGS_KEY);
    const logs = Array.isArray(data[ERROR_LOGS_KEY]) ? data[ERROR_LOGS_KEY] : [];
    const previous = logs[0];
    const previousAt = Date.parse(previous?.timestamp || "");
    if (previous?.source === entry.source && previous?.stage === entry.stage &&
        previous?.message === entry.message && Date.now() - previousAt < 30_000) return;
    await chrome.storage.local.set({ [ERROR_LOGS_KEY]: [entry, ...logs].slice(0, MAX_ERROR_LOGS) });
  });
  return errorLogQueue.catch(() => {});
}

function isMarketplaceUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "mercadolivre.com.br" || host.endsWith(".mercadolivre.com.br") ||
      host === "mercadolibre.com" || host.endsWith(".mercadolibre.com");
  } catch {
    return false;
  }
}

function alarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

async function readSearches() {
  const data = await chrome.storage.local.get(SEARCHES_KEY);
  return data[SEARCHES_KEY] || {};
}

async function writeSearch(tabId, value) {
  const searches = await readSearches();
  searches[String(tabId)] = value;
  await chrome.storage.local.set({ [SEARCHES_KEY]: searches });
}

async function removeSearch(tabId) {
  const searches = await readSearches();
  delete searches[String(tabId)];
  await chrome.storage.local.set({ [SEARCHES_KEY]: searches });
  await chrome.alarms.clear(alarmName(tabId));
}

async function pauseSearchForError(tabId, message) {
  const searches = await readSearches();
  const search = searches[String(tabId)];
  await chrome.alarms.clear(alarmName(tabId));
  if (!search) return;
  search.running = false;
  search.status = "needs_attention";
  search.resultMessage = "A extensão encontrou um erro e pausou a busca. Consulte o histórico de erros.";
  search.updatedAt = Date.now();
  search.nextRefreshAt = 0;
  await writeSearch(tabId, search);
  await showNotification(tabId, "Busca pausada por erro", message || search.resultMessage);
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function getOverview() {
  const [activeTabs, allTabs, searches, saved] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.tabs.query({}),
    readSearches(),
    chrome.storage.local.get([LAST_CONFIG_KEY, ERROR_LOGS_KEY])
  ]);
  const activeTab = activeTabs[0] || null;
  const relevantTabs = allTabs.filter(tab => tab.id !== undefined && isMarketplaceUrl(tab.url || ""));
  const tabRows = await Promise.all(relevantTabs.map(async tab => {
    const page = await sendToTab(tab.id, { type: "PAGE_INFO" });
    const search = searches[String(tab.id)] || null;
    return {
      id: tab.id,
      title: tab.title || "Aba do Mercado Livre",
      url: tab.url || "",
      supportedPage: Boolean(page && page.supported),
      recoveryStep: page?.recoveryStep || "",
      schedulePage: Boolean(page?.schedulePage),
      pageMessage: page?.message || "Aguardando a página carregar",
      search
    };
  }));
  const activePage = activeTab?.id === undefined
    ? null
    : await sendToTab(activeTab.id, { type: "PAGE_INFO" });

  return {
    activeTabId: activeTab?.id ?? null,
    activeTabTitle: activeTab?.title || "",
    activeTabUrl: activeTab?.url || "",
    activeSupportedPage: Boolean(activePage && activePage.supported),
    activeRecoveryStep: activePage?.recoveryStep || "",
    activeSchedulePage: Boolean(activePage?.schedulePage),
    activePageMessage: activePage?.message || "Abra a tela de agendamento do Full no Mercado Livre.",
    tabs: tabRows,
    lastConfig: saved[LAST_CONFIG_KEY] || null,
    errorLog: Array.isArray(saved[ERROR_LOGS_KEY]) ? saved[ERROR_LOGS_KEY] : []
  };
}

function normalizeConfig(config) {
  const intervalSeconds = Math.max(30, Math.min(300, Number(config.intervalSeconds) || 30));
  const mode = config.mode === "range" ? "range" : "specific";
  return {
    mode,
    dates: Array.isArray(config.dates) ? [...new Set(config.dates.filter(isIsoDate))] : [],
    startDate: isIsoDate(config.startDate) ? config.startDate : "",
    endDate: isIsoDate(config.endDate) ? config.endDate : "",
    intervalSeconds,
    autoConfirm: config.autoConfirm !== false,
    shipmentId: String(config.shipmentId || "").replace(/\D/g, "")
  };
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function startOne(tab, config) {
  if (!tab || tab.id === undefined || !isMarketplaceUrl(tab.url || "")) {
    return { ok: false, tabId: tab?.id, error: "Aba fora do Mercado Livre." };
  }
  const page = await sendToTab(tab.id, { type: "PAGE_INFO" });
  if (!page?.supported) {
    return { ok: false, tabId: tab.id, error: page?.message || "Abra a página de agendamento do Full." };
  }
  if (config.shipmentId && page.shipmentId !== config.shipmentId) {
    return { ok: false, tabId: tab.id, error: `O ID cadastrado (#${config.shipmentId}) não corresponde ao envio aberto nesta aba.` };
  }

  const now = Date.now();
  const search = {
    running: true,
    status: "monitoring",
    config,
    tabTitle: tab.title || "Aba do Mercado Livre",
    tabUrl: tab.url || "",
    startedAt: now,
    updatedAt: now,
    lastRefreshAt: 0,
    nextRefreshAt: now + config.intervalSeconds * 1000
  };
  await writeSearch(tab.id, search);
  await chrome.storage.local.set({ [LAST_CONFIG_KEY]: config });
  await chrome.alarms.create(alarmName(tab.id), {
    delayInMinutes: config.intervalSeconds / 60,
    periodInMinutes: config.intervalSeconds / 60
  });
  await sendToTab(tab.id, { type: "SCAN", config });
  return { ok: true, tabId: tab.id, title: search.tabTitle };
}

async function stopOne(tabId) {
  const searches = await readSearches();
  const prior = searches[String(tabId)];
  await removeSearch(tabId);
  await sendToTab(tabId, { type: "STOP_SCAN" });
  return Boolean(prior);
}

async function stopAll() {
  const searches = await readSearches();
  await Promise.all(Object.keys(searches).map(id => stopOne(Number(id))));
}

async function resumeSearch(tabId) {
  const searches = await readSearches();
  const search = searches[String(tabId)];
  if (!search || search.status !== "needs_attention") {
    return { ok: false, error: "Não há uma busca pausada para retomar nesta aba." };
  }
  if (!isMarketplaceUrl(search.tabUrl || "")) {
    return { ok: false, error: "A busca salva não pertence a uma aba do Mercado Livre." };
  }
  const page = await sendToTab(tabId, { type: "PAGE_INFO" });
  if (page?.recoveryStep) {
    if (!search.config?.shipmentId) {
      return { ok: false, error: "Cadastre o ID do envio antes de retomar a recuperação." };
    }
    await chrome.alarms.clear(alarmName(tabId));
    search.running = false;
    search.status = "recovering";
    search.recoveryStep = page.recoveryStep;
    search.updatedAt = Date.now();
    search.nextRefreshAt = 0;
    await writeSearch(tabId, search);
    await sendToTab(tabId, { type: "RECOVER", config: search.config });
    return { ok: true, message: `Retomada iniciada na etapa ${page.recoveryStep}.` };
  }
  if (page?.schedulePage) {
    if (search.config?.shipmentId && page.shipmentId !== search.config.shipmentId) {
      return { ok: false, error: `O ID cadastrado (#${search.config.shipmentId}) não corresponde ao envio aberto nesta aba.` };
    }
    search.running = true;
    search.status = "monitoring";
    search.recoveryStep = "";
    search.resultMessage = "";
    search.updatedAt = Date.now();
    const interval = normalizeConfig(search.config).intervalSeconds;
    search.nextRefreshAt = search.updatedAt + interval * 1000;
    await writeSearch(tabId, search);
    await chrome.alarms.create(alarmName(tabId), {
      delayInMinutes: interval / 60,
      periodInMinutes: interval / 60
    });
    await sendToTab(tabId, { type: "SCAN", config: search.config });
    return { ok: true, message: "Busca retomada na página de agendamento." };
  }
  return { ok: false, error: "Esta aba ainda não está em uma etapa reconhecida da recuperação ou do agendamento." };
}

async function handleContentEvent(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false };
  if (message.event === "APP_ERROR") {
    await appendErrorLog({
      source: message.source || "Página do Mercado Livre",
      stage: message.stage || "content script",
      message: message.message || "Falha sem detalhes."
    });
    await pauseSearchForError(tabId);
    return { ok: true };
  }
  const searches = await readSearches();
  const search = searches[String(tabId)];
  if (!search) return { ok: false };

  const now = Date.now();
  if (message.event === "RECOVERY_STARTED") {
    await chrome.alarms.clear(alarmName(tabId));
    search.running = false;
    search.status = "recovering";
    search.recoveryStep = message.step || "error";
    search.updatedAt = now;
    search.nextRefreshAt = 0;
    await writeSearch(tabId, search);
    return { ok: true };
  }

  if (message.event === "RECOVERY_STEP") {
    search.running = false;
    search.status = "recovering";
    search.recoveryStep = message.step || search.recoveryStep || "";
    search.updatedAt = now;
    search.nextRefreshAt = 0;
    await writeSearch(tabId, search);
    return { ok: true };
  }

  if (message.event === "RECOVERY_COMPLETE") {
    search.running = true;
    search.status = "monitoring";
    search.recoveryStep = "";
    search.resultMessage = "";
    search.updatedAt = now;
    const interval = normalizeConfig(search.config).intervalSeconds;
    search.nextRefreshAt = now + interval * 1000;
    await writeSearch(tabId, search);
    await chrome.alarms.create(alarmName(tabId), {
      delayInMinutes: interval / 60,
      periodInMinutes: interval / 60
    });
    return { ok: true };
  }

  if (message.event === "RECOVERY_FAILED") {
    await chrome.alarms.clear(alarmName(tabId));
    search.running = false;
    search.status = "needs_attention";
    search.recoveryStep = message.step || search.recoveryStep || "";
    search.resultMessage = message.message || "Não consegui retomar o envio com segurança.";
    search.updatedAt = now;
    search.nextRefreshAt = 0;
    await writeSearch(tabId, search);
    await appendErrorLog({ source: "Recuperação", stage: search.recoveryStep, message: search.resultMessage });
    await showNotification(tabId, "Retomada pausada", search.resultMessage);
    return { ok: true };
  }

  if (message.event === "FOUND_DATE") {
    await chrome.alarms.clear(alarmName(tabId));
    search.running = false;
    search.status = message.autoConfirm ? "confirming" : "found";
    search.foundDate = message.date;
    search.updatedAt = now;
    search.nextRefreshAt = 0;
    await writeSearch(tabId, search);
    if (message.autoConfirm) {
      await showNotification(tabId, "Data selecionada", `${message.date} foi selecionada. Estou confirmando o agendamento.`);
    }
    return { ok: true };
  }

  if (message.event === "CONFIRMATION_RESULT") {
    search.running = false;
    const manualConfirmation = message.automatic === false && !message.error;
    search.status = message.confirmed ? "confirmed" : (manualConfirmation ? "found" : "needs_attention");
    search.foundDate = message.date || search.foundDate || "";
    search.resultMessage = message.message || "";
    search.updatedAt = now;
    search.nextRefreshAt = 0;
    await writeSearch(tabId, search);
    if (!message.confirmed && !manualConfirmation) {
      await appendErrorLog({
        source: "Agendamento",
        stage: message.error || message.automatic === false ? "seleção de data" : "confirmação automática",
        message: message.message || "Não foi possível confirmar a data."
      });
    }
    const title = message.confirmed ? "Data ajustada com sucesso" : (manualConfirmation ? "Data selecionada" : "Confira o agendamento");
    const body = message.confirmed
      ? `A coleta para ${search.foundDate} foi confirmada no Mercado Livre.`
      : manualConfirmation
        ? `${search.foundDate} foi selecionada. Confirme o agendamento na página do Mercado Livre.`
        : `${search.foundDate} foi selecionada, mas precisa de atenção. ${message.message || "Verifique a página para concluir."}`;
    await showNotification(tabId, title, body);
    return { ok: true };
  }

  if (message.event === "PAGE_NOT_SUPPORTED") {
    await removeSearch(tabId);
    return { ok: true };
  }
  return { ok: false };
}

async function showNotification(tabId, title, message) {
  try {
    await chrome.notifications.create(`findfull-${tabId}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2
    });
  } catch (error) {
    await appendErrorLog({ source: "Avisos", stage: "notificação do Chrome", message: error?.message || "Não foi possível exibir a notificação.", severity: "warning" });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_OVERVIEW") return getOverview();
    if (message.type === "LOG_ERROR") {
      await appendErrorLog({ source: message.source || "Popup", stage: message.stage || "interface", message: message.message || "Falha na interface." });
      return { ok: true };
    }
    if (message.type === "GET_TAB_SEARCH") {
      const id = sender.tab?.id;
      const searches = await readSearches();
      return id === undefined ? null : searches[String(id)] || null;
    }
    if (message.type === "CONTENT_EVENT") return handleContentEvent(message, sender);
    if (message.type === "START_SEARCH") {
      const config = normalizeConfig(message.config || {});
      const tabs = message.scope === "all"
        ? (await chrome.tabs.query({})).filter(tab => isMarketplaceUrl(tab.url || ""))
        : [await chrome.tabs.get(message.tabId).catch(() => null)];
      const results = await Promise.all(tabs.map(tab => startOne(tab, config)));
      return { ok: results.some(result => result.ok), results };
    }
    if (message.type === "STOP_SEARCH") return { ok: await stopOne(message.tabId) };
    if (message.type === "RESUME_SEARCH") return await resumeSearch(message.tabId);
    if (message.type === "STOP_ALL") {
      await stopAll();
      return { ok: true };
    }
    return { ok: false, error: "Comando desconhecido." };
  })().then(sendResponse).catch(async error => {
    const errorMessage = error?.message || "Falha ao executar a ação.";
    await appendErrorLog({ source: message?.type || "background", stage: "mensagem", message: errorMessage });
    sendResponse({ ok: false, error: errorMessage });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  handleScheduledRefresh(alarm).catch(async error => {
    const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
    await appendErrorLog({ source: "Atualização", stage: "alarme de refresh", message: error?.message || "Falha durante a atualização agendada." });
    if (Number.isInteger(tabId)) await pauseSearchForError(tabId, "Falha na atualização. Consulte o histórico de erros no Full Radar.");
  });
});

async function handleScheduledRefresh(alarm) {
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  const searches = await readSearches();
  const search = searches[String(tabId)];
  if (!search?.running) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  const now = Date.now();
  const intervalMs = normalizeConfig(search.config).intervalSeconds * 1000;
  search.nextRefreshAt = Math.max(Number(alarm.scheduledTime) || now, now) + intervalMs;
  search.updatedAt = now;
  await writeSearch(tabId, search);

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await removeSearch(tabId);
    return;
  }
  if (!isMarketplaceUrl(tab.url || "")) {
    await stopOne(tabId);
    return;
  }
  const page = await sendToTab(tabId, { type: "PAGE_INFO" });
  if (page?.recoveryStep) {
    await chrome.alarms.clear(alarm.name);
    search.nextRefreshAt = 0;
    search.running = false;
    search.status = "recovering";
    search.recoveryStep = page.recoveryStep;
    search.updatedAt = Date.now();
    await writeSearch(tabId, search);
    await sendToTab(tabId, { type: "RECOVER", config: search.config });
    return;
  }
  if (page && !page.supported) {
    await handleContentEvent({ event: "PAGE_NOT_SUPPORTED" }, { tab: { id: tabId } });
    return;
  }
  if (tab.status === "loading") return;
  try {
    await chrome.tabs.reload(tabId);
    search.lastRefreshAt = Date.now();
    search.nextRefreshAt = search.lastRefreshAt + intervalMs;
    search.updatedAt = search.lastRefreshAt;
    search.status = "monitoring";
    await writeSearch(tabId, search);
  } catch (error) {
    await appendErrorLog({ source: "Atualização", stage: "recarregar página", message: error?.message || "Não foi possível atualizar a página." });
    await pauseSearchForError(tabId, "A página não pôde ser atualizada. Abra o Full Radar e consulte o histórico de erros.");
  }
}

chrome.tabs.onRemoved.addListener(async tabId => {
  await removeSearch(tabId);
});

async function restoreAlarms() {
  const searches = await readSearches();
  for (const [id, search] of Object.entries(searches)) {
    const tabId = Number(id);
    if (!search.running || !Number.isInteger(tabId)) continue;
    try {
      await chrome.tabs.get(tabId);
      const interval = normalizeConfig(search.config).intervalSeconds;
      const now = Date.now();
      search.nextRefreshAt = now + interval * 1000;
      await writeSearch(tabId, search);
      await chrome.alarms.create(alarmName(tabId), {
        delayInMinutes: interval / 60,
        periodInMinutes: interval / 60
      });
    } catch {
      await removeSearch(tabId);
    }
  }
}

chrome.runtime.onStartup.addListener(restoreAlarms);
chrome.runtime.onInstalled.addListener(restoreAlarms);
