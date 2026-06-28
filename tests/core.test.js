const assert = require("node:assert/strict");

const TemuPrice = require("../src/temu-price");
const TemuRoas = require("../src/roas");
require("../src/plugin-config");
const TemuCostSync = require("../src/cost-sync");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("normalizes ongoing minimum activity price by product ID", () => {
  const prices = TemuPrice.normalizeTemuEnrollPrices(
    {
      result: {
        list: [
          {
            productId: 9401217708,
            sessionStatus: 2,
            skcList: [
              {
                skuList: [
                  { activityPrice: 12711 },
                  { activityPrice: "11,700" }
                ]
              }
            ]
          },
          {
            productId: 9401217708,
            sessionStatus: 1,
            skcList: [{ skuList: [{ activityPrice: 9900 }] }]
          }
        ]
      }
    },
    ["9401217708"]
  );

  assert.deepEqual(prices, {
    9401217708: 117
  });
});

test("ignores enroll prices when all assigned sessions have ended", () => {
  const prices = TemuPrice.normalizeTemuEnrollPrices(
    {
      result: {
        list: [
          {
            productId: 5139109387,
            sessionStatus: 2,
            assignSessionList: [{ sessionStatus: 3 }],
            skcList: [{ skuList: [{ activityPrice: 3180 }] }]
          },
          {
            productId: 5139109387,
            sessionStatus: 3,
            assignSessionList: [{ sessionStatus: 3 }],
            skcList: [{ skuList: [{ activityPrice: 2257 }] }]
          }
        ]
      }
    },
    ["5139109387"]
  );

  assert.deepEqual(prices, {});
});

test("uses enroll prices when any assigned session is ongoing", () => {
  const prices = TemuPrice.normalizeTemuEnrollPrices(
    {
      result: {
        list: [
          {
            productId: 5139109387,
            sessionStatus: 2,
            assignSessionList: [{ sessionStatus: 3 }, { sessionStatus: 2 }],
            skcList: [{ skuList: [{ activityPrice: 3180 }] }]
          }
        ]
      }
    },
    ["5139109387"]
  );

  assert.deepEqual(prices, {
    5139109387: 31.8
  });
});

test("ignores clearance sale prices but keeps them as a note", () => {
  const payload = {
    result: {
      list: [
        {
          productId: 4624817620,
          sessionStatus: 2,
          activityType: 27,
          activityName: "清仓甩卖",
          activityLabel: "退件散货",
          skcList: [{ skuList: [{ activityPrice: 6688 }] }]
        },
        {
          productId: 4624817620,
          sessionStatus: 2,
          activityType: 8,
          activityName: "官方大促",
          skcList: [{ skuList: [{ activityPrice: 9823 }] }]
        }
      ]
    }
  };

  assert.deepEqual(
    TemuPrice.normalizeTemuEnrollPrices(payload, ["4624817620"]),
    {
      4624817620: 98.23
    }
  );

  assert.deepEqual(
    TemuPrice.normalizeTemuEnrollPriceStates(payload, ["4624817620"]),
    {
      4624817620: {
        price: 98.23,
        ignoredClearance: {
          price: 66.88,
          label: "退件散货",
          activityName: "清仓甩卖"
        }
      }
    }
  );
});

test("can include non-ongoing sessions when configured", () => {
  const prices = TemuPrice.normalizeTemuEnrollPrices(
    {
      data: {
        list: [
          {
            spuId: "123456789",
            sessionStatus: 1,
            skcList: [{ skuList: [{ activityPrice: 8800 }] }]
          }
        ]
      }
    },
    ["123456789"],
    { onlyOngoing: false }
  );

  assert.deepEqual(prices, {
    123456789: 88
  });
});

test("readList ignores malformed list payloads", () => {
  assert.deepEqual(TemuPrice.readList({ result: { list: {} } }), []);
  assert.deepEqual(TemuPrice.readList([null, { productId: 1 }]), [
    { productId: 1 }
  ]);
});

test("toProductIds keeps unsafe numeric IDs as strings", () => {
  assert.deepEqual(TemuPrice.toProductIds(["12345", "9007199254740993"]), [
    12345,
    "9007199254740993"
  ]);
});

test("builds Temu request headers from settings and runtime values", () => {
  assert.deepEqual(
    TemuPrice.buildTemuHeaders(
      { temuMallId: "configured-mall", temuAntiContent: "configured-anti" },
      { mallId: "runtime-mall", antiContent: "runtime-anti", csrfToken: "csrf" }
    ),
    {
      accept: "*/*",
      "cache-control": "no-cache",
      "content-type": "application/json",
      pragma: "no-cache",
      mallid: "runtime-mall",
      "anti-content": "runtime-anti",
      "x-csrf-token": "csrf"
    }
  );
});

test("detects configured or runtime anti-content", () => {
  assert.equal(TemuPrice.hasTemuAntiContent({}, {}), false);
  assert.equal(
    TemuPrice.hasTemuAntiContent(
      { temuAntiContent: "" },
      { antiContent: "runtime-anti" }
    ),
    true
  );
  assert.equal(
    TemuPrice.hasTemuAntiContent(
      { temuAntiContent: "configured-anti" },
      { antiContent: "" }
    ),
    true
  );
});

