# Instagram の取り方(全体のまとめ)

ハロプロのメンバー・OG の Instagram の投稿を、どこから・どう取って D1 に入れているかのまとめ。
次の作業を始めるときは、まずここを読む。

## いちばん大事なこと

**宮本佳林さん(`karin_miyamoto.official`)は絶対。何においても最優先で、常に最新にしておく。**
サイトの編集にも使うので、新着が遅れてはいけない。

- 公式APIの新着確認は、ほかの人(週1回)とは別に **3時間ごと** に見て、新着を見る番の **一番先** に回す
  (`crawler/fetch.py` の `PRIORITY` / `PRIORITY_EVERY`)。回数制限で止まる前に必ず見る
- 個人アカウントの `miyamoto_mg` は公式APIでは取れない。Apify か IG取得で入れる
- 取得の仕組みを変えるときは、まず宮本さんが取れ続けるかを確かめる

## 取り方は4つ

| 取り方 | 対象 | 自動か | 中身 |
|---|---|---|---|
| 公式API(Graph API の Business Discovery) | プロアカウント(ビジネス/クリエイター)の人 | 毎時 | `crawler/fetch.py`。いいね数・種類・持ち主まで取れる |
| Apify(Instagram Scraper) | 個人アカウントで、よく投稿する人(高瀬くるみ、Juice=Juice など) | 毎朝 | Apify の Webhook → `POST /api/crawl/apify` |
| IG取得(ブックマークレット) | 個人アカウントの人の過去分、たまにしか投稿しない人 | 手で | `/import` のページ。画面に出た投稿を読むだけ |
| 公式の埋め込み | 見るとき | - | 一覧の「▶ ここで見る」で Instagram 公式の embed.js |

どの取り方で入っても、同じ投稿は1件にまとまる(公式APIは Instagram のメディアID、それ以外は `web:<shortcode>`)。
個人アカウントの人がプロに切り替えたら、公式APIの分が `web:` の分を置き換える(最初に入った日時は引き継ぐ)。

## 公式API(Fetch)

- 対象: karin-archive の SNS一覧スプシ(accounts シート)で **instagram 行がある人は全員**(現役 → J.P ROOM → M-line → UP-FRONT → その他のOG)。
  グループ公式アカウントと、`EXTRA_ACCOUNTS`(福田花音さん、ショップ・FC など)も入る。
  `EXCLUDED` の人は外す(石栗奏美さん: 鍵アカウントで何も取れない)
- 起動: **Cloudflare の Worker の定時実行(毎時37分)が GitHub の workflow_dispatch で起動する**(`GH_DISPATCH_TOKEN`)。
  GitHub の定時実行は混むと間引かれ、1時間おきでも1日4回ほどしか動かなかったため。GitHub の schedule は控えとして残している。
  起動できなかったら Discord に1日1回まで知らせる
- 1回の流れ:
  1. 新着を見る番の人の最新50件(宮本さんは3時間ごと・一番先、ほかは `LATEST_EVERY_HOURS` ごと。既定 168 = 週1回)
  2. 残った回数で、過去分の遡り(50件ずつ古い方へ)
  3. Meta の回数制限(`Application request limit reached`)に当たったらその回は終わり。1回で使えるのは 1〜90回ほどでばらつく
- 遡りが全員終わったら、GitHub の Variables に `LATEST_EVERY_HOURS=20` を入れて新着を毎日に戻す
- 個人アカウントの人は「個人アカウント(取得不可)」と記録し、新着確認のときにだけ試す(プロに切り替えたら拾うため)
- 共同投稿: 持ち主(`username`)も聞き、持ち主が対象アカウントならその人の投稿にする。対象外の人が持ち主なら、前に入れた人のまま(行ったり来たりしない)
- `media_product_type`(FEED / REELS)も聞いて `post.product_type` に入れる。断られたら警告してその項目だけ聞かずに続ける
- 返事の後ろに余計な文字が付くことがある(JSONDecodeError: Extra data)。前の部分だけ使い、読めなければその人だけ飛ばす
- D1 が混んで 500(overloaded)が返ったら、15・30・60秒あけてやり直す。本文が同じ投稿は索引(`post_fts`)を書き直さない(`cap_hash`)

## Apify(個人アカウントの新着)

- Apify の **Instagram Scraper** のタスクを、グループごとに分けて毎朝動かす(失敗やコストを分けるため)
  - Content to scrape: Posts / Instagram URLs: プロフィールの URL(Bulk edit で1行1人) / Results limit per URL: 10
  - Filter by date: **Relative で 3 days**(取りこぼし防止のゆとり)
  - **Maximum cost per run を必ず十分にする**(1件 $0.0027 ほど。低いと1件取ったところで止まる。人数 × 10件 × $0.003 より大きく)
  - Memory 512MB、Timeout 600秒で足りる
  - スケジュール: 毎朝(例 JST 6:00 = cron `0 21 * * *` UTC)。グループごとに10分ずつずらす
