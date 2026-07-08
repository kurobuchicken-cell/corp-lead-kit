'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const {
  fetchHtml,
  fetchPageWithFallback,
  findContactLinks,
  extractEmails,
  extractPhoneNumbers,
  looksLikeThinSpaShell,
} = require('../src/lib/scrape');

test('extractEmails: 公開メールアドレスを抽出し、大小文字違いの重複は除去する', () => {
  const text = 'お問い合わせは info@sample-corp.co.jp または INFO@Sample-Corp.co.jp まで。';
  const emails = extractEmails(text);
  assert.deepEqual(emails, ['info@sample-corp.co.jp']);
});

test('extractEmails: 解析タグ・サンプルドメイン等の誤検出は除外する', () => {
  const text = 'tracking: xxxx@sentry.io / xxxx@google-analytics.com / test@example.com のみ';
  const emails = extractEmails(text);
  assert.deepEqual(emails, []);
});

test('extractEmails: 誤検出パターンと本物のメールが混在していても本物だけ拾う', () => {
  const text = '解析用: err@sentry.io 連絡先: contact@real-company.jp';
  const emails = extractEmails(text);
  assert.deepEqual(emails, ['contact@real-company.jp']);
});

test('extractPhoneNumbers: ハイフン区切りの電話番号を抽出し、重複は除去する', () => {
  const text = 'TEL: 03-1234-5678 / FAX: 03-1234-5678 フリーダイヤル: 0120-123-456';
  const phones = extractPhoneNumbers(text);
  assert.deepEqual(phones, ['03-1234-5678', '0120-123-456']);
});

test('extractPhoneNumbers: 電話番号が本文に無ければ空配列を返す', () => {
  assert.deepEqual(extractPhoneNumbers('お問い合わせはフォームより承っております。'), []);
});

test('findContactLinks: 会社概要・お問い合わせ等のキーワードを含むリンクのみ拾う', () => {
  const html = `
    <html><body>
      <a href="/about/">会社概要</a>
      <a href="/contact">お問い合わせ</a>
      <a href="/blog">ブログ</a>
      <a href="#top">トップへ戻る</a>
      <a href="mailto:info@example.com">メール</a>
    </body></html>
  `;
  const $ = cheerio.load(html);
  const links = findContactLinks($, 'https://example.com/', { limit: 2 });
  assert.deepEqual(links.sort(), ['https://example.com/about/', 'https://example.com/contact'].sort());
});

test('looksLikeThinSpaShell: SPAのルート要素だけで本文がほぼ無い場合はtrue', () => {
  const html = '<html><body><div id="root"></div><script src="bundle.js"></script></body></html>';
  assert.equal(looksLikeThinSpaShell('', html), true);
});

test('looksLikeThinSpaShell: 通常のHTMLで本文があればfalse', () => {
  const html = '<html><body><h1>会社概要</h1><p>我々は...</p></body></html>';
  const text = '会社概要 我々は...'.repeat(10);
  assert.equal(looksLikeThinSpaShell(text, html), false);
});

test('fetchHtml: fetchImplを注入して取得できる(ネットワーク不要)', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    text: async () => '<html><body>ok</body></html>',
  });
  const { html } = await fetchHtml('https://example.com/', { fetchImpl });
  assert.match(html, /ok/);
});

test('fetchHtml: HTTPエラーはthrowする', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => fetchHtml('https://example.com/', { fetchImpl }), /500/);
});

test('fetchPageWithFallback: 通常のHTMLはPlaywrightにフォールバックしない', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    text: async () => '<html><body><h1>会社概要</h1><p>' + 'テスト文章。'.repeat(20) + '</p></body></html>',
  });
  const result = await fetchPageWithFallback('https://example.com/', { fetchImpl });
  assert.equal(result.renderedWith, 'fetch');
  assert.match(result.text, /会社概要/);
});