test("calculates break-even ROAS and status", () => {
  assert.deepEqual(TemuRoas.calculateBreakEven(117, 80, 4), {
    breakEvenRoas: 117 / 37,
    message: "达标",
    statusClass: "is-good"
  });

  assert.equal(TemuRoas.calculateBreakEven(117, 117, 4).message, "成本过高");
  assert.equal(TemuRoas.calculateBreakEven(null, 80, 4).message, "缺价格");
});

test("calculates gross profit", () => {
  assert.equal(TemuRoas.calculateGrossProfit(117, 80, 10), 25.3);
  assert.equal(TemuRoas.calculateGrossProfit(null, 80, 10), null);
  assert.equal(TemuRoas.calculateGrossProfit(117, null, 10), null);
  assert.equal(TemuRoas.calculateGrossProfit(117, 80, null), null);
});

test("uses declared price when activity price is unavailable", () => {
  assert.deepEqual(
    TemuRoas.resolveCalculationPrice({ price: 98.23 }, 111.48),
    {
      price: 98.23,
      source: "activity"
    }
  );

  assert.deepEqual(
    TemuRoas.resolveCalculationPrice({ noActivity: true }, 118.79),
    {
      price: 118.79,
      source: "declared"
    }
  );

  assert.deepEqual(TemuRoas.resolveCalculationPrice({ noActivity: true }, ""), {
    price: null,
    source: "declared-missing"
  });
});

test("normalizes and merges SPU cost maps", () => {
  assert.deepEqual(
    TemuCostSync.normalizeCostMap({
      " 200 ": "18.5",
      100: 12,
      bad: "x"
    }),
    {
      100: 12,
      200: 18.5
    }
  );

  assert.deepEqual(
    TemuCostSync.mergeCostMaps({ 100: 12, 300: 7 }, { 100: 13, 200: 8 }),
    {
      100: 13,
      200: 8,
      300: 7
    }
  );
});

test("preserves dirty local SPU costs when pulling remote costs", () => {
  assert.deepEqual(
    TemuCostSync.normalizeDirtySpuIds([" 100 ", 200, "", 100]),
    ["100", "200"]
  );

  assert.deepEqual(
    TemuCostSync.mergeCostMapsPreservingDirty(
      { 100: 14, 300: 7 },
      { 100: 13, 200: 8, 300: 9 },
      ["100"]
    ),
    {
      100: 14,
      200: 8,
      300: 9
    }
  );

  assert.deepEqual(
    TemuCostSync.mergeCostMapsPreservingDirty(
      { 300: 7 },
      { 100: 13, 300: 9 },
      ["100"]
    ),
    {
      300: 9
    }
  );
});

test("forces plugin cost sync config over stored settings", () => {
  const normalized = TemuCostSync.normalizeSettings({
    costSyncEnabled: false,
    costSyncOwner: "other-owner",
    costSyncRepo: "other-repo",
    costSyncBranch: "dev",
    costSyncPath: "/tmp/costs.json",
    costSyncToken: "stored-token"
  });

  assert.deepEqual(
    {
      ...normalized,
      costSyncToken: normalized.costSyncToken ? "<configured>" : ""
    },
    {
      costSyncEnabled: true,
      costSyncOwner: "LZH0713",
      costSyncRepo: "temu-ads",
      costSyncBranch: "cost-data",
      costSyncPath: "data/spu-costs.json",
      costSyncToken: "<configured>"
    }
  );
});

test("uses local GitHub token before plugin cost sync token", () => {
  const configuredToken = global.TemuAdsRoasConfig.costSync.token;

  assert.equal(
    TemuCostSync.resolveGitHubToken(
      { costSyncToken: "plugin-token" },
      "local-token"
    ),
    "local-token"
  );

  assert.equal(
    TemuCostSync.resolveGitHubToken({ costSyncToken: "plugin-token" }),
    configuredToken
  );
});

test("keeps update checks on the main code branch", () => {
  assert.deepEqual(TemuCostSync.getUpdateSettings(), {
    updateOwner: "LZH0713",
    updateRepo: "temu-ads",
    updateBranch: "main",
    downloadUrl: "",
    downloadUrlTemplate:
      "https://github.com/LZH0713/temu-ads/archive/refs/tags/{tag}.zip"
  });
});

test("parses cost sync file payloads", () => {
  assert.deepEqual(
    TemuCostSync.parseCostFile({
      version: 1,
      costBySpu: {
        5139109387: "31.8"
      }
    }),
    {
      5139109387: 31.8
    }
  );
});

test("compares remote extension versions", () => {
  assert.equal(TemuCostSync.compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(TemuCostSync.compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(TemuCostSync.compareVersions("0.1.9", "0.2.0"), -1);
});

for (const { name, fn } of tests) {
  fn();
  console.log(`ok - ${name}`);
}
