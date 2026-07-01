# auto_apo-app 仕様書 v1.0

> 中小企業向け「アポ獲得 半自動化システム」。
> 公開情報から見込み企業を集め、AIが各社向けの個別メール下書きを生成し、Discordで人間がGO/NOT GOした分だけ送信する。
> ※プロジェクト名は仮。既存の命名規則（auto_x-app 等）に合わせて変更可。

---

## 0. このドキュメントの位置づけ

- 本書はClaude Codeでの実装を前提とした仕様書。
- 思想は auto_x-app と同じ：**「AIが作る → Discordで人間がGO → 実行」**。新規発明はしない、既存の型を移植する。
- **大原則：このシステムは"アポを無限に増やす魔法"ではなく、"アポ獲得を確率と数字で管理できるラインにする装置"。** 母集団→送信可能リストの歩留まりは実測で12〜14%想定。無限ではないが、母集団（中小企業約360万社）に対して枯れない。

### 0-1. アーキテクチャ方針：汎用部分と固有部分を分離する（車輪の再発明をしない）

パイプラインのうち **M1〜M3（企業を集める→調べる→送っていい相手に絞る）は「何のために送るか」を一切知らない、用途非依存の処理**。一方 **M4〜M7（メール文面・承認・送信）は"アポ獲得"という今回の目的に固有の処理**。この境界で2層に分ける。

- **`corp-lead-kit`（汎用ライブラリ・新設）**：M1〜M3を実装。企業リサーチが必要な別のアプリ（採用スカウト、提携打診、講師派遣の営業先探し等）が出てきたら、このライブラリを呼ぶだけで済む。「事実」（社名・連絡先・事業内容要約・お断り表示の有無）だけを持ち、「目的」は持たない。
- **`auto_apo-app`（本アプリ）**：`corp-lead-kit` に依存し、M4〜M7（アポ獲得メールの下書き・Discord承認・送信・返信管理）のみを実装する。

**設計原則**
- `corp-lead-kit` の `companies` テーブルは `discovered → enriched → (mail_ready | call_list | excluded)` までの状態しか持たない。「下書き生成」「承認」「送信」の状態は持たせない。
- **配信停止リスト（suppression）は `corp-lead-kit` 側に置く**。ある会社が「営業メール一切お断り」と反応した事実は、用途（アポ獲得でも採用でも提携でも）を問わず守るべき情報のため。
- `auto_apo-app` は自分のDBに `drafts` / `sent_log` テーブルだけを持ち、`corp-lead-kit` の `companies.id` を外部キーとして参照する（2つのSQLiteファイルを跨ぐ場合はcompany_idで紐付け、または同一DBファイル内で `corp-lead-kit` のテーブルを共有する運用でも可）。
- 詳細な実装構成・呼び出し方は §8 のディレクトリ構成、§8-1 を参照。

---

## 1. システム概要

入口（公開企業情報）から出口（送信＋記録）まで、7段階のパイプライン。各段階は独立して再実行できる（途中失敗しても続きから流せる）。**M1〜M3は `corp-lead-kit`（汎用ライブラリ）、M4〜M7は `auto_apo-app`（本アプリ）が担当**（§0-1）。

```
┌─ corp-lead-kit（汎用ライブラリ）───────────────────────────
│ [M1] 母集団取得        … 法人番号CSV/API から「社名・所在地・法人番号」を取得
│         ↓
│ [M2] サイト巡回・抽出   … 各社サイトを巡回し「公開メール / 事業内容 / 営業お断り表示」を抽出（スクレイピング＋AI）
│         ↓
│ [M3] 適格判定・除外     … 特電法フィルタ（公開アドresのみ / お断り除外 / 過去拒否除外 / フォームのみ→架電リスト）
└──────────────────────────── companies(status=mail_ready) を返す ─┘
          ↓
┌─ auto_apo-app（本アプリ・アポ獲得固有）────────────────────
│ [M4] 下書き生成         … 各社の"痛み仮説"を立て、その会社にしか出せないメール本文をAIが生成（法定4項目の署名を自動付与）
│         ↓
│ [M5] Discord承認        … 下書きを並べて樫山が GO / NOT GO（ボタン or リアクション）
│         ↓
│ [M6] 送信・記録         … GO分のみ送信し、送信ログをDBに記録
│         ↓
│ [M7] 返信・配信停止管理 … 返信／配信停止依頼を記録し、corp-lead-kitのサプレッションリストへ反映。二度と送らない
└─────────────────────────────────────────────────────────┘
```

