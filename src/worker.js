/**
 * ハロプロ Instagram 投稿アーカイブ Worker (Static Assets 併用)
 *
 * 公開API
 *   GET /api/posts?a=&act=&order=&from=&to=&q=&before=   投稿を新しい順に100件ずつ。a はユーザー名のカンマ区切り。act=1 は(a が無いとき)現役グループの人だけ
 *   GET /api/calendar?ym=YYYY-MM&a=&q=        その月の日ごとの投稿数(a / q の条件込み)。ym なしなら月ごとの投稿数
 *   GET /api/accounts                         絞り込み用のアカウント一覧
 *   GET /api/day?d=YYYY-MM-DD                 その日の投稿を時刻の順に(/day のページ用)
 *   POST /api/takedown                        削除・公開停止の依頼(about のフォーム)。Discord にも知らせる
 *
 * クローラ用API (Authorization: Bearer <CRAWL_TOKEN>。未設定なら存在しないことにする)
 *   GET  /api/crawl/state      アカウントごとの取得の進み具合
 *   POST /api/crawl/accounts   SNSスプシ由来の対象アカウントを丸ごと差し替え(外れた人は active=0)。
 *                              remove の人は、アカウントと投稿を D1 から消す(載せないと決めた人)。
 *                              drop の人(個人アカウントのOG)も消す。ただし公式APIで入った投稿がある人は残す
 *   POST /api/crawl/posts      1ページ分の投稿と、そのアカウントの進み具合をまとめて書く
 *   POST /api/crawl/error      取得エラーを記録
 *   POST /api/crawl/paste      取り込みページから、個人アカウントの投稿を書く(public/import.html)
 *   POST /api/crawl/apify      Apify の Webhook から。Instagram Scraper の結果を読んで、個人アカウントの投稿を書く
 *   GET  /api/crawl/gone       周回で返ってこなかった(消えたかもしれない)投稿の一覧
 *   POST /api/crawl/gone       { id, action: "delete" | "keep" } 管理人が確かめて、消す・残す
 *   GET  /api/crawl/admin      取り込みページの上のまとめ(削除依頼の一覧・アクセストークンの期限)
 *   POST /api/crawl/takedown   { id, action: "done" | "undo" | "delete" } 削除依頼に印を付ける
 *   POST /api/crawl/token      { expires_at } Fetch が調べたアクセストークンの期限(UNIX秒。0 は期限なし)
 *
 * 定期実行: 毎日 JST 20:00 に、収録件数・前回からの増加数・新着投稿を Discord へ送る(DISCORD_WEBHOOK)。
 *           アクセストークンの期限が14日を切ったとき・未対応の削除依頼があるときは、その一言も足す。
 *           毎時37分に、GitHub Actions の Fetch(公式APIの取得)を起動する(GH_DISPATCH_TOKEN)。
 *
 * それ以外は静的アセット(public/)へ。
 */

const MAX_Q = 100;         // 検索語の長さの上限
const PAGE = 100;          // 1回に返す投稿数
const EXCERPT_LEN = 80;    // 一覧に出す本文の先頭の文字数
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ============================ 正規化・bigram ============================ */

// 索引と検索で完全に同じものを使う: NFKC→小文字→日本語と英数字以外を除去
const DROP = /[^0-9a-z々぀-ヿ㐀-䶿一-鿿]/gu;

function normalize(s) {
  return (s || "").normalize("NFKC").toLowerCase().replace(DROP, "");
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

// 検索語 → FTS5 のクエリ。語ごとに bigram のフレーズ(連続一致≒部分一致)にして AND で繋ぐ。
// 「-」で始まる語は、含まない語(NOT)。含まない語だけのときは { onlyNot: true }(探せない)
function buildMatch(q) {
  const terms = [], nots = [];
  for (const raw of q.slice(0, MAX_Q).split(/[\s　]+/)) {
    const neg = /^[-－‐−]/.test(raw);
    const toks = bigrams(normalize(neg ? raw.slice(1) : raw));
    if (toks.length) (neg ? nots : terms).push('"' + toks.join(" ") + '"');
  }
  if (!terms.length) return nots.length ? { onlyNot: true } : null;
  let match = terms.join(" AND ");
  if (nots.length) match = `(${match})` + nots.map((p) => ` NOT (${p})`).join("");
  return { match };
}

/* ============================ 共通 ============================ */

function json(obj, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    // API の中身(取れないアカウントの一覧など)は検索エンジンに載せない
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-robots-tag": "noindex" },
  });
}

