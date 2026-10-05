# 開発ガイド

Page Translate の開発・テスト・リリースの手順です。使い方は [使い方ガイド](docs/index.html) をご覧ください。

## 開発と提出用パッケージ

- Node.js 20.19以上、または22.12以上
- Chrome 116以上

```sh
npm install
npm run build
npm run zip
```

`npm run zip` は `.output/page-translate-v<version>-chrome.zip` を作成します。ZIPを開いたとき、`manifest.json` が直下にある構成です。開発中は `dist` を `chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」から読み込みます。

`main` への push では、GitHub Actions が同じ `npm run zip` を実行し、できた ZIP をアーティファクトとして残します。アーティファクト名は ZIP のファイル名と同じです（例: `page-translate-v<version>-chrome.zip`）。ダウンロードしたファイルが提出用 ZIP そのものです。

公開するときは、`src/manifest.ts` の `version` と `package.json` の `version` を同じ新しい値にして `main` にマージします。マージすると GitHub Actions の「Release」ワークフローが自動で動き、`npm test` と `npm run zip` を実行して、`v<version>` のようなタグと GitHub Release を作り、ZIP を添付します。すでにリリース済みの version のままなら何もしません。

ほかに次の方法でもリリースできます。

- GitHub の Actions タブで「Release」ワークフローを手動実行する（`ref` は通常 `main`）。同じタグがすでにある場合は失敗します。
- `v<version>` のように `v` と version を続けたタグを push する。

### テスト

```sh
npm test            # ユニットテスト（Vitest）
npm run test:e2e    # ビルドしてから、実際の拡張機能をChromiumで動かすE2Eテスト（Playwright）
```

初回だけ `npx playwright install chromium` でテスト用のChromiumを入れてください。

- `tests/unit`：本文判定のルール（`src/sidepanel/rules.ts`）、英作文の差分、ページ種別の判定、DeepLのプラン判定
- `tests/e2e/content-script.spec.ts`：`dist` を拡張機能として読み込み、`tests/e2e/fixtures` のページで本文抽出、ページ内翻訳、コネクタ、ページクリックモードを確かめます
- `tests/e2e/selection-auto.spec.ts`：パネルを閉じたまま選択範囲を翻訳する流れ（実際のサービスワーカー。APIキーがないため、DeepLで断られるところまでを確かめます）
- `tests/e2e/page-watch.spec.ts` / `page-navigation.spec.ts`：ページ移動の検知と、パネルを閉じたときにモードがオフになること
- `tests/e2e/selection-tooltip.spec.ts` / `selection-panel.spec.ts`：選択範囲翻訳のツールチップ（実際の拡張機能。閉じた Shadow DOM の中は DevTools プロトコルで読みます）と、パネル側のボタン・ショートカット
- `tests/e2e/side-panel.spec.ts`：ビルドしたサイドパネルを `chrome.*` のモック（`tests/e2e/support/chrome-mock.ts`）付きで開き、カード表示、本文の判定（Claude・Jev・なし）、同意、英作文チェックを確かめます

不具合を直したときは、再発を防ぐテストを一緒に追加してください。サイトで問題が出たときは、該当部分を最小限のHTMLにして `tests/e2e/fixtures` に置くと再現できます。`E2E_DIST=<別ビルドのdist> npx playwright test` で、過去のリリースに対して同じテストを実行できます。

pull request と `main` への push では、GitHub Actions が型チェック、ユニットテスト、ビルド、E2Eテストを実行します。

`docs/` は GitHub Pages で公開します。使い方ガイド（`docs/index.html`）は https://s-hiraoku.github.io/page-translate-extension/ 、プライバシーポリシー（`docs/privacy.html`）は https://s-hiraoku.github.io/page-translate-extension/privacy.html です。