---

## 2. スコープ

### やること（v1）
- 中小企業（補助金活用層）向けの、メールによるアポ獲得アウトリーチの半自動化。
- 公開メールアドレス宛のみ。特電法の例外（公表アドレス）を厳格に運用。
- 送信は**手動**（M5でGOした下書きを樫山が自分のメールから送る）を初期デフォルトとする。半自動送信は将来オプション。

### やらないこと（v1では対象外）
- フォーム自動投稿（規約・難易度・法務リスクが高い。フォームのみの企業は「架電リスト」に回すだけ）。
- 自動テレアポ（架電は手動。AIは"架電カンペ"を作るのみ＝将来拡張）。
- 自治体・教育機関への一斉送信（塩撒き厳禁。ここは既存リレーション経由の手動アプローチで対応）。
- リスト購入（v1は公開情報の自前取得のみ。購入は将来の補助輪）。

---

## 3. 機能要件

### M1：母集団取得
- **目的**：狙う地域の企業リスト（社名・所在地・法人番号）を作る。
- **データ源の方針（重要・規約判断あり）**
  - **主軸＝国税庁 法人番号API／全件CSVダウンロード**。理由：**オープンデータで商用利用が明示的にOK**。営業リストの生成元として安全に使える唯一の確定ソース。
  - **gBizINFO（経産省）は v1では営業リストの生成元に使わない**。理由：業種・補助金採択先で絞れて非常に魅力的だが、**公式ポリシーに「営業名簿づくりを許可する明示記載がなく」、スクレイピングも非推奨でAPI利用前提**。規約グレーで事業の土台を揺らすリスクがあるため、利用規約を一次確認して許諾が取れるまで保留（§13）。業種補完は M2 のAI推定で代替する。

- **① 国税庁 法人番号システム Web-API（確定仕様）**
  - 最新は **Ver.4.0**。機能は「法人番号指定／取得期間指定／法人名指定」の3つ。
  - 無料。要・アプリケーションID（発行無料、メール登録＋規約同意。**発行に2週間〜1か月。最優先で申請**）。
  - REST(GET)。**レスポンスは CSV(Shift-JIS/Unicode) または XML のみ。JSONは非対応**（パーサはCSV前提で実装）。エンドポイント例：`https://api.houjin-bangou.nta.go.jp/4/...`
  - **検索レスポンスは2,000件超で分割**される（ページング実装必須）。
  - **1日のリクエスト上限は非公開**（「利用が著しく集中した場合に制限」とのみ規定）。→ レート制御を必ず入れ、間隔を空けて行儀よく叩く。
  - **取得できるのは基本3情報（商号・所在地・法人番号）のみ**。業種・電話・メールは含まない。
