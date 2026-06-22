(function attachTemuPrice(root) {
  const DEFAULT_TEMU_ENDPOINT =
    "https://agentseller.temu.com/api/kiana/gamblers/marketing/enroll/list";
  const CLEARANCE_ACTIVITY_TYPE = 27;
  const CLEARANCE_PATTERN = /清仓甩卖/;
  const CLEARANCE_LABEL_PATTERN = /退件散货|退货散货|退[件货][^，,\s）)]*散货|散货/;

  function normalizeTemuEnrollPrices(payload, productIds, options = {}) {
    const states = normalizeTemuEnrollPriceStates(payload, productIds, options);
    const prices = {};
    for (const [productId, state] of Object.entries(states)) {
      if (state.price != null) {
        prices[productId] = state.price;
      }
    }

    return prices;
  }

  function normalizeTemuEnrollPriceStates(payload, productIds, options = {}) {
    const wantedIds = new Set(productIds.map(String));
    const list = readList(payload);
    const onlyOngoing = options.onlyOngoing !== false;
    const sourceList = onlyOngoing ? list.filter(isOngoingEnrollItem) : list;
    const states = {};

    for (const item of sourceList) {
      const productId = readProductId(item, wantedIds);
      if (!productId) {
        continue;
      }

      const itemPrices = collectActivityPriceEntries(item);
      if (!itemPrices.length) {
        continue;
      }

      const currentState = states[productId] || {};
      for (const entry of itemPrices) {
        if (entry.isClearance) {
          currentState.ignoredClearance = chooseLowerPriceEntry(
            currentState.ignoredClearance,
            entry
          );
          continue;
        }

        currentState.price =
          currentState.price == null
            ? entry.price
            : Math.min(currentState.price, entry.price);
      }

      states[productId] = currentState;
    }

    return Object.fromEntries(
      Object.entries(states).map(([productId, state]) => [
        productId,
        normalizePriceState(state)
      ])
    );
  }

  function readList(payload) {
    if (Array.isArray(payload)) {
      return payload.filter((item) => item && typeof item === "object");
    }

    if (!payload || typeof payload !== "object") {
      return [];
    }

    const list =
      payload.result?.list ??
      payload.data?.list ??
      payload.list ??
      [];

    return Array.isArray(list)
      ? list.filter((item) => item && typeof item === "object")
      : [];
  }

  function readTotal(payload) {
    const total = Number(payload?.result?.total ?? payload?.data?.total ?? payload?.total);
    return Number.isFinite(total) ? total : 0;
  }

  function isOngoingEnrollItem(item) {
    const status = readStatusNumber(item?.sessionStatus);
    if (status != null && status !== 2) {
      return false;
    }

    const sessions = Array.isArray(item?.assignSessionList)
      ? item.assignSessionList
      : [];
    if (sessions.length) {
      return sessions.some(
        (session) => readStatusNumber(session?.sessionStatus) === 2
      );
    }

    return status === 2;
  }

  function readStatusNumber(value) {
    const status = Number(value);
    return Number.isFinite(status) ? status : null;
  }

  function readProductId(item, wantedIds) {
    const candidates = [
      item.productId,
      item.spuId,
      item.spuID,
      item.spu_id,
      item.goodsId
    ];

    for (const candidate of candidates) {
      const normalized = String(candidate ?? "");
      if (wantedIds.has(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  function collectActivityPrices(node, depth = 0) {
    return collectActivityPriceEntries(node, depth).map((entry) => entry.price);
  }

  function collectActivityPriceEntries(node, depth = 0, ancestors = []) {
    if (node == null || depth > 10) {
      return [];
    }

    if (Array.isArray(node)) {
      return node.flatMap((item) =>
        collectActivityPriceEntries(item, depth + 1, ancestors)
      );
    }

    if (typeof node !== "object") {
      return [];
    }

    const entries = [];
    const contextNodes = [node, ...ancestors];
    if (Object.prototype.hasOwnProperty.call(node, "activityPrice")) {
      const price = convertActivityPrice(node.activityPrice);
      if (price != null) {
        const clearance = readClearanceContext(contextNodes);
        entries.push({
          price,
          isClearance: Boolean(clearance),
          label: clearance?.label || "",
          activityName: clearance?.activityName || ""
        });
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        entries.push(
          ...collectActivityPriceEntries(value, depth + 1, contextNodes)
        );
      }
    }

    return entries;
  }

  function chooseLowerPriceEntry(currentEntry, nextEntry) {
    if (!currentEntry || nextEntry.price < currentEntry.price) {
      return normalizeIgnoredPrice(nextEntry);
    }

    return currentEntry;
  }

  function normalizePriceState(state) {
    const normalized = {};
    if (state.price != null) {
      normalized.price = state.price;
    } else if (state.ignoredClearance) {
      normalized.noActivity = true;
    }

    if (state.ignoredClearance) {
      normalized.ignoredClearance = normalizeIgnoredPrice(state.ignoredClearance);
    }

    return normalized;
  }

  function normalizeIgnoredPrice(entry) {
    return {
      price: entry.price,
      label: entry.label || "退件散货",
      activityName: entry.activityName || "清仓甩卖"
    };
  }

  function readClearanceContext(nodes) {
    if (nodes.some(hasClearanceActivityType)) {
      return {
        label: readClearanceLabel(nodes) || "退件散货",
        activityName: "清仓甩卖"
      };
    }

    for (const node of nodes) {
      const text = readContextText(node);
      if (!CLEARANCE_PATTERN.test(text)) {
        continue;
      }

      return {
        label: readClearanceLabel(nodes) || "退件散货",
        activityName: "清仓甩卖"
      };
    }

    return null;
  }

  function hasClearanceActivityType(node) {
    if (!node || typeof node !== "object") {
      return false;
    }

    return [
      node.activityType,
      node.activity_type,
      node.activityTypeId,
      node.activity_type_id
    ].some((value) => readStatusNumber(value) === CLEARANCE_ACTIVITY_TYPE);
  }

  function readClearanceLabel(nodes) {
    for (const node of nodes) {
      const match = readContextText(node).match(CLEARANCE_LABEL_PATTERN);
      if (match?.[0]) {
        return match[0] === "散货" ? "退件散货" : match[0];
      }
    }

    return "";
  }

  function readContextText(node) {
    if (!node || typeof node !== "object") {
      return "";
    }

    const parts = [];
    for (const [key, value] of Object.entries(node)) {
      if (value == null) {
        continue;
      }

      if (isScalar(value)) {
        parts.push(String(value));
      } else if (
        !Array.isArray(value) &&
        typeof value === "object" &&
        /activity|campaign|promotion|session/i.test(key)
      ) {
        for (const childValue of Object.values(value)) {
          if (isScalar(childValue)) {
            parts.push(String(childValue));
          }
        }
      }
    }

    return parts.join(" ");
  }

  function isScalar(value) {
    return ["string", "number", "boolean"].includes(typeof value);
  }

  function convertActivityPrice(value) {
    const number = readNumber(value);
    if (number == null) {
      return null;
    }

    return number / 100;
  }

  function readNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    const normalized = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!normalized) {
      return null;
    }

    const number = Number(normalized[0]);
    return Number.isFinite(number) ? number : null;
  }

  function toProductIds(spuIds) {
    return spuIds.map((spuId) => {
      const text = String(spuId);
      if (!/^\d+$/.test(text)) {
        return text;
      }

      const number = Number(text);
      return Number.isSafeInteger(number) ? number : text;
    });
  }

  function buildTemuHeaders(settings = {}, runtimeValues = {}) {
    const headers = {
      accept: "*/*",
      "cache-control": "no-cache",
      "content-type": "application/json",
      pragma: "no-cache"
    };

    const mallId = firstNonEmpty(
      runtimeValues.mallId,
      settings.temuMallId
    );
    const antiContent = firstNonEmpty(
      runtimeValues.antiContent,
      settings.temuAntiContent
    );
    const csrfToken = firstNonEmpty(
      settings.temuCsrfToken,
      runtimeValues.csrfToken
    );

    if (mallId) {
      headers.mallid = mallId;
    }

    if (antiContent) {
      headers["anti-content"] = antiContent;
    }

    if (csrfToken) {
      headers["x-csrf-token"] = csrfToken;
    }

    return headers;
  }

  function hasTemuAntiContent(settings = {}, runtimeValues = {}) {
    return Boolean(firstNonEmpty(runtimeValues.antiContent, settings.temuAntiContent));
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) {
        return text;
      }
    }

    return "";
  }

  const api = {
    DEFAULT_TEMU_ENDPOINT,
    buildTemuHeaders,
    hasTemuAntiContent,
    normalizeTemuEnrollPriceStates,
    normalizeTemuEnrollPrices,
    readList,
    readTotal,
    toProductIds
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.TemuPrice = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
