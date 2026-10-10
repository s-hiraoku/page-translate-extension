/**
 * The terms of the reader's dictionary (see dictionary.ts), one "term = translation" per line. The
 * whole dictionary is stored as one text under GLOSSARY_KEY, so it can be edited and copied as it is.
 */

export const GLOSSARY_KEY = "pageTranslateGlossary";
/** Longest dictionary text that is kept (characters). Only the parts a passage needs are sent. */
export const GLOSSARY_MAX_CHARS = 100_000;

export interface GlossaryEntry {
  term: string;
  translation: string;
}

/**
 * Entries from the glossary text. A line is "term = translation" or "term<Tab>translation" (as pasted
 * from a spreadsheet); empty lines, lines starting with # and lines without both sides are skipped.
 */
export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(.+?)\s*(?:\t|=)\s*(.+)$/.exec(trimmed);
    const term = match?.[1]?.trim();
    const translation = match?.[2]?.trim();
    if (term && translation) entries.push({ term, translation });
  }
  return entries;
}

/**
 * The entries a text uses, as the term found in the text and how to render it. An entry works both
 * ways: when the text has the translation instead (a Japanese page translated into English), it is
 * rendered as the term. `reverseFirst` tries that direction first, for text translated into the
 * terms' language.
 */
export function glossaryFor(entries: GlossaryEntry[], text: string, reverseFirst = false): GlossaryEntry[] {
  const used: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const reversed = { term: entry.translation, translation: entry.term };
    // A text with both sides is matched in the direction the translation goes.
    const [first, second] = reverseFirst ? [reversed, entry] : [entry, reversed];
    const found = contains(text, first.term) ? first : contains(text, second.term) ? second : null;
    if (!found || seen.has(found.term.toLowerCase())) continue;
    seen.add(found.term.toLowerCase());
    used.push(found);
  }
  return used;
}

/**
 * Case-insensitive; a Latin-script term must stand as a word, so "type" does not match "prototype",
 * and a katakana term likewise, so "クラス" does not match "クラスター".
 */
function contains(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edge = (char: string) => /[A-Za-z0-9_]/.test(char) ? "A-Za-z0-9_" : /[\u30A0-\u30FF]/.test(char) ? "\\u30A0-\\u30FF" : "";
  const before = edge(term[0] ?? "");
  const after = edge(term[term.length - 1] ?? "");
  const start = before ? `(?<![${before}])` : "";
  const end = after ? `(?![${after}])` : "";
  return new RegExp(`${start}${escaped}${end}`, "i").test(text);
}

/**
 * A starter glossary for software documentation, as Japanese technical writing usually renders the
 * terms. Machine translation tends to get these wrong ("issue" as 問題, "deploy" as 配備).
 */
export const PROGRAMMING_GLOSSARY = `# プログラミング
pull request = プルリクエスト
issue = Issue
commit = コミット
repository = リポジトリ
branch = ブランチ
merge = マージ
rebase = リベース
fork = フォーク
clone = クローン
deploy = デプロイ
build = ビルド
release = リリース
dependency = 依存関係
package = パッケージ
library = ライブラリ
framework = フレームワーク
runtime = ランタイム
compiler = コンパイラ
interpreter = インタープリター
function = 関数
method = メソッド
argument = 引数
parameter = パラメーター
return value = 戻り値
variable = 変数
constant = 定数
type = 型
interface = インターフェース
class = クラス
instance = インスタンス
object = オブジェクト
property = プロパティ
field = フィールド
module = モジュール
namespace = 名前空間
callback = コールバック
closure = クロージャ
promise = Promise
thread = スレッド
event loop = イベントループ
exception = 例外
error handling = エラー処理
stack trace = スタックトレース
debug = デバッグ
breakpoint = ブレークポイント
test = テスト
unit test = 単体テスト
assertion = アサーション
mock = モック
refactor = リファクタリング
endpoint = エンドポイント
request = リクエスト
response = レスポンス
query = クエリ
schema = スキーマ
migration = マイグレーション
cache = キャッシュ
environment variable = 環境変数
configuration = 設定
command line = コマンドライン
shell = シェル
container = コンテナ
token = トークン
authentication = 認証
authorization = 認可
deprecated = 非推奨
backward compatible = 後方互換
breaking change = 破壊的変更
`;
