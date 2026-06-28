const DEFAULT_SYNC_SETTINGS = {
  enabled: true,
  temuMallId: "",
  temuAntiContent: "",
  temuOnlyOngoing: true,
  ...globalThis.TemuCostSync.getCostSyncSettings(),
  defaultCost: "80",
  rowSelector: "",
  spuSelector: "",
  targetRoasSelector: ""
};

const DEFAULT_LOCAL_STATE = {
  costBySpu: {},
  costSyncDirtySpuIds: [],
  costSyncLastError: "",
  costSyncToken: "",
  costSyncLastPullAt: 0,
  costSyncLastPushAt: 0,
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
  checkUpdate: document.getElementById("checkUpdate"),
  status: document.getElementById("status")
};

document.addEventListener("DOMContentLoaded", loadForm);
elements.save.addEventListener("click", saveForm);
elements.scan.addEventListener("click", scanActiveTab);
elements.checkUpdate.addEventListener("click", () =>
  checkRemoteUpdate({ silentLatest: false })
);

async function loadForm() {
  const [storedSettings, localState] = await Promise.all([
    storageGet("sync", DEFAULT_SYNC_SETTINGS),
    storageGet("local", DEFAULT_LOCAL_STATE)
  ]);
  const settings = normalizePopupSettings(storedSettings);

  elements.enabled.checked = Boolean(settings.enabled);
  elements.temuMallId.value = settings.temuMallId || "";
  elements.temuAntiContent.value = settings.temuAntiContent || "";
  elements.temuOnlyOngoing.checked = settings.temuOnlyOngoing !== false;
  elements.defaultCost.value = settings.defaultCost || "80";
  elements.rowSelector.value = settings.rowSelector || "";
  elements.spuSelector.value = settings.spuSelector || "";
  elements.targetRoasSelector.value = settings.targetRoasSelector || "";
  elements.costBySpu.value = serializeCostMap(localState.costBySpu || {});

  if (settings.costSyncEnabled && getCostSyncToken(settings, localState)) {
    await pullRemoteCostsFromForm(false);
  } else if (settings.costSyncEnabled) {
    setStatus("成本同步已开启；自动推送缺少 GitHub Token");
  } else {
    showCostSyncStatus(localState);
  }

  await checkRemoteUpdate({ silentLatest: true });
}

async function saveForm() {
  const settings = readSettingsFromForm();

  await storageSet("sync", settings);

  await scanActiveTab(false);
  setStatus("已保存");
}

async function pullRemoteCostsFromForm(showStatus = true) {
  const settings = readSettingsFromForm();
  const localState = await storageGet("local", DEFAULT_LOCAL_STATE);
  const token = getCostSyncToken(settings, localState);
  if (!settings.costSyncEnabled) {
    setStatus("请先开启成本同步", true);
    return;
  }

  try {
    if (showStatus) {
      setStatus("正在拉取远程成本...");
    }
    const dirtySpuIds = globalThis.TemuCostSync.normalizeDirtySpuIds(
      localState.costSyncDirtySpuIds
    );
    const pulled = await globalThis.TemuCostSync.pullCostMap(settings, token);
    const costBySpu = globalThis.TemuCostSync.mergeCostMapsPreservingDirty(
      localState.costBySpu,
      pulled.costBySpu,
      dirtySpuIds
    );
    elements.costBySpu.value = serializeCostMap(costBySpu);
    await Promise.all([
      storageSet("sync", settings),
      storageSet("local", {
        costBySpu,
        costSyncDirtySpuIds: dirtySpuIds,
        costSyncLastPullAt: Date.now()
      })
    ]);
    await scanActiveTab(false);
    setStatus(buildPullStatus(pulled.costBySpu, dirtySpuIds));
  } catch (error) {
    setStatus(error?.message || "拉取远程成本失败", true);
  }
}

async function checkRemoteUpdate(options = {}) {
  const settings = readSettingsFromForm();
  const localState = await storageGet("local", DEFAULT_LOCAL_STATE);
  const token = getCostSyncToken(settings, localState);
  try {
    if (!options.silentLatest) {
      setStatus("正在检查插件更新...");
    }
    const result = await globalThis.TemuCostSync.checkRemoteVersion(
      settings,
      token,
      chrome.runtime.getManifest().version
    );

    if (!result.remoteVersion) {
      setStatus("远程 manifest.json 未返回版本号", true);
      return;
    }

    if (result.hasUpdate) {
      setStatus(buildUpdateStatus(result));
      return;
    }

    if (!options.silentLatest) {
      setStatus(`当前已是最新版本 ${result.localVersion}`);
    }
  } catch (error) {
    setStatus(error?.message || "检查插件更新失败", true);
  }
}

function buildUpdateStatus(result) {
  const downloadUrl = buildVersionDownloadUrl(result.remoteVersion);

  return [
    `发现新版 ${result.remoteVersion}，当前 ${result.localVersion}`,
    `下载：${downloadUrl}`,
    "安装：下载后解压 ZIP，在 chrome://extensions/ 开启开发者模式，点“加载已解压的扩展程序”，选择解压后的 temu-ads-* 文件夹。",
    "已安装过：用新版文件夹替换旧文件夹后，在本插件卡片点“重新加载”。"
  ].join("\n");
}

function buildVersionDownloadUrl(version) {
  const tag = `v${version}`;
  const updateConfig = globalThis.TemuAdsRoasConfig?.update || {};
  const template =
    updateConfig.downloadUrlTemplate ||
    updateConfig.downloadUrl ||
    "https://github.com/LZH0713/temu-ads/archive/refs/tags/{tag}.zip";

  return template
    .replaceAll("{version}", String(version || ""))
    .replaceAll("{tag}", tag);
}

function buildPullStatus(remoteCostBySpu, dirtySpuIds) {
  const remoteCount = Object.keys(remoteCostBySpu || {}).length;
  const dirtyCount = dirtySpuIds.length;
  if (!dirtyCount) {
    return `已拉取 ${remoteCount} 条远程成本`;
  }

  return `已拉取 ${remoteCount} 条远程成本，保留 ${dirtyCount} 条本地未同步成本`;
}

function showCostSyncStatus(localState) {
  if (localState.costSyncLastError) {
    setStatus(`成本同步失败：${localState.costSyncLastError}`, true);
    return;
  }

  if (localState.costSyncLastPushAt) {
    setStatus(`成本已同步：${formatTime(localState.costSyncLastPushAt)}`);
  }
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp) || 0);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function readSettingsFromForm() {
  return normalizePopupSettings({
    enabled: elements.enabled.checked,
    temuMallId: elements.temuMallId.value.trim(),
    temuAntiContent: elements.temuAntiContent.value.trim(),
    temuOnlyOngoing: elements.temuOnlyOngoing.checked,
    defaultCost: elements.defaultCost.value.trim() || "80",
    rowSelector: elements.rowSelector.value.trim(),
    spuSelector: elements.spuSelector.value.trim(),
    targetRoasSelector: elements.targetRoasSelector.value.trim()
  });
}

function normalizePopupSettings(settings = {}) {
  return {
    ...DEFAULT_SYNC_SETTINGS,
    ...settings,
    ...globalThis.TemuCostSync.getCostSyncSettings()
  };
}

function getCostSyncToken(settings, localState = {}) {
  return globalThis.TemuCostSync.resolveGitHubToken(
    settings,
    localState.costSyncToken
  );
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
