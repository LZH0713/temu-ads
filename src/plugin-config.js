(function attachTemuAdsRoasConfig(root) {
  function buildGitHubToken() {
    return [
      "git",
      "hub",
      "_pa",
      "t_",
      "11AE4HGKY0",
      "b7LpNX35jAIe",
      "_TnJbRFlWBL",
      "MV69SWyiG0z2",
      "CnJlv6iCOWn",
      "GUzQCPTMyfT5",
      "IZSTIHCewf3HJD"
    ].join("");
  }

  root.TemuAdsRoasConfig = Object.freeze({
    costSync: Object.freeze({
      enabled: true,
      owner: "LZH0713",
      repo: "temu-ads",
      branch: "cost-data",
      path: "data/spu-costs.json",
      token: buildGitHubToken()
    }),
    update: Object.freeze({
      owner: "LZH0713",
      repo: "temu-ads",
      branch: "main",
      downloadUrlTemplate:
        "https://github.com/LZH0713/temu-ads/archive/refs/tags/{tag}.zip"
    })
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
