# 本文判定の評価（selection eval）

ページから「翻訳する本文」を選ぶ判定（ルールのみ／Jev／Claude）が、どれだけ本文を取りこぼし、どれだけ余計なもの（ナビゲーションや広告など）を残すかを測ります。claude-api スキルの `build-eval` / `hillclimb` の手順に沿った構成です。

## しくみ

1. **ケース**：`cases/<id>/` に1ページずつ置きます。
   - `page.html`：保存したページ（スクリプトを除き、CSSを埋め込んだもの）
   - `case.json`：元のURL、出どころ、メモ
   - `candidates.json`：拡張機能のスキャン結果（`prepare.mjs scan` が作る）
   - `labels.json`：候補ごとの正解ラベル。`content`（訳すべき）、`chrome`（除くべき）、`either`（採点しない）
2. **実行**：`run-eval.mjs` が各ケースを、拡張機能の判定コード（`src/background/providers.ts` の `classifyCandidates` / `classifyWithClaude`）にそのまま通し、サイドパネルと同じ規則で「表示されるか」を決めます。
3. **採点**：ラベルと照らし合わせ、再現率（本文を取りこぼさないか）を主指標に、特異度・適合率を記録します。定義は `.claude/hillclimb/selection/metrics.md` にあります。

## 使い方

前提：`npm ci` と `npm run build` を済ませておきます。実行には `bun`（または `npx tsx`）を使います。

```bash
# ページを保存してスキャンする
node eval/selection/prepare.mjs snapshot nikkei-article https://example.com/article
node eval/selection/prepare.mjs scan
# labels.json の label を埋めたら、確認用の一覧を作る
node eval/selection/prepare.mjs review          # → eval/selection/labels.md

# 採点の仕組みを確かめる（APIは呼びません）
bun eval/selection/check.mjs

# 本番の比較（キーは環境変数から読みます）
export TYPESAFE_API_KEY=...  ANTHROPIC_API_KEY=...
bun eval/selection/run-eval.mjs --flow .claude/hillclimb/selection --variant baseline --judge jev
bun eval/selection/run-eval.mjs --flow .claude/hillclimb/selection --variant v1 --judge claude
```

`--judge` は `none`（ページ側のルールだけ）、`jev`、`claude` のほか、仕組みの確認用に `oracle`（正解ラベルそのもの）と `skip-all`（すべて除外）を選べます。

初回は `run-eval.mjs` が「ハーネス未承認」で止まります。`run-eval.mjs` と `selection.mjs` の中身を確認したうえで、`--approve-harness` を付けて一度実行してください（以後、これらが変わると再承認を求めます）。

結果は `.claude/hillclimb/selection/<variant>/results.jsonl` に1ページ1行で残り、claude-api スキルのレポート生成スクリプトで `report.html` にまとめられます。
