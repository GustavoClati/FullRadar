(() => {
  const MONTHS = {
    janeiro: 1, jan: 1, fevereiro: 2, fev: 2,
    marco: 3, mar: 3, março: 3, abril: 4, abr: 4, maio: 5, mai: 5,
    junho: 6, jun: 6, julho: 7, jul: 7, agosto: 8, ago: 8,
    setembro: 9, set: 9, outubro: 10, out: 10, novembro: 11, nov: 11,
    dezembro: 12, dez: 12
  };
  const MONTH_PATTERN = "janeiro|jan|fevereiro|fev|março|marco|mar|abril|abr|maio|mai|junho|jun|julho|jul|agosto|ago|setembro|set|outubro|out|novembro|nov|dezembro|dez";
  const DATE_CANDIDATE_SELECTOR = "button,[role='button'],[role='gridcell'],td,[data-date],[data-testid*='day'],[class*='day'],a[href],[aria-label][tabindex],input[type='button'],span,div";
  let scanning = false;
  let scanGeneration = 0;

  function normalized(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function recoveryStep() {
    const text = normalized(document.body?.innerText || "");
    if (text.includes("escolha quando quer que a coleta passe") || text.includes("escolha como voce deseja envia")) return "";
    const errorLink = [...document.querySelectorAll("a,button,[role='button']")]
      .some(element => isVisible(element) && normalized(element.innerText || element.textContent || "") === "ir para gestao de envios full");
    if (text.includes("ocorreu um erro") && errorLink) return "error";
    const managementRoute = /\/shipping\/inbounds\/?$/.test(location.pathname);
    const hasFinishAction = [...document.querySelectorAll("a[href],button,[role='button']")]
      .some(element => isVisible(element) && normalized(element.innerText || element.textContent || "") === "terminar envio");
    if ((text.includes("data reservada") && text.includes("custo aplicado") && text.includes("status")) || (managementRoute && hasFinishAction)) return "management";
    if (text.includes("preparacao do envio")) return "preparation";
    const shipmentRoute = location.pathname.match(/^\/shipping\/inbounds\/(\d+)(?:\/([^/]+))?\/?$/);
    if (shipmentRoute && !/appointment/i.test(location.pathname) && text.includes("envio")) return "preparation";
    return "";
  }

  function pageInfo() {
    const text = normalized(document.body?.innerText || "");
    const recovery = recoveryStep();
    const mentionsFull = /\bfull\b/.test(text);
    const mentionsDate = /\bdata\b/.test(text);
    const mentionsAction = /agend|enviar|coleta|centro de distribuicao/.test(text);
    const collectionHeading = text.includes("escolha quando quer que a coleta passe");
    const dispatchHeading = text.includes("escolha como voce deseja envia");
    const dateControl = (collectionHeading || dispatchHeading) && Boolean(findDatePickerTrigger());
    const collectionStep = text.includes("escolha quando quer que a coleta passe") &&
      (text.includes("custo estimado") || text.includes("coleta"));
    const calendarMonth = new RegExp(`\\b(?:${MONTH_PATTERN})\\b[^\\n]{0,24}\\b20\\d{2}\\b`).test(text);
    const dispatchStep = text.includes("escolha como voce deseja envia") &&
      (text.includes("centro de distribuicao") || text.includes("full") || text.includes("volume estimado") || calendarMonth || dateControl);
    const supported = !recovery && ((mentionsFull && mentionsDate && mentionsAction) || collectionStep || dispatchStep);
    const shipmentId = location.pathname.match(/\/shipping\/inbounds\/(\d+)(?:\/|$)/)?.[1] || "";
    return {
      supported,
      schedulePage: collectionStep || dispatchStep,
      recoveryStep: recovery,
      shipmentId,
      message: recovery ? "Etapa de recuperação do envio detectada." : supported ? "Página de agendamento reconhecida." : "Abra a página do Full para agendar o envio dos produtos."
    };
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && element.getClientRects().length > 0;
  }

  function colorChannels(value) {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].match(/[\d.]+/g)?.map(Number) || [];
    if (parts.length < 3) return null;
    return { red: parts[0], green: parts[1], blue: parts[2], alpha: parts.length > 3 ? parts[3] : 1 };
  }

  function isLightNeutral(color) {
    if (!color || color.alpha < 0.7) return false;
    const maximum = Math.max(color.red, color.green, color.blue);
    const minimum = Math.min(color.red, color.green, color.blue);
    const brightness = (color.red + color.green + color.blue) / 3;
    return brightness >= 165 && maximum - minimum <= 42;
  }

  function isVisuallyUnavailable(element) {
    const possibleTextNodes = [...element.querySelectorAll("*")]
      .filter(node => /^\d{1,2}$/.test(normalized(node.textContent).trim()));
    const textElement = possibleTextNodes.at(-1) || element;
    const textStyle = getComputedStyle(textElement);
    if (Number(textStyle.opacity) < 0.7) return true;

    const textColor = colorChannels(textStyle.color);
    // O Andes renderiza dias indisponíveis com o próprio texto translúcido
    // (por exemplo #00000040); dias disponíveis usam opacidade alta (#000000CC).
    if (textColor && textColor.alpha < 0.55) return true;
    let ancestor = element;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      const background = colorChannels(getComputedStyle(ancestor).backgroundColor);
      if (background && background.alpha > 0.7) {
        const saturation = Math.max(background.red, background.green, background.blue) - Math.min(background.red, background.green, background.blue);
        if (saturation > 55) return false;
      }
    }
    return isLightNeutral(textColor);
  }

  function isDisabled(element) {
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return true;
    return /disabled|indisponivel|unavailable|outside.?month|other.?month|adjacent.?month|previous.?month|next.?month|prev.?month/i.test(`${element.className || ""} ${element.getAttribute("data-state") || ""}`) || isVisuallyUnavailable(element);
  }

  function iso(year, month, day) {
    const date = new Date(Number(year), Number(month) - 1, Number(day), 12);
    if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function monthNumber(value) {
    return MONTHS[normalized(value).replace(/\.$/, "")] || 0;
  }

  function currentRequestedDates(config) {
    if (config.mode === "specific") return config.dates || [];
    if (!config.startDate || !config.endDate || config.startDate > config.endDate) return [];
    const dates = [];
    const start = new Date(`${config.startDate}T12:00:00`);
    const end = new Date(`${config.endDate}T12:00:00`);
    for (let date = start; date <= end && dates.length < 366; date.setDate(date.getDate() + 1)) {
      dates.push(date.toISOString().slice(0, 10));
    }
    return dates;
  }

  function datesInLabel(label, requestedDates) {
    const source = normalized(label);
    const found = new Set();
    let match;

    const isoPattern = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g;
    while ((match = isoPattern.exec(source))) {
      const value = iso(match[1], match[2], match[3]);
      if (value) found.add(value);
    }

    const numericPattern = /\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](20\d{2}))?\b/g;
    while ((match = numericPattern.exec(source))) {
      if (match[3]) {
        const value = iso(match[3], match[2], match[1]);
        if (value) found.add(value);
      } else {
        const day = Number(match[1]);
        const month = Number(match[2]);
        for (const date of requestedDates) {
          if (Number(date.slice(8, 10)) === day && Number(date.slice(5, 7)) === month) found.add(date);
        }
      }
    }

    const monthPattern = new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_PATTERN})\\.?(?:\\s+de)?(?:[,/ ]+((?:19|20)\\d{2}))?\\b`, "g");
    while ((match = monthPattern.exec(source))) {
      const day = Number(match[1]);
      const month = monthNumber(match[2]);
      if (!month) continue;
      if (match[3]) {
        const value = iso(match[3], month, day);
        if (value) found.add(value);
      } else {
        for (const date of requestedDates) {
          if (Number(date.slice(8, 10)) === day && Number(date.slice(5, 7)) === month) found.add(date);
        }
      }
    }

    return [...found].filter(date => requestedDates.includes(date));
  }

  function labelHasDateDetail(label) {
    const source = normalized(label);
    const monthDate = new RegExp(`\\b\\d{1,2}\\s*(?:de\\s+)?(?:${MONTH_PATTERN})\\b`, "i");
    return /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/.test(source) ||
      /\b\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{4})?\b/.test(source) || monthDate.test(source);
  }

  function monthYearIn(text) {
    const source = normalized(text);
    const pattern = new RegExp(`\\b(${MONTH_PATTERN})\\.?[,/ ]+(20\\d{2})\\b`, "i");
    const match = source.match(pattern);
    if (!match) return null;
    return { month: monthNumber(match[1]), year: Number(match[2]) };
  }

  function contextDateForDay(element, requestedDates) {
    const text = normalized(element.innerText || element.textContent || "").trim();
    const dayMatch = text.match(/(?:^|\D)(\d{1,2})(?:\D|$)/);
    if (!dayMatch) return [];
    const day = Number(dayMatch[1]);
    if (day < 1 || day > 31) return [];
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
      const heading = ancestor.querySelector("h1,h2,h3,[role='heading']");
      const monthYear = monthYearIn(heading?.innerText || heading?.textContent || "") ||
        monthYearIn(ancestor.getAttribute("aria-label") || "") ||
        monthYearIn(ancestor.innerText || ancestor.textContent || "");
      if (monthYear) {
        return requestedDates.filter(date => Number(date.slice(8, 10)) === day && Number(date.slice(5, 7)) === monthYear.month && Number(date.slice(0, 4)) === monthYear.year);
      }
    }
    return [];
  }

  function findDateElement(requestedDates) {
    const root = findVisibleCalendarRoot();
    if (!root) return null;
    const elements = [...root.querySelectorAll(DATE_CANDIDATE_SELECTOR)];
    const hits = [];
    elements.forEach((element, index) => {
      const dayText = normalized(element.innerText || element.textContent || "").trim();
      const isActionable = element.matches("button,[role='button'],[role='gridcell'],a[href],[tabindex],input[type='button'],td,[data-date],[data-testid*='day'],[class*='day']");
      const hasInteractiveChild = element.querySelector("button,[role='button'],[role='gridcell'],a[href],[tabindex],input[type='button']");
      const hasNestedDayText = /^\d{1,2}$/.test(dayText) && [...element.querySelectorAll("span,div")]
        .some(child => normalized(child.innerText || child.textContent || "").trim() === dayText);
      if ((!isActionable && hasInteractiveChild) || ((element.matches("div,span,p") || !isActionable) && hasNestedDayText)) return;
      const ownLabels = [
        element.getAttribute("data-date"), element.getAttribute("aria-label"),
        element.getAttribute("title"), element.innerText, element.textContent
      ].filter(Boolean).join(" ");
      let matches = datesInLabel(ownLabels, requestedDates);
      if (!matches.length && !labelHasDateDetail(ownLabels)) matches = contextDateForDay(element, requestedDates);
      if (!matches.length) return;
      // No calendário Andes, td.day-box é só o contêiner; o dia clicável é o filho .day.
      // Canonicalizamos para o elemento do dia para não clicar primeiro no td externo.
      const dayElement = element.matches(".day") ? element : element.closest(".day") || element.querySelector(".day");
      const clickTarget = dayElement || element.closest("button,[role='button'],[role='gridcell'],a[href],[tabindex],input[type='button'],td,[data-date],[data-testid*='day'],[class*='day']") || element;
      const statusElement = dayElement || element;
      if (!isVisible(element) || !isVisible(clickTarget) || isDisabled(statusElement) || isDisabled(clickTarget)) return;
      const priority = Math.min(...matches.map(date => requestedDates.indexOf(date)));
      hits.push({ element: clickTarget, date: requestedDates[priority], priority, index });
    });
    hits.sort((a, b) => a.priority - b.priority || a.index - b.index);
    return hits[0] || null;
  }

  function calendarDayElements(root) {
    return [...root.querySelectorAll(DATE_CANDIDATE_SELECTOR)].filter(element => {
      if (!isVisible(element)) return false;
      const text = normalized(element.innerText || element.textContent || "").trim();
      const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-date"), text].filter(Boolean).join(" ");
      return /^\d{1,2}$/.test(text) || labelHasDateDetail(label);
    });
  }

  function findVisibleCalendarRoot() {
    // Alguns calendários do Mercado Livre não usam heading/ARIA no título do mês.
    // Incluímos elementos simples com texto curto para localizar também esses widgets.
    const headers = [...document.querySelectorAll("h1,h2,h3,[role='heading'],[aria-live],[class*='month'],[class*='Month'],[class*='calendar'],[class*='Calendar'],[data-testid*='month'],[data-testid*='Month'],span,div,p")];
    for (const header of headers) {
      const headerText = normalized(header.innerText || header.textContent || "");
      if (!isVisible(header) || headerText.length > 45 || !monthYearIn(headerText)) continue;
      let ancestor = header;
      for (let depth = 0; ancestor && depth < 7; depth += 1, ancestor = ancestor.parentElement) {
        if (calendarDayElements(ancestor).length >= 15) return ancestor;
      }
    }
    return null;
  }

  function logCalendarScan(requestedDates, reason) {
    const root = findVisibleCalendarRoot();
    const cells = root ? calendarDayElements(root).slice(0, 50).map(element => {
      const text = normalized(element.innerText || element.textContent || "").trim();
      const labels = [element.getAttribute("data-date"), element.getAttribute("aria-label"), element.getAttribute("title"), text].filter(Boolean).join(" ");
      let matches = datesInLabel(labels, requestedDates);
      if (!matches.length) matches = contextDateForDay(element, requestedDates);
      const dayElement = element.matches(".day") ? element : element.closest(".day") || element.querySelector(".day");
      const clickTarget = dayElement || element.closest("button,[role='button'],[role='gridcell'],a[href],[tabindex],td,[data-date],[data-testid*='day'],[class*='day']") || element;
      return {
        text,
        ariaLabel: element.getAttribute("aria-label") || "",
        dataDate: element.getAttribute("data-date") || "",
        role: element.getAttribute("role") || element.tagName.toLowerCase(),
        className: String(element.className || "").slice(0, 90),
        clickTarget: `${clickTarget.tagName.toLowerCase()}.${String(clickTarget.className || "").trim().replace(/\s+/g, ".")}`,
        disabled: isDisabled(clickTarget),
        matches
      };
    }) : [];
    console.info("[Full Radar] leitura do calendário", { reason, requestedDates, cells });
    if (cells.length) console.table(cells);
  }

  function appointmentSection() {
    const heading = [...document.querySelectorAll("h1,h2,h3,[role='heading'],p,strong")].find(element => {
      const text = normalized(element.innerText || element.textContent || "");
      return text.includes("escolha quando quer que a coleta passe") || text.includes("escolha como voce deseja envia");
    });
    return heading?.closest("section,form,[role='group']") || heading?.parentElement?.parentElement || null;
  }

  function findDatePickerTrigger() {
    const scope = appointmentSection();
    if (!scope) return null;
    const selector = "input:not([type='hidden']),button,[role='button'],[role='combobox'],[aria-haspopup='dialog']";
    const candidates = [...scope.querySelectorAll(selector)].filter(element => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
    const ranked = [];
    for (const element of candidates) {
      const aria = element.getAttribute("aria-label") || "";
      const title = element.getAttribute("title") || "";
      const placeholder = element.getAttribute("placeholder") || "";
      const value = element.value || "";
      const label = [aria, title, placeholder, value, element.innerText, element.textContent].filter(Boolean).join(" ");
      const explicitCalendar = /calend|data|dia/i.test(`${aria} ${title} ${placeholder}`);
      const hasDateValue = element.type === "date" || labelHasDateDetail(label);
      const canOpen = element.type === "date" || element.readOnly || element.getAttribute("aria-haspopup") === "dialog" ||
        element.getAttribute("role") === "combobox" || element.tagName === "BUTTON" || element.getAttribute("role") === "button" ||
        (element.tagName === "INPUT" && hasDateValue);
      if (!canOpen || (!explicitCalendar && !hasDateValue)) continue;
      const score = (explicitCalendar ? 10 : 0) + (element.type === "date" ? 8 : 0) + (element.readOnly ? 5 : 0) +
        (element.getAttribute("aria-haspopup") === "dialog" ? 4 : 0) + (hasDateValue ? 2 : 0);
      ranked.push({ element, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
    return ranked[0].element;
  }

  function calendarIsOpen() {
    return Boolean(findVisibleCalendarRoot());
  }

  async function openCalendarAndWait(requestedDates, generation) {
    if (calendarIsOpen() || findDateElement(requestedDates)) return true;
    const trigger = findDatePickerTrigger();
    if (!trigger) return false;
    trigger.focus?.();
    trigger.click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (generation !== scanGeneration) return false;
      await wait(100);
      if (calendarIsOpen() || findDateElement(requestedDates)) return true;
    }
    return false;
  }

  function findConfirmButton() {
    const allowed = /^(confirmar(?: agendamento| data| envio)?|agendar(?: envio)?|reservar(?: data)?|salvar(?: data)?)$/i;
    return [...document.querySelectorAll("button,[role='button'],input[type='submit']")]
      .find(element => isVisible(element) && !isDisabled(element) && allowed.test(normalized(element.innerText || element.value || element.getAttribute("aria-label"))));
  }

  function dateIsSelected(date, clickedElement = null) {
    if (clickedElement && isVisible(clickedElement) &&
      (clickedElement.getAttribute("aria-selected") === "true" || clickedElement.getAttribute("aria-pressed") === "true" || /selected|is-active/i.test(String(clickedElement.className || "")))) {
      return true;
    }
    const evidence = [];
    for (const element of document.querySelectorAll("input,select,[role='combobox'],[role='textbox'],button[aria-haspopup='dialog'],[role='button'][aria-haspopup='dialog']")) {
      if (!isVisible(element)) continue;
      evidence.push(element.value, element.getAttribute("aria-label"), element.getAttribute("placeholder"));
    }
    for (const element of document.querySelectorAll("[aria-selected='true'],[aria-pressed='true'],[aria-checked='true']")) {
      if (isVisible(element)) evidence.push(element.getAttribute("aria-label"), element.innerText, element.textContent);
    }
    return evidence.filter(Boolean).some(value => datesInLabel(value, [date]).includes(date));
  }

  function selectedDateFromControls(requestedDates) {
    const controls = document.querySelectorAll("input,select,[role='combobox'],[role='textbox'],button[aria-haspopup='dialog'],[role='button'][aria-haspopup='dialog']");
    for (const element of controls) {
      if (!isVisible(element)) continue;
      const labels = [element.value, element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.innerText, element.textContent].filter(Boolean);
      for (const label of labels) {
        const match = datesInLabel(label, requestedDates)[0];
        if (match) return match;
      }
    }
    return "";
  }

  function findCalendarConfirmButton(dayElement) {
    const allowed = /^(confirmar|selecionar data)$/i;
    let ancestor = dayElement.parentElement;
    for (let depth = 0; ancestor && depth < 9; depth += 1, ancestor = ancestor.parentElement) {
      if (!isVisible(ancestor) || !monthYearIn(ancestor.innerText || ancestor.textContent || "")) continue;
      const button = [...ancestor.querySelectorAll("button,[role='button']")]
        .find(element => isVisible(element) && !isDisabled(element) && allowed.test(normalized(element.innerText || element.textContent || element.getAttribute("aria-label"))));
      if (button) return button;
    }
    return null;
  }

  function finalConfirmationPanelVisible(date) {
    const text = normalized(document.body?.innerText || "");
    const collectionPanel = text.includes("escolha quando quer que a coleta passe") ||
      (text.includes("cancelar reserva") && text.includes("custo estimado"));
    return collectionPanel && dateIsSelected(date);
  }

  async function sendEvent(event, fields = {}) {
    try {
      return await chrome.runtime.sendMessage({ type: "CONTENT_EVENT", event, ...fields });
    } catch {
      return null;
    }
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForPageSignal(timeoutMs = 1000) {
    return new Promise(resolve => {
      let finished = false;
      let timer;
      const observer = new MutationObserver(() => finish());
      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      timer = setTimeout(finish, timeoutMs);
    });
  }

  function hasShipmentId(text, shipmentId) {
    return new RegExp(`(?:^|\\D)${shipmentId}(?!\\d)`).test(normalized(text));
  }

  function visibleExactActions(scope, label) {
    return [...scope.querySelectorAll("a[href],button,[role='button']")]
      .filter(element => isVisible(element) && !isDisabled(element) && normalized(element.innerText || element.textContent || element.getAttribute("aria-label")) === label);
  }

  function findFinishShipmentAction(shipmentId) {
    const matches = new Set();
    const actions = visibleExactActions(document, "terminar envio");
    for (const action of actions) {
      let ancestor = action.parentElement;
      for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
        const rowText = ancestor.innerText || ancestor.textContent || "";
        if (!hasShipmentId(rowText, shipmentId)) continue;
        const rowActions = visibleExactActions(ancestor, "terminar envio");
        if (rowActions.length === 1) matches.add(action);
        break;
      }
    }
    return [...matches];
  }

  function findCollectionEditAction() {
    const matches = new Set();
    for (const action of visibleExactActions(document, "editar")) {
      let ancestor = action.parentElement;
      for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
        const cardText = normalized(ancestor.innerText || ancestor.textContent || "");
        if (!cardText.includes("agendou a coleta para")) continue;
        const edits = visibleExactActions(ancestor, "editar");
        if (edits.length === 1) matches.add(action);
        break;
      }
    }
    return [...matches];
  }

  async function recoveryFailure(message, step = recoveryStep()) {
    await sendEvent("RECOVERY_FAILED", { message, step });
    return false;
  }

  async function waitForNextRecoveryStep(currentStep, generation, shipmentId) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (generation !== scanGeneration) return "cancelled";
      const info = pageInfo();
      if (info.recoveryStep && info.recoveryStep !== currentStep) return info.recoveryStep;
      if (!info.recoveryStep && info.schedulePage) return "schedule";
      if (currentStep === "error" && findFinishShipmentAction(shipmentId).length === 1) return "management";
      if (currentStep === "management") {
        const routeId = location.pathname.match(/^\/shipping\/inbounds\/(\d+)(?:\/|$)/)?.[1] || "";
        if (routeId === shipmentId && !/\/appointment(?:-v\d+)?(?:\/|$)/i.test(location.pathname)) return "preparation";
        if (hasShipmentId(document.body?.innerText || "", shipmentId) && findCollectionEditAction().length === 1) return "preparation";
      }
      await waitForPageSignal(1000);
    }
    return "timeout";
  }

  async function waitForRecoveryAction(step, shipmentId, generation) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (generation !== scanGeneration) return { cancelled: true };
      if (step === "error") {
        const actions = visibleExactActions(document, "ir para gestao de envios full");
        if (actions.length === 1) return { action: actions[0] };
        if (actions.length > 1) return { error: "Encontrei mais de um link para Gestão de envios Full." };
      } else if (step === "management") {
        const idVisible = hasShipmentId(document.body?.innerText || "", shipmentId);
        const actions = findFinishShipmentAction(shipmentId);
        if (actions.length === 1) return { action: actions[0] };
        if (actions.length > 1) return { error: `Encontrei mais de uma ação “Terminar envio” na linha do envio #${shipmentId}.` };
        if (idVisible && visibleExactActions(document, "terminar envio").length > 0) {
          // A linha pode estar terminando de renderizar; aguardamos a próxima mutação.
        }
      } else if (step === "preparation") {
        const idMatches = hasShipmentId(document.body?.innerText || "", shipmentId);
        const actions = idMatches ? findCollectionEditAction() : [];
        if (actions.length === 1) return { action: actions[0] };
        if (actions.length > 1) return { error: `Encontrei mais de um “Editar” na seção da coleta do envio #${shipmentId}.` };
      }
      await waitForPageSignal(1000);
    }

    if (step === "management" && !hasShipmentId(document.body?.innerText || "", shipmentId)) {
      return { error: `Não encontrei o envio #${shipmentId} visível na Gestão. Confirme o ID e se o envio aparece nesta lista.` };
    }
    if (step === "preparation" && !hasShipmentId(document.body?.innerText || "", shipmentId)) {
      return { error: `A página de preparação não corresponde ao envio #${shipmentId}. Não cliquei em Editar.` };
    }
    if (step === "management") {
      return { error: `Encontrei o envio #${shipmentId}, mas não uma única ação “Terminar envio” na linha dele. Confira o status do envio na Gestão.` };
    }
    if (step === "preparation") return { error: `Não encontrei um único “Editar” na seção da coleta do envio #${shipmentId}.` };
    return { error: "Encontrei a tela de erro, mas não um único link para Gestão de envios Full." };
  }

  async function driveRecovery(config, generation, alreadyRecovering) {
    const shipmentId = String(config.shipmentId || "").replace(/\D/g, "");
    if (!shipmentId) {
      return recoveryFailure("A tela de erro apareceu, mas não há ID do envio cadastrado. Cadastre o ID e reinicie a busca.");
    }

    let step = recoveryStep();
    let recoveryAnnounced = alreadyRecovering;
    for (let count = 0; step && count < 4; count += 1) {
      if (generation !== scanGeneration) return false;
      console.info("[Full Radar] etapa de recuperação", { step, shipmentId });
      await sendEvent(recoveryAnnounced ? "RECOVERY_STEP" : "RECOVERY_STARTED", { step });
      recoveryAnnounced = true;

      if (!["error", "management", "preparation"].includes(step)) {
        return recoveryFailure("A recuperação chegou a uma etapa que a extensão não reconhece.");
      }

      const actionResult = await waitForRecoveryAction(step, shipmentId, generation);
      if (actionResult.cancelled) return false;
      if (actionResult.error) return recoveryFailure(actionResult.error, step);
      const action = actionResult.action;
      console.info("[Full Radar] ação da recuperação localizada", { step, shipmentId, label: normalized(action.innerText || action.textContent || "") });

      action.scrollIntoView?.({ block: "center", behavior: "auto" });
      action.click();
      const next = await waitForNextRecoveryStep(step, generation, shipmentId);
      if (next === "cancelled") return false;
      if (next === "timeout") {
        const stepName = { error: "tela de erro", management: "Gestão de envios", preparation: "preparação do envio" }[step] || step;
        return recoveryFailure(`A ação na ${stepName} foi clicada, mas não reconheci a próxima tela mesmo após aguardar. Não repeti o clique automaticamente. Confira a página e use “Retomar busca” quando ela estiver pronta.`, step);
      }
      if (next === "schedule") {
        await sendEvent("RECOVERY_COMPLETE");
        return true;
      }
      step = next;
    }

    return recoveryFailure("Não consegui completar o retorno ao calendário em segurança.");
  }

  function confirmationVisible() {
    const text = normalized(document.body?.innerText || "");
    return /agendamento (?:foi )?confirmado|reserva (?:foi )?confirmada|coleta (?:esta )?(?:foi )?agendada|data agendada com sucesso|envio (?:foi )?agendado|agendado com sucesso|agendamento concluido/.test(text);
  }

  async function runScan(config, priorStatus = "monitoring") {
    if (scanning) return;
    scanning = true;
    const generation = ++scanGeneration;
    try {
      let info = pageInfo();
      if (priorStatus === "recovering" && !info.schedulePage && !info.recoveryStep) {
        // Páginas da Gestão também contêm “Full”, “data” e ações e podiam ser
        // confundidas com a tela de agendamento durante o carregamento da tabela.
        // Na recuperação, só aceitamos o cabeçalho específico do calendário.
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (generation !== scanGeneration) return;
          await waitForPageSignal(1000);
          info = pageInfo();
          if (info.schedulePage || info.recoveryStep) break;
        }
      }

      if (info.recoveryStep) {
        const recovered = await driveRecovery(config, generation, priorStatus === "recovering");
        if (!recovered || generation !== scanGeneration) return;
        info = pageInfo();
      } else if (priorStatus === "recovering" && info.schedulePage) {
        await sendEvent("RECOVERY_COMPLETE");
      } else if (priorStatus === "recovering") {
        await recoveryFailure("A página abriu, mas não reconheci nem a Gestão, nem a preparação do envio, nem o calendário. A busca foi pausada sem clicar em outra ação.");
        return;
      }

      if (!info.supported) {
        if (priorStatus === "recovering") {
          await recoveryFailure("A página mudou durante a retomada e não corresponde a uma etapa reconhecida. A busca foi pausada.");
        } else {
          await sendEvent("PAGE_NOT_SUPPORTED");
        }
        return;
      }
      const requestedDates = currentRequestedDates(config);
      if (!requestedDates.length) return;
      let hit = findDateElement(requestedDates);
      if (!hit) {
        const opened = await openCalendarAndWait(requestedDates, generation);
        if (!opened || generation !== scanGeneration) {
          logCalendarScan(requestedDates, "não consegui localizar ou abrir o calendário");
          return;
        }
        hit = findDateElement(requestedDates);
      }
      if (!hit) {
        logCalendarScan(requestedDates, "calendário aberto, mas nenhuma data solicitada foi reconhecida como disponível");
        return;
      }

      const currentDate = selectedDateFromControls(requestedDates);
      if (currentDate && hit.priority >= requestedDates.indexOf(currentDate)) return;

      const calendarConfirmBeforeClick = findCalendarConfirmButton(hit.element);
      if (generation !== scanGeneration) return;
      console.info("[Full Radar] tentando selecionar data", {
        date: hit.date,
        tag: hit.element.tagName.toLowerCase(),
        role: hit.element.getAttribute("role") || "",
        ariaLabel: hit.element.getAttribute("aria-label") || "",
        className: String(hit.element.className || "").slice(0, 90),
        text: normalized(hit.element.innerText || hit.element.textContent || "").trim()
      });
      hit.element.click();
      await wait(400);
      if (generation !== scanGeneration) return;

      if (!dateIsSelected(hit.date, hit.element)) {
        logCalendarScan(requestedDates, `cliquei em ${hit.date}, mas o Mercado Livre não confirmou a seleção`);
        await sendEvent("CONFIRMATION_RESULT", {
          date: hit.date,
          confirmed: false,
          automatic: config.autoConfirm !== false,
          error: true,
          message: "Encontrei a data, mas não consegui verificar a seleção no campo do Mercado Livre. Confira a aba."
        });
        return;
      }

      await sendEvent("FOUND_DATE", { date: hit.date, autoConfirm: config.autoConfirm !== false });

      const calendarConfirm = findCalendarConfirmButton(hit.element) ||
        (calendarConfirmBeforeClick?.isConnected && isVisible(calendarConfirmBeforeClick) ? calendarConfirmBeforeClick : null);
      if (calendarConfirm) {
        calendarConfirm.click();
        await wait(650);
        if (generation !== scanGeneration) return;
      }

      if (config.autoConfirm === false) {
        await sendEvent("CONFIRMATION_RESULT", {
          date: hit.date,
          confirmed: false,
          automatic: false,
          message: "A data foi selecionada. Revise os detalhes e confirme manualmente na página."
        });
        return;
      }

      if (generation !== scanGeneration) return;
      if (!finalConfirmationPanelVisible(hit.date)) {
        await sendEvent("CONFIRMATION_RESULT", {
          date: hit.date,
          confirmed: false,
          automatic: true,
          message: "A data foi selecionada, mas não reconheci o resumo final da coleta. Confira os detalhes antes de confirmar."
        });
        return;
      }

      const confirm = findConfirmButton();
      if (!confirm) {
        await sendEvent("CONFIRMATION_RESULT", {
          date: hit.date,
          confirmed: false,
          automatic: true,
          message: "O resumo da coleta apareceu, mas não encontrei o botão final de confirmação."
        });
        return;
      }
      confirm.click();
      await wait(1500);
      await sendEvent("CONFIRMATION_RESULT", {
        date: hit.date,
        confirmed: confirmationVisible(),
        automatic: true,
        message: confirmationVisible() ? "" : "O site não exibiu uma confirmação reconhecível. Confira a aba."
      });
    } finally {
      if (generation === scanGeneration) scanning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PAGE_INFO") {
      sendResponse(pageInfo());
      return false;
    }
    if (message.type === "SCAN") {
      runScan(message.config, "monitoring").catch(error => {
        console.error("[Full Radar] falha na busca", error);
        sendEvent("APP_ERROR", { source: "Busca", stage: "verificação do calendário", message: error?.message || String(error) });
      });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "RECOVER") {
      runScan(message.config, "recovering").catch(error => {
        console.error("[Full Radar] falha na recuperação", error);
        sendEvent("APP_ERROR", { source: "Recuperação", stage: "fluxo de retorno", message: error?.message || String(error) });
      });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_SCAN") {
      scanGeneration += 1;
      scanning = false;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.runtime.sendMessage({ type: "GET_TAB_SEARCH" }).then(async search => {
    if (search?.status === "confirming" && search.foundDate) {
      const confirmed = confirmationVisible();
      sendEvent("CONFIRMATION_RESULT", {
        date: search.foundDate,
        confirmed,
        automatic: search.config?.autoConfirm !== false,
        message: confirmed ? "" : "A página mudou após a tentativa. Confira se o agendamento foi concluído."
      });
    } else if ((search?.running || search?.status === "recovering") && search.config) {
      runScan(search.config, search.status).catch(error => {
        console.error("[Full Radar] falha ao retomar a busca", error);
        sendEvent("APP_ERROR", { source: "Busca", stage: "retomada após recarga", message: error?.message || String(error) });
      });
    } else if (search?.status === "needs_attention" && search.recoveryStep && search.config?.shipmentId) {
      const info = pageInfo();
      if (info.schedulePage && info.shipmentId === search.config.shipmentId) {
        await sendEvent("RECOVERY_COMPLETE");
        runScan(search.config, "monitoring").catch(error => {
          console.error("[Full Radar] falha após recuperação", error);
          sendEvent("APP_ERROR", { source: "Recuperação", stage: "retorno ao calendário", message: error?.message || String(error) });
        });
      }
    }
  }).catch(error => {
    sendEvent("APP_ERROR", { source: "Busca", stage: "inicialização", message: error?.message || String(error) });
  });
})();
