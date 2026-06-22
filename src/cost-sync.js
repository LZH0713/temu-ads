(function attachTemuCostSync(root) {
  const DEFAULT_COST_SYNC_SETTINGS = {
    costSyncEnabled: true,
    costSyncOwner: "LZH0713",
    costSyncRepo: "temu-ads",
    costSyncBranch: "cost-data",
    costSyncPath: "data/spu-costs.json"
  };

  function normalizeCostMap(costBySpu = {}) {
    const normalized = {};
    for (const [rawSpuId, rawCost] of Object.entries(costBySpu || {})) {
      const spuId = String(rawSpuId || "").trim();
      const cost = Number(rawCost);
      if (!spuId || !Number.isFinite(cost)) {
        continue;
      }

      normalized[spuId] = cost;
    }

    return sortCostMap(normalized);
  }

  function mergeCostMaps(baseCostBySpu = {}, overrideCostBySpu = {}) {
    return sortCostMap({
      ...normalizeCostMap(baseCostBySpu),
      ...normalizeCostMap(overrideCostBySpu)
    });
  }

  function mergeCostMapsPreservingDirty(
    localCostBySpu = {},
    remoteCostBySpu = {},
    dirtySpuIds = []
  ) {
    const local = normalizeCostMap(localCostBySpu);
    const merged = mergeCostMaps(local, remoteCostBySpu);

    for (const spuId of normalizeDirtySpuIds(dirtySpuIds)) {
      if (Object.prototype.hasOwnProperty.call(local, spuId)) {
        merged[spuId] = local[spuId];
      } else {
        delete merged[spuId];
      }
    }

    return sortCostMap(merged);
  }

  function normalizeDirtySpuIds(spuIds = []) {
    const values = Array.isArray(spuIds) ? spuIds : Object.keys(spuIds || {});
    return [...new Set(values.map((spuId) => String(spuId || "").trim()))]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  function buildCostFile(costBySpu = {}) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      costBySpu: normalizeCostMap(costBySpu)
    };
  }

  function parseCostFile(payload) {
    if (!payload || typeof payload !== "object") {
      return {};
    }

    return normalizeCostMap(payload.costBySpu || payload);
  }

  async function pullCostMap(settings = {}, token = "") {
    const remote = await readRemoteCostFile(settings, token);
    return {
      costBySpu: parseCostFile(remote.json),
      sha: remote.sha
    };
  }

  async function pushCostMap(
    settings = {},
    token = "",
    costBySpu = {},
    options = {}
  ) {
    const remote = await readRemoteCostFile(settings, token);
    const mergedCostBySpu = mergeCostMaps(parseCostFile(remote.json), costBySpu);
    for (const spuId of normalizeDirtySpuIds(options.deletedSpuIds)) {
      delete mergedCostBySpu[spuId];
    }

    const file = buildCostFile(mergedCostBySpu);
    const config = normalizeSettings(settings);
    const response = await fetch(buildContentsUrl(config), {
      method: "PUT",
      headers: buildGitHubHeaders(token),
      body: JSON.stringify({
        branch: config.costSyncBranch,
        message: "Update SPU costs",
        content: encodeBase64(JSON.stringify(file, null, 2) + "\n"),
        sha: remote.sha || undefined
      })
    });

    if (!response.ok) {
      throw new Error(await formatGitHubError(response));
    }

    const payload = await response.json();
    return {
      costBySpu: mergedCostBySpu,
      sha: payload?.content?.sha || ""
    };
  }

  async function readRemoteCostFile(settings = {}, token = "") {
    const config = normalizeSettings(settings);
    return readRemoteJsonFile(config, token, config.costSyncPath, {
      allowMissing: true
    });
  }

  async function checkRemoteVersion(settings = {}, token = "", localVersion = "") {
    const updateSettings = getUpdateSettings(settings);
    const remote = await readRemoteJsonFile(settings, token, "manifest.json", {
      owner: updateSettings.updateOwner,
      repo: updateSettings.updateRepo,
      branch: updateSettings.updateBranch
    });
    const remoteVersion = String(remote.json?.version || "");
    return {
      hasUpdate: compareVersions(remoteVersion, localVersion) > 0,
      localVersion: String(localVersion || ""),
      remoteVersion,
      sha: remote.sha
    };
  }

  async function readRemoteJsonFile(
    settings = {},
    token = "",
    path = "",
    options = {}
  ) {
    const baseConfig = normalizeSettings(settings);
    const config = {
      ...baseConfig,
      costSyncOwner: String(options.owner || baseConfig.costSyncOwner).trim(),
      costSyncRepo: String(options.repo || baseConfig.costSyncRepo).trim(),
      costSyncBranch: String(options.branch || baseConfig.costSyncBranch).trim()
    };
    const normalizedPath = String(path || "").trim().replace(/^\/+/, "");
    if (!config.costSyncOwner || !config.costSyncRepo || !normalizedPath) {
      throw new Error("远程仓库配置不完整");
    }

    const response = await fetch(
      `${buildContentsUrl(config, normalizedPath)}?ref=${encodeURIComponent(config.costSyncBranch)}`,
      {
        headers: buildGitHubHeaders(token)
      }
    );

    if (response.status === 404 && options.allowMissing) {
      return {
        json: {},
        sha: ""
      };
    }

    if (response.status === 404) {
      throw new Error(`远程文件不存在或 GitHub Token 无权限：${normalizedPath}`);
    }

    if (!response.ok) {
      throw new Error(await formatGitHubError(response));
    }

    const payload = await response.json();
    const content = String(payload?.content || "").replace(/\s/g, "");
    return {
      json: content ? JSON.parse(decodeBase64(content)) : {},
      sha: String(payload?.sha || "")
    };
  }

  function normalizeSettings(settings = {}) {
    const fixedSettings = getCostSyncSettings();
    const mergedSettings = {
      ...DEFAULT_COST_SYNC_SETTINGS,
      ...settings,
      ...fixedSettings
    };

    return {
      ...mergedSettings,
      costSyncEnabled: fixedSettings.costSyncEnabled !== false,
      costSyncOwner: String(mergedSettings.costSyncOwner).trim(),
      costSyncRepo: String(mergedSettings.costSyncRepo).trim(),
      costSyncBranch: String(mergedSettings.costSyncBranch).trim(),
      costSyncPath: String(mergedSettings.costSyncPath)
        .trim()
        .replace(/^\/+/, "")
    };
  }

  function getCostSyncSettings() {
    const config = root.TemuAdsRoasConfig?.costSync || {};

    return {
      costSyncEnabled: config.enabled !== false,
      costSyncOwner: String(config.owner || DEFAULT_COST_SYNC_SETTINGS.costSyncOwner).trim(),
      costSyncRepo: String(config.repo || DEFAULT_COST_SYNC_SETTINGS.costSyncRepo).trim(),
      costSyncBranch: String(config.branch || DEFAULT_COST_SYNC_SETTINGS.costSyncBranch).trim(),
      costSyncPath: String(config.path || DEFAULT_COST_SYNC_SETTINGS.costSyncPath)
        .trim()
        .replace(/^\/+/, "")
    };
  }

  function getUpdateSettings(settings = {}) {
    const config = root.TemuAdsRoasConfig?.update || {};
    const costSettings = getCostSyncSettings();

    return {
      updateOwner: String(
        config.owner || settings.costSyncOwner || costSettings.costSyncOwner
      ).trim(),
      updateRepo: String(
        config.repo || settings.costSyncRepo || costSettings.costSyncRepo
      ).trim(),
      updateBranch: String(config.branch || "main").trim(),
      downloadUrl: String(config.downloadUrl || "").trim(),
      downloadUrlTemplate: String(config.downloadUrlTemplate || "").trim()
    };
  }

  function compareVersions(leftVersion = "", rightVersion = "") {
    const leftParts = splitVersion(leftVersion);
    const rightParts = splitVersion(rightVersion);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const left = leftParts[index] || 0;
      const right = rightParts[index] || 0;
      if (left !== right) {
        return left > right ? 1 : -1;
      }
    }

    return 0;
  }

  function splitVersion(version) {
    return String(version || "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((part) => Number(part))
      .filter((part) => Number.isFinite(part));
  }

  function buildContentsUrl(settings, path = settings.costSyncPath) {
    return `https://api.github.com/repos/${encodeURIComponent(
      settings.costSyncOwner
    )}/${encodeURIComponent(settings.costSyncRepo)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  function buildGitHubHeaders(token = "") {
    const headers = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    };
    const trimmedToken = String(token || "").trim();
    if (trimmedToken) {
      headers.authorization = `Bearer ${trimmedToken}`;
    }

    return headers;
  }

  async function formatGitHubError(response) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.message || "";
    } catch (_error) {
      detail = "";
    }

    return detail
      ? `GitHub 同步失败：${response.status} ${detail}`
      : `GitHub 同步失败：${response.status}`;
  }

  function sortCostMap(costBySpu) {
    return Object.fromEntries(
      Object.entries(costBySpu).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    );
  }

  function encodeBase64(text) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(text, "utf8").toString("base64");
    }

    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  function decodeBase64(text) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(text, "base64").toString("utf8");
    }

    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  }

  const api = {
    DEFAULT_COST_SYNC_SETTINGS,
    buildCostFile,
    checkRemoteVersion,
    compareVersions,
    getCostSyncSettings,
    getUpdateSettings,
    mergeCostMaps,
    mergeCostMapsPreservingDirty,
    normalizeDirtySpuIds,
    normalizeCostMap,
    normalizeSettings,
    parseCostFile,
    pullCostMap,
    pushCostMap
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.TemuCostSync = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