- **② 全件CSVダウンロード（大量母集団向け・v1の主軸として推奨）**
  - 全件・差分は「基本3情報ダウンロード機能」で取得（APIの検索レスポンスとは別物）。**アプリケーションID不要・今すぐ利用可**（`https://www.houjin-bangou.nta.go.jp/download/zenken/` から都道府県別 or 全国のzipを手動DL）。
  - ファイルはzip圧縮・OpenPGP署名付き。全国ファイルは約219MB・500万件規模、**1ファイル300MB超で分割**。都道府県単位のダウンロードも可能（母集団を絞るならこちらが軽くて速い）。
  - **CSV列定義は確定済み（一次情報：国税庁「リソース定義書」4.1版）**。ヘッダー行なし、以下30列がこの順で並ぶ：
    ```
    1 一連番号 / 2 法人番号 / 3 処理区分 / 4 訂正区分 / 5 更新年月日 / 6 変更年月日 /
    7 商号又は名称 / 8 商号又は名称イメージID / 9 法人種別 /
    10 国内所在地(都道府県) / 11 国内所在地(市区町村) / 12 国内所在地(丁目番地等) / 13 国内所在地イメージID /
    14 都道府県コード / 15 市区町村コード / 16 郵便番号 /
    17 国外所在地 / 18 国外所在地イメージID /
    19 登記記録の閉鎖等年月日 / 20 登記記録の閉鎖等の事由 / 21 承継先法人番号 / 22 変更事由の詳細 /
    23 法人番号指定年月日 / 24 最新履歴 /
    25 商号又は名称(英語) / 26 都道府県(英語) / 27 市区町村丁目番地等(英語) / 28 国外所在地(英語) /
    29 フリガナ / 30 検索対象除外
    ```
  - **フィルタリングで使う重要フィールド**：`処理区分=99`（削除）は除外／`最新履歴≠1`（過去情報）は除外／`法人種別`が101(国の機関)・201(地方公共団体)・401(外国会社等)は営業対象外として除外し、301〜305・399（株式会社〜その他設立登記法人）のみを残す。
  - **自己検証を実装に入れること**：法人番号は13桁数字、都道府県コードは1〜2桁、郵便番号は7桁の固定長。パース時にこれを検証し、桁数が合わなければ「列定義がズレている」と即座に検知できるようにする（列ズレはサイレントに壊れると気づきにくいため）。
- **③ Web-API（法人番号指定・期間指定検索）：日次更新の差分取得や特定法人の照会向け**
  - 上記②で作った母集団の**日次アップデート**に使う位置づけ。初回の大量母集団作りはCSVダウンロードで十分。
- **出力**：`companies` テーブルに `discovered` で登録（社名・所在地・法人番号・source=houjin_api|houjin_csv）。
- **表示義務**：出力物の参照可能な場所に「このサービスは国税庁法人番号システムWeb-APIを利用して取得した情報をもとに作成しているが、国税庁が保証したものではない」を記載（API利用規約の要件）。

### M2：サイト巡回・情報抽出
- **目的**：各社の公式サイトから「公開メールアドレス」「事業内容」「営業お断り表示の有無」を取る。
- **処理**
  1. 社名＋所在地でWeb検索 or 推定して公式サイトURLを特定。
  2. トップ／会社概要／お問い合わせ ページを取得（HTML）。
  3. 公開メールアドレスを正規表現＋AIで抽出（`info@～` 等）。
  4. ページ本文をAI（Claude）に渡し、(a)事業内容を2〜3行で要約、(b)「営業メールお断り」「営業目的の連絡禁止」等の表示の有無を判定。
- **出力**：`companies` を `enriched` に更新（website_url / email / business_summary / optout_notice_flag / contact_type[email|form_only|none]）。
- **マナー・適法性（必須）**
  - robots.txt を尊重。アクセスは**1サイトずつ間隔を空ける**（例：2〜5秒）。並列数を絞る。User-Agentを明示。
  - 取得はサイトの利用規約の範囲内に留める。規約でスクレイピング禁止のサイトは除外。
  - **JSが重いサイトはPlaywright等で対応**（cheerioで取れない場合のフォールバック）。

### M3：適格判定・除外（コンプライアンスフィルタ）
- **目的**：法的・実務的に「送ってよい先」だけ残す。ここが事業の生命線。
- **除外ルール（自動）**
  - `email` が無い → `contact_type=form_only` なら **架電リスト** へ／`none` なら除外。
  - `optout_notice_flag = true`（営業お断り表示あり）→ **除外**（送ると違法）。
  - サプレッションリスト（過去に配信停止・拒否・バウンス）に一致 → **除外**。
  - 重複（同一ドメイン／同一法人番号）→ 名寄せして1社に。
