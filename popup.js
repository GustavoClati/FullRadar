const send = message => chrome.runtime.sendMessage(message);
const $ = selector => document.querySelector(selector);
let overview = null;
let mode = "specific";
let initialized = false;
let activeSearch = null;

function setMessage(text, success = false) {
  const box = $("#actionMessage");
  box.textContent = text;
  box.classList.toggle("is-visible", Boolean(text));
  box.classList.toggle("is-success", Boolean(text) && success);
}

function parseDate(value) {
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return validIso(text) ? text : null;
  match = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return validIso(iso) ? iso : null;
}

function validIso(value) {
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function readConfig() {
  const intervalSeconds = Number($("#interval").value);
  const rawShipmentId = $("#shipmentId").value.trim();
  const shipmentId = rawShipmentId.replace(/\D/g, "");
  if (rawShipmentId && (shipmentId.length < 6 || shipmentId.length > 20)) {
    throw new Error("Informe o ID do envio com pelo menos 6 dígitos.");
  }
  if (mode === "specific") {
    const rawDates = $("#dates").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!rawDates.length) throw new Error("Informe ao menos uma data na ordem de preferência.");
    const dates = rawDates.map(parseDate);
    if (dates.some(date => !date)) throw new Error("Revise as datas. Use DD/MM/AAAA ou AAAA-MM-DD.");
    return { mode, dates: [...new Set(dates)], intervalSeconds, autoConfirm: $("#autoConfirm").checked, shipmentId };
  }
  const startDate = $("#startDate").value;
  const endDate = $("#endDate").value;
  if (!validIso(startDate) || !validIso(endDate) || startDate > endDate) {
    throw new Error("Escolha um período válido: a data inicial deve ser anterior à final.");
  }
  return { mode, startDate, endDate, intervalSeconds, autoConfirm: $("#autoConfirm").checked, shipmentId };
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(year, month - 1, day, 12));
}

function loadConfig(config) {
  if (!config) return;
  mode = config.mode === "range" ? "range" : "specific";
  setMode(mode);
  if (mode === "specific" && Array.isArray(config.dates)) $("#dates").value = config.dates.map(formatDate).join("\n");
  if (mode === "range") {
    $("#startDate").value = config.startDate || "";
    $("#endDate").value = config.endDate || "";
  }
  $("#interval").value = String(config.intervalSeconds || 30);
  $("#autoConfirm").checked = config.autoConfirm !== false;
  $("#shipmentId").value = config.shipmentId || "";
  updateInterval();
  updateStartAllAvailability();
}