- 終わったら **Webhook**(Run succeeded)で `https://insta.karin-archive.com/api/crawl/apify` に POST
  - ヘッダー: `{"Authorization": "Bearer <CRAWL_TOKEN>"}`、本文は既定のまま
  - Webhook はタスクごとに付けるか、取得ツール(Actor)に1つ付ける
- サイト側: 結果を `APIFY_TOKEN`(Worker のシークレット)で読み、`web:<shortcode>` で書く。
  持ち主が対象アカウントならその人、対象外の人(共同投稿)なら取りに行ったプロフィールの人の分
- 確かめ方: `https://api.apify.com/v2/webhook-dispatches?token=<APIFY_TOKEN>&desc=1&limit=5` をブラウザで開き、
  `responseBody` の `added`(新しく入った)/ `same`(もう入っていた)を見る
- Apify の結果の `timestamp` は UTC。サイトは JST で持つ(9時間ずれて見えるのは正しい)
- 料金: 月 $5 ほどの無料枠。直近3日だけなら、数人〜十数人で月 $1 前後

## IG取得(ブックマークレット)

- `/import` のページから **IG取得** をブックマークバーへドラッグして使う。
  **対象アカウントが増えたら、ドラッグし直す**(対象の一覧がリンクに埋め込まれるため)
- 取り込み用の別アカウントでログインしたブラウザ(画像オフの専用 Chrome)で、プロフィールを開いて押す →
  Scroll で一番下まで → 送る → 取り込みページで登録
- 投稿タブ・リールタブでは、持ち主が対象外の人の共同投稿も、開いている人の投稿として拾う。タグ付け・リポストのタブは拾わない
- 取り込みページの表の「あと N」が大きい人が、まだ取れていない人。「IG N件」は Instagram のプロフィールの投稿数
- 一番下まで送ると「サイトにあって今回の一覧に無い投稿」がリンク付きで出る(消えた投稿・隠れたリールの確認用)
- 注意: Instagram の利用規約は「許可なく自動化された手段での取得」を禁止している。
  ゆっくり(5〜8秒おき)、窓は少なめ、こまめに休む。メインのアカウントでは使わない

## 数がずれる理由(気にしなくてよいもの)

- **サイトの方が多い**: 公式APIは、本人が共同投稿者になっている投稿もその人の一覧に返す。
  Instagram のプロフィールの「投稿 N件」はそれを数えない(広本瑠璃さん 176 / IG 145 など)
- **サイトの方が少し少ない**: 持ち主が別の人の共同投稿は、持ち主の分に入る
- 共同投稿の本当の持ち主は、`instagram.com/適当な名前/p/<shortcode>/` を開くと持ち主の名前に直される(リダイレクト)ので、それで確かめられる

## 鍵・設定のありか

| 名前 | 場所 | 使い道 |
|---|---|---|
| `CRAWL_TOKEN` | GitHub Secrets(デプロイで Worker にも入る)/ 取り込みページのブラウザ / Apify の Webhook ヘッダー | クローラ用API の合言葉。**GitHub の値が正**(Cloudflare だけ変えても次のデプロイで戻る)。忘れたら取り込みページで F12 → `copy(localStorage.crawlToken)` |
| `IG_USER_ID` / `IG_ACCESS_TOKEN` | GitHub Secrets | 公式API。トークンは約60日で切れる(README の手順で更新) |
| `GH_DISPATCH_TOKEN` | Cloudflare の Worker シークレット | 毎時 Fetch を起動。fine-grained、このリポジトリの Actions を Read and write。約1年で切れる |
| `APIFY_TOKEN` | Cloudflare の Worker シークレット | Apify の結果を読む(Apify → Settings → API & Integrations) |
| `DISCORD_WEBHOOK` | Cloudflare の Worker シークレット | 毎日 20:00 の報告と、Fetch を起動できなかったときの知らせ |
| `LATEST_EVERY_HOURS` | GitHub Variables(無ければ 168) | 新着を見る間隔 |

## これからやるかもしれないこと

- 遡りが全員終わったら `LATEST_EVERY_HOURS=20` に戻す
- Apify を Juice=Juice → アンジュルムへ広げる(安定を見てから)
- 公開ページ(日付から「あの日」をたどる)。サイト名に「Instagram」「インスタ」を入れるのは Instagram のブランドガイドラインに触れるかもしれない
- IG取得の種類(写真・動画・複数枚)をサムネイルのアイコンから読む