async function cached(request, ctx, build) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// 2026-10-13T10:00:00+0000 → JST の '2026-10-13 19:00'
function toJst(ts) {
  const d = new Date(String(ts).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  if (isNaN(d)) return null;
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}

// 合言葉を聞く画面(Basic 認証)。サイトの鍵と取り込みページで同じ realm にし、ブラウザが覚えた合言葉を使い回せるようにする
function locked() {
  return new Response("この画面は非公開です。\n", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="hello-insta", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// 合言葉が合っているか(Basic認証の形。利用者名は何でもよく、合言葉だけを見る)
function unlocked(request, pass) {
  const got = request.headers.get("authorization") || "";
  if (!got.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(got.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const given = decoded.slice(decoded.indexOf(":") + 1);
  // 長さの違いで中身が漏れないよう、最後まで見てから比べる
  if (given.length !== pass.length) return false;
  let diff = 0;
  for (let i = 0; i < pass.length; i++) diff |= given.charCodeAt(i) ^ pass.charCodeAt(i);
  return diff === 0;
}

// 片割れになったサロゲート(以前の切り方で絵文字が割れたもの)を取り除く
function dropBroken(s) {
  return String(s || "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

const nowJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

/* ============================ 公開API ============================ */

// a / from / to / q の共通条件
// 「ハロプロ現役のみ」の対象の見出し(account.section の頭)。crawler/fetch.py の GROUPS(現役グループ)と同じものを保つ
const ACTIVE_SECTIONS = ["モーニング娘。", "アンジュルム", "Juice=Juice", "つばきファクトリー", "BEYOOOOONDS", "OCHA NORMA", "ロージークロニクル"];

// 共同投稿の、持ち主以外の対象アカウント(カンマ区切り。無ければ NULL)
const CO_SQL = "(SELECT group_concat(account) FROM post_collab WHERE post_id = post.id) AS co";

// 検索語のうち、色を付ける・抜粋を合わせる語(「-」の語は除く)。正規化したもの
function searchTerms(q) {
  return q.slice(0, MAX_Q).split(/[\s　]+/)
    .filter((w) => w && !/^[-－‐−]/.test(w))
    .map(normalize).filter((w) => w.length >= 2);
}

// 本文から、検索語が最初に当たった箇所の前後を、excerpt と同じ長さ(EXCERPT_LEN 文字)で切り出す。
// 当たった箇所が先頭の近くなら null(いつもの先頭の抜粋のまま)。本文を持っていない投稿も null
const SNIP_BEFORE = 20;   // 当たった語の前に残す文字数
function snippet(caption, terms) {
  if (!caption) return null;
  const chars = Array.from(String(caption).split(/\s+/).filter(Boolean).join(" "));
  // 1文字ずつ正規化して、正規化後の位置 → 元の文字の位置の対応を作る(索引と同じ正規化)
  let flat = "";
  const map = [];
  chars.forEach((c, i) => {
    const n = normalize(c);
    for (let k = 0; k < n.length; k++) map.push(i);
    flat += n;
  });
  let at = -1;
  for (const t of terms) {
    const i = flat.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const hit = map[at];
  if (hit + 10 <= EXCERPT_LEN) return null;   // 先頭の抜粋の中に見えている
  const start = Math.max(0, hit - SNIP_BEFORE);
  const end = Math.min(chars.length, start + EXCERPT_LEN);
  return (start > 0 ? "…" : "") + chars.slice(start, end).join("").trim() + (end < chars.length ? "…" : "");
}

function filters(p) {
  const where = [];
  const args = [];
  const accounts = (p.get("a") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  // 共同投稿は、共同投稿者(post_collab)を選んだときにも出す
  if (accounts.length) {
    const qs = accounts.map(() => "?").join(",");
    where.push(`(account IN (${qs}) OR id IN (SELECT post_id FROM post_collab WHERE account IN (${qs})))`);
    args.push(...accounts, ...accounts);
  } else if (p.get("act") === "1") {
    // アカウントを選んでいないときだけ、現役グループの人に絞る(選んでいれば、その人たちを出す)
    const act = `SELECT username FROM account WHERE active = 1 AND (${ACTIVE_SECTIONS.map(() => "section LIKE ?").join(" OR ")})`;
    where.push(`(account IN (${act}) OR id IN (SELECT post_id FROM post_collab WHERE account IN (${act})))`);
    args.push(...ACTIVE_SECTIONS.map((s) => s + "%"), ...ACTIVE_SECTIONS.map((s) => s + "%"));
  }
  const from = p.get("from") || "";
  const to = p.get("to") || "";
  if (DATE_RE.test(from)) { where.push("ts >= ?"); args.push(from); }
  if (DATE_RE.test(to)) { where.push("ts < ?"); args.push(to + " 99"); } // その日の終わりまで
  const built = buildMatch(p.get("q") || "");
  if (built && built.match) {
    where.push("id IN (SELECT id FROM post_fts WHERE post_fts MATCH ?)");
    args.push(built.match);
  }
  return { where, args, notonly: !!(built && built.onlyNot) };
}

// 新しい順(order=old なら古い順)。人気順はやめた。いいね数での並べ替えは公開画面では使わない
async function handlePosts(url, env) {
  const p = url.searchParams;
  const { where, args, notonly } = filters(p);
  if (notonly) return json({ error: "notonly", posts: [], more: false });   // 含まない語(-)だけでは探せない
  const before = p.get("before") || "";
  // order=old は古い順(続きの before は「これより新しいもの」になる)
  const old = p.get("order") === "old";
  if (before) { where.push(old ? "ts > ?" : "ts < ?"); args.push(before.slice(0, 16)); }
  // 検索語があるときは本文も読み、抜粋を「当たった箇所の前後」にする(本文そのものは返さない)
  const terms = searchTerms(p.get("q") || "");
  const sql =
    "SELECT id, account, ts, permalink, media_type, excerpt" + (terms.length ? ", caption" : "") + ", " + CO_SQL + " FROM post" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + (old ? " ORDER BY ts ASC LIMIT ?" : " ORDER BY ts DESC LIMIT ?");
  const { results } = await env.DB.prepare(sql).bind(...args, PAGE).all();
  for (const r of results) {
    if (terms.length) {
      const s = snippet(r.caption, terms);
      if (s) r.excerpt = s;
      delete r.caption;
    }
    if (!r.co) delete r.co;
  }
  return json({ posts: results, more: results.length === PAGE }, 200, "public, max-age=300");
}

async function handleCalendar(url, env) {
  const p = new URLSearchParams(url.searchParams);
  const ym = p.get("ym") || "";
  p.delete("from");
  p.delete("to");
  const { where, args } = filters(p);
  // ym なし: 月ごとの件数(年×月の表と、いつから・いつまでの選択肢に使う)
  if (!ym) {
    const { results } = await env.DB
      .prepare("SELECT substr(ts, 1, 7) AS ym, COUNT(*) AS n FROM post" +
        (where.length ? " WHERE " + where.join(" AND ") : "") + " GROUP BY ym ORDER BY ym")
      .bind(...args)
      .all();
    return json({ months: results.map((r) => [r.ym, r.n]) }, 200, "public, max-age=300");
  }
  if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: "ym" }, 400);
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  where.push("ts >= ?", "ts < ?");
  args.push(ym, next);
  const { results } = await env.DB
    .prepare(`SELECT substr(ts, 1, 10) AS d, COUNT(*) AS n FROM post WHERE ${where.join(" AND ")} GROUP BY d`)
    .bind(...args)
    .all();
  const days = {};
  for (const r of results) days[r.d] = r.n;
  return json({ days }, 200, "public, max-age=300");
}

// その日(日本時間)の投稿を、時刻の早い順に全部。多すぎるときは DAY_MAX 件で切って truncated を付ける
const DAY_MAX = 1000;

async function handleDay(url, env) {
  const d = url.searchParams.get("d") || "";
  if (!DATE_RE.test(d)) return json({ error: "d" }, 400);
  const { results } = await env.DB
    .prepare("SELECT account, ts, permalink, media_type, excerpt, " + CO_SQL + " FROM post WHERE ts >= ? AND ts < ? ORDER BY ts, id LIMIT ?")
    .bind(d, d + " 99", DAY_MAX + 1)
    .all();
  const truncated = results.length > DAY_MAX;
  return json({ posts: results.slice(0, DAY_MAX), truncated }, 200, "public, max-age=300");
}

async function handleAccounts(env) {
  const [accounts, latest] = await env.DB.batch([
    env.DB.prepare(
      "SELECT a.username, a.name, a.section, a.active, s.last_error AS error, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username) AS posts, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username AND id LIKE 'web:%') AS posts_web, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username AND ifnull(excerpt, '') = '') AS nocap, " +
      // 本文なしのうち、画面から拾った分(web:)。本当に本文がないのか、拾えなかったのかは分からない
      "(SELECT COUNT(*) FROM post WHERE account = a.username AND ifnull(excerpt, '') = '' AND id LIKE 'web:%') AS nocap_web, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username AND caption IS NOT NULL AND caption != '') AS withcap, " +
      // 本文なしのうち、投稿を開いて確かめて、本当に本文がなかったもの(caption が空文字)
      "(SELECT COUNT(*) FROM post WHERE account = a.username AND ifnull(excerpt, '') = '' AND caption = '' AND id LIKE 'web:%') AS nocap_chk, " +
      "(SELECT MIN(ts) FROM post WHERE account = a.username) AS first, " +
      "(SELECT MAX(ts) FROM post WHERE account = a.username) AS last, " +
      "(SELECT permalink FROM post WHERE account = a.username ORDER BY ts DESC LIMIT 1) AS last_url, " +
      "(SELECT MAX(added_at) FROM post WHERE account = a.username) AS last_added, a.ig_count, a.ig_count_at, a.groups " +
      "FROM account a LEFT JOIN fetch_state s ON s.username = a.username ORDER BY a.active DESC, a.sort"),
    env.DB.prepare("SELECT MAX(ts) AS ts FROM post"),
  ]);
  return json({
    accounts: accounts.results,
    latest: latest.results[0] ? latest.results[0].ts : null,
  }, 200, "public, max-age=300");
}

/* ============================ 削除・公開停止の依頼 ============================ */

// アメブロ検索(ameblo.karin-archive.com)と同じ作り。IP は日付とソルトを混ぜたハッシュだけ残し、同じ人の連投を数える。
// 一覧と「対応済み」は、取り込みページ(GET /api/crawl/admin・POST /api/crawl/takedown)で見る・付ける
const TD_RATE_MIN = 10;     // レート制限の窓(分)
const TD_RATE_MAX = 5;      // 窓あたりの上限件数
const TD_LIST_LIMIT = 200;  // 取り込みページに出す件数

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleTakedown(request, env, ctx) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  if (b.website) return json({ ok: true });   // 人には見えない欄。埋まっていたら機械の送信なので黙って捨てる
  const cut = (s, n) => String(s || "").trim().slice(0, n);
  const target = cut(b.target, 300), contact = cut(b.contact, 200), message = cut(b.message, 2000);
  if (!target) return json({ error: "target" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "";
  const today = new Date().toISOString().slice(0, 10);
  const ipHash = await sha256Hex(`${env.TAKEDOWN_SALT || "hello-insta"}:${today}:${ip}`);
  const cnt = await env.DB.prepare("SELECT count(*) AS n FROM takedown WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, new Date(Date.now() + 9 * 3600e3 - TD_RATE_MIN * 60000).toISOString().slice(0, 16).replace("T", " ")).first();
  if ((cnt?.n || 0) >= TD_RATE_MAX) return json({ error: "rate" }, 429);

  const ua = (request.headers.get("user-agent") || "").slice(0, 300);
  const res = await env.DB.prepare(
    "INSERT INTO takedown (target, contact, message, user_agent, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(target, contact || null, message || null, ua, ipHash, nowJst()).run();
  const id = res.meta.last_row_id;
  if (env.DISCORD_WEBHOOK) {
    ctx.waitUntil(fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Instagram 検索",
        content: (`**削除・公開停止の依頼 #${id}**\n対象: ${target}\n連絡先: ${contact || "(なし)"}` +
          (message ? `\n${message}` : "") + `\n[取り込みページ](${SITE}/import)で対応済みにする`).slice(0, 1900),
        allowed_mentions: { parse: [] },
      }),
    }).catch(() => {}));
  }
  return json({ ok: true, id });
}

// 取り込みページの上に出す、管理人向けのまとめ(削除依頼の一覧・アクセストークンの期限)
async function crawlAdmin(env) {
  const [td, meta] = await env.DB.batch([
    env.DB.prepare("SELECT id, target, contact, message, done, created_at FROM takedown ORDER BY done ASC, id DESC LIMIT ?")
      .bind(TD_LIST_LIMIT),
    env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('token_expires_at', 'token_checked_at')"),
  ]);
  const m = Object.fromEntries(meta.results.map((r) => [r.k, r.v]));
  return json({
    takedown: td.results,
    token: { expires_at: m.token_expires_at == null ? null : Number(m.token_expires_at), checked_at: m.token_checked_at || null },
  });
}

// { id, action: "done" | "undo" | "delete" }
async function crawlTakedownDecide(request, env) {
  const { id, action } = await request.json();
  if (!Number.isInteger(id) || id <= 0) return json({ error: "bad_request" }, 400);
  if (action === "delete") await env.DB.prepare("DELETE FROM takedown WHERE id = ?").bind(id).run();
  else if (action === "done" || action === "undo") {
    await env.DB.prepare("UPDATE takedown SET done = ? WHERE id = ?").bind(action === "done" ? 1 : 0, id).run();
  } else return json({ error: "bad_request" }, 400);
  return json({ ok: true });
}

// Fetch(GitHub Actions)が、毎回 Meta の debug_token で調べたアクセストークンの期限を送ってくる。
// { expires_at }: UNIX 秒。0 は「期限なし」
async function crawlToken(request, env) {
  const { expires_at } = await request.json();
  if (!Number.isFinite(expires_at)) return json({ error: "bad_request" }, 400);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('token_expires_at', ?)").bind(String(Math.floor(expires_at))),
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('token_checked_at', ?)").bind(nowJst()),
  ]);
  return json({ ok: true });
}

// アクセストークンの期限が近いときの一言(毎日の報告に足す)。近くなければ空
const TOKEN_WARN_DAYS = 14;
async function tokenWarning(env) {
  const v = await env.DB.prepare("SELECT v FROM meta WHERE k = 'token_expires_at'").first("v");
  if (v == null || Number(v) === 0) return "";
  const days = Math.floor((Number(v) * 1000 - Date.now()) / 86400e3);
  if (days > TOKEN_WARN_DAYS) return "";
  const when = new Date(Number(v) * 1000 + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  return days < 0
    ? `\n⚠ **アクセストークン(IG_ACCESS_TOKEN)の期限が切れています**（${when}）。取得が止まっています。発行し直して GitHub の Secrets を更新してください`
    : `\n⚠ **アクセストークン(IG_ACCESS_TOKEN)の期限まで、あと ${days} 日**（${when}）。発行し直して GitHub の Secrets を更新してください`;
}

/* ============================ クローラ用API ============================ */

function authorized(request, env) {
  const token = env.CRAWL_TOKEN;
  if (!token) return false;
  const got = request.headers.get("authorization") || "";
  const want = `Bearer ${token}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function crawlState(env) {
  const { results } = await env.DB
    .prepare(
      // 件数は数えない(全投稿を数えるので重く、直後の書き込みで D1 が overloaded になることがあった。fetch.py も使っていない)
      "SELECT s.username, s.after, s.done, s.last_error, s.latest_at, s.round_after, s.round_start, s.round_at FROM fetch_state s")
    .all();
  return json({ state: results });
}

// { accounts: [{ username, name, section, sort }] }
async function crawlAccounts(request, env) {
  const { accounts, remove, drop } = await request.json();
  if (!Array.isArray(accounts) || !accounts.length) return json({ error: "empty" }, 400);
  const stmts = [env.DB.prepare("UPDATE account SET active = 0")];
  // 載せないと決めた人(fetch.py の EXCLUDED)は、対象から外すだけでなく、投稿ごと消す。
  // 対象に入っている人は消さない(書き間違いで現役の人を消さないため)
  const keep = new Set(accounts.map((a) => String(a.username)));
  for (const u of (Array.isArray(remove) ? remove : []).map(String).filter((u) => u && !keep.has(u))) {
    stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id IN (SELECT id FROM post WHERE account = ?)").bind(u));
    stmts.push(env.DB.prepare("DELETE FROM post_collab WHERE account = ?1 OR post_id IN (SELECT id FROM post WHERE account = ?1)").bind(u));
    stmts.push(env.DB.prepare("DELETE FROM post WHERE account = ?").bind(u));
    stmts.push(env.DB.prepare("DELETE FROM fetch_state WHERE username = ?").bind(u));
    stmts.push(env.DB.prepare("DELETE FROM account WHERE username = ?").bind(u));
  }
  // 個人アカウントと分かった OG。公式APIで入った投稿(id が web: でないもの)がある人は、
  // プロから個人に戻した人なので消さない(対象から外れて active=0 になるだけ)
  for (const u of (Array.isArray(drop) ? drop : []).map(String).filter((u) => u && !keep.has(u))) {
    const official = "SELECT 1 FROM post WHERE account = ?1 AND id NOT LIKE 'web:%'";
    stmts.push(env.DB.prepare(`DELETE FROM post_fts WHERE id IN (SELECT id FROM post WHERE account = ?1) AND NOT EXISTS (${official})`).bind(u));
    stmts.push(env.DB.prepare(`DELETE FROM post WHERE account = ?1 AND NOT EXISTS (${official})`).bind(u));
    stmts.push(env.DB.prepare(`DELETE FROM fetch_state WHERE username = ?1 AND NOT EXISTS (${official})`).bind(u));
    stmts.push(env.DB.prepare(`DELETE FROM account WHERE username = ?1 AND NOT EXISTS (${official})`).bind(u));
  }
  for (const a of accounts) {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO account(username, name, section, sort, active, groups) VALUES(?, ?, ?, ?, 1, ?) " +
        "ON CONFLICT(username) DO UPDATE SET name = excluded.name, section = excluded.section, " +
        "sort = excluded.sort, active = 1, groups = excluded.groups")
      .bind(String(a.username), String(a.name), String(a.section), Number(a.sort) || 0, String(a.groups || "")));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: accounts.length });
}

// permalink の /p/ /reel/ の後ろ。同じ投稿でも形が揺れるので、投稿どうしを比べるときはここだけを見る
function shortcode(permalink) {
  const m = String(permalink || "").match(/\/(?:p|reel|tv)\/([^/?#]+)/);
  return m ? m[1] : "";
}

// 貼り付けで入った投稿の id。公式APIのメディアIDとは別物で、shortcode から作る
const WEB_ID = "web:";

// 一覧に出す本文の先頭。絵文字(サロゲートペア)を途中で割らないよう、文字単位(Array.from)で切る
function makeExcerpt(caption) {
  return Array.from(String(caption || "").split(/\s+/).filter(Boolean).join(" ")).slice(0, EXCERPT_LEN).join("");
}

// 本文の指紋(FNV-1a 32bit)。本文が前と同じ投稿は、重い索引(post_fts)を書き直さないのに使う
function capHash(caption) {
  let h = 0x811c9dc5;
  for (const c of String(caption || "")) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// 書こうとしている投稿(と、その貼り付け版 web:<shortcode>)のうち、もう入っているものの今の値。
// D1 の1文の値の数の上限(100)に収まるよう分けて聞く
async function knownPosts(env, ids) {
  const known = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB
      .prepare(`SELECT id, account, cap_hash, like_count, comments_count, product_type, caption IS NULL AS no_caption FROM post WHERE id IN (${part.map(() => "?").join(",")})`)
      .bind(...part).all();
    for (const r of results) known.set(r.id, r);
  }
  return known;
}

// 投稿1件を書く文を stmts に足す。{ id, caption, timestamp, permalink, media_type, like_count, comments_count }
// known(knownPosts の結果)を渡すと、本文が前と同じ投稿は索引を書き直さず、変わった数だけ書く。
// 渡さなければ毎回まるごと書く
function upsertPost(env, stmts, username, p, known) {
  const ts = toJst(p.timestamp);
  if (!p.id || !ts) return false;
  const id = String(p.id);
  const caption = p.caption || "";
  const excerpt = makeExcerpt(caption);
  const hash = capHash(caption);
  const likes = Number.isFinite(p.like_count) ? p.like_count : null;
  const comments = Number.isFinite(p.comments_count) ? p.comments_count : null;
  // 通常の投稿(FEED)かリール(REELS)か。公式APIで聞けたときだけ来る
  const product = p.media_product_type ? String(p.media_product_type) : null;
  // 公式APIで入る投稿が先に貼り付けで入っていたら(個人→プロに切り替えた人)、そちらを置き換える。
  // added_at はそちらの値を引き継ぐ(毎日の報告で新着に出し直さないため)
  const webId = id.startsWith(WEB_ID) ? null : WEB_ID + shortcode(p.permalink);
  const prev = known && known.get(id);
  if (prev && prev.cap_hash === hash && !(webId && known.has(webId))) {
    // 本文が前と同じ: いいね数・コメント数・持ち主・種類が変わったときだけ、その列を書く
    // (いいね数を非表示にされたら値が来ないので、前に取れた数を残す)
    const nextLikes = likes ?? prev.like_count, nextComments = comments ?? prev.comments_count;
    const nextProduct = product ?? prev.product_type;
    // 本文(caption)をまだ持っていない投稿(列を足す前に入ったもの)は、本文も書く
    const fill = prev.no_caption && caption;
    if (fill || prev.account !== username || prev.like_count !== nextLikes || prev.comments_count !== nextComments ||
        prev.product_type !== nextProduct) {
      stmts.push(env.DB.prepare("UPDATE post SET account = ?, like_count = ?, comments_count = ?, product_type = ?, caption = coalesce(?, caption) WHERE id = ?")
        .bind(username, nextLikes, nextComments, nextProduct, fill ? caption : null, id));
    }
    return true;
  }
  // 取り直しでは added_at を変えない(初めて入った日時を残す)
  stmts.push(env.DB
    .prepare(
      "INSERT INTO post(id, account, ts, permalink, media_type, excerpt, added_at, like_count, comments_count, cap_hash, product_type, caption) " +
      "VALUES(?, ?, ?, ?, ?, ?, coalesce((SELECT added_at FROM post WHERE id = ?), ?), ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET account = excluded.account, ts = excluded.ts, permalink = excluded.permalink, " +
      "media_type = excluded.media_type, excerpt = excluded.excerpt, cap_hash = excluded.cap_hash, caption = excluded.caption, " +
      // いいね数を非表示にされたら値が来ないので、前に取れた数を残す
      "like_count = coalesce(excluded.like_count, like_count), " +
      "comments_count = coalesce(excluded.comments_count, comments_count), " +
      "product_type = coalesce(excluded.product_type, product_type)")
    .bind(id, username, ts, String(p.permalink || ""), p.media_type || null, excerpt, webId, nowJst(),
      likes, comments, hash, product, caption || (p.caption_checked ? "" : null)));
  // known があれば、入っていない行を消しに行く文は省く
  if (webId && (!known || known.has(webId))) {
    stmts.push(env.DB.prepare("DELETE FROM post WHERE id = ?").bind(webId));
    stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(webId));
  }
  if (!known || prev) stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(id));
  const grams = bigrams(normalize(caption)).join(" ");
  if (grams) stmts.push(env.DB.prepare("INSERT INTO post_fts(id, bigram) VALUES(?, ?)").bind(id, grams));
  return true;
}

// Instagram のプロフィールに出ている投稿数を覚える(入っている件数と比べて、取り込みが要るか見るため)。
// 投稿の書き込みとは別にし、こちらが失敗しても投稿は入るようにする
async function setIgCount(env, username, n) {
  if (!Number.isInteger(n) || n < 0) return;
  try {
    await env.DB.prepare("UPDATE account SET ig_count = ?, ig_count_at = ? WHERE username = ?").bind(n, nowJst(), username).run();
  } catch (e) {
    console.log("ig_count", username, e.message);
  }
}

// { username, posts: [{ id, caption, timestamp, permalink, media_type }], state: { after, done } | null, media_count, latest, round }
// latest: 新着を見た(最新ページ)なら true。fetch_state.latest_at に覚え、1人1日1回にするのに使う
// round: 周回のページなら { start, after, done }。start=周回の最初のページ、after=次のカーソル、done=周回を読みきった
// 投稿と進み具合を1つの batch(=トランザクション)で書く。途中で落ちても、進み具合だけ進むことはない
async function crawlPosts(request, env) {
  const { username, posts, state, media_count, latest, round } = await request.json();
  if (!username || !Array.isArray(posts)) return json({ error: "bad_request" }, 400);
  const stmts = [];
  const ids = posts.filter((p) => p.id).flatMap((p) => [String(p.id), WEB_ID + shortcode(p.permalink)]);
  const known = await knownPosts(env, ids);
  // 共同投稿は、持ち主と共同投稿者の両方の一覧に出てくる。取りに行った人の分にすると、
  // 最後に取った人へ行ったり来たりするので、持ち主に固定する:
  //   持ち主(p.username)が対象アカウントならその人 → 前に入れた人(貼り付け版も含む) → 今取っている人
  const { results: accs } = await env.DB.prepare("SELECT username FROM account").all();
  const target = new Map(accs.map((a) => [a.username.toLowerCase(), a.username]));
  for (const p of posts) {
    const prev = known.get(String(p.id)) || known.get(WEB_ID + shortcode(p.permalink));
    const owner = p.username && target.get(String(p.username).toLowerCase());
    const who = owner || (prev && prev.account) || username;
    upsertPost(env, stmts, who, p, known);
    // 持ち主以外の人の一覧で返ってきた = その人は共同投稿者。その人を選んだときにも出すよう覚える
    if (p.id && who.toLowerCase() !== String(username).toLowerCase()) {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO post_collab(post_id, account) VALUES(?, ?)").bind(String(p.id), username));
    }
  }
  if (state) {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO fetch_state(username, after, done, last_error, checked_at) VALUES(?, ?, ?, NULL, ?) " +
        "ON CONFLICT(username) DO UPDATE SET after = excluded.after, done = excluded.done, " +
        "last_error = NULL, checked_at = excluded.checked_at")
      .bind(username, state.after || null, state.done ? 1 : 0, nowJst()));
  } else {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO fetch_state(username, last_error, checked_at) VALUES(?, NULL, ?) " +
        "ON CONFLICT(username) DO UPDATE SET last_error = NULL, checked_at = excluded.checked_at")
      .bind(username, nowJst()));
  }
  if (latest) stmts.push(env.DB.prepare("UPDATE fetch_state SET latest_at = ? WHERE username = ?").bind(nowJst(), username));
  // 公式APIの返事に入っていた投稿は「まだある」。周回のあと、これが古いままの投稿を消えたかもとして出す
  const now = nowJst();
  const apiIds = posts.filter((p) => p.id).map((p) => String(p.id));
  for (let i = 0; i < apiIds.length; i += 90) {
    const part = apiIds.slice(i, i + 90);
    stmts.push(env.DB.prepare(`UPDATE post SET seen_at = ? WHERE id IN (${part.map(() => "?").join(",")})`).bind(now, ...part));
  }
  if (round) {
    if (round.start) stmts.push(env.DB.prepare("UPDATE fetch_state SET round_start = ? WHERE username = ?").bind(now, username));
    stmts.push(round.done
      ? env.DB.prepare("UPDATE fetch_state SET round_after = NULL, round_at = ? WHERE username = ?").bind(now, username)
      : env.DB.prepare("UPDATE fetch_state SET round_after = ? WHERE username = ?").bind(String(round.after || ""), username));
  }
  await env.DB.batch(stmts);
  await setIgCount(env, username, media_count);
  return json({ ok: true, count: posts.length });
}

// 消えたかもしれない投稿: 周回を読みきった人の、周回で返ってこなかった公式APIの投稿。
// 周回で返ってきた一番古い投稿より古いもの(Meta がそこより先を返さない人)と、周回を始めたあとの投稿は数えない。
// 周回の途中の人は、読みきるまで出さない。消すかどうかは管理人が決める(自動では消さない)
const GONE_SQL =
  "WITH r AS (SELECT s.username, s.round_start, " +
  "  (SELECT min(q.ts) FROM post q WHERE q.account = s.username AND q.seen_at >= s.round_start) AS oldest " +
  "  FROM fetch_state s WHERE s.round_at IS NOT NULL AND s.round_start IS NOT NULL AND s.round_at >= s.round_start) " +
  "SELECT p.id, p.account, ifnull(a.name, p.account) AS name, p.ts, p.permalink, p.excerpt, p.seen_at, r.round_start " +
  "FROM r JOIN post p ON p.account = r.username AND p.ts >= r.oldest AND p.ts < r.round_start " +
  "LEFT JOIN account a ON a.username = p.account " +
  "WHERE p.id NOT LIKE 'web:%' AND p.keep IS NULL AND (p.seen_at IS NULL OR p.seen_at < r.round_start)";
const GONE_MAX = 500;
// 1人の候補が、これを超えたら「APIの異常かも」とみて、一覧に出さず、人ごとにまとめて知らせる。
// 本当に何十件も消えることはまずなく、周回で Meta が期間ごと飛ばして返したときに、まとめて誤検出されるため(石田亜佑美で約2年分が出た。2026-11-20)
const GONE_SUSPECT = 50;

// 候補が多すぎる人 [{account, name, n}]
async function goneSuspects(env) {
  const { results } = await env.DB
    .prepare(`SELECT account, name, COUNT(*) AS n FROM (${GONE_SQL}) GROUP BY account HAVING COUNT(*) > ${GONE_SUSPECT} ORDER BY n DESC`)
    .all();
  return results;
}

// ?account=ユーザー名 を付けると、その人の候補を(多くても)出す
async function crawlGone(env, url) {
  const only = url ? url.searchParams.get("account") || "" : "";
  if (only) {
    const { results } = await env.DB
      .prepare(`SELECT * FROM (${GONE_SQL}) WHERE account = ? ORDER BY ts DESC LIMIT ${GONE_MAX + 1}`)
      .bind(only).all();
    return json({ posts: results.slice(0, GONE_MAX), more: results.length > GONE_MAX, suspects: [] });
  }
  const suspects = await goneSuspects(env);
  const skip = suspects.map((s) => s.account);
  const where = skip.length ? ` WHERE account NOT IN (${skip.map(() => "?").join(",")})` : "";
  const { results } = await env.DB
    .prepare(`SELECT * FROM (${GONE_SQL})${where} ORDER BY account, ts DESC LIMIT ${GONE_MAX + 1}`)
    .bind(...skip).all();
  return json({ posts: results.slice(0, GONE_MAX), more: results.length > GONE_MAX, suspects });
}

// { id, action: "delete" | "keep" }。消えたかもしれない投稿を、管理人が確かめて消す・残す
async function crawlGoneDecide(request, env) {
  const { id, action, account } = await request.json();
  // その人の候補を、全部残す(周回の飛ばしで、まとめて候補に入ったとき)
  if (action === "keep_all" && account) {
    await env.DB.prepare(`UPDATE post SET keep = 1 WHERE id IN (SELECT id FROM (${GONE_SQL}) WHERE account = ?)`).bind(String(account)).run();
    return json({ ok: true });
  }
  if (!id || String(id).startsWith(WEB_ID)) return json({ error: "bad_request" }, 400);
  if (action === "delete") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(String(id)),
      env.DB.prepare("DELETE FROM post_collab WHERE post_id = ?").bind(String(id)),
      env.DB.prepare("DELETE FROM post WHERE id = ?").bind(String(id)),
    ]);
  } else if (action === "keep") {
    await env.DB.prepare("UPDATE post SET keep = 1 WHERE id = ?").bind(String(id)).run();
  } else {
    return json({ error: "bad_request" }, 400);
  }
  return json({ ok: true });
}

// { username, error, latest }
async function crawlError(request, env) {
  const { username, error, latest } = await request.json();
  if (!username) return json({ error: "bad_request" }, 400);
  const now = nowJst();
  // 新着を見に行って失敗したとき(個人アカウントなど)も、その日は見たことにする
  await env.DB
    .prepare(
      "INSERT INTO fetch_state(username, last_error, checked_at, latest_at) VALUES(?, ?, ?, ?) " +
      "ON CONFLICT(username) DO UPDATE SET last_error = excluded.last_error, checked_at = excluded.checked_at, " +
      "latest_at = coalesce(excluded.latest_at, latest_at)")
    .bind(username, String(error || "").slice(0, 500), now, latest ? now : null)
    .run();
  return json({ ok: true });
}

// shortcode → 投稿日時(UNIX 秒)。shortcode はメディアIDを64進にしたもので、
// メディアIDの上位(23ビットより上)が Instagram 独自の起点からのミリ秒
const SHORTCODE_ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IG_EPOCH_MS = 1314220021721n;

function takenFromCode(code) {
  let n = 0n;
  for (const c of String(code).slice(0, 11)) {
    const v = SHORTCODE_ABC.indexOf(c);
    if (v < 0) return null;
    n = n * 64n + BigInt(v);
  }
  const ms = Number((n >> 23n) + IG_EPOCH_MS);
  // 起点(2011年)より前や未来になるのは、形の違う shortcode
  return ms > 1314220021721 && ms < Date.now() + 86400e3 ? Math.floor(ms / 1000) : null;
}

// { username, posts: [{ code, caption, kind }] }
// 取り込みページ(public/import.html)から。ブックマークレットが画面から拾った個人アカウントの投稿。
// 日時は shortcode から出す。本文は拾えなかったら null(入っている投稿の本文は消さない)。
// 対象アカウントの人なら受け付ける(公式APIで取れる人も、遡りの先回りとして手で入れてよい)。
// 公式APIで入っている投稿は shortcode で見て飛ばし、手で入れた分はあとで公式APIが追いついたら置き換わる(upsertPost)
const PASTE_MAX = 100;
const DRY_MAX = 5000;  // 1回に受け付ける件数(貼り付けページが分けて送る)
const EXTRA_MAX = 300;  // サイトにあって一覧に無い投稿を、確認用に返す上限
const MEDIA_TYPE = { 1: "IMAGE", 2: "VIDEO", 8: "CAROUSEL_ALBUM" };

// dry: true なら書き込まず、新規・公式で入っている・取り込み済みに振り分けた件数だけ返す(取り込みページの確認用)。
// あわせて、サイトにはあるのに今回送られてきた一覧(posts と seen)に無い投稿を extra で返す
// (公式APIはプロフィールに出ない投稿も返すので、それが何かを目で確かめるため)。
// seen: 同じときに別の人の分として送られた shortcode(他の人が持ち主の共同投稿は、その人の分になるため)。
// extra はプロフィールを一番下まで見た人(want_extra)だけ。共同投稿で数件まざっただけの人は比べても意味がない
async function crawlPaste(request, env) {
  const { username, posts, dry, ig_count, seen, want_extra } = await request.json();
  // 書き込みは1回 PASTE_MAX 件まで。数えるだけ(dry)なら1人分をまとめて受ける
  if (!username || !Array.isArray(posts) || posts.length > (dry ? DRY_MAX : PASTE_MAX)) return json({ error: "bad_request" }, 400);
  const [{ results: acc }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT username FROM account WHERE lower(username) = lower(?)").bind(String(username)),
  ]);
  if (!acc.length) return json({ error: "unknown_account", message: `@${username} は対象アカウントにいません` }, 400);
  const user = acc[0].username;
  const { results: existing } = await env.DB
    .prepare("SELECT id, ts, permalink, excerpt, caption IS NULL AS no_caption FROM post WHERE account = ?").bind(user).all();
  const official = new Set(existing.filter((r) => !r.id.startsWith(WEB_ID)).map((r) => shortcode(r.permalink)));
  const have = new Set(existing.map((r) => r.id));
  const excerptOf = new Map(existing.map((r) => [r.id, r.excerpt || ""]));

  if (dry) {
    const n = { fresh: 0, official: 0, imported: 0, invalid: 0 };
    for (const p of posts) {
      const code = String(p.code || "");
      if (!/^[A-Za-z0-9_-]+$/.test(code) || !(Number.isFinite(p.taken_at) || takenFromCode(code))) n.invalid++;
      else if (official.has(code)) n.official++;
      else if (have.has(WEB_ID + code)) n.imported++;
      else n.fresh++;
    }
    if (!want_extra) return json({ ok: true, username: user, dry: true, ...n });
    const sent = new Set(posts.map((p) => String(p.code || "")).concat(Array.isArray(seen) ? seen.map(String) : []));
    const extra = existing
      .filter((r) => !sent.has(shortcode(r.permalink)))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, EXTRA_MAX)
      .map((r) => ({ ts: r.ts, url: r.permalink, excerpt: r.excerpt || "", web: r.id.startsWith(WEB_ID) }));
    return json({ ok: true, username: user, dry: true, ...n, extra });
  }

  const noCaption = new Set(existing.filter((r) => r.no_caption).map((r) => r.id));
  return json(await writeWebPosts(env, user, posts, ig_count, { official, have, excerptOf, noCaption }));
}

// 画面から拾った投稿(取り込みページ・Apify)を web:<shortcode> で書く。
// posts: [{ code, caption, taken_at, media_type, kind, product }]。known が無ければ、その人の入っている投稿を読む
async function writeWebPosts(env, user, posts, ig_count, known) {
  if (!known) {
    const { results: existing } = await env.DB
      .prepare("SELECT id, permalink, excerpt, caption IS NULL AS no_caption FROM post WHERE account = ?").bind(user).all();
    known = {
      official: new Set(existing.filter((r) => !r.id.startsWith(WEB_ID)).map((r) => shortcode(r.permalink))),
      have: new Set(existing.map((r) => r.id)),
      excerptOf: new Map(existing.map((r) => [r.id, r.excerpt || ""])),
      noCaption: new Set(existing.filter((r) => r.no_caption).map((r) => r.id)),
    };
  }
  const { official, have, excerptOf, noCaption } = known;
  const stmts = [];
  let added = 0, updated = 0, skipped = 0, same = 0;
  for (const p of posts) {
    const code = String(p.code || "");
    const taken = Number.isFinite(p.taken_at) ? p.taken_at : takenFromCode(code);
    if (!/^[A-Za-z0-9_-]+$/.test(code) || !taken || official.has(code)) { skipped++; continue; }
    const id = WEB_ID + code;
    // 本文が拾えなかった投稿は、もう入っていれば触らない(入っている本文を空で上書きしない)
    // 取り込み済みの投稿は、本文が前と違うとき(前は拾えなかった本文が今回拾えた、など)だけ書き直す
    // (本文の列を足す前に入った投稿は、先頭が同じでも、本文を持つために書き直す)
    // 開いて確かめて本文がなかった投稿(caption が空文字)は、まだ確かめていない投稿(NULL)と分けて、空文字で印を付ける
    const checkedEmpty = p.caption === "";
    if (have.has(id) && (p.caption == null ||
        (makeExcerpt(p.caption) === excerptOf.get(id) && !(noCaption && noCaption.has(id) && p.caption)))) {
      if (checkedEmpty && noCaption && noCaption.has(id) && !excerptOf.get(id)) {
        stmts.push(env.DB.prepare("UPDATE post SET caption = '' WHERE id = ? AND caption IS NULL").bind(id));
        updated++;
      } else same++;
      continue;
    }
    const ok = upsertPost(env, stmts, user, {
      id,
      caption: String(p.caption || ""),
      caption_checked: checkedEmpty,
      timestamp: new Date(taken * 1000).toISOString(),
      // サイトでは /p/ にそろえて出すので、最初から /p/ で持つ
      permalink: `https://www.instagram.com/p/${code}/`,
      media_type: MEDIA_TYPE[p.media_type] || (p.kind === "reel" ? "VIDEO" : null),
      like_count: p.like_count,
      comments_count: p.comments_count,
      media_product_type: p.product || null,
    });
    if (!ok) skipped++;
    else if (have.has(id)) updated++;
    else added++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setIgCount(env, user, ig_count);
  return { ok: true, username: user, added, updated, same, skipped };
}

/* ============================ Apify(個人アカウントの新着) ============================ */

// Apify の Instagram Scraper のタスクを毎日動かし、終わったら Webhook でここに知らせてもらう
// (Authorization: Bearer <CRAWL_TOKEN> を Webhook のヘッダーに入れる)。
// 本文は Webhook の既定の形({ resource: { defaultDatasetId } })か { datasetId }。
// 結果は APIFY_TOKEN(Worker のシークレット)で読み、取り込みページと同じ web:<shortcode> で書く。
// 持ち主が対象アカウントならその人、対象外の人(共同投稿)なら、取りに行ったプロフィールの人の分にする
const APIFY_FIELDS = "shortCode,caption,timestamp,type,productType,ownerUsername,inputUrl";
const APIFY_TYPE = { Image: 1, Video: 2, Sidecar: 8 };

async function crawlApify(request, env) {
  if (!env.APIFY_TOKEN) return json({ error: "no_token", message: "APIFY_TOKEN が Worker に入っていません" }, 500);
  const body = await request.json().catch(() => ({}));
  const datasetId = body.datasetId || (body.resource && body.resource.defaultDatasetId);
  if (!/^[A-Za-z0-9]+$/.test(String(datasetId || ""))) return json({ error: "bad_request", message: "datasetId がありません" }, 400);
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=1&format=json&fields=${APIFY_FIELDS}`, {
    headers: { authorization: `Bearer ${env.APIFY_TOKEN}` },
  });
  if (!res.ok) return json({ error: "apify", message: `Apify が ${res.status} を返しました` }, 502);
  const items = await res.json();

  const { results: accs } = await env.DB.prepare("SELECT username FROM account").all();
  const target = new Map(accs.map((a) => [a.username.toLowerCase(), a.username]));
  const groups = new Map();
  let outside = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const profile = (String(it.inputUrl || "").match(/instagram\.com\/([A-Za-z0-9._]+)/) || [])[1];
    const user = target.get(String(it.ownerUsername || "").toLowerCase()) || target.get(String(profile || "").toLowerCase());
    const t = Date.parse(it.timestamp);
    if (!user || !it.shortCode || !Number.isFinite(t)) { outside++; continue; }
    const pt = String(it.productType || "");
    if (!groups.has(user)) groups.set(user, []);
    groups.get(user).push({
      code: String(it.shortCode),
      caption: it.caption == null ? null : String(it.caption),
      taken_at: Math.floor(t / 1000),
      media_type: APIFY_TYPE[it.type],
      product: pt === "clips" ? "REELS" : pt === "feed" || pt === "carousel_container" ? "FEED" : pt ? pt.toUpperCase() : null,
    });
  }
  const results = [];
  for (const [user, posts] of groups) {
    for (let i = 0; i < posts.length; i += PASTE_MAX) {
      results.push(await writeWebPosts(env, user, posts.slice(i, i + PASTE_MAX)));
    }
  }
  return json({ ok: true, items: Array.isArray(items) ? items.length : 0, outside, results });
}

/* ============================ 毎日の報告 ============================ */

const SITE = "https://insta.karin-archive.com";
const REPORT_LIST_MAX = 30;   // 新着として一覧に載せる最大件数(Discord の文字数上限に収める)
const FRESH_DAYS = 3;         // 新着とみなす投稿日時の古さの上限

// 収録件数と前回からの増加数、新着の一覧を送る。
// 増加数には過去分の遡りで入った古い投稿も含む。
// 新着は「前回の報告以降にDBへ入った」かつ「投稿が直近 FRESH_DAYS 日以内」のもの
// (取得は数時間おきなので、投稿日時だけで区切ると報告の直前の投稿が漏れる。遡りで入った古い投稿は除く)
async function dailyReport(env) {
  if (!env.DISCORD_WEBHOOK) return;
  const [{ results: tot }, { results: prev }] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM post"),
    env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('report_at', 'report_total')"),
  ]);
  const total = tot[0].n;
  const m = Object.fromEntries(prev.map((r) => [r.k, r.v]));
  const now = nowJst();
  // 初回は24時間前から
  const since = m.report_at || new Date(Date.now() + (9 - 24) * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const diff = m.report_total == null ? null : total - Number(m.report_total);

  const { results: fresh } = await env.DB
    .prepare(
      "SELECT p.ts, p.permalink, p.excerpt, ifnull(a.name, p.account) AS name FROM post p " +
      "LEFT JOIN account a ON a.username = p.account WHERE p.added_at > ? AND p.ts >= ? ORDER BY p.ts")
    .bind(since, new Date(Date.now() + (9 - 24 * FRESH_DAYS) * 3600e3).toISOString().slice(0, 16).replace("T", " "))
    .all();

  const lines = fresh.slice(0, REPORT_LIST_MAX).map((r) => {
    const text = Array.from(dropBroken(r.excerpt) || "（本文なし）").slice(0, 40).join("").replace(/[\[\]]/g, "");
    return `${r.ts.slice(5).replace("-", "/")} **${r.name}** [${text}](${r.permalink.replace("/reel/", "/p/")})`;
  });
  if (fresh.length > REPORT_LIST_MAX) lines.push(`ほか ${fresh.length - REPORT_LIST_MAX} 件は[サイト](${SITE}/)で`);

  // 消えたかもしれない投稿の数(数えられなくても報告は送る)
  let gone = 0, suspects = [];
  try {
    gone = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${GONE_SQL})`).first()).n;
    // 候補が多すぎる人は「APIの異常かも」として、別に知らせる(数にも内訳にも入れない)
    suspects = await goneSuspects(env);
    gone -= suspects.reduce((s, x) => s + x.n, 0);
  } catch (e) {
    console.log("gone", e.message);
  }

  // 内訳(どの人が多いか。上位5人)。何が原因で増減したかを見るため
  let goneBy = "";
  if (gone) {
    try {
      const skip = suspects.map((s) => s.account);
      const where = skip.length ? ` WHERE account NOT IN (${skip.map(() => "?").join(",")})` : "";
      const { results } = await env.DB.prepare(`SELECT name, COUNT(*) AS n FROM (${GONE_SQL})${where} GROUP BY name ORDER BY n DESC LIMIT 5`).bind(...skip).all();
      goneBy = results.map((r) => `${r.name} ${r.n}`).join("、");
    } catch (e) {
      console.log("gone by", e.message);
    }
  }

  let warn = "";
  try {
    warn = await tokenWarning(env);
    const open = (await env.DB.prepare("SELECT COUNT(*) AS n FROM takedown WHERE done = 0").first()).n;
    if (open) warn += `\n⚠ 削除・公開停止の依頼が **${open}** 件、未対応です（[取り込みページ](${SITE}/import)）`;
  } catch (e) {
    console.log("warn", e.message);
  }

  const head =
    `収録 **${total.toLocaleString()}** 件` +
    (diff == null ? "" : `（前回から ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}）`) +
    `\n新着 **${fresh.length}** 件（${since.slice(5).replace("-", "/")} 〜 ${now.slice(5).replace("-", "/")}）` +
    (gone ? `\n消えたかもしれない投稿 **${gone}** 件（[取り込みページ](${SITE}/import)で確かめる）` + (goneBy ? `\n　多い人: ${goneBy}` : "") : "") +
    warn +
    (suspects.length ? `\n候補が多すぎる人（APIが期間ごと飛ばした疑い。一覧には出していない。[取り込みページ](${SITE}/import)で確かめる）: ${suspects.map((s) => `${s.name} ${s.n}`).join("、")}` : "");

  const res = await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Instagram 検索",  // ウェブフックは karin と共用。送り主の表示だけ変える
      embeds: [{
        title: "今日の Instagram",
        url: SITE + "/",
        description: (head + (lines.length ? "\n\n" + lines.join("\n") : "")).slice(0, 4000),
        color: 0x8c6bb8,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);

  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('report_at', ?)").bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('report_total', ?)").bind(String(total)),
  ]);
}