- **出力**：残ったものを `mail_ready`、外したものを `excluded`(理由付き) or `call_list` に分類。

### M4：メール下書き生成
- **目的**：その会社にしか出せない、個別最適化された1通目を作る。
- **入力**：business_summary（M2）＋ テンプレ骨子＋ 痛み仮説プロンプト。
- **処理**
  1. business_summary からAIが「この会社ならこの業務がAIで楽になりそう」という**痛み仮説を1つ**立てる。
  2. その仮説を1文織り込んだ本文を生成。補助金（デジタル化・AI導入補助金）に触れ「予算がつく前提の提案」にする。
  3. **法定4項目の署名ブロックを自動付与**（§4参照）。
- **出力**：`drafts` テーブル（company_id / subject / body / pain_hypothesis / status=`pending_approval`）。
- **品質ガード**：テンプレ丸出しNG。AIが痛み仮説を立てられない（情報不足）会社は下書きを作らず `low_confidence` フラグを立て、M5で目視判断に回す。

### M5：Discord承認（GO / NOT GO）
- **目的**：送信前に樫山が1通ずつ品質チェック。auto_x-app の承認フローを流用。
- **処理**：下書きを1社1メッセージでDiscordに投稿（社名・痛み仮説・件名・本文・信頼度を表示）。✅=GO / ❌=NOT GO / ✏️=要修正。
- **出力**：GO→`approved`、NOT GO→`rejected`、修正→該当社のみM4再生成。

### M6：送信・記録
- **v1デフォルト（手動送信）**：`approved` の下書きを、コピーしやすい形（件名＋本文＋宛先）で出力。樫山が自分のメールから送る。送信後 `sent` に手動 or 半自動マーク。
- **将来オプション（半自動送信）**：SMTP / メール配信API連携。ただし到達率（ドメイン評価）とスパムトラップに要注意。初期数十社の反応を見てから解禁。
- **出力**：`sent_log`（company_id / sent_at / channel）。

### M7：返信・配信停止管理
- **目的**：「二度と送らない」を機械的に担保（特電法の必須要件）。
- **処理**：返信・配信停止依頼・バウンスを受けたら、その company を**サプレッションリストに永久登録**。以降M3で必ず除外。
- **アポ獲得時**：`replied → meeting_set` までステータスを進め、歩留まり（送信数→返信数→アポ数）を集計できるようにする。

---

## 4. コンプライアンス要件（特定電子メール法）── 必須・絶対遵守

このシステムは合法に動くことが大前提。以下はコードで機械的に強制する。

### 4-1. 送ってよい相手（オプトイン規制の例外）
- **公表されているメールアドレス宛のみ**送信可（自社サイト等で公開している企業アドレス）。これが使える唯一の根拠。
- ただし、アドレスと併せて**「送信を拒否する／営業お断り」表示がある先はNG**（M3で除外）。

### 4-2. 一度断られたら二度と送らない
- 配信停止・受信拒否を受けた相手への再送信は**違法**。サプレッションリストで永久ブロック（M7）。

### 4-3. 本文に法定4項目を必ず表示（法第4条 表示義務）
全メールの署名に以下を必ず含める（M4で自動付与・欠落時は送信不可とする）：
1. 送信者（樫山／CodeBlitz Inc.）の**氏名又は名称**
2. **受信拒否ができる旨**＋そのための**メールアドレス又はURL**（配信停止導線）
3. 送信者の**住所**
4. **苦情・問い合わせの受付先**（電話／メール／URL）

