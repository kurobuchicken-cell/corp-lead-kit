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
// maxUses: web_searchツールの最大呼び出し回数。3→1でコスト¥6.12→¥3.29/社(-46%)、
// 発見率25.0%→21.0%(-4pt、同一100社ペア比較でMcNemar exact p≈0.22、統計的有意差なし)。
// コスト効果を優先し1をデフォルトに採用（2026-07-09検証、SESSION_LOG.md参照）。
async function findOfficialWebsite(client, { name, address, onUsage, maxUses = 1 }) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
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

// 営業お断り表示の有無だけを判定する（①コンプラ判定）。お断り表示は通常フッターや問い合わせ欄
// 付近に短く明記されているため、フルの本文を読ませる必要はなく、軽量な範囲（3,000字）で十分という
// 想定。ここでお断りと判定されれば、後段②（業務内容確認、コストの高い呼び出し）を丸ごとスキップできる。
// onUsage: 呼び出しごとの usage（コスト集計用）を受け取るコールバック（省略可）。
async function checkOptOut(client, { name, text, onUsage }) {
  const truncated = text.slice(0, 3000);
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content:
          `以下は企業「${name}」の公式サイトの本文（抜粋）です。\n` +
          `「営業メールお断り」「営業目的の連絡・訪問はご遠慮ください」等の、営業行為を断る旨の表示があるか判定してください。\n` +
          `あれば "true"、無ければ "false" とだけ答えてください（説明文は不要）。\n\n` +
          `本文:\n${truncated}`,
      },
    ],
  });
  if (onUsage) onUsage(message.usage);
  return { optOut: extractText(message).trim().toLowerCase().includes('true'), usage: message.usage };
}

// ページ本文から (a) 事業内容の要約 (b) 業種 (c) 痛み仮説の手がかり を判定する（②業務内容確認）。
// 営業お断り判定は①（checkOptOut）で別途行うため、ここでは含めない
// （項目を絞ることで、pain_hintに割かれるAIの"労力"を確保する狙い）。
// M2（全社対象・無料化）ではなく、①を通過した会社だけを対象にする（対象を絞ることでコストを抑える設計）。
// onUsage: 呼び出しごとの usage（コスト集計用）を受け取るコールバック（省略可）。
async function qualifyFromPage(client, { name, text, onUsage }) {
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
          `  "industry": "業種を10字程度の短い言葉で（例: 不動産仲介、機械部品商社、ITコンサルティング）。判断できなければnull",\n` +
          `  "pain_hint": "手作業・紙ベース・Excel管理・繰り返し作業になっていそうな業務プロセスの具体的な手がかりを、本文に根拠がある範囲で3行程度の箇条書きで。見当たらなければnull"\n` +
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
    industry: typeof parsed.industry === 'string' ? parsed.industry : null,
    pain_hint: typeof parsed.pain_hint === 'string' ? parsed.pain_hint : null,
  };
}

// 痛み仮説の手がかりだけを専用に探す（他の項目は一切聞かない）。qualifyFromPageに同梱すると
// AIの"労力"が分散し検出率が下がる傾向が見られたため、専用呼び出しでの効果検証用に用意した。
// onUsage: 呼び出しごとの usage（コスト集計用）を受け取るコールバック（省略可）。
async function findPainHint(client, { name, text, onUsage }) {
  const truncated = text.slice(0, 6000);
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content:
          `以下は企業「${name}」の公式サイトの本文です。\n` +
          `手作業・紙ベース・Excel管理・繰り返し作業になっていそうな業務プロセスの具体的な手がかりを、` +
          `本文に根拠がある範囲で3行程度の箇条書きで拾い出してください。\n` +
          `推測や一般論で埋めず、本文に書かれている内容のみを根拠にしてください。\n` +
          `手がかりが見当たらない場合は、無理に作らず "NONE" とだけ答えてください（説明文は不要）。\n\n` +
          `本文:\n${truncated}`,
      },
    ],
  });
  if (onUsage) onUsage(message.usage);
  const text2 = extractText(message).trim();
  return { hint: text2.includes('NONE') ? null : text2, usage: message.usage };
}

module.exports = {
  createClient,
  findOfficialWebsite,
  checkOptOut,
  qualifyFromPage,
  findPainHint,
  parseJsonResponse,
  MODEL,
};
