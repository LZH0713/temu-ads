(() => {
  if (window.__temuAdsRoasHelperLoaded) {
    return;
  }
  window.__temuAdsRoasHelperLoaded = true;

  const DEFAULT_SYNC_SETTINGS = {
    enabled: true,
    temuMallId: "",
    temuAntiContent: "",
    temuOnlyOngoing: true,
    defaultCost: "80",
    rowSelector: "",
    spuSelector: "",
    targetRoasSelector: ""
  };

  const DEFAULT_LOCAL_STATE = {
    costBySpu: {},
    targetRoasBySpu: {}
  };

  const ROW_SELECTORS = [
    "tr",
    "[role='row']",
    ".ant-table-row",
    ".semi-table-row",
    ".arco-table-tr",
    "[class*='table-row']",
    "[class*='TableRow']"
  ];

  const SPU_REGEX =
    /(?:SPU\s*ID|SPUID|SPU|商品\s*ID|商品编号|商品ID)\s*[:：#]?\s*([A-Za-z0-9_-]{5,40})/i;
  const SPU_ID_REGEX =
    /(?:SPU\s*ID|SPUID|SPU)\s*[:：#]?\s*([A-Za-z0-9_-]{5,40})/i;
  const PRODUCT_ID_REGEX =
    /(?:商品\s*ID|商品编号|商品ID)\s*[:：#]?\s*([A-Za-z0-9_-]{5,40})/i;
  const FALLBACK_ID_REGEX = /\b\d{8,20}\b/;
  const ROAS_REGEX =
    /(?:目标\s*ROAS|目标ROAS|Target\s*ROAS|ROAS)\s*[:：#]?\s*(\d+(?:\.\d+)?)/i;
  const BUDGET_BID_HEADER = "预算和出价";
  const REQUIRED_AD_LIST_HEADERS = ["商品推广", "状态", "操作"];
  const REQUIRED_AD_LIST_METRIC_HEADERS = ["总花费", "净总花费"];
  const TABLE_COLUMNS = [
    { key: "price", label: "最低活动价", width: 112 },
    { key: "cost", label: "成本价", width: 92 },
    { key: "grossProfit", label: "毛利", width: 86 },
    { key: "target", label: "目标ROAS", width: 92 },
    { key: "breakEven", label: "回本ROAS", width: 92 },
    { key: "status", label: "判断", width: 86 }
  ];

  const state = {
    settings: { ...DEFAULT_SYNC_SETTINGS },
    local: { ...DEFAULT_LOCAL_STATE },
    priceCache: new Map(),
    pendingPrices: new Set(),
    forceRefreshPrices: false,
    scanTimer: null,
    observer: null
  };

  init();

  async function init() {
    injectStyles();
    window.addEventListener("message", handleAntiContentMessage);
    requestCapturedAntiContent();
    await reloadState();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync") {
        for (const [key, change] of Object.entries(changes)) {
          state.settings[key] =
            change.newValue === undefined && key in DEFAULT_SYNC_SETTINGS
              ? DEFAULT_SYNC_SETTINGS[key]
              : change.newValue;
        }
        state.priceCache.clear();
      }

      if (areaName === "local") {
        for (const [key, change] of Object.entries(changes)) {
          state.local[key] =
            change.newValue === undefined && key in DEFAULT_LOCAL_STATE
              ? DEFAULT_LOCAL_STATE[key]
              : change.newValue || {};
        }
      }

      scheduleScan(true);
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "TEMU_ROAS_SCAN") {
        state.forceRefreshPrices = true;
        scheduleScan(true);
        sendResponse({ ok: true });
        return true;
      }

      if (message?.type === "TEMU_ROAS_FETCH_PRICES_IN_PAGE") {
        fetchTemuEnrollPricesInPage(
          message.spuIds || [],
          message.settings || state.settings
        )
          .then(sendResponse)
          .catch((error) => {
            sendResponse({
              ok: false,
              error: error?.message || "价格获取失败"
            });
          });
        return true;
      }

      return false;
    });

    state.observer = new MutationObserver((mutations) => {
      if (mutations.every(isOwnMutation)) {
        return;
      }

      scheduleScan(false);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    scheduleScan(true);
  }

  function handleAntiContentMessage(event) {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }

    if (event.data?.type !== "TEMU_ROAS_ANTI_CONTENT") {
      return;
    }

    const antiContent = String(event.data.antiContent || "").trim();
    if (!antiContent || antiContent === state.settings.temuAntiContent) {
      return;
    }

    state.settings.temuAntiContent = antiContent;
  }

  function requestCapturedAntiContent() {
    window.postMessage(
      {
        type: "TEMU_ROAS_REQUEST_ANTI_CONTENT"
      },
      location.origin
    );
  }

  async function reloadState() {
    const [settings, localState] = await Promise.all([
      storageGet("sync", DEFAULT_SYNC_SETTINGS),
      storageGet("local", DEFAULT_LOCAL_STATE)
    ]);

    state.settings = { ...DEFAULT_SYNC_SETTINGS, ...settings };
    state.local = {
      ...DEFAULT_LOCAL_STATE,
      ...localState,
      costBySpu: localState.costBySpu || {},
      targetRoasBySpu: localState.targetRoasBySpu || {}
    };
  }

  function scheduleScan(immediate) {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(scanPage, immediate ? 0 : 300);
  }

  async function scanPage() {
    if (!state.settings.enabled) {
      removeAllPanels();
      return;
    }

    const rows = discoverRows();
    const spuIds = [];

    for (const row of rows) {
      const spuId = extractSpuId(row);
      if (!spuId) {
        continue;
      }

      const targetRoas = extractTargetRoas(row);
      const declaredPrice = extractDeclaredPrice(row);
      ensureHelperUi(row, spuId, targetRoas, declaredPrice);
      spuIds.push(spuId);
    }

    const forceRefreshPrices = state.forceRefreshPrices;
    state.forceRefreshPrices = false;

    await requestMissingPrices(spuIds, {
      forceRefresh: forceRefreshPrices,
      retryErrors: forceRefreshPrices
    });
    refreshPanels();
  }

  function discoverRows() {
    const configuredRows = selectAllSafe(state.settings.rowSelector);
    if (configuredRows.length) {
      return uniqueElements(configuredRows);
    }

    const directRows = selectAllSafe(ROW_SELECTORS.join(",")).filter((row) =>
      isEligibleAdListRow(row) && extractSpuId(row)
    );
    if (directRows.length) {
      return uniqueElements(directRows);
    }

    const hits = [];
    const elements = Array.from(document.body?.querySelectorAll("*") || []);
    for (const element of elements) {
      if (hits.length >= 200) {
        break;
      }

      if (
        element.closest(
          ".temu-roas-helper-host, .temu-roas-helper-column-cell"
        )
      ) {
        continue;
      }

      const text = compactText(element.textContent);
      if (!text || text.length > 240 || !SPU_REGEX.test(text)) {
        continue;
      }

      const row = findRowAncestor(element);
      if (row && isEligibleAdListRow(row)) {
        hits.push(row);
      }
    }

    return uniqueElements(hits);
  }

  function extractSpuId(row) {
    const configuredNode = selectOneSafe(state.settings.spuSelector, row);
    const configuredSpu = configuredNode
      ? extractSpuFromText(configuredNode.textContent)
      : null;
    if (configuredSpu) {
      return configuredSpu;
    }

    return extractSpuFromText(getOwnRowText(row));
  }

  function extractSpuFromText(text) {
    const compacted = compactText(text);
    const spuMatch = compacted.match(SPU_ID_REGEX);
    if (spuMatch?.[1]) {
      return spuMatch[1];
    }

    const productMatch = compacted.match(PRODUCT_ID_REGEX);
    if (productMatch?.[1]) {
      return productMatch[1];
    }

    if (/SPU/i.test(compacted)) {
      const fallbackMatch = compacted.match(FALLBACK_ID_REGEX);
      if (fallbackMatch?.[0]) {
        return fallbackMatch[0];
      }
    }

    return null;
  }

  function extractTargetRoas(row) {
    const configuredNode = selectOneSafe(state.settings.targetRoasSelector, row);
    const configuredRoas = configuredNode
      ? parseNumber(configuredNode.textContent)
      : null;
    if (configuredRoas != null) {
      return configuredRoas;
    }

    const text = compactText(getOwnRowText(row));
    const match = text.match(ROAS_REGEX);
    return match?.[1] ? parseNumber(match[1]) : null;
  }

  function extractDeclaredPrice(row) {
    const text = compactText(getOwnRowText(row));
    const match = text.match(
      /(?:申报价|申报价格)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)(?:\s*(?:~|-|－|—|至)\s*[¥￥]?\s*([\d,]+(?:\.\d+)?))?/i
    );
    if (!match) {
      return null;
    }

    const prices = [parseNumber(match[1]), parseNumber(match[2])].filter(
      (price) => price != null
    );
    return prices.length ? Math.min(...prices) : null;
  }

  function ensureHelperUi(row, spuId, detectedTargetRoas, declaredPrice) {
    const columnContext = findBudgetColumnContext(row);
    if (columnContext) {
      ensureColumnRow(
        row,
        spuId,
        detectedTargetRoas,
        declaredPrice,
        columnContext
      );
      return;
    }

    removeLegacyPanel(row);
  }

  function isEligibleAdListRow(row) {
    if (row.tagName !== "TR") {
      return false;
    }

    const context = findBudgetColumnContext(row);
    if (!context || row.closest('[role="dialog"], [aria-modal="true"]')) {
      return false;
    }

    const cells = Array.from(row.children).filter(
      (cell) => !cell.dataset.temuRoasHelperColumn
    );
    if (cells.length < context.budgetIndex + 4) {
      return false;
    }

    const text = compactText(getOwnRowText(row));
    return /推广日预算|目标\s*ROAS|目标ROAS/i.test(text);
  }

  function ensurePanel(row, spuId, detectedTargetRoas, declaredPrice) {
    let host = row.querySelector(":scope > .temu-roas-helper-host");
    if (!host) {
      host = document.createElement(row.tagName === "TR" ? "td" : "div");
      host.className = "temu-roas-helper-host";
      host.dataset.temuRoasHelper = "true";
      row.append(host);
      buildPanel(host);
    }

    host.dataset.spuId = spuId;
    const panel = host.querySelector(".temu-roas-helper-panel");
    panel.dataset.temuRoasHelperRow = "true";
    panel.dataset.spuId = spuId;
    setOptionalDatasetNumber(panel, "declaredPrice", declaredPrice);
    setText(panel.querySelector("[data-role='spu']"), spuId);

    const costInput = panel.querySelector("[data-role='cost']");
    const targetInput = panel.querySelector("[data-role='target']");
    const storedCost = parseNumber(state.local.costBySpu?.[spuId]);
    const defaultCost = readDefaultCost();
    const storedTarget = parseNumber(state.local.targetRoasBySpu?.[spuId]);

    if (document.activeElement !== costInput) {
      setInputValue(costInput, formatInputValue(storedCost ?? defaultCost));
    }

    if (document.activeElement !== targetInput) {
      setInputValue(
        targetInput,
        formatInputValue(storedTarget ?? detectedTargetRoas)
      );
    }

    refreshPanel(panel);
  }

  function findBudgetColumnContext(row) {
    if (row.tagName !== "TR") {
      return null;
    }

    const table = row.closest("table");
    const headerTable = findBudgetHeaderTable(table);
    const headerRow = headerTable
      ? Array.from(headerTable.querySelectorAll("tr")).find(
          (candidate) => findBudgetColumnIndex(candidate) != null
        )
      : null;
    const budgetIndex = headerRow ? findBudgetColumnIndex(headerRow) : null;

    if (!table || !headerTable || !headerRow || budgetIndex == null) {
      return null;
    }

    return {
      budgetIndex,
      headerRow,
      headerTable,
      table
    };
  }

  function findBudgetHeaderTable(table) {
    if (!table) {
      return null;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    const tableIndex = tables.indexOf(table);
    for (let index = tableIndex; index >= 0; index -= 1) {
      const candidate = tables[index];
      if (isAdListHeaderTable(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function isAdListHeaderTable(table) {
    const headers = Array.from(table.querySelectorAll("th")).map((cell) =>
      compactText(cell.textContent)
    );
    if (!headers.includes(BUDGET_BID_HEADER)) {
      return false;
    }

    return (
      REQUIRED_AD_LIST_HEADERS.every((header) => headers.includes(header)) &&
      REQUIRED_AD_LIST_METRIC_HEADERS.some((header) => headers.includes(header))
    );
  }

  function findBudgetColumnIndex(row) {
    return findLogicalCellIndex(
      row,
      (cell) => compactText(cell.textContent) === BUDGET_BID_HEADER
    );
  }

  function ensureColumnRow(
    row,
    spuId,
    detectedTargetRoas,
    declaredPrice,
    columnContext
  ) {
    removeLegacyPanel(row);
    ensureTableColumns(columnContext);

    row.dataset.temuRoasHelperRow = "true";
    row.dataset.spuId = spuId;
    setOptionalDatasetNumber(row, "declaredPrice", declaredPrice);

    const cells = ensureHelperCells(
      row,
      "td",
      columnContext.budgetIndex,
      getCellAtLogicalColumn(row, columnContext.budgetIndex)
    );
    ensureColumnCellContent(cells);

    const costInput = row.querySelector(
      ".temu-roas-helper-column-cell [data-role='cost']"
    );
    const targetInput = row.querySelector(
      ".temu-roas-helper-column-cell [data-role='target']"
    );
    const storedCost = parseNumber(state.local.costBySpu?.[spuId]);
    const defaultCost = readDefaultCost();
    const storedTarget = parseNumber(state.local.targetRoasBySpu?.[spuId]);

    if (costInput && document.activeElement !== costInput) {
      setInputValue(costInput, formatInputValue(storedCost ?? defaultCost));
    }

    if (targetInput && document.activeElement !== targetInput) {
      setInputValue(
        targetInput,
        formatInputValue(storedTarget ?? detectedTargetRoas)
      );
    }

    refreshColumnRow(row);
  }

  function ensureTableColumns(columnContext) {
    ensureHelperColgroup(columnContext.headerTable, columnContext.budgetIndex);
    ensureHelperHeaderCells(columnContext);

    if (columnContext.table !== columnContext.headerTable) {
      ensureHelperColgroup(columnContext.table, columnContext.budgetIndex);
      for (const row of columnContext.table.querySelectorAll("tr")) {
        ensureBlankHelperCells(row, columnContext.budgetIndex);
      }
    }
  }

  function ensureHelperColgroup(table, budgetIndex) {
    const colgroup = table?.querySelector("colgroup");
    if (!colgroup) {
      return;
    }

    const existingCols = colgroup.querySelectorAll(
      "col[data-temu-roas-helper-column]"
    );
    if (existingCols.length === TABLE_COLUMNS.length) {
      return;
    }

    existingCols.forEach((column) => column.remove());
    const cols = Array.from(colgroup.children).filter(
      (column) => column.tagName === "COL"
    );
    let anchor = cols[budgetIndex] || cols[cols.length - 1] || null;

    for (const definition of TABLE_COLUMNS) {
      const column = document.createElement("col");
      column.dataset.temuRoasHelperColumn = definition.key;
      column.style.width = `${definition.width}px`;
      if (anchor) {
        anchor.after(column);
      } else {
        colgroup.append(column);
      }
      anchor = column;
    }
  }

  function ensureHelperHeaderCells(columnContext) {
    const budgetHeaderCell = getCellAtLogicalColumn(
      columnContext.headerRow,
      columnContext.budgetIndex
    );
    const cells = ensureHelperCells(
      columnContext.headerRow,
      "th",
      columnContext.budgetIndex,
      budgetHeaderCell
    );

    cells.forEach((cell, index) => {
      const definition = TABLE_COLUMNS[index];
      setText(cell, definition.label);
      cell.title = definition.label;
    });
  }

  function ensureBlankHelperCells(row, budgetIndex) {
    if (row.querySelector(":scope > th") || row.dataset.temuRoasHelperRow) {
      return;
    }

    const cells = ensureHelperCells(
      row,
      "td",
      budgetIndex,
      getCellAtLogicalColumn(row, budgetIndex)
    );

    if (!row.dataset.temuRoasHelperRow) {
      cells.forEach((cell) => {
        cell.textContent = "";
        delete cell.dataset.temuRoasHelperReady;
      });
    }
  }

  function ensureHelperCells(row, tagName, budgetIndex, referenceCell) {
    const existingCells = Array.from(
      row.querySelectorAll(":scope > [data-temu-roas-helper-column]")
    );
    if (
      existingCells.length === TABLE_COLUMNS.length &&
      existingCells.every(
        (cell, index) =>
          cell.tagName.toLowerCase() === tagName &&
          cell.dataset.temuRoasHelperColumn === TABLE_COLUMNS[index].key
      )
    ) {
      return existingCells;
    }

    existingCells.forEach((cell) => cell.remove());

    const insertBefore = getCellAfterLogicalColumn(row, budgetIndex);
    const cells = TABLE_COLUMNS.map((definition) =>
      buildTableCell(tagName, definition, referenceCell)
    );

    for (const cell of cells) {
      row.insertBefore(cell, insertBefore);
    }

    return cells;
  }

  function buildTableCell(tagName, definition, referenceCell) {
    const cell = document.createElement(tagName);
    if (referenceCell?.className) {
      cell.className = referenceCell.className;
    }
    cell.classList.add(
      "temu-roas-helper-column-cell",
      `temu-roas-helper-column-${definition.key}`
    );
    cell.dataset.temuRoasHelper = "true";
    cell.dataset.temuRoasHelperColumn = definition.key;
    return cell;
  }

  function ensureColumnCellContent(cells) {
    for (const cell of cells) {
      const definition = TABLE_COLUMNS.find(
        (item) => item.key === cell.dataset.temuRoasHelperColumn
      );
      if (!definition || cell.dataset.temuRoasHelperReady === definition.key) {
        continue;
      }

      cell.textContent = "";
      if (definition.key === "cost" || definition.key === "target") {
        const input = document.createElement("input");
        input.className = "temu-roas-helper-table-input";
        input.dataset.role = definition.key;
        input.type = "number";
        input.min = "0";
        input.step = "0.01";
        input.placeholder = "0";
        input.setAttribute("aria-label", definition.label);
        input.addEventListener(
          "input",
          definition.key === "cost" ? handleCostChange : handleTargetChange
        );
        input.addEventListener(
          "change",
          definition.key === "cost" ? handleCostChange : handleTargetChange
        );
        cell.append(input);
      } else {
        const value = document.createElement("span");
        value.className =
          definition.key === "status"
            ? "temu-roas-helper-status temu-roas-helper-table-status"
            : "temu-roas-helper-table-value";
        value.dataset.role =
          definition.key === "breakEven" ? "breakEven" : definition.key;
        value.textContent = "-";
        cell.append(value);
      }

      cell.dataset.temuRoasHelperReady = definition.key;
    }
  }

  function getCellAtLogicalColumn(row, targetIndex) {
    let columnIndex = 0;
    for (const cell of Array.from(row.children)) {
      if (cell.dataset.temuRoasHelperColumn) {
        continue;
      }

      const span = Number(cell.colSpan) || 1;
      if (columnIndex <= targetIndex && targetIndex < columnIndex + span) {
        return cell;
      }
      columnIndex += span;
    }

    return null;
  }

  function getCellAfterLogicalColumn(row, targetIndex) {
    const cell = getCellAtLogicalColumn(row, targetIndex);
    return cell?.nextElementSibling || null;
  }

  function findLogicalCellIndex(row, predicate) {
    if (!row) {
      return null;
    }

    let columnIndex = 0;
    for (const cell of Array.from(row.children)) {
      if (cell.dataset.temuRoasHelperColumn) {
        continue;
      }

      const span = Number(cell.colSpan) || 1;
      if (predicate(cell)) {
        return columnIndex;
      }
      columnIndex += span;
    }

    return null;
  }

  function removeLegacyPanel(row) {
    row
      .querySelectorAll(":scope > .temu-roas-helper-host")
      .forEach((element) => element.remove());
  }

  function buildPanel(host) {
    const panel = document.createElement("div");
    panel.className = "temu-roas-helper-panel";

    panel.append(
      buildValue("SPU", "spu"),
      buildValue("最低价", "price"),
      buildInput("成本", "cost"),
      buildValue("毛利", "grossProfit"),
      buildInput("目标", "target"),
      buildValue("回本", "breakEven"),
      buildStatus()
    );

    panel
      .querySelector("[data-role='cost']")
      .addEventListener("input", handleCostChange);
    panel
      .querySelector("[data-role='cost']")
      .addEventListener("change", handleCostChange);
    panel
      .querySelector("[data-role='target']")
      .addEventListener("input", handleTargetChange);
    panel
      .querySelector("[data-role='target']")
      .addEventListener("change", handleTargetChange);

    host.append(panel);
  }

  function buildValue(label, role) {
    const item = document.createElement("label");
    item.className = "temu-roas-helper-field";

    const labelSpan = document.createElement("span");
    labelSpan.className = "temu-roas-helper-label";
    labelSpan.textContent = label;

    const valueSpan = document.createElement("span");
    valueSpan.className = "temu-roas-helper-value";
    valueSpan.dataset.role = role;
    valueSpan.textContent = "-";

    item.append(labelSpan, valueSpan);
    return item;
  }

  function buildInput(label, role) {
    const item = document.createElement("label");
    item.className = "temu-roas-helper-field";

    const labelSpan = document.createElement("span");
    labelSpan.className = "temu-roas-helper-label";
    labelSpan.textContent = label;

    const input = document.createElement("input");
    input.className = "temu-roas-helper-input";
    input.dataset.role = role;
    input.type = "number";
    input.min = "0";
    input.step = "0.01";
    input.placeholder = "0";

    item.append(labelSpan, input);
    return item;
  }

  function buildStatus() {
    const item = document.createElement("div");
    item.className = "temu-roas-helper-status";
    item.dataset.role = "status";
    item.textContent = "待计算";
    return item;
  }

  async function handleCostChange(event) {
    const helperRow = event.currentTarget.closest(
      "[data-temu-roas-helper-row]"
    );
    const spuId = helperRow?.dataset.spuId;
    if (!spuId) {
      return;
    }

    const value = parseNumber(event.currentTarget.value);

    state.local.costBySpu = { ...(state.local.costBySpu || {}) };
    if (value == null) {
      delete state.local.costBySpu[spuId];
    } else {
      state.local.costBySpu[spuId] = value;
    }

    await storageSet("local", { costBySpu: state.local.costBySpu });
    refreshHelperRow(helperRow);
  }

  async function handleTargetChange(event) {
    const helperRow = event.currentTarget.closest(
      "[data-temu-roas-helper-row]"
    );
    const spuId = helperRow?.dataset.spuId;
    if (!spuId) {
      return;
    }

    const value = parseNumber(event.currentTarget.value);

    state.local.targetRoasBySpu = { ...(state.local.targetRoasBySpu || {}) };
    if (value == null) {
      delete state.local.targetRoasBySpu[spuId];
    } else {
      state.local.targetRoasBySpu[spuId] = value;
    }

    await storageSet("local", { targetRoasBySpu: state.local.targetRoasBySpu });
    refreshHelperRow(helperRow);
  }

  async function requestMissingPrices(spuIds, options = {}) {
    const missingSpuIds = [...new Set(spuIds)].filter(
      (spuId) =>
        !state.pendingPrices.has(spuId) &&
        (options.forceRefresh ||
          !state.priceCache.has(spuId) ||
          (options.retryErrors && state.priceCache.get(spuId)?.error))
    );

    if (!missingSpuIds.length) {
      return;
    }

    missingSpuIds.forEach((spuId) => state.priceCache.delete(spuId));
    missingSpuIds.forEach((spuId) => state.pendingPrices.add(spuId));
    refreshPanels();

    try {
      const response = await fetchTemuEnrollPrices(missingSpuIds);

      if (!response?.ok) {
        missingSpuIds.forEach((spuId) =>
          state.priceCache.set(spuId, {
            error: response?.error || "价格获取失败"
          })
        );
        return;
      }

      for (const spuId of missingSpuIds) {
        if (response.prices && response.prices[spuId] != null) {
          const price = Number(response.prices[spuId]);
          state.priceCache.set(
            spuId,
            Number.isFinite(price) ? price : { error: "价格格式不正确" }
          );
        } else {
          state.priceCache.set(spuId, { noActivity: true });
        }
      }
    } catch (error) {
      missingSpuIds.forEach((spuId) =>
        state.priceCache.set(spuId, {
          error: error?.message || "价格获取失败"
        })
      );
    } finally {
      missingSpuIds.forEach((spuId) => state.pendingPrices.delete(spuId));
    }
  }

  async function fetchTemuEnrollPrices(spuIds) {
    const backgroundResponse = await fetchPricesViaBackground(spuIds);
    if (backgroundResponse) {
      return backgroundResponse;
    }

    return fetchTemuEnrollPricesInPage(spuIds, state.settings);
  }

  async function fetchTemuEnrollPricesInPage(spuIds, settings) {
    if (!globalThis.TemuPrice) {
      return {
        ok: false,
        error: "价格模块未加载，请刷新页面"
      };
    }

    if (location.hostname !== "agentseller.temu.com") {
      return {
        ok: false,
        error: "Temu 接口需在 agentseller.temu.com 页面使用"
      };
    }

    const productIds = globalThis.TemuPrice.toProductIds(spuIds);
    const pageSize = Math.max(10, Math.min(100, productIds.length * 5));
    const headers = globalThis.TemuPrice.buildTemuHeaders(
      settings,
      readTemuRuntimeValues()
    );

    const combined = {
      result: {
        total: 0,
        list: []
      }
    };

    for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
      const response = await fetch(globalThis.TemuPrice.DEFAULT_TEMU_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pageNo,
          pageSize,
          productIds
        }),
        credentials: "include",
        cache: "no-store"
      });

      if (!response.ok) {
        return {
          ok: false,
          error: await formatTemuFetchError(response)
        };
      }

      let payload;
      try {
        payload = await response.json();
      } catch (_error) {
        return {
          ok: false,
          error: "Temu 接口返回非 JSON"
        };
      }

      const list = globalThis.TemuPrice.readList(payload);
      const total = globalThis.TemuPrice.readTotal(payload);
      combined.result.total = Math.max(combined.result.total, total);
      combined.result.list.push(...list);

      if (!list.length || !total || combined.result.list.length >= total) {
        break;
      }
    }

    return {
      ok: true,
      prices: globalThis.TemuPrice.normalizeTemuEnrollPrices(
        combined,
        spuIds,
        {
          onlyOngoing: settings.temuOnlyOngoing
        }
      )
    };
  }

  async function formatTemuFetchError(response) {
    let detail = "";
    try {
      detail = compactText((await response.text()).slice(0, 240));
    } catch (_error) {
      detail = "";
    }

    return detail
      ? `Temu 接口请求失败：${response.status} ${detail}`
      : `Temu 接口请求失败：${response.status}`;
  }

  function readTemuRuntimeValues() {
    const search = new URLSearchParams(location.search);
    const mallId =
      search.get("mallId") ||
      search.get("mallid") ||
      findStorageValue(/mall.?id/i);
    const antiContent = findStorageValue(/anti.?content/i);
    const csrfToken =
      readCookie("csrfToken") ||
      readCookie("_csrf") ||
      findMetaContent(/csrf/i) ||
      findStorageValue(/csrf|token/i);

    return {
      mallId,
      antiContent,
      csrfToken
    };
  }

  function findStorageValue(pattern) {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key || !pattern.test(key)) {
          continue;
        }

        const value = storage.getItem(key);
        if (value && value.length < 4096) {
          return value;
        }
      }
    }

    return "";
  }

  function readCookie(name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`)
    );
    return match ? decodeURIComponent(match[1]) : "";
  }

  function findMetaContent(pattern) {
    for (const meta of document.querySelectorAll("meta")) {
      if (pattern.test(meta.name || "") || pattern.test(meta.id || "")) {
        return meta.content || "";
      }
    }

    return "";
  }

  function fetchPricesViaBackground(spuIds) {
    if (!chrome.runtime?.sendMessage) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "TEMU_ROAS_FETCH_PRICES",
          settings: {
            temuMallId: state.settings.temuMallId,
            temuAntiContent: state.settings.temuAntiContent,
            temuOnlyOngoing: state.settings.temuOnlyOngoing
          },
          spuIds
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }

          resolve(response || null);
        }
      );
    });
  }

  function refreshPanels() {
    document
      .querySelectorAll("[data-temu-roas-helper-row]")
      .forEach((helperRow) => refreshHelperRow(helperRow));
  }

  function refreshHelperRow(helperRow) {
    if (helperRow.classList.contains("temu-roas-helper-panel")) {
      refreshPanel(helperRow);
      return;
    }

    refreshColumnRow(helperRow);
  }

  function refreshPanel(panel) {
    const spuId = panel.dataset.spuId;
    const priceState = state.priceCache.get(spuId);
    const declaredPrice = parseNumber(panel.dataset.declaredPrice);
    const calculationPrice = globalThis.TemuRoas.resolveCalculationPrice(
      priceState,
      declaredPrice
    );
    const price = calculationPrice.price;
    const cost = parseNumber(panel.querySelector("[data-role='cost']").value);
    const targetRoas = parseNumber(
      panel.querySelector("[data-role='target']").value
    );

    const priceEl = panel.querySelector("[data-role='price']");
    const grossProfitEl = panel.querySelector("[data-role='grossProfit']");
    const breakEvenEl = panel.querySelector("[data-role='breakEven']");
    const statusEl = panel.querySelector("[data-role='status']");

    if (state.pendingPrices.has(spuId)) {
      setText(priceEl, "获取中");
    } else if (price != null) {
      setText(
        priceEl,
        calculationPrice.source === "declared"
          ? "无活动价"
          : formatNumber(price)
      );
      setTitle(
        priceEl,
        calculationPrice.source === "declared"
          ? `按最低申报价 ${formatNumber(price)} 计算`
          : ""
      );
    } else if (priceState?.noActivity) {
      setText(priceEl, "无活动价");
      setTitle(priceEl, "未识别到申报价，无法计算");
    } else if (priceState?.error) {
      setText(priceEl, priceState.error);
      setTitle(priceEl, priceState.error);
    } else {
      setText(priceEl, "待获取");
      setTitle(priceEl, "");
    }

    const result = globalThis.TemuRoas.calculateBreakEven(
      price,
      cost,
      targetRoas
    );
    const grossProfit = globalThis.TemuRoas.calculateGrossProfit(
      price,
      cost,
      targetRoas
    );
    setText(
      grossProfitEl,
      grossProfit == null ? "-" : formatNumber(grossProfit)
    );
    setText(
      breakEvenEl,
      result.breakEvenRoas == null ? "-" : formatNumber(result.breakEvenRoas)
    );

    setClassName(statusEl, `temu-roas-helper-status ${result.statusClass}`);
    setText(statusEl, result.message);
    setTitle(statusEl, result.detail || "");
  }

  function refreshColumnRow(row) {
    const spuId = row.dataset.spuId;
    const priceState = state.priceCache.get(spuId);
    const declaredPrice = parseNumber(row.dataset.declaredPrice);
    const calculationPrice = globalThis.TemuRoas.resolveCalculationPrice(
      priceState,
      declaredPrice
    );
    const price = calculationPrice.price;
    const cost = parseNumber(
      row.querySelector(".temu-roas-helper-column-cell [data-role='cost']")
        ?.value
    );
    const targetRoas = parseNumber(
      row.querySelector(".temu-roas-helper-column-cell [data-role='target']")
        ?.value
    );

    const priceEl = row.querySelector(
      ".temu-roas-helper-column-cell [data-role='price']"
    );
    const grossProfitEl = row.querySelector(
      ".temu-roas-helper-column-cell [data-role='grossProfit']"
    );
    const breakEvenEl = row.querySelector(
      ".temu-roas-helper-column-cell [data-role='breakEven']"
    );
    const statusEl = row.querySelector(
      ".temu-roas-helper-column-cell [data-role='status']"
    );

    if (!priceEl || !grossProfitEl || !breakEvenEl || !statusEl) {
      return;
    }

    if (state.pendingPrices.has(spuId)) {
      setText(priceEl, "获取中");
      setTitle(priceEl, "");
    } else if (price != null) {
      setText(
        priceEl,
        calculationPrice.source === "declared"
          ? "无活动价"
          : formatNumber(price)
      );
      setTitle(
        priceEl,
        calculationPrice.source === "declared"
          ? `按最低申报价 ${formatNumber(price)} 计算`
          : ""
      );
    } else if (priceState?.noActivity) {
      setText(priceEl, "无活动价");
      setTitle(priceEl, "未识别到申报价，无法计算");
    } else if (priceState?.error) {
      setText(priceEl, compactError(priceState.error));
      setTitle(priceEl, priceState.error);
    } else {
      setText(priceEl, "待获取");
      setTitle(priceEl, "");
    }

    const result = globalThis.TemuRoas.calculateBreakEven(
      price,
      cost,
      targetRoas
    );
    const grossProfit = globalThis.TemuRoas.calculateGrossProfit(
      price,
      cost,
      targetRoas
    );
    setText(
      grossProfitEl,
      grossProfit == null ? "-" : formatNumber(grossProfit)
    );
    setText(
      breakEvenEl,
      result.breakEvenRoas == null ? "-" : formatNumber(result.breakEvenRoas)
    );

    setClassName(
      statusEl,
      "temu-roas-helper-status temu-roas-helper-table-status " +
        result.statusClass
    );
    setText(statusEl, result.message);
    setTitle(statusEl, result.detail || "");
  }

  function findRowAncestor(element) {
    return element.closest(ROW_SELECTORS.join(",")) || element.parentElement;
  }

  function uniqueElements(elements) {
    return [...new Set(elements.filter(Boolean))];
  }

  function selectAllSafe(selector, root = document) {
    if (!selector || !selector.trim()) {
      return [];
    }

    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  function selectOneSafe(selector, root = document) {
    if (!selector || !selector.trim()) {
      return null;
    }

    try {
      return root.querySelector(selector);
    } catch (_error) {
      return null;
    }
  }

  function isOwnMutation(mutation) {
    if (isInsideHelper(mutation.target)) {
      return true;
    }

    const changedNodes = [
      ...Array.from(mutation.addedNodes),
      ...Array.from(mutation.removedNodes)
    ];

    return changedNodes.length > 0 && changedNodes.every(isHelperNode);
  }

  function isInsideHelper(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return Boolean(
        node.closest(".temu-roas-helper-host, .temu-roas-helper-column-cell")
      );
    }

    return Boolean(
      node.parentElement?.closest(
        ".temu-roas-helper-host, .temu-roas-helper-column-cell"
      )
    );
  }

  function isHelperNode(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return (
        node.matches(
          ".temu-roas-helper-host, .temu-roas-helper-column-cell, col[data-temu-roas-helper-column]"
        ) ||
        Boolean(
          node.closest(".temu-roas-helper-host, .temu-roas-helper-column-cell")
        )
      );
    }

    return isInsideHelper(node);
  }

  function setText(element, value) {
    const text = String(value);
    if (element.textContent !== text) {
      element.textContent = text;
    }
  }

  function setInputValue(input, value) {
    if (input.value !== value) {
      input.value = value;
    }
  }

  function setClassName(element, value) {
    if (element.className !== value) {
      element.className = value;
    }
  }

  function setTitle(element, value) {
    if (element.title !== value) {
      element.title = value;
    }
  }

  function setOptionalDatasetNumber(element, key, value) {
    if (value == null || !Number.isFinite(Number(value))) {
      delete element.dataset[key];
      return;
    }

    element.dataset[key] = String(value);
  }

  function parseNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }

    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  }

  function compactText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getOwnRowText(row) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (
          node.parentElement?.closest(
            ".temu-roas-helper-host, .temu-roas-helper-column-cell"
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const parts = [];

    while (walker.nextNode()) {
      parts.push(walker.currentNode.nodeValue);
    }

    return parts.join(" ");
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: 2
    }).format(value);
  }

  function formatInputValue(value) {
    return value == null || Number.isNaN(Number(value)) ? "" : String(value);
  }

  function readDefaultCost() {
    return parseNumber(state.settings.defaultCost) ?? 80;
  }

  function compactError(message) {
    const text = String(message || "");
    if (text.includes("anti-content")) {
      return "缺anti";
    }

    if (text.includes("agentseller.temu.com")) {
      return "需登录态";
    }

    if (text.includes("返回非 JSON")) {
      return "返回异常";
    }

    if (text.includes("请求失败")) {
      return "请求失败";
    }

    return text.length > 8 ? "获取失败" : text;
  }

  function storageGet(areaName, defaults) {
    return new Promise((resolve) => {
      chrome.storage[areaName].get(defaults, resolve);
    });
  }

  function storageSet(areaName, values) {
    return new Promise((resolve) => {
      chrome.storage[areaName].set(values, resolve);
    });
  }

  function removeAllPanels() {
    document
      .querySelectorAll(
        ".temu-roas-helper-host, .temu-roas-helper-column-cell, col[data-temu-roas-helper-column]"
      )
      .forEach((element) => element.remove());
    document
      .querySelectorAll("[data-temu-roas-helper-row]")
      .forEach((element) => {
        delete element.dataset.temuRoasHelperRow;
        delete element.dataset.spuId;
      });
  }

  function injectStyles() {
    if (document.getElementById("temu-roas-helper-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "temu-roas-helper-style";
    style.textContent = `
      .temu-roas-helper-host {
        min-width: 280px !important;
        vertical-align: middle !important;
        box-sizing: border-box !important;
      }

      .temu-roas-helper-column-cell {
        box-sizing: border-box !important;
        min-width: 82px !important;
        max-width: 128px !important;
        padding: 8px 10px !important;
        vertical-align: top !important;
        background: #ffffff !important;
        color: #172033 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        font-size: 12px !important;
        letter-spacing: 0 !important;
      }

      th.temu-roas-helper-column-cell {
        color: #475569 !important;
        font-weight: 700 !important;
        white-space: nowrap !important;
      }

      .temu-roas-helper-table-input {
        width: 72px !important;
        min-width: 0 !important;
        height: 26px !important;
        box-sizing: border-box !important;
        padding: 4px 6px !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 6px !important;
        background: #ffffff !important;
        color: #0f172a !important;
        font: inherit !important;
        text-align: right !important;
      }

      .temu-roas-helper-table-input:focus {
        border-color: #2563eb !important;
        outline: none !important;
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.14) !important;
      }

      .temu-roas-helper-table-value {
        display: inline-flex !important;
        max-width: 100% !important;
        min-height: 24px !important;
        align-items: center !important;
        overflow: hidden !important;
        color: #0f172a !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }

      .temu-roas-helper-table-status {
        min-width: 54px !important;
        min-height: 24px !important;
        padding: 3px 7px !important;
        font-size: 12px !important;
      }

      .temu-roas-helper-panel {
        display: grid !important;
        grid-template-columns: repeat(3, minmax(72px, 1fr)) !important;
        gap: 6px !important;
        align-items: stretch !important;
        min-width: 260px !important;
        max-width: 360px !important;
        padding: 8px !important;
        border: 1px solid #d7dde8 !important;
        border-radius: 8px !important;
        background: #ffffff !important;
        color: #1f2937 !important;
        box-shadow: 0 8px 22px rgba(15, 23, 42, 0.1) !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        font-size: 12px !important;
        line-height: 1.25 !important;
        letter-spacing: 0 !important;
      }

      .temu-roas-helper-field {
        display: flex !important;
        min-width: 0 !important;
        flex-direction: column !important;
        gap: 3px !important;
        margin: 0 !important;
      }

      .temu-roas-helper-label {
        color: #64748b !important;
        font-size: 11px !important;
        white-space: nowrap !important;
      }

      .temu-roas-helper-value {
        min-height: 26px !important;
        overflow: hidden !important;
        padding: 5px 6px !important;
        border-radius: 6px !important;
        background: #f8fafc !important;
        color: #0f172a !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }

      .temu-roas-helper-input {
        width: 100% !important;
        min-width: 0 !important;
        height: 26px !important;
        box-sizing: border-box !important;
        padding: 4px 6px !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 6px !important;
        background: #ffffff !important;
        color: #0f172a !important;
        font: inherit !important;
      }

      .temu-roas-helper-status {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-height: 26px !important;
        padding: 5px 6px !important;
        border-radius: 6px !important;
        background: #eef2f7 !important;
        color: #475569 !important;
        font-weight: 700 !important;
        white-space: nowrap !important;
      }

      .temu-roas-helper-status.is-good {
        background: #dcfce7 !important;
        color: #166534 !important;
      }

      .temu-roas-helper-status.is-danger {
        background: #fee2e2 !important;
        color: #991b1b !important;
      }

      .temu-roas-helper-status.is-pending {
        background: #f1f5f9 !important;
        color: #475569 !important;
      }
    `;
    document.documentElement.append(style);
  }
})();
