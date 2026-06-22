(function attachTemuAdsRoasConfig(root) {
  root.TemuAdsRoasConfig = Object.freeze({
    costSync: Object.freeze({
      enabled: true,
      owner: "LZH0713",
      repo: "temu-ads",
      branch: "main",
      path: "data/spu-costs.json"
    }),
    update: Object.freeze({
      downloadUrl:
        "https://github.com/LZH0713/temu-ads/archive/refs/heads/main.zip"
    })
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
