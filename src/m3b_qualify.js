'use strict';

const pLimit = require('p-limit');

const { openDb, updateEnrichment, DEFAULT_DB_PATH } = require('./lib/db');
const { fetchPageWithFallback } = require('./lib/scrape');
const { createClient, checkOptOut, qualifyFromPage, findPainHint } = require('./lib/ai');
const { createCostTracker } = require('./lib/cost');

const DEFAULT_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS) || 3000;
const DEFAULT_CONCURRENCY = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPacer(delayMs) {
  let chain = Promise.resolve();
  let last = 0;
  return function pace() {
    chain = chain.then(async () => {
      const wait = Math.max(0, last + delayMs - Date.now());
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    return chain;
  };
}

// mail_ready/call_list（メアドまたはフォームが見つかった会社）だけを対象に、サイト本文を読み直し
// ①コンプラ判定（軽量・お断り表示の有無のみ）→ 通過した会社だけ②業務内容確認（事業内容・業種・
// 痛みの手がかり）という2段構成で行う。①をお断り対象で打ち切ることで②（コストが高い）を省ける上、
// ②が3項目に絞られることでpain_hintの抽出精度も上がる想定。ここまでの結果＝営業リスト。
async function qualifyOne(company, ctx) {
  let page;
  try {
    page = await ctx.fetchPage(company.website_url, { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs });
  } catch (err) {
    // 一時的な取得失敗はstatusを変えず、再実行でリトライ可能にする。
    return updateEnrichment(ctx.db, company.id, { exclude_reason: `qualify_fetch_error: ${err.message}` });
  }

  const optOutResult = await ctx.checkOptOut(ctx.client, {
    name: company.name,
    text: page.text,
    onUsage: (usage) => ctx.costTracker.add(usage),
  });

  if (optOutResult.optOut) {
    return updateEnrichment(ctx.db, company.id, { status: 'excluded', exclude_reason: 'optout_notice' });
  }

  const result = await ctx.qualify(ctx.client, {
    name: company.name,
    text: page.text,
    onUsage: (usage) => ctx.costTracker.add(usage),
  });

  // ②でpain_hintが取れなかった会社だけ、専用の呼び出しでもう一度だけ探す（フォールバック）。
  // 同じ情報源に別角度で聞き直すことでヒット率が底上げされる（実測：14社中2件→3件）一方、
  // 既にヒットした会社には無駄打ちしないため、null時のみ追加コストが発生する設計。
  let painHint = result.pain_hint;
  if (!painHint) {
    const fallback = await ctx.findPainHint(ctx.client, {
      name: company.name,
      text: page.text,
      onUsage: (usage) => ctx.costTracker.add(usage),
    });
    painHint = fallback.hint;
  }

  return updateEnrichment(ctx.db, company.id, {
    status: 'qualified',
    business_summary: result.business_summary,
    industry: result.industry,
    pain_hint: painHint,
    exclude_reason: null,
  });
}

async function qualifyCompanies(companies, options = {}) {
  const {
    dbPath = DEFAULT_DB_PATH,
    delayMs = DEFAULT_DELAY_MS,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = 15000,
    anthropicApiKey = process.env.ANTHROPIC_API_KEY,
    client,
    checkOptOut: checkOptOutFn = checkOptOut,
    qualify = qualifyFromPage,
    findPainHint: findPainHintFn = findPainHint,
    fetchPage = fetchPageWithFallback,
    fetchImpl,
    progressEvery = 50,
  } = options;

  const needsAiClient =
    checkOptOutFn === checkOptOut || qualify === qualifyFromPage || findPainHintFn === findPainHint;
  const resolvedClient = client || (needsAiClient ? createClient(anthropicApiKey) : undefined);

  const costTracker = options.costTracker || createCostTracker();
  const db = openDb(dbPath);
  const ctx = {
    db,
    client: resolvedClient,
    checkOptOut: checkOptOutFn,
    qualify,
    findPainHint: findPainHintFn,
    fetchPage,
    fetchImpl,
    timeoutMs,
    costTracker,
    pace: createPacer(delayMs),
  };

  const limit = pLimit(concurrency);
  let completed = 0;
  try {
    const results = await Promise.all(
      companies.map((company) =>
        limit(async () => {
          await ctx.pace();
          const result = await qualifyOne(company, ctx);
          completed += 1;
          if (progressEvery && completed % progressEvery === 0) {
            console.log(
              `[qualify進捗] ${completed}/${companies.length}社 完了・累計コスト 約¥${Math.round(costTracker.spentJpy)}`
            );
          }
          return result;
        })
      )
    );
    results.costJpy = costTracker.spentJpy;
    results.costBreakdown = {
      tokenJpy: costTracker.tokenJpy,
      searchJpy: costTracker.searchJpy,
      searchCount: costTracker.searchCount,
      callCount: costTracker.callCount,
    };
    return results;
  } finally {
    db.close();
  }
}

module.exports = { qualifyCompanies };
