# ハロプロ インスタ 検索

https://insta.karin-archive.com/

ハロー！プロジェクトのメンバーとOGのインスタの投稿を、日付・メンバー・本文で探せる個人の非公式サイト。
[karin-archive](https://karin-archive.com/) とは別の Worker・別の D1 で動いている。
サイトの説明は [このサイトについて](https://insta.karin-archive.com/about) と [仕組み](https://insta.karin-archive.com/tech) にある。

## 構成

| 場所 | 中身 |
|---|---|
| `src/worker.js` | 公開API（投稿・カレンダー・アカウント・日付）とクローラ用API。正規化と bigram 化はここだけ |
| `public/` | 画面（静的ファイル） |
| `schema.sql` | D1 `hello-insta` のテーブル。デプロイのたびに流す |
| `crawler/fetch.py` | Instagram Graph API の Business Discovery で取得し、クローラ用API経由で D1 に書く |
| `docs/instagram.md` | 投稿の取り方のまとめ |

## 動き方

- **Deploy**（`deploy.yml`）: main への push で、スキーマ適用 → Worker デプロイ
- **Fetch**（`fetch.yml`）: Worker の定時実行が毎時起動する。新着の確認・過去分の遡り・周回（読み直し）
- **毎日の報告**: Worker の定時実行で、収録件数と新着を Discord へ
- 公式APIで取れるのはビジネス／クリエイターアカウントだけ。個人アカウントの人の分は別の方法で入れている（`docs/instagram.md`）

## 設定

GitHub の Secrets:

| 名前 | 中身 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Workers・D1 の編集と、DNS 編集ができるトークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウントID |
| `CRAWL_TOKEN` | クローラ用APIの合言葉（長いランダム文字列）。デプロイ時に Worker の Secret にも入る |
| `IG_USER_ID` | 自分のプロアカウントの Instagram ユーザーID |
| `IG_ACCESS_TOKEN` | Graph API の長期アクセストークン（約60日で切れる） |
| `SITE_PASS` | サイトの鍵（Basic 認証の合言葉）。デプロイ時に Worker の Secret に入る。消すと鍵なしで公開になる（取り込みページ `/import` は消しても `CRAWL_TOKEN` を合言葉にして閉じたまま） |

GitHub の Variables: `CRAWL_API`（サイトのURL）。任意で `LATEST_EVERY_HOURS` `ROUND_CALLS` `ROUND_EVERY_DAYS`。

Worker の Secret（Cloudflare）: `GH_DISPATCH_TOKEN`（Fetch の起動）、`DISCORD_WEBHOOK`、`APIFY_TOKEN`。

## アクセストークンの更新（約60日ごと）

1. [Graph API エクスプローラー](https://developers.facebook.com/tools/explorer/)でアプリとユーザートークンを選び、
   `instagram_basic` `instagram_manage_insights` `pages_show_list` `pages_read_engagement` `business_management` で Generate Access Token
2. [アクセストークンデバッガー](https://developers.facebook.com/tools/debug/accesstoken/)に貼って「アクセストークンを延長」
3. Secrets の `IG_ACCESS_TOKEN` を差し替える