### 4-4. その他
- 送信元情報を偽らない（なりすまし禁止）。
- 罰則は重い（個人：1年以下の懲役 or 100万円以下の罰金／法人：3,000万円以下の罰金）。CodeBlitzの看板を背負う以上、グレーは踏まない。
- **設計思想：迷ったら送らない。** フィルタは安全側に倒す。

---

## 5. データ設計（SQLite 想定）

- **DB実装は `node:sqlite`（Node.js 22+ 組み込み）を推奨。better-sqlite3は使わない。**
  理由：better-sqlite3はネイティブビルドが必要で、環境によってはビルドに失敗する（ネットワーク制限のある環境や、Pythonビルドツール未整備の環境で特に）。`node:sqlite`はNode.js本体に組み込みのため**追加インストール不要・ビルド不要**で、Node.js 22系なら即動く。API（`DatabaseSync`、`prepare().run()/.get()/.all()`）はbetter-sqlite3とほぼ同じ感覚で書ける。
  ※ Node.jsのバージョンは `node -v` で確認（22以上が必要）。既存プロジェクトが古いNodeを使っている場合はそこだけ要確認。

**`companies` と `suppression` は `corp-lead-kit` 側が所有**（用途を問わず使う「事実」のデータ）。**`drafts` と `sent_log` は `auto_apo-app` 側が所有**（アポ獲得固有の「目的」のデータ）。

```
【corp-lead-kit（leads.db）— 汎用・用途非依存】

companies
  id              INTEGER PK
  corporate_no    TEXT UNIQUE -- 法人番号（13桁）
  name            TEXT
  address         TEXT
  prefecture      TEXT        -- 都道府県（絞り込み・地域展開の管理用に追加）
  source          TEXT        -- houjin_csv | houjin_api | gbizinfo
  website_url     TEXT
  email           TEXT
  contact_type    TEXT        -- email | form_only | none
  business_summary TEXT
  optout_notice   INTEGER     -- 0/1 営業お断り表示
  status          TEXT        -- discovered | enriched | excluded | call_list | mail_ready
  exclude_reason  TEXT
  created_at / updated_at

suppression           -- 永久ブロック（用途を問わず全アプリで共有・尊重する）
  id / corporate_no / email / reason / created_at


【auto_apo-app（apo.db）— アポ獲得アプリ固有】

drafts
  id / company_id            -- corp-lead-kitのcompanies.idを参照（外部キー相当。DBファイルを分ける場合はアプリ側でJOIN）
  subject / body
  pain_hypothesis TEXT
  confidence      TEXT        -- normal | low_confidence
  status          TEXT        -- pending_approval | approved | rejected | sent

sent_log
  id / company_id / draft_id / sent_at / channel
```

- **UPSERTで冪等に**：`corporate_no` にUNIQUE制約を張り、`INSERT ... ON CONFLICT(corporate_no) DO UPDATE`で登録する。同じCSV/差分データを何度流しても重複登録されない設計にする（月次の差分更新を安全に運用するため）。
- **DBファイルを分けるか同一にするかは実装時の判断でよい**。分ける場合（`corp-lead-kit/data/leads.db` と `auto_apo-app/data/apo.db`）は `drafts.company_id` を単なる数値として持ちアプリ側でJOINする。同一DBファイルで運用する場合はSQLiteの通常の外部キーで組んでよい（Claude Codeの実装時の判断に委ねる）。

**status 遷移（corp-lead-kit 側）**
```
discovered → enriched → (excluded | call_list | mail_ready)
```

**status 遷移（auto_apo-app 側。起点は corp-lead-kit の mail_ready）**
```
mail_ready → draft_generated → pending_approval
pending_approval → (approved | rejected)
approved → sent → (replied | bounced | unsubscribed)
replied → meeting_set        ← 最終ゴール
bounced/unsubscribed → corp-lead-kit の suppression に登録（用途を問わず以後ブロック）
```

---

## 6. 実行方法・パラメータ（CLI）

各モジュールは個別に実行でき、`--limit` で初回テスト走行を小さく止められる。

