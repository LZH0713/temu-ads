const assert = require("node:assert/strict");

const TemuPrice = require("../src/temu-price");
const TemuRoas = require("../src/roas");

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

test("calculates break-even ROAS and status", () => {
  assert.deepEqual(TemuRoas.calculateBreakEven(117, 80, 4), {
    breakEvenRoas: 117 / 37,
    message: "达标",
    statusClass: "is-good"
  });

  assert.equal(TemuRoas.calculateBreakEven(117, 117, 4).message, "成本过高");
  assert.equal(TemuRoas.calculateBreakEven(null, 80, 4).message, "缺价格");
});

test("uses declared price when activity price is unavailable", () => {
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

for (const { name, fn } of tests) {
  fn();
  console.log(`ok - ${name}`);
}
