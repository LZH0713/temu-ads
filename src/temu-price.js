(function attachTemuPrice(root) {
  const DEFAULT_TEMU_ENDPOINT =
    "https://agentseller.temu.com/api/kiana/gamblers/marketing/enroll/list";

  function normalizeTemuEnrollPrices(payload, productIds, options = {}) {
    const wantedIds = new Set(productIds.map(String));
    const list = readList(payload);
    const onlyOngoing = options.onlyOngoing !== false;
    const sourceList = onlyOngoing ? list.filter(isOngoingEnrollItem) : list;
    const prices = {};

    for (const item of sourceList) {
      const productId = readProductId(item, wantedIds);
      if (!productId) {
        continue;
      }

      const itemPrices = collectActivityPrices(item);
      if (!itemPrices.length) {
        continue;
      }

      const minPrice = Math.min(...itemPrices);
      prices[productId] =
        prices[productId] == null ? minPrice : Math.min(prices[productId], minPrice);
    }

    return prices;
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
    if (node == null || depth > 10) {
      return [];
    }

    if (Array.isArray(node)) {
      return node.flatMap((item) => collectActivityPrices(item, depth + 1));
    }

    if (typeof node !== "object") {
      return [];
    }

    const prices = [];
    if (Object.prototype.hasOwnProperty.call(node, "activityPrice")) {
      const price = convertActivityPrice(node.activityPrice);
      if (price != null) {
        prices.push(price);
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        prices.push(...collectActivityPrices(value, depth + 1));
      }
    }

    return prices;
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
