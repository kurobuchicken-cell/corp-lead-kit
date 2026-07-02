'use strict';

// claude-haiku-4-5 の標準価格（USD / 1Mトークン）とWeb検索ツールの単価（2026-07時点、公式pricingページ準拠）。
const HAIKU_PRICE_PER_MTOK = { input: 1.0, output: 5.0 };
const WEB_SEARCH_PRICE_PER_1000 = 10.0;

function usdToJpy(usd, rate = Number(process.env.USD_JPY_RATE) || 150) {
  return usd * rate;
}

function calcCostJpy(usage, rate) {
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const webSearchRequests = usage?.server_tool_use?.web_search_requests || 0;
  const usd =
    (inputTokens / 1e6) * HAIKU_PRICE_PER_MTOK.input +
    (outputTokens / 1e6) * HAIKU_PRICE_PER_MTOK.output +
    (webSearchRequests / 1000) * WEB_SEARCH_PRICE_PER_1000;
  return usdToJpy(usd, rate);
}

// M2実行中のコストを合算するための集計器（M4のcreateBudgetTrackerと同じ発想）。
function createCostTracker() {
  let spentJpy = 0;
  return {
    add(usage) {
      const costJpy = calcCostJpy(usage);
      spentJpy += costJpy;
      return costJpy;
    },
    get spentJpy() {
      return spentJpy;
    },
  };
}

module.exports = { calcCostJpy, createCostTracker, HAIKU_PRICE_PER_MTOK, WEB_SEARCH_PRICE_PER_1000 };