/* ============================ Fetch の起動 ============================ */

// GitHub の定時実行は混んでいると間引かれ、1時間おきの設定でも1日4回ほどしか動かなかった。
// Cloudflare の定時実行から workflow_dispatch で起動する。
// GH_DISPATCH_TOKEN: このリポジトリの Actions を読み書きできる GitHub のトークン(Worker のシークレット)
const FETCH_CRON = "37 * * * *";  // wrangler.jsonc の triggers.crons と同じ文字列にする
const FETCH_WORKFLOW = "https://api.github.com/repos/yxmxgxn/hello-insta/actions/workflows/fetch.yml/dispatches";

async function dispatchFetch(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  const res = await fetch(FETCH_WORKFLOW, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "hello-insta-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.ok) return;
  const msg = `Fetch を起動できませんでした(GitHub ${res.status} ${(await res.text()).slice(0, 200)})`;
  console.log(msg);
  // 黙って止まらないよう Discord に知らせる。毎時鳴らないよう1日1回まで(トークンの期限切れなら作り直す)
  if (!env.DISCORD_WEBHOOK) return;
  const today = nowJst().slice(0, 10);
  const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'dispatch_alert_at'").first("v");
  if (last === today) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Instagram 検索",
      content: msg + "\n401 ならトークンの期限切れなので、作り直して Worker の GH_DISPATCH_TOKEN を入れ直してください。",
    }),
  });
  await env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('dispatch_alert_at', ?)").bind(today).run();
}