```
# 初回テスト走行：100社で止める（事故・コスト・歩留まりを実測）
node src/run.js --stage all --pref 東京都 --industry 製造業 --limit 100 --dry-run

# 段階実行の例
node src/run.js --stage m1 --pref 神奈川県 --limit 500      # 母集団だけ取得
node src/run.js --stage m2-m4 --limit 100                    # 巡回〜下書き生成
node src/run.js --stage m5                                   # Discord承認に流す
```
- `--limit N`：処理する社数の上限（**初回は必ず100程度で**）。
- `--dry-run`：送信・課金を伴う処理を実行せず件数とコスト見積だけ出す。
- `--pref / --industry`：母集団の絞り込み（業種は gBizINFO 利用時のみ）。

---

## 7. 技術スタック（推奨）

- **言語：Node.js**（auto_x-app の Discord + Anthropic SDK の型をそのまま流用できるため第一候補）。
  - スクレイピングが重い場合のみ Python（BeautifulSoup/Playwright）を一部併用してもよい。
- **Discord**：discord.js（debate.js / auto_x の実績あり）。
- **AI**：Anthropic SDK。要約・判定・低コスト処理は **Haiku**、痛み仮説＋本文生成は **Sonnet** で使い分け（コスト最適化）。
- **DB**：**node:sqlite（Node.js 22+ 組み込み、追加インストール不要）**。better-sqlite3はネイティブビルドが要り環境依存の失敗要因になるため不採用。ローカル完結、auto_shortmovie 等と同じ思想。
- **スクレイピング**：cheerio（軽量）＋ Playwright（JS重いサイトのフォールバック）。
- **HTTP**：標準fetch / undici。レート制御は p-limit 等。
- **配置**：ローカル実行（auto_shortmovie型）。常駐不要。Fly.ioは将来の半自動送信時に検討。

---

## 8. ディレクトリ構成（案）— 2パッケージ構成

`corp-lead-kit`（汎用ライブラリ）と `auto_apo-app`（本アプリ）を別ディレクトリ（別npmパッケージ）にする。将来別アプリからも `corp-lead-kit` を再利用できるように、リポジトリも分けるのが理想（最小構成なら同一リポジトリ内の別フォルダでも可）。

```
corp-lead-kit/                  ★ 汎用ライブラリ（M1〜M3。用途を問わず再利用可能）
  package.json                  # npm packageとして他プロジェクトから require/import できるようにする
  README.md                     # このライブラリ単体の使い方（他プロジェクトから見た入口）
  data/
    leads.db                    # SQLite（companies / suppression のみ）
  src/
    index.js                    # 外部公開API（collectFromCsv / enrichSites / filterCompliant）
    m1_collect.js                # 母集団取得（CSV取り込み）
    m2_enrich.js                 # サイト巡回・抽出
    m3_filter.js                 # 適格判定・除外
    lib/
      db.js                      # companies / suppression のスキーマ・接続
      csvParser.js                # 国税庁CSVパーサ
      houjinCsvSchema.js          # CSV列定義（一次情報で確定済み）
      scrape.js                   # サイト巡回（cheerio / Playwright）
      compliance.js               # 特電法フィルタルール
  data/incoming/                 # ダウンロードしたCSV/ZIPの置き場

auto_apo-app/                   ★ 本アプリ（M4〜M7。アポ獲得固有）
  CLAUDE.md                     # 運用ルール（§11）
  README.md
  .env                          # 機密（gitignore）
  .env.example
  package.json                  # dependencies に corp-lead-kit を追加
  data/
    apo.db                      # SQLite（drafts / sent_log のみ。company_idでcorp-lead-kitのcompaniesを参照）
    call_list.csv               # フォームのみ企業（架電用）
  src/
    run.js                      # オーケストレータ（--stage 制御。内部でcorp-lead-kitのAPIを呼ぶ）
    m4_draft.js                 # 下書き生成
    m5_discord.js               # 承認フロー
    m6_send.js                  # 送信・記録
    m7_inbox.js                 # 返信・配信停止管理（corp-lead-kitのsuppressionへ反映）
    lib/
      db.js / ai.js / cost.js   # このアプリ固有のDB・AI呼び出し
  prompts/
    pain_hypothesis.md          # 痛み仮説プロンプト
    mail_body.md                # 本文生成プロンプト
    signature.md                # 法定4項目署名テンプレ
```

