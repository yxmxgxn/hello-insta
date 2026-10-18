# ハロプロ Instagram 検索

https://insta.karin-archive.com/

ハロプロ現役メンバーとOG（J.P ROOM・M-line・UP-FRONT PROMOTION）の公式Instagramの投稿を、日付・メンバー・本文で探せるサイト。
[karin-archive](https://karin-archive.com/) から独立させた別 Worker・別 D1。

## 構成

| 場所 | 中身 |
|---|---|
| `src/worker.js` | 公開API（投稿・カレンダー・アカウント）とクローラ用API。正規化と bigram 化はここだけ |
| `public/` | 画面（静的ファイル。Worker を通さず配信） |
| `schema.sql` | D1 `hello-insta` のテーブル。デプロイのたびに流す |
| `crawler/fetch.py` | Graph API の Business Discovery で取得し、クローラ用API経由で D1 に書く |
| `public/import.*` | 個人アカウント用の取り込みページ（自分用）とブックマークレット |

## 動き方

- **Deploy**（`deploy.yml`）: main への push で、スキーマ適用 → Worker デプロイ
- **Fetch**（`fetch.yml`）: 2時間おき（JST の奇数時15分。遡りが終わったら1日4回に戻してよい）。対象アカウントを SNS一覧スプシから読み、全員の最新50件と、過去分の遡りを1回150回まで
- **毎日の報告**（Worker の cron）: JST 20:00 に収録件数・前回からの増加数・新着を Discord へ（Worker のシークレット `DISCORD_WEBHOOK`）
- 対象アカウントは karin-archive の SNS一覧スプシ（accounts シート）の所属で決まる。条件は `crawler/fetch.py` の `load_targets()`
- 取れるのはビジネス／クリエイターアカウントだけ。個人アカウントは Fetch の警告に出る
- **取り込み**（`public/import.html`）: 個人アカウントの分は手で入れる。`/import` を開き、合言葉（`CRAWL_TOKEN`）を欄に入れてブラウザに覚えさせ（Git には置かない）、
  ブックマークレットを Graph API とは別のアカウントでログインしたブラウザの instagram.com で押す。
  画面に出た投稿（プロフィールの一覧のリンクとサムネイルの alt、開いた投稿の本文）を拾うだけで、Instagram へは問い合わせない。
  スクロールしてためたら「送る」（開いた貼り付けページへ postMessage で渡す）か「コピー」して貼り付けページで登録。
  日時は shortcode から出す（メディアIDの上位ビットが投稿時刻）。受け付けるのは Fetch で「個人アカウント」になっている人だけ。
  id は `web:<shortcode>`。公式APIで入っている投稿は shortcode で見て飛ばし、あとでプロに切り替えた人は公式APIの分に置き換わる

## 設定

GitHub の Secrets:

| 名前 | 中身 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Workers・D1 の編集と、karin-archive.com の DNS 編集ができるトークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウントID |
| `CRAWL_TOKEN` | クローラ用APIの合言葉（適当な長いランダム文字列）。デプロイ時に Worker の Secret にも入る |
| `IG_USER_ID` | 自分のプロアカウントの Instagram ユーザーID |
| `IG_ACCESS_TOKEN` | Graph API の長期アクセストークン（約60日で切れる） |

GitHub の Variables: `CRAWL_API` = `https://insta.karin-archive.com`

## アクセストークンの更新（約60日ごと）

1. [Graph API エクスプローラー](https://developers.facebook.com/tools/explorer/)でアプリ hello・ユーザートークンを選び、
   `instagram_basic` `instagram_manage_insights` `pages_show_list` `pages_read_engagement` `business_management` で Generate Access Token
2. [アクセストークンデバッガー](https://developers.facebook.com/tools/debug/accesstoken/)に貼って「アクセストークンを延長」
3. Secrets の `IG_ACCESS_TOKEN` を差し替える