/* ============================ ルーティング ============================ */

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === FETCH_CRON) {
      ctx.waitUntil(dispatchFetch(env).catch((e) => console.log("Fetch の起動に失敗", String(e))));
      return;
    }
    ctx.waitUntil(dailyReport(env).catch((e) => console.log("毎日の報告に失敗", String(e))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 取り込みページ(管理人用)は、サイトの鍵(SITE_PASS)を外して公開したあとも、CRAWL_TOKEN を合言葉にして閉じたままにする
    // (Basic 認証。利用者名は何でもよい)。中のデータの読み書きは、別に Bearer の CRAWL_TOKEN で守っている
    if (p === "/import" || p.startsWith("/import.")) {
      if (!env.CRAWL_TOKEN) return new Response("Not found", { status: 404 });
      if (!unlocked(request, env.CRAWL_TOKEN)) return locked();
    }

    // 鍵: SITE_PASS(Worker のシークレット)があるあいだは、合言葉を知っている人だけ通す(Basic 認証。利用者名は何でもよい)。
    // 取り込みページと同じ CRAWL_TOKEN でも通す(合言葉を1つ覚えておけば両方開けるように)。
    // クローラ用APIは Bearer トークンで守っているので対象外。SITE_PASS を消せば関門ごと無くなる(取り込みページは閉じたまま)
    if (env.SITE_PASS) {
      if (p === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", {
          headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
        });
      }
      if (!p.startsWith("/api/crawl/") && !unlocked(request, env.SITE_PASS) &&
          !(env.CRAWL_TOKEN && unlocked(request, env.CRAWL_TOKEN))) {
        return locked();
      }
    }

    // 公開API: 同一IPからの叩きすぎを止める
    if (p.startsWith("/api/") && !p.startsWith("/api/crawl/") && env.RL) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429);
    }

    try {
      if (p === "/api/posts" && request.method === "GET") return await cached(request, ctx, () => handlePosts(url, env));
      if (p === "/api/calendar" && request.method === "GET") return await cached(request, ctx, () => handleCalendar(url, env));
      if (p === "/api/accounts" && request.method === "GET") return await cached(request, ctx, () => handleAccounts(env));
      if (p === "/api/day" && request.method === "GET") return await cached(request, ctx, () => handleDay(url, env));
      if (p === "/api/takedown" && request.method === "POST") return await handleTakedown(request, env, ctx);
    } catch (e) {
      return json({ error: "failed" }, 500);
    }

    if (p.startsWith("/api/crawl/")) {
      if (!authorized(request, env)) return new Response("Not found", { status: 404 });
      try {
        const route = `${request.method} ${p.slice("/api/crawl/".length)}`;
        if (route === "GET state") return await crawlState(env);
        if (route === "POST accounts") return await crawlAccounts(request, env);
        if (route === "POST posts") return await crawlPosts(request, env);
        if (route === "POST error") return await crawlError(request, env);
        if (route === "POST paste") return await crawlPaste(request, env);
        if (route === "POST apify") return await crawlApify(request, env);
        if (route === "GET gone") return await crawlGone(env, url);
        if (route === "POST gone") return await crawlGoneDecide(request, env);
        if (route === "GET admin") return await crawlAdmin(env);
        if (route === "POST takedown") return await crawlTakedownDecide(request, env);
        if (route === "POST token") return await crawlToken(request, env);
        return new Response("Not found", { status: 404 });
      } catch (e) {
        // 例外のままだと Cloudflare の汎用エラー(1101)になって原因が分からないので中身を返す
        return json({ error: "crawl", message: String((e && e.message) || e) }, 500);
      }
    }

    if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