### 8-1. `corp-lead-kit` の外部公開API（呼び出しイメージ）

`auto_apo-app` はこの3関数を呼ぶだけでM1〜M3を完了できる。用途固有の判断（何のために送るか）は一切ここに書かない。

```js
// auto_apo-app/src/run.js 内でのイメージ
const { collectFromCsv, enrichSites, filterCompliant } = require('corp-lead-kit');

const companies = await collectFromCsv({ file: '...', pref: '東京都', limit: 100 }); // M1
const enriched  = await enrichSites(companies);                                        // M2
const mailReady = await filterCompliant(enriched);                                     // M3
// ここから先（drafts生成〜送信）は auto_apo-app 側の m4_draft.js 以降が担当
```

- `collectFromCsv`：CSV/ZIPを読み込み `companies` に登録して返す（§3 M1のロジック）。
- `enrichSites`：`companies` を巡回し email / business_summary / optout_notice を埋めて返す（§3 M2）。
- `filterCompliant`：特電法フィルタを適用し、`mail_ready` / `call_list` / `excluded` に仕分けて返す（§3 M3）。suppressionチェックもここで行う。
- 将来、別アプリ（採用スカウト等）を作る場合も、この3関数の返り値（`mail_ready` の会社リスト）を、そのアプリ独自の「下書き生成」ロジックに渡すだけで済む。

---

## 9. 環境変数（.env）

```
ANTHROPIC_API_KEY=          # ※Claude Codeとは別。送信文生成用のAPIキー
HOUJIN_APP_ID=              # 国税庁 法人番号API アプリケーションID
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
SENDER_NAME=樫山 / CodeBlitz Inc.
SENDER_ADDRESS=             # 法定4項目：住所
SENDER_CONTACT=             # 法定4項目：苦情・問合せ先
UNSUBSCRIBE_URL_OR_MAIL=    # 法定4項目：配信停止導線
DAILY_API_BUDGET_JPY=500    # 1日のAPI課金上限（超えたら停止）
SCRAPE_DELAY_MS=3000        # サイト巡回の間隔
```
※ `.env` はマシン間で手動同期（既存運用に合わせる）。`.env.example` のみGit管理。

---

## 10. コスト・レート制御

- **API課金の見える化**：1社あたりの推定コスト（要約Haiku＋生成Sonnet）を集計し、`--dry-run` で事前見積。`DAILY_API_BUDGET_JPY` 超過で自動停止。
- **想定**：1社あたり数円〜十数円。100社初回＝数百円規模。
- **スクレイピング**：間隔（`SCRAPE_DELAY_MS`）と並列数を絞り、相手サーバーに負荷をかけない。

---

## 11. CLAUDE.md に書くべき運用ルール

- このプロジェクトの鉄則：**「公開アドレスのみ・お断り除外・配信停止は永久ブロック・署名に法定4項目」を絶対に外さない。**
- 送信判断は必ず人間（M5）を通す。AIは下書きまで。
- 初回は必ず `--limit 100 --dry-run` から。いきなり全件を流さない。
- スクレイピングは robots.txt と間隔を守る。規約でNGのサイトは触らない。
- セッション運用は既存ルール（SESSION_LOG.md 等）を踏襲。

---

## 12. 開発フェーズ（段階実装）

