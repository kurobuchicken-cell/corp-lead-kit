'use strict';

const pLimit = require('p-limit');

const { openDb, updateEnrichment, DEFAULT_DB_PATH } = require('./lib/db');
const { isAllowedByRobots, USER_AGENT_TOKEN } = require('./lib/robots');
const { fetchPageWithFallback, findContactLinks, extractEmails, extractPhoneNumbers, USER_AGENT } = require('./lib/scrape');
const { createClient, findOfficialWebsite } = require('./lib/ai');
const { createCostTracker } = require('./lib/cost');

const DEFAULT_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS) || 3000;
const DEFAULT_CONCURRENCY = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// concurrency>1でも「同一時刻に複数サイトへ一斉アクセスしない」よう、
// 呼び出し全体でdelayMs間隔を最低限あける直列ゲートを作る。
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

async function fetchPages(websiteUrl, ctx) {
  await ctx.pace();
  const top = await ctx.fetchPage(websiteUrl, { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs });
  const pages = [top];

  const links = ctx.findContactLinks(top.$, top.finalUrl, { limit: 1 });
  const extraUrl = links.find((l) => l !== top.finalUrl && l !== websiteUrl);
  if (extraUrl) {
    await ctx.pace();
    try {
      const extra = await ctx.fetchPage(extraUrl, { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs });
      pages.push(extra);
    } catch {
      // 追加ページ（会社概要等）が取れなくてもトップページの情報のみで続行する
    }
  }
  return pages;
}

async function enrichOne(company, ctx) {
  let websiteUrl = company.website_url;

  if (!websiteUrl) {
    websiteUrl = await ctx.findWebsite(ctx.client, {
      name: company.name,
      address: company.address,
      onUsage: (usage) => ctx.costTracker.add(usage),
    });
    if (!websiteUrl) {
      return updateEnrichment(ctx.db, company.id, {
        status: 'excluded',
        exclude_reason: 'website_not_found',
      });
    }
  }

  const allowed = await ctx.isAllowed(websiteUrl, { userAgentToken: USER_AGENT_TOKEN });
  if (!allowed) {
    return updateEnrichment(ctx.db, company.id, {
      website_url: websiteUrl,
      status: 'excluded',
      exclude_reason: 'robots_disallowed',
    });
  }

  let pages;
  try {
    pages = await fetchPages(websiteUrl, ctx);
  } catch (err) {
    // 一時的な取得失敗はexcludedにせずdiscoveredのまま残し、再実行でリトライ可能にする
    return updateEnrichment(ctx.db, company.id, {
      website_url: websiteUrl,
      exclude_reason: `fetch_error: ${err.message}`,
    });
  }

  const combinedText = pages.map((p) => p.text).join('\n\n');
  const combinedHtml = pages.map((p) => p.html).join('\n');
  const emails = ctx.extractEmails(`${combinedHtml}\n${combinedText}`);
  const phones = ctx.extractPhoneNumbers(`${combinedHtml}\n${combinedText}`);

  // 連絡先種別の判定はAIを使わず無料で行う（メアドの有無は正規表現、フォームの有無は
  // 「お問い合わせ」等のリンク検出で判定）。事業内容・業種・営業お断り判定・痛みの手がかりは
  // ここでは取得せず、メアド/フォームが見つかった会社だけを対象にした後段（qualifyCompanies）に委ねる。
  const email = emails[0] || null;
  const hasContactLink = ctx.findContactLinks(pages[0].$, pages[0].finalUrl, { limit: 1 }).length > 0;
  const contactType = email ? 'email' : hasContactLink ? 'form_only' : 'none';

  return updateEnrichment(ctx.db, company.id, {
    website_url: websiteUrl,
    email,
    phone: phones[0] || null,
    contact_type: contactType,
    status: 'enriched',
    exclude_reason: null,
  });
}

// companiesを巡回し email / business_summary / optout_notice を埋めてenrichedに更新する（M2）。
// robots.txtを尊重し、依頼元サイトへは最低delayMsの間隔をあけてアクセスする。
async function enrichSites(companies, options = {}) {
  const {
    dbPath = DEFAULT_DB_PATH,
    delayMs = DEFAULT_DELAY_MS,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = 15000,
    anthropicApiKey = process.env.ANTHROPIC_API_KEY,
    client,
    findWebsite = findOfficialWebsite,
    fetchPage = fetchPageWithFallback,
    isAllowed = isAllowedByRobots,
    fetchImpl,
    // 大量件数を回す際、完走を待たずに途中経過のコストを把握できるようにする（0で無効化）。
    progressEvery = 50,
  } = options;

  const needsAiClient = findWebsite === findOfficialWebsite;
  const resolvedClient = client || (needsAiClient ? createClient(anthropicApiKey) : undefined);

  const costTracker = options.costTracker || createCostTracker();
  const db = openDb(dbPath);
  const ctx = {
    db,
    client: resolvedClient,
    findWebsite,
    fetchPage,
    isAllowed,
    fetchImpl,
    timeoutMs,
    findContactLinks,
    extractEmails,
    extractPhoneNumbers,
    costTracker,
    pace: createPacer(delayMs),
  };

  const limit = pLimit(concurrency);
  let completed = 0;
  try {
    const results = await Promise.all(
      companies.map((company) =>
        limit(async () => {
          const result = await enrichOne(company, ctx);
          completed += 1;
          if (progressEvery && completed % progressEvery === 0) {
            console.log(
              `[M2進捗] ${completed}/${companies.length}社 完了・累計コスト 約¥${Math.round(costTracker.spentJpy)}`
            );
          }
          return result;
        })
      )
    );
    // 呼び出し元がresults.lengthや配列アクセスを前提にしている(既存テスト含む)ため配列のまま返し、
    // コスト情報はプロパティとして追加する。
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

module.exports = { enrichSites, USER_AGENT };
