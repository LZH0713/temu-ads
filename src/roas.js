(function attachTemuRoas(root) {
  function calculateBreakEven(price, cost, targetRoas) {
    if (price == null) {
      return {
        message: "缺价格",
        statusClass: "is-pending"
      };
    }

    if (cost == null) {
      return {
        message: "填成本",
        statusClass: "is-pending"
      };
    }

    const breakEvenAdCost = price - cost;
    if (breakEvenAdCost <= 0) {
      return {
        message: "成本过高",
        statusClass: "is-danger",
        detail: "成本价必须低于最低活动价"
      };
    }

    const breakEvenRoas = price / breakEvenAdCost;
    if (targetRoas == null) {
      return {
        breakEvenRoas,
        message: "填目标",
        statusClass: "is-pending"
      };
    }

    if (targetRoas > breakEvenRoas) {
      return {
        breakEvenRoas,
        message: "达标",
        statusClass: "is-good"
      };
    }

    return {
      breakEvenRoas,
      message: "偏低",
      statusClass: "is-danger"
    };
  }

  function calculateGrossProfit(price, cost, targetRoas) {
    if (price == null || cost == null || targetRoas == null || targetRoas <= 0) {
      return null;
    }

    return price - cost - price / targetRoas;
  }

  function resolveCalculationPrice(priceState, declaredPrice) {
    if (typeof priceState === "number" && Number.isFinite(priceState)) {
      return {
        price: priceState,
        source: "activity"
      };
    }

    const activityPrice = Number(priceState?.price);
    if (Number.isFinite(activityPrice)) {
      return {
        price: activityPrice,
        source: "activity"
      };
    }

    const fallbackPrice =
      declaredPrice === "" || declaredPrice == null ? null : Number(declaredPrice);
    if (priceState?.noActivity && Number.isFinite(fallbackPrice)) {
      return {
        price: fallbackPrice,
        source: "declared"
      };
    }

    return {
      price: null,
      source: priceState?.noActivity ? "declared-missing" : "missing"
    };
  }

  const api = {
    calculateBreakEven,
    calculateGrossProfit,
    resolveCalculationPrice
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.TemuRoas = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