function setMode(nextMode) {
  mode = nextMode;
  $("#specificFields").hidden = mode !== "specific";
  $("#rangeFields").hidden = mode !== "range";
  document.querySelectorAll(".mode-button").forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function updateInterval() {
  const seconds = Number($("#interval").value);
  $("#intervalOutput").textContent = seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
}

function updateStartAllAvailability() {
  const compatibleCount = overview?.tabs.filter(tab => tab.supportedPage).length || 0;
  const hasShipmentId = Boolean($("#shipmentId").value.trim());
  $("#startAll").disabled = compatibleCount === 0 || hasShipmentId;
  $("#startAll").title = hasShipmentId
    ? "O ID do envio vale para esta aba. Inicie a busca nela para habilitar a recuperação."
    : "Iniciar em todas as abas compatíveis";
}

function renderOverview(data) {
  overview = data;
  const state = $("#pageState");
  const text = $("#pageStateText");
  const activeRow = data.tabs.find(tab => tab.id === data.activeTabId);
  const search = activeRow?.search;
  activeSearch = search || null;
  const recoveryNames = { error: "tela de erro", management: "Gestão de envios", preparation: "preparação do envio" };
  const canResume = search?.status === "needs_attention" && Boolean(search.config?.shipmentId) &&
    Boolean(data.activeRecoveryStep || data.activeSchedulePage);
  state.className = "page-state";
  if (search?.running || search?.status === "recovering") {
    state.classList.add("is-running");
    text.textContent = search.status === "recovering"
      ? `Recuperando o envio #${search.config?.shipmentId || ""}…`
      : "Busca ativa nesta aba. A página será verificada no intervalo escolhido.";
  } else if (data.activeRecoveryStep) {
    state.classList.add("is-error");
    text.textContent = `Etapa detectada: ${recoveryNames[data.activeRecoveryStep] || "recuperação"}. Você pode retomar abaixo.`;
  } else if (data.activeSupportedPage) {
    state.classList.add("is-ready");
    text.textContent = "Página de agendamento detectada. Configure as datas para começar.";
  } else {
    state.classList.add("is-error");
    text.textContent = data.activePageMessage || "Abra a tela de agendamento do Full.";
  }
  $("#startActive").disabled = !data.activeSupportedPage || Boolean(data.activeRecoveryStep);
  $("#resumeSearch").hidden = !canResume;
  updateStartAllAvailability();
  $("#stopAll").disabled = !data.tabs.some(tab => tab.search);
  renderSearches(data.tabs);
  renderRefreshCounter();
  renderErrorLog(data.errorLog || []);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const remainder = String(value % 60).padStart(2, "0");
  return String(minutes).padStart(2, "0") + ":" + remainder;
}

function intervalLabel(seconds) {
  if (seconds < 60) return "a cada " + seconds + " s";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder
    ? "a cada " + minutes + " min " + remainder + " s"
    : "a cada " + minutes + " min";
}

function renderRefreshCounter() {
  const title = $("#refreshCountdown");
  const detail = $("#refreshDetail");
  const search = activeSearch;
  if (search?.running && search.status === "monitoring") {
    const seconds = Math.max(30, Number(search.config?.intervalSeconds) || 30);
    const remaining = Number(search.nextRefreshAt)
      ? Math.ceil((search.nextRefreshAt - Date.now()) / 1000)
      : seconds;
    title.textContent = "Próximo refresh em " + formatDuration(remaining);
    detail.textContent = intervalLabel(seconds) + (search.lastRefreshAt
      ? " · último pedido há " + formatDuration((Date.now() - search.lastRefreshAt) / 1000)
      : " · aguardando a primeira atualização") + " · estimativa do Chrome";
    return;
  }
  if (search?.status === "recovering") {
    title.textContent = "Refresh pausado durante a recuperação";
    detail.textContent = "A busca volta a atualizar a página quando retornar ao calendário.";
    return;
  }
  if (search?.status === "confirming") {
    title.textContent = "Refresh pausado enquanto a data é confirmada";
    detail.textContent = "A extensão está concluindo a seleção do agendamento.";
    return;
  }
  if (search?.status === "found") {
    title.textContent = "Data " + formatDate(search.foundDate) + " selecionada";
    detail.textContent = "Confirme o agendamento na página do Mercado Livre.";
    return;
  }
  if (search?.status === "confirmed") {
    title.textContent = "Coleta confirmada para " + formatDate(search.foundDate);
    detail.textContent = "Busca encerrada com sucesso.";
    return;
  }
  if (search?.status === "needs_attention") {
    title.textContent = "Busca pausada; precisa de atenção";
    detail.textContent = "Confira a página e use Retomar busca quando estiver pronta.";
    return;
  }
  title.textContent = "Inicie uma busca para acompanhar o refresh.";
  detail.textContent = "O intervalo escolhido aparece aqui durante a busca.";
}

function renderErrorLog(logs) {
  const rows = $("#errorLogRows");
  const empty = $("#errorLogEmpty");
  const exportButton = $("#exportErrorLog");
  rows.replaceChildren();
  $("#errorLogCount").textContent = String(logs.length);
  empty.hidden = logs.length > 0;
  exportButton.disabled = logs.length === 0;
  for (const entry of logs.slice(0, 6)) {
    const row = document.createElement("article");
    row.className = "diagnostic-row" + (entry.severity === "warning" ? " is-warning" : "");
    const heading = document.createElement("div");
    heading.className = "diagnostic-heading";
    const source = document.createElement("strong");
    source.textContent = [entry.source, entry.stage].filter(Boolean).join(" · ") || "Extensão";
    const date = document.createElement("time");
    const timestamp = new Date(entry.timestamp);
    date.textContent = Number.isNaN(timestamp.valueOf())
      ? ""
      : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(timestamp);
    heading.append(source, date);
    const message = document.createElement("p");
    message.textContent = entry.message || "Falha sem detalhes.";
    row.append(heading, message);
    rows.append(row);
  }
}

function exportErrorLog() {
  const logs = overview?.errorLog || [];
  if (!logs.length) return;
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "full-radar-erros-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderSearches(tabs) {
  const searches = tabs.filter(tab => tab.search);
  const section = $("#searchList");
  const rows = $("#searchRows");
  section.hidden = searches.length === 0;
  $("#searchCount").textContent = String(searches.length);
  rows.replaceChildren();
  for (const tab of searches) {
    const row = document.createElement("div");
    row.className = "search-row";
    const indicator = document.createElement("span");
    const active = tab.search.running || tab.search.status === "recovering";
    indicator.className = `search-indicator${active ? "" : " is-done"}`;
    const copy = document.createElement("div");
    copy.className = "search-copy";
    const title = document.createElement("strong");
    title.textContent = tab.title;
    const detail = document.createElement("small");
    detail.textContent = searchStatus(tab.search);
    copy.append(title, detail);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "stop-one";
    stop.textContent = active ? "Parar" : tab.search.status === "confirming" ? "Cancelar" : "Limpar";
    stop.addEventListener("click", async () => {
      await send({ type: "STOP_SEARCH", tabId: tab.id });
      await refresh();
    });
    row.append(indicator, copy, stop);
    rows.append(row);
  }
}

function searchStatus(search) {
  if (search.status === "monitoring") return "Procurando datas…";
  if (search.status === "recovering") return `Retomando o envio #${search.config?.shipmentId || ""}…`;
  if (search.status === "confirming") return `Confirmando ${formatDate(search.foundDate)}…`;
  if (search.status === "confirmed") return `Agendado para ${formatDate(search.foundDate)}`;
  if (search.status === "needs_attention") return search.foundDate
    ? `Verifique ${formatDate(search.foundDate)} na aba`
    : search.resultMessage || "A retomada foi pausada; confira a aba.";
  if (search.status === "found") return `Data ${formatDate(search.foundDate)} encontrada`;
  return "Busca encerrada";
}

async function refresh() {
  try {
    const data = await send({ type: "GET_OVERVIEW" });
    renderOverview(data);
    if (!initialized) {
      const active = data.tabs.find(tab => tab.id === data.activeTabId);
      if (active?.search?.config) loadConfig(active.search.config);
      else if (data.lastConfig) loadConfig(data.lastConfig);
      initialized = true;
    }
  } catch (error) {
    setMessage("Não consegui consultar o estado da extensão. Reabra o popup.");
    send({
      type: "LOG_ERROR",
      source: "Popup",
      stage: "consulta do estado",
      message: error?.message || String(error)
    }).catch(() => {});
  }
}

async function start(scope) {
  setMessage("");
  if (!overview) return;
  let config;
  try {
    config = readConfig();
    if (scope === "all" && config.shipmentId) {
      throw new Error("Para recuperar um envio específico, inicie a busca somente nesta aba.");
    }
  } catch (error) {
    setMessage(error.message);
    return;
  }
  const response = await send({ type: "START_SEARCH", scope, tabId: overview.activeTabId, config });
  const started = response?.results?.filter(result => result.ok) || [];
  const errors = response?.results?.filter(result => !result.ok) || [];
  if (started.length) {
    setMessage(scope === "all"
      ? `Busca iniciada em ${started.length} aba(s) compatível(is).`
      : "Busca iniciada. Esta aba será recarregada no intervalo escolhido.", true);
  }
  if (errors.length) setMessage(errors.map(result => result.error).join(" "));
  await refresh();
}

async function resumeActive() {
  setMessage("");
  if (!overview?.activeTabId) return;
  const response = await send({ type: "RESUME_SEARCH", tabId: overview.activeTabId });
  if (!response?.ok) setMessage(response?.error || "Não consegui retomar a busca nesta aba.");
  else setMessage(response.message || "Busca retomada.", true);
  await refresh();
}

document.querySelectorAll(".mode-button").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
$("#interval").addEventListener("input", updateInterval);
$("#shipmentId").addEventListener("input", updateStartAllAvailability);
$("#startActive").addEventListener("click", () => start("active"));
$("#resumeSearch").addEventListener("click", resumeActive);
$("#startAll").addEventListener("click", () => start("all"));
$("#stopAll").addEventListener("click", async () => {
  await send({ type: "STOP_ALL" });
  setMessage("Todas as buscas foram interrompidas.", true);
  await refresh();
});
$("#exportErrorLog").addEventListener("click", exportErrorLog);

refresh();
setInterval(refresh, 2500);
setInterval(renderRefreshCounter, 1000);
