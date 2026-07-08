'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// 検索・要約・お断り判定は低コストなHaikuで十分（仕様書§7）。
const MODEL = 'claude-haiku-4-5-20251001';

function createClient(apiKey = process.env.ANTHROPIC_API_KEY) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません（M2の稼働にはWeb検索・要約用のAPIキーが必須です）');
  }
  return new Anthropic({ apiKey });
}

function extractText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// 社名＋所在地からWeb検索ツールで公式サイトURLを推定する。見つからない場合は null。
// onUsage: 呼び出しごとの usage（コスト集計用）を受け取るコールバック（省略可）。
async function findOfficialWebsite(client, { name, address, onUsage }) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [
      {
        role: 'user',
        content:
          `次の企業の公式サイトのトップページURLを1つ調べてください。\n` +
          `社名: ${name}\n所在地: ${address}\n\n` +
          `注意：モール・SNS・求人媒体・法人番号検索サイト等の外部サイトではなく、企業自身が運営する公式サイトのURLのみを選んでください。\n` +
          `見つからない場合、または確信が持てない場合は "NOT_FOUND" とだけ答えてください。\n` +
          `回答はURL1つ、または "NOT_FOUND" のみを最後の行に書いてください（説明文は不要です）。`,
      },
    ],
  });
  if (onUsage) onUsage(message.usage);

  const text = extractText(message).trim();
  const lastLine = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  if (!lastLine || lastLine.includes('NOT_FOUND')) return null;
  const urlMatch = lastLine.match(/https?:\/\/\S+/);
  return urlMatch ? urlMatch[0].replace(/[)\].,]+$/, '') : null;
}

function parseJsonResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`AI応答からJSONを抽出できません: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ページ本文から (a) 事業内容の要約 (b) 営業お断り表示の有無 (c) 問い合わせ手段 を判定する。
// onUsage: 呼び出しごとの usage（コスト集計用）を受け取るコールバック（省略可）。
async function analyzeCompanyPage(client, { name, text, onUsage }) {
  const truncated = text.slice(0, 6000);
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content:
          `以下は企業「${name}」の公式サイトの本文です。これを読んで、次のJSON形式のみで回答してください（説明文・コードブロック記号は不要）。\n\n` +
          `{\n` +
          `  "business_summary": "事業内容を2〜3行で要約した文字列",\n` +
          `  "optout_notice": true または false（「営業メールお断り」「営業目的の連絡・訪問はご遠慮ください」等の表示があればtrue）,\n` +
          `  "contact_type": "email" または "form_only" または "none"（メールアドレスの記載があればemail、問い合わせフォームのみならform_only、どちらも無ければnone）,\n` +
          `  "industry": "業種を10字程度の短い言葉で（例: 不動産仲介、機械部品商社、ITコンサルティング）。判断できなければnull"\n` +
          `}\n\n` +
          `本文:\n${truncated}`,
      },
    ],
  });
  if (onUsage) onUsage(message.usage);

  const text2 = extractText(message);
  const parsed = parseJsonResponse(text2);
  return {
    business_summary: typeof parsed.business_summary === 'string' ? parsed.business_summary : null,
    optout_notice: Boolean(parsed.optout_notice),
    contact_type: ['email', 'form_only', 'none'].includes(parsed.contact_type) ? parsed.contact_type : 'none',
    industry: typeof parsed.industry === 'string' ? parsed.industry : null,
  };
}

module.exports = { createClient, findOfficialWebsite, analyzeCompanyPage, parseJsonResponse, MODEL };
