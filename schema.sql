-- ハロプロ Instagram 投稿アーカイブ D1 スキーマ(hello-insta)
-- デプロイのたびに流す(IF NOT EXISTS なので何度流しても同じ)。
--
-- Instagram 側は過去分を遡りにくいので、ここが原本になる。消すのは手でやるときだけ。
-- 本文は先頭の抜粋だけ持つ。検索は本文全体の bigram(post_fts)で行う。

CREATE TABLE IF NOT EXISTS post (
  id         TEXT PRIMARY KEY,  -- Instagram のメディアID
  account    TEXT NOT NULL,     -- ユーザー名
  ts         TEXT NOT NULL,     -- 投稿日時(JST, 'YYYY-MM-DD HH:MM')
  permalink  TEXT NOT NULL,
  media_type TEXT,              -- IMAGE / VIDEO / CAROUSEL_ALBUM
  excerpt    TEXT,              -- 本文の先頭(一覧表示用)
  added_at   TEXT,              -- このDBに初めて入った日時(JST)。毎日の報告の「新着」に使う
  like_count     INTEGER,       -- (使っていない。取らないことにした。古い列を残してあるだけで、値は消してある)
  comments_count INTEGER,       -- (同上)
  cap_hash   TEXT,              -- 本文の指紋。本文が前と同じなら索引(post_fts)を書き直さないのに使う
  product_type TEXT,            -- 公式APIの media_product_type。通常の投稿(FEED)かリール(REELS)か
  seen_at    TEXT,              -- 最後に公式APIの返事に入っていた日時(JST)。周回で返ってこなかった投稿を「消えたかも」と出すのに使う
  keep       INTEGER,           -- 1=管理人が「消えていない」と確かめた(年齢制限などで API が返さない投稿)。消えたかもに出さない
  source     TEXT,              -- 最初にどの経路で入ったか: api(公式API)・apify・import(IG取得)・manual(手で入れた)。NULL=不明(この列を足す前に入ったもの)
  caption    TEXT               -- 本文(Instagram に書かれたとおり)。画面には出さない。検索で当たった箇所の前後(excerpt と同じ長さ)を切り出すのにだけ使う
);
CREATE INDEX IF NOT EXISTS post_ts ON post(ts);
CREATE INDEX IF NOT EXISTS post_account_ts ON post(account, ts);

-- 画面から取り込んだ(web:)投稿の登録の履歴。1回の登録(Apify の1回・IG取得の送り・手で入れた1件)ごとに1行。
-- 取り込みページの履歴と、毎日の報告(Apify が来ているか)に使う
CREATE TABLE IF NOT EXISTS import_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,       -- 登録した日時(JST)
  source  TEXT NOT NULL,       -- apify / import / manual
  account TEXT NOT NULL,       -- 登録した先のアカウント(持ち主)
  added   INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  same    INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  collab  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS import_log_at ON import_log(at);

-- 共同投稿の、持ち主(post.account)以外の対象アカウント。公式APIは共同投稿を共同投稿者の一覧にも返すので、
-- 持ち主以外の人の一覧で返ってきたら、ここに書く。その人を選んだときにも出す
CREATE TABLE IF NOT EXISTS post_collab (
  post_id TEXT NOT NULL,
  account TEXT NOT NULL,
  PRIMARY KEY (post_id, account)
);
CREATE INDEX IF NOT EXISTS post_collab_account ON post_collab(account);

CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(
  id UNINDEXED,
  bigram
);

-- 対象アカウント。SNS一覧スプシから毎回まるごと送られてくる。
-- 対象から外れた人も消さずに active=0 にする(貯めた投稿をその人で絞り込めるように)
CREATE TABLE IF NOT EXISTS account (
  username TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  section  TEXT NOT NULL,       -- 選択肢の見出し(グループ名 / J.P ROOM など)
  sort     INTEGER NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  ig_count    INTEGER,           -- Instagram のプロフィールに出ている投稿数(公式APIの media_count か、IG取得が拾った数)
  ig_count_at TEXT,              -- その数を取った日時(JST)
  groups      TEXT               -- 所属したことがある現役グループの名前(",モーニング娘。,Juice=Juice,")。OG を、グループで絞る(プルダウン)のに使う
);

-- アカウントごとの取得の進み具合
CREATE TABLE IF NOT EXISTS fetch_state (
  username   TEXT PRIMARY KEY,
  after      TEXT,              -- 次に遡るときのカーソル
  done       INTEGER NOT NULL DEFAULT 0,  -- 1=過去分を遡りきった
  last_error TEXT,              -- 直近の取得エラー(取れたら NULL に戻す)
  checked_at TEXT,              -- 最後に取りに行った日時(JST)
  latest_at  TEXT,              -- 最後に新着(最新ページ)を見た日時(JST)。1人1日1回にするのに使う
  -- 周回(全部の投稿を新しい方から読み直す。書き直された本文・いいね数をそろえ、消えた投稿を見つける)
  round_after TEXT,             -- 周回の途中のカーソル(NULL=周回していない)
  round_start TEXT,             -- 今の(最後の)周回を始めた日時(JST)
  round_at    TEXT              -- 最後に周回を終えた日時(JST)
);

-- 1回きりの覚え書き(前回の毎日の報告の時刻と件数など)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 削除・公開停止の依頼(about のフォーム。アメブロ検索と同じ作り)。送られたら Discord にも知らせる。
-- 一覧と対応済みの印は、取り込みページで見る・付ける
CREATE TABLE IF NOT EXISTS takedown (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL,              -- 投稿のURL か アカウント名
  contact    TEXT,                       -- 返事が欲しい人だけ(任意)
  message    TEXT,                       -- 任意
  user_agent TEXT,
  ip_hash    TEXT,                       -- 日付とソルトを混ぜたIPのハッシュ。IPそのものは残さない(同じ人の連投を数えるため)
  done       INTEGER NOT NULL DEFAULT 0,  -- 対応済みなら1
  created_at TEXT NOT NULL
);