| フェーズ | パッケージ | 内容 | ゴール |
|---|---|---|---|
| 0 | - | 全件CSVダウンロード（**ID不要・今すぐ**）を手動取得／並行して国税庁APIのアプリID申請（発行2週間〜1か月、将来の日次更新用） | CSVが手元にある／IDが届く |
| 1 | **corp-lead-kit** | M1（CSV取り込み＋DB）。まず単体で動く汎用ライブラリとして作る | 100社のリストが取れる |
| 2 | **corp-lead-kit** | M2（巡回・抽出）＋M3（除外） | 送信可能リスト（歩留まり実測） |
| 3 | auto_apo-app | corp-lead-kitを依存として組み込み、M4（下書き生成）＋prompts | 個別最適メールが並ぶ |
| 4 | auto_apo-app | M5（Discord承認） | GO/NOT GOが回る |
| 5 | auto_apo-app | M6手動送信＋M7記録 | 1サイクル完走・歩留まり数値化 |
| 6（将来） | auto_apo-app | 半自動送信／架電カンペ／Web-APIでの日次差分更新 | 量の拡大・データ鮮度維持 |
| 6（将来） | corp-lead-kit | 他アプリ（採用スカウト等）からの再利用 | ライブラリとしての価値実証 |

> **フェーズ1・2（corp-lead-kit相当）は着想の検証として一部試作済み**（CSV列定義の一次情報確認、パーサ・DBスキーマ・フィルタロジックの動作検証）。実装自体はVS Code + Claude Codeで進める前提のため、本書はその仕様の正確性を担保するところまでを役割とする。列定義・フィルタ条件（§3 M1）はそのままコードに落とせる精度で記載済み。

---

## 13. 確定事項・運用判断スイッチ

### 13-1. 一次情報で確定した仕様（実装に反映済み）
- **法人番号API**：最新Ver.4.0／レスポンスは**CSV・XMLのみ（JSON非対応）**／検索結果は**2,000件超で分割**／**1日上限は非公開**（行儀よくレート制御）／アプリID発行は**2週間〜1か月**／取得は基本3情報のみ。全件CSVは別途DL機能で**300MB超分割**。
- **gBizINFO**：REST API v2、**APIトークン方式**。`prefecture / city / industry / subsidy` 等で**業種・地域・補助金採択で絞り込み可能**、`page / limit` でページング可。取得項目に業種コード・事業内容・補助金採択情報を含む。

### 13-2. 運用判断スイッチ（実装はする・使用可否は樫山が別途判断）
> **基本方針：システムは全機能を実装する。ただし下記は"実際に営業利用してよいか"が規約・法務判断に依存するため、コード上はフラグでON/OFFできるようにし、デフォルトOFF（または警告表示）にしておく。実装すること自体に問題はない。使うかどうかは運用時に慎重に判断する。**

| スイッチ | 状態 | 判断ポイント |
|---|---|---|
| `USE_GBIZINFO_AS_LIST_SOURCE` | **デフォルトOFF** | gBizINFOは営業名簿づくりの明示許可がなく、スクレイピング非推奨。営業リスト生成元に使う場合は利用規約の許諾を確認してからONにする。機能自体は実装する。 |
| `ENABLE_AUTO_SEND`（M6半自動送信） | **デフォルトOFF** | 初期は手動送信。到達率・スパムトラップ・特電法の運用が固まってからON。 |
| 各サイトのスクレイピング | robots/規約遵守を実装 | 規約でNGのサイトは実行時に自動スキップ。 |

- これらのスイッチと判断理由は **CLAUDE.md にも転記**し、将来「これ使っていいんだっけ？」を即座に思い出せるようにする。
- **配信停止導線**：法定要件を満たす最小実装として、まずは「配信停止用メールアドレス受信＋手動でサプレッション登録」で開始可。将来URLフォーム化。

### 13-3. 残タスク（実装と並行で確認）
- gBizINFO 利用規約の営業利用可否（許諾が取れれば最強の母集団＝補助金採択先が解禁される）。
- 配信停止URLフォームの要否（量が増えてから）。
