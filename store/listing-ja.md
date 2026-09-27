# Chrome Web Store 掲載情報（日本語）

## 商品情報

- 商品名：Page Translate
- 短い説明：Jevが翻訳箇所を選び、DeepLが英語と日本語を翻訳。原文の位置と訳文をサイドパネルで確認できます。
- カテゴリ：仕事効率化（Productivity）
- 言語：日本語
- サポートURL：https://github.com/s-hiraoku/page-translate-extension/issues
- ホームページ：https://github.com/s-hiraoku/page-translate-extension
- プライバシーポリシー：https://s-hiraoku.github.io/page-translate-extension/privacy.html（公開後、HTTP 200を確認してから登録）

## 詳細な説明

ページを離れずに、英語と日本語の文章を翻訳できます。

Page Translateは、表示中のページから翻訳候補を抽出し、TypeSafe Jevが翻訳対象を選びます。選ばれた文章はDeepLで翻訳され、原文の位置と一緒にChromeサイドパネルへ表示されます。

### 主な機能

- 英語から日本語、日本語から英語へのページ翻訳
- 原文をページに残し、訳文を位置情報と一緒にサイドパネルに表示
- 項目を選ぶと原文の場所へ移動し、コネクタで対応箇所を表示
- 翻訳文をページ上に表示し、原文へ戻すモード
- TypeSafe Jevが文章ごとに翻訳対象を選定
- 英作文チェック：自分で書いた英文の訳し戻し、DeepLのお手本英訳との比較、DeepL Writeの添削（有料プランのキー）
- DeepLの接続先はキーから自動で判定（無料・有料プランを手動で選ぶこともできます）
- キーボードショートカット：Alt+Shift+Yで翻訳、Alt+Shift+Kでページクリックのオン・オフ（MacはControl+Shift、変更可能）

### APIキーについて

TypeSafe JevとDeepLのAPIキーは利用者自身で用意してください。API利用枠や料金は各サービスの契約に従います。キーはこのChromeセッションのメモリにのみ保存され、Chrome終了時または拡張機能の再読み込み・更新時に消去されます。Page Translateに共有APIキーや中継サーバーはありません。

### データの送信

翻訳開始時に、ページから抽出した候補文章とページタイトルをTypeSafe Jevへ送ります。Jevが選んだ文章だけをDeepLへ送ります。APIキーは各サービスへの認証に直接使用します。送信先はTypeSafe JevとDeepLで、Page Translateの開発者はページ文章、APIキー、翻訳結果を受信・保存しません。翻訳を始める前に拡張機能内で送信内容と送信先を表示し、同意後に処理を開始します。

個人情報や機密情報を含む文章を送る場合は、TypeSafe Jevおよび利用するDeepL APIプランの条件を確認してください。

### 権限の説明

- すべてのWebページへのアクセス：利用者が翻訳を開始したときに、表示中のページから文章を抽出し、選んだモードで表示するために使います。
- `sidePanel`：翻訳結果と設定をChromeサイドパネルに表示します。
- `storage`：表示設定とデータ送信への同意を保存し、APIキーをChromeセッション中だけ保持します。
- TypeSafe Jev / DeepLへの接続：翻訳候補の判定と文章の翻訳に使います。

サポートとプライバシーポリシーは上記URLをご覧ください。

## 画像

- アイコン：`public/icons/icon128.png`
- 日本語プロモーションタイル：`store/images/store-tile.ja.png`（440×280）
- スクリーンショット：`store/images/screenshot-ja-*.png`（1280×800以上。実機での最終撮影が必要）
- 任意のマーキー画像：未作成
- プロモーション動画：なし
