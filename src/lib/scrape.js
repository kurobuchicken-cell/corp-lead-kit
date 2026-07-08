'use strict';

const cheerio = require('cheerio');

const USER_AGENT = 'corp-lead-kit-bot/0.1 (+https://github.com/kurobuchicken-cell/corp-lead-kit; research use)';

const CONTACT_LINK_KEYWORDS = [
  '会社概要', '企業情報', '会社案内', '会社情報', 'about',
  'お問い合わせ', 'お問合せ', 'contact', 'inquiry',
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// 誤検出になりやすいドメイン・パターン（解析タグ・画像CDN・サンプル用ドメイン等）を除外する。
const EMAIL_FALSE_POSITIVE_RE = /(sentry\.io|wixpress\.com|w3\.org|schema\.org|example\.(com|jp)|google-analytics\.com|godaddy\.com|\.(png|jpg|jpeg|gif|svg|webp)$)/i;

// 日本の固定電話・フリーダイヤル・携帯電話番号（ハイフン区切り）。FAXとの区別はしない。
const PHONE_RE = /0\d{1,4}-\d{1,4}-\d{3,4}/g;

function htmlToText($) {
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function looksLikeThinSpaShell(text, html) {
  const hasAppRoot = /id=["'](app|root|__next|__nuxt)["']/.test(html);
  return hasAppRoot && text.length < 200;
}

async function fetchHtml(url, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

// PlaywrightはJSレンダリングが必要な場合のみ遅延requireする（未使用時に起動コストをかけない）。
async function fetchHtmlWithBrowser(url, { timeoutMs = 20000 } = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    const html = await page.content();
    return { html, finalUrl: res ? res.url() : url };
  } finally {
    await browser.close();
  }
}

// まずcheerio向けの静的取得を試み、内容が薄い(SPAシェルのみ等)場合はPlaywrightにフォールバックする。
async function fetchPageWithFallback(url, options = {}) {
  const { fetchImpl, timeoutMs, allowBrowserFallback = true } = options;
  let { html, finalUrl } = await fetchHtml(url, { timeoutMs, fetchImpl });
  let $ = cheerio.load(html);
  let text = htmlToText($);
  let renderedWith = 'fetch';

  if (allowBrowserFallback && looksLikeThinSpaShell(text, html)) {
    ({ html, finalUrl } = await fetchHtmlWithBrowser(url, { timeoutMs }));
    $ = cheerio.load(html);
    text = htmlToText($);
    renderedWith = 'playwright';
  }

  return { html, text, finalUrl, renderedWith, $ };
}

// トップページから「会社概要」「お問い合わせ」等、事業内容・お断り表示が書かれていそうなリンクを見つける。
function findContactLinks($, baseUrl, { limit = 2 } = {}) {
  const found = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    if (found.length >= limit) return;
    const text = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const matches = CONTACT_LINK_KEYWORDS.some((kw) => text.includes(kw));
    if (!matches) return;
    let absolute;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    seen.add(absolute);
    found.push(absolute);
  });
  return found;
}

function extractEmails(text) {
  const matches = text.match(EMAIL_RE) || [];
  const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
  return unique.filter((e) => !EMAIL_FALSE_POSITIVE_RE.test(e));
}

function extractPhoneNumbers(text) {
  const matches = text.match(PHONE_RE) || [];
  return [...new Set(matches)];
}

module.exports = {
  USER_AGENT,
  fetchHtml,
  fetchHtmlWithBrowser,
  fetchPageWithFallback,
  findContactLinks,
  extractEmails,
  extractPhoneNumbers,
  htmlToText,
  looksLikeThinSpaShell,
};
