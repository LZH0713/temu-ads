importScripts("temu-price.js");

const AGENTSELLER_LOG_URL =
  "https://agentseller.temu.com/activity/marketing-activity/log";
const CAPTURE_STORAGE_KEY = "temuRoasCapturedRuntime";
const CAPTURED_RUNTIME_MAX_AGE_MS = 90 * 1000;
const capturedRuntime = {
  antiContent: "",
  mallId: "",
  updatedAt: 0
};

installTemuRequestHeaderCapture();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TEMU_ROAS_FETCH_PRICES") {
    return false;
  }

  fetchTemuEnrollPrices(message.spuIds || [], message.settings || {})
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "价格获取失败"
      });
    });

  return true;
});

async function fetchTemuEnrollPrices(spuIds, settings) {
  let preparedSettings = await mergeCapturedRuntimeSettings(settings);
  const relayResponse = await fetchTemuEnrollPricesViaAgentsellerTab(
    spuIds,
    preparedSettings
  );
  if (relayResponse) {
    return relayResponse;
  }

  preparedSettings = await mergeCapturedRuntimeSettings(settings);
  return fetchTemuEnrollPricesDirect(spuIds, preparedSettings);
}

async function fetchTemuEnrollPricesViaAgentsellerTab(spuIds, settings) {
  const tab = await ensureAgentsellerFetchTab();
  if (!tab) {
    return null;
  }

  let preparedSettings = await ensureTemuRuntimeSettings(tab.id, settings);
  const pageResponse = await executeFetchInAgentsellerPage(
    tab.id,
    spuIds,
    preparedSettings
  );
  if (!pageResponse) {
    return null;
  }

  if (!pageResponse.ok) {
    return pageResponse;
  }

  return {
    ok: true,
    prices: globalThis.TemuPrice.normalizeTemuEnrollPriceStates(
      pageResponse.combined,
      spuIds,
      {
        onlyOngoing: settings.temuOnlyOngoing
      }
    )
  };
}

function selectAgentsellerFetchTab(tabs) {
  const candidates = tabs.filter((candidate) => candidate.id != null);
  return (
    candidates.find((candidate) =>
      String(candidate.url || "").includes("/activity/marketing-activity/log")
    ) ||
    candidates.find((candidate) =>
      isUsableAgentsellerUrl(candidate.url)
    ) ||
    null
  );
}

function isUsableAgentsellerUrl(url) {
  const text = String(url || "");
  return (
    text.includes("agentseller.temu.com") &&
    !text.includes("/auth/") &&
    !text.includes("/auth?")
  );
}

async function ensureTemuRuntimeSettings(tabId, settings) {
  let preparedSettings = await mergeCapturedRuntimeSettings(settings);
  if (await hasFreshCapturedRuntimeAntiContent()) {
    return preparedSettings;
  }

  await reloadTabAndWait(tabId);
  preparedSettings = await waitForCapturedRuntimeSettings(settings, 10000);
  return preparedSettings;
}

async function ensureAgentsellerFetchTab() {
  const existingTabs = await tabsQuery({
    url: "https://agentseller.temu.com/*"
  });
  const existingTab = selectAgentsellerFetchTab(existingTabs);
  if (existingTab) {
    return existingTab;
  }

  const tab = await tabsCreate({
    active: false,
    url: AGENTSELLER_LOG_URL
  });
  if (!tab?.id) {
    return null;
  }

  await waitForTabLoad(tab.id, 15000);
  await delay(1500);

  const tabs = await tabsQuery({
    url: "https://agentseller.temu.com/*"
  });
  return selectAgentsellerFetchTab(tabs) || tab;
}

async function reloadTabAndWait(tabId) {
  await tabsReload(tabId);
  await waitForTabLoad(tabId, 15000);
  await delay(1500);
}

async function fetchTemuEnrollPricesDirect(spuIds, settings) {
  if (!globalThis.TemuPrice) {
    return {
      ok: false,
      error: "价格模块未加载，请刷新扩展"
    };
  }

  const productIds = globalThis.TemuPrice.toProductIds(spuIds);
  const pageSize = Math.max(10, Math.min(100, productIds.length * 5));
  const headers = globalThis.TemuPrice.buildTemuHeaders(settings);
  if (!globalThis.TemuPrice.hasTemuAntiContent(settings)) {
    return {
      ok: false,
      error: "缺少 anti-content，请在扩展配置里填入当前 Temu 请求的 anti-content 后重试"
    };
  }

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
    prices: globalThis.TemuPrice.normalizeTemuEnrollPriceStates(
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

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab) => resolve(tab || null));
  });
}

function tabsReload(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.reload(tabId, {}, () => resolve());
  });
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(finish, timeoutMs);

    function finish() {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete") {
        finish();
      }
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCapturedRuntimeSettings(settings, timeoutMs) {
  const startedAt = Date.now();
  let preparedSettings = await mergeCapturedRuntimeSettings(settings);

  while (
    !(await hasFreshCapturedRuntimeAntiContent()) &&
    Date.now() - startedAt < timeoutMs
  ) {
    await delay(250);
    preparedSettings = await mergeCapturedRuntimeSettings(settings);
  }

  return preparedSettings;
}

async function mergeCapturedRuntimeSettings(settings = {}) {
  const runtimeValues = await readCapturedRuntimeValues();
  const runtimeIsFresh = isCapturedRuntimeFresh(runtimeValues);

  return {
    ...settings,
    temuMallId:
      (runtimeIsFresh ? runtimeValues.mallId : "") || settings.temuMallId,
    temuAntiContent:
      (runtimeIsFresh ? runtimeValues.antiContent : "") ||
      settings.temuAntiContent
  };
}

