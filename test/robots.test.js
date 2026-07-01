'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRobots, isPathAllowed, isAllowedByRobots } = require('../src/lib/robots');

const SAMPLE_ROBOTS = `
User-agent: *
Disallow: /private/
Allow: /private/public-page.html

User-agent: BadBot
Disallow: /
`;

test('Disallowされたパス配下は不許可になる', () => {
  const groups = parseRobots(SAMPLE_ROBOTS);
  assert.equal(isPathAllowed(groups, '/private/secret', 'corp-lead-kit-bot'), false);
});

test('Disallow配下でもAllowでより長く一致すれば許可される', () => {
  const groups = parseRobots(SAMPLE_ROBOTS);
  assert.equal(isPathAllowed(groups, '/private/public-page.html', 'corp-lead-kit-bot'), true);
});

test('該当ルールが無いパスは許可される', () => {
  const groups = parseRobots(SAMPLE_ROBOTS);
  assert.equal(isPathAllowed(groups, '/about', 'corp-lead-kit-bot'), true);
});

test('isAllowedByRobots: robots.txtが取得できない(404)場合は許可扱い', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const allowed = await isAllowedByRobots('https://example.com/company', { fetchImpl });
  assert.equal(allowed, true);
});

test('isAllowedByRobots: 取得自体が失敗した場合も許可扱い(安全側フォールバック)', async () => {
  const fetchImpl = async () => {
    throw new Error('network error');
  };
  const allowed = await isAllowedByRobots('https://example.com/company', { fetchImpl });
  assert.equal(allowed, true);
});

test('isAllowedByRobots: 全面Disallowのサイトは不許可', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => 'User-agent: *\nDisallow: /' });
  const allowed = await isAllowedByRobots('https://example.com/company', { fetchImpl });
  assert.equal(allowed, false);
});
