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

const elements = {
  enabled: document.getElementById("enabled"),
  temuMallId: document.getElementById("temuMallId"),
  temuAntiContent: document.getElementById("temuAntiContent"),
  temuOnlyOngoing: document.getElementById("temuOnlyOngoing"),
  defaultCost: document.getElementById("defaultCost"),
  rowSelector: document.getElementById("rowSelector"),
  spuSelector: document.getElementById("spuSelector"),
  targetRoasSelector: document.getElementById("targetRoasSelector"),
  costBySpu: document.getElementById("costBySpu"),
  save: document.getElementById("save"),
  scan: document.getElementById("scan"),
  status: document.getElementById("status")
};

document.addEventListener("DOMContentLoaded", loadForm);
elements.save.addEventListener("click", saveForm);
elements.scan.addEventListener("click", scanActiveTab);

async function loadForm() {
  const [settings, localState] = await Promise.all([
    storageGet("sync", DEFAULT_SYNC_SETTINGS),
    storageGet("local", DEFAULT_LOCAL_STATE)
  ]);

  elements.enabled.checked = Boolean(settings.enabled);
  elements.temuMallId.value = settings.temuMallId || "";
  elements.temuAntiContent.value = settings.temuAntiContent || "";
  elements.temuOnlyOngoing.checked = settings.temuOnlyOngoing !== false;
  elements.defaultCost.value = settings.defaultCost || "80";
  elements.rowSelector.value = settings.rowSelector || "";
  elements.spuSelector.value = settings.spuSelector || "";
  elements.targetRoasSelector.value = settings.targetRoasSelector || "";
  elements.costBySpu.value = serializeCostMap(localState.costBySpu || {});
}

async function saveForm() {
  const settings = {
    enabled: elements.enabled.checked,
    temuMallId: elements.temuMallId.value.trim(),
    temuAntiContent: elements.temuAntiContent.value.trim(),
    temuOnlyOngoing: elements.temuOnlyOngoing.checked,
    defaultCost: elements.defaultCost.value.trim() || "80",
    rowSelector: elements.rowSelector.value.trim(),
    spuSelector: elements.spuSelector.value.trim(),
    targetRoasSelector: elements.targetRoasSelector.value.trim()
  };

  const costBySpu = parseCostMap(elements.costBySpu.value);

  await Promise.all([
    storageSet("sync", settings),
    storageSet("local", { costBySpu })
  ]);

  await scanActiveTab(false);
  setStatus("已保存");
}

async function scanActiveTab(showStatus = true) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    if (showStatus) {
      setStatus("没有可扫描的当前标签页", true);
    }
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "TEMU_ROAS_SCAN" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus("当前页面未加载内容脚本，请刷新页面后重试", true);
      return;
    }

    if (!response?.ok) {
      setStatus("扫描失败", true);
      return;
    }

    if (showStatus) {
      setStatus("已触发扫描");
    }
  });
}

function parseCostMap(text) {
  const result = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [spuId, rawCost] = trimmed.split(/[=,，\s]+/);
    const cost = Number(rawCost);
    if (!spuId || !Number.isFinite(cost)) {
      continue;
    }

    result[spuId] = cost;
  }

  return result;
}

function serializeCostMap(costBySpu) {
  return Object.entries(costBySpu)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([spuId, cost]) => `${spuId}=${cost}`)
    .join("\n");
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
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
