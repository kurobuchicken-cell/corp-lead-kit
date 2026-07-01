'use strict';

const pLimit = require('p-limit');

const { openDb, updateEnrichment, DEFAULT_DB_PATH } = require('./lib/db');
const { isAllowedByRobots, USER_AGENT_TOKEN } = require('./lib/robots');
const { fetchPageWithFallback, findContactLinks, extractEmails, USER_AGENT } = require('./lib/scrape');
const { createClient, findOfficialWebsite, analyzeCompanyPage } = require('./lib/ai');

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
    websiteUrl = await ctx.findWebsite(ctx.client, { name: company.name, address: company.address });
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
  const analysis = await ctx.analyzePage(ctx.client, { name: company.name, text: combinedText });

  const email = emails[0] || null;
  const contactType = email ? 'email' : analysis.contact_type;

  return updateEnrichment(ctx.db, company.id, {
    website_url: websiteUrl,
    email,
    contact_type: contactType,
    business_summary: analysis.business_summary,
    optout_notice: analysis.optout_notice,
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
    analyzePage = analyzeCompanyPage,
    fetchPage = fetchPageWithFallback,
    isAllowed = isAllowedByRobots,
    fetchImpl,
  } = options;

  const needsAiClient = findWebsite === findOfficialWebsite || analyzePage === analyzeCompanyPage;
  const resolvedClient = client || (needsAiClient ? createClient(anthropicApiKey) : undefined);

  const db = openDb(dbPath);
  const ctx = {
    db,
    client: resolvedClient,
    findWebsite,
    analyzePage,
    fetchPage,
    isAllowed,
    fetchImpl,
    timeoutMs,
    findContactLinks,
    extractEmails,
    pace: createPacer(delayMs),
  };

  const limit = pLimit(concurrency);
  try {
    const results = await Promise.all(companies.map((company) => limit(() => enrichOne(company, ctx))));
    return results;
  } finally {
    db.close();
  }
}

module.exports = { enrichSites, USER_AGENT };
