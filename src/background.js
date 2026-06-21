importScripts("temu-price.js");

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
  const relayResponse = await fetchTemuEnrollPricesViaAgentsellerTab(
    spuIds,
    settings
  );
  if (relayResponse) {
    return relayResponse;
  }

  return fetchTemuEnrollPricesDirect(spuIds, settings);
}

async function fetchTemuEnrollPricesViaAgentsellerTab(spuIds, settings) {
  const tabs = await tabsQuery({
    url: "https://agentseller.temu.com/*"
  });
  const tab = tabs.find((candidate) => candidate.id != null);
  if (!tab) {
    return null;
  }

  const pageResponse = await executeFetchInAgentsellerPage(
    tab.id,
    spuIds,
    settings
  );
  if (!pageResponse) {
    return null;
  }

  if (!pageResponse.ok) {
    return pageResponse;
  }

  return {
    ok: true,
    prices: globalThis.TemuPrice.normalizeTemuEnrollPrices(
      pageResponse.combined,
      spuIds,
      {
        onlyOngoing: settings.temuOnlyOngoing
      }
    )
  };
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
  const headers = {
    accept: "*/*",
    "content-type": "application/json"
  };

  if (settings.temuMallId) {
    headers.mallid = settings.temuMallId;
  }

  if (settings.temuAntiContent) {
    headers["anti-content"] = settings.temuAntiContent;
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
        error: `Temu 接口请求失败：${response.status}`
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
    prices: globalThis.TemuPrice.normalizeTemuEnrollPrices(combined, spuIds, {
      onlyOngoing: settings.temuOnlyOngoing
    })
  };
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
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
          const headers = {
            accept: "*/*",
            "cache-control": "no-cache",
            "content-type": "application/json",
            pragma: "no-cache"
          };

          if (settings.temuMallId) {
            headers.mallid = settings.temuMallId;
          }

          if (settings.temuAntiContent) {
            headers["anti-content"] = settings.temuAntiContent;
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
                error: `Temu 接口请求失败：${response.status}`
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
        }
      },
      (results) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

        resolve(results?.[0]?.result || null);
      },
    );
  });
}