async function hasFreshCapturedRuntimeAntiContent() {
  const runtimeValues = await readCapturedRuntimeValues();
  return Boolean(isCapturedRuntimeFresh(runtimeValues) && runtimeValues.antiContent);
}

function isCapturedRuntimeFresh(runtimeValues) {
  return Boolean(
    runtimeValues.updatedAt &&
    Date.now() - runtimeValues.updatedAt <= CAPTURED_RUNTIME_MAX_AGE_MS
  );
}

async function readCapturedRuntimeValues() {
  if (capturedRuntime.antiContent || capturedRuntime.mallId) {
    return { ...capturedRuntime };
  }

  const stored = await storageSessionGet(CAPTURE_STORAGE_KEY);
  const runtimeValues = stored?.[CAPTURE_STORAGE_KEY] || {};
  capturedRuntime.antiContent = String(runtimeValues.antiContent || "");
  capturedRuntime.mallId = String(runtimeValues.mallId || "");
  capturedRuntime.updatedAt = Number(runtimeValues.updatedAt || 0);
  return { ...capturedRuntime };
}

function installTemuRequestHeaderCapture() {
  if (!chrome.webRequest?.onBeforeSendHeaders) {
    return;
  }

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const requestHeaders = details.requestHeaders || [];
      const antiContent = readHeader(requestHeaders, "anti-content");
      const mallId = readHeader(requestHeaders, "mallid");

      if (!antiContent && !mallId) {
        return;
      }

      if (antiContent) {
        capturedRuntime.antiContent = antiContent;
      }

      if (mallId) {
        capturedRuntime.mallId = mallId;
      }

      capturedRuntime.updatedAt = Date.now();
      storageSessionSet({
        [CAPTURE_STORAGE_KEY]: { ...capturedRuntime }
      });
    },
    {
      urls: ["https://agentseller.temu.com/*"]
    },
    ["requestHeaders", "extraHeaders"]
  );
}

function readHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  const header = headers.find(
    (item) => String(item.name || "").toLowerCase() === normalizedName
  );
  return String(header?.value || "").trim();
}

function storageSessionGet(key) {
  return new Promise((resolve) => {
    const area = chrome.storage.session || chrome.storage.local;
    area.get(key, resolve);
  });
}

function storageSessionSet(values) {
  const area = chrome.storage.session || chrome.storage.local;
  area.set(values);
}

function executeFetchInAgentsellerPage(tabId, spuIds, settings) {
  const productIds = globalThis.TemuPrice.toProductIds(spuIds);
  const pageSize = Math.max(10, Math.min(100, productIds.length * 5));

  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        args: [
          {
            endpoint: globalThis.TemuPrice.DEFAULT_TEMU_ENDPOINT,
            pageSize,
            productIds,
            settings
          }
        ],
        func: async ({ endpoint, pageSize, productIds, settings }) => {
          const generatedAntiContent = await generateTemuAntiContent();
          const runtimeValues = readTemuRuntimeValues(generatedAntiContent);
          const headers = buildTemuHeaders(settings, runtimeValues);
          if (generatedAntiContent) {
            headers["anti-content"] = generatedAntiContent;
          }

          if (!hasTemuAntiContent(settings, runtimeValues)) {
            return {
              ok: false,
              error: "缺少 anti-content，请在扩展配置里填入当前 Temu 请求的 anti-content 后重试"
            };
          }

          const combined = {
            result: {
              total: 0,
              list: []
            }
          };

          for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
            const response = await fetch(endpoint, {
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

            const list =
              payload?.result?.list ?? payload?.data?.list ?? payload?.list ?? [];
            const total = Number(
              payload?.result?.total ?? payload?.data?.total ?? payload?.total
            );
            combined.result.total = Math.max(
              combined.result.total,
              Number.isFinite(total) ? total : 0
            );
            if (Array.isArray(list)) {
              combined.result.list.push(...list);
            }

            if (
              !Array.isArray(list) ||
              !list.length ||
              !total ||
              combined.result.list.length >= total
            ) {
              break;
            }
          }

          return {
            ok: true,
            combined
          };

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
            return Boolean(
              firstNonEmpty(runtimeValues.antiContent, settings.temuAntiContent)
            );
          }

          async function generateTemuAntiContent() {
            try {
              let webpackRequire = window.__webpack_require__;
              const chunkArray =
                window.webpackChunktemu_sca_container ||
                self.webpackChunktemu_sca_container;

              if (typeof webpackRequire !== "function" && Array.isArray(chunkArray)) {
                chunkArray.push([
                  [Math.floor(Math.random() * 1000000000)],
                  {},
                  (require) => {
                    webpackRequire = require;
                  }
                ]);
              }

              if (typeof webpackRequire !== "function") {
                return "";
              }

              const riskModule = webpackRequire(65531);
              if (typeof riskModule?.cN === "function") {
                return await riskModule.cN();
              }

              if (typeof riskModule?.xy === "function") {
                return riskModule.xy();
              }
            } catch (_error) {
              return "";
            }

            return "";
          }

          function readTemuRuntimeValues(generatedAntiContent) {
            const search = new URLSearchParams(location.search);
            return {
              mallId:
                search.get("mallId") ||
                search.get("mallid") ||
                findStorageValue(/mall.?id/i),
              antiContent:
                generatedAntiContent ||
                findStorageValue(/anti.?content/i),
              csrfToken:
                readCookie("csrfToken") ||
                readCookie("_csrf") ||
                findMetaContent(/csrf/i) ||
                findStorageValue(/csrf|token/i)
            };
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

          function compactText(text) {
            return String(text || "").replace(/\s+/g, " ").trim();
          }
        }
      },
      (results) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: `无法在 Temu 页面执行请求：${chrome.runtime.lastError.message}`
          });
          return;
        }

        resolve(results?.[0]?.result || null);
      }
    );
  });
}
