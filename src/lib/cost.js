'use strict';

// claude-haiku-4-5 の標準価格（USD / 1Mトークン）とWeb検索ツールの単価（2026-07時点、公式pricingページ準拠）。
const HAIKU_PRICE_PER_MTOK = { input: 1.0, output: 5.0 };
const WEB_SEARCH_PRICE_PER_1000 = 10.0;

function usdToJpy(usd, rate = Number(process.env.USD_JPY_RATE) || 150) {
  return usd * rate;
}

function tokenCostJpy(usage, rate) {
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const usd = (inputTokens / 1e6) * HAIKU_PRICE_PER_MTOK.input + (outputTokens / 1e6) * HAIKU_PRICE_PER_MTOK.output;
  return usdToJpy(usd, rate);
}

function searchCostJpy(usage, rate) {
  const webSearchRequests = usage?.server_tool_use?.web_search_requests || 0;
  const usd = (webSearchRequests / 1000) * WEB_SEARCH_PRICE_PER_1000;
  return usdToJpy(usd, rate);
}

function calcCostJpy(usage, rate) {
  return tokenCostJpy(usage, rate) + searchCostJpy(usage, rate);
}

// M2実行中のコストを合算するための集計器（M4のcreateBudgetTrackerと同じ発想）。
// 「トークン由来」と「Web検索由来」を分けて見えるようにし、どちらが支配的かを診断できるようにする。
function createCostTracker() {
  let tokenJpy = 0;
  let searchJpy = 0;
  let searchCount = 0;
  let callCount = 0;
  return {
    add(usage) {
      const t = tokenCostJpy(usage);
      const s = searchCostJpy(usage);
      tokenJpy += t;
      searchJpy += s;
      searchCount += usage?.server_tool_use?.web_search_requests || 0;
      callCount += 1;
      return t + s;
    },
    get spentJpy() {
      return tokenJpy + searchJpy;
    },
    get tokenJpy() {
      return tokenJpy;
    },
    get searchJpy() {
      return searchJpy;
    },
    get searchCount() {
      return searchCount;
    },
    get callCount() {
      return callCount;
    },
  };
}

module.exports = { calcCostJpy, tokenCostJpy, searchCostJpy, createCostTracker, HAIKU_PRICE_PER_MTOK, WEB_SEARCH_PRICE_PER_1000 };
