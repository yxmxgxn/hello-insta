/**
 * ハロプロ Instagram 投稿アーカイブ Worker (Static Assets 併用)
 *
 * 公開API
 *   GET /api/posts?a=&from=&to=&q=&before=   投稿を新しい順に100件ずつ。a はユーザー名のカンマ区切り
 *                  &sort=popular&o=         a が1人のときだけ、いいねの多い順(数字は返さない)。o は何件目から
 *   GET /api/calendar?ym=YYYY-MM&a=&q=        その月の日ごとの投稿数(a / q の条件込み)
 *   GET /api/accounts                         絞り込み用のアカウント一覧
 *
 * クローラ用API (Authorization: Bearer <CRAWL_TOKEN>。未設定なら存在しないことにする)
 *   GET  /api/crawl/state      アカウントごとの取得の進み具合
 *   POST /api/crawl/accounts   SNSスプシ由来の対象アカウントを丸ごと差し替え(外れた人は active=0)
 *   POST /api/crawl/posts      1ページ分の投稿と、そのアカウントの進み具合をまとめて書く
 *   POST /api/crawl/error      取得エラーを記録
 *   POST /api/crawl/paste      取り込みページから、個人アカウントの投稿を書く(public/import.html)
 *
 * 定期実行: 毎日 JST 20:00 に、収録件数・前回からの増加数・新着投稿を Discord へ送る(DISCORD_WEBHOOK)。
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

// 検索語 → FTS5 のクエリ。語ごとに bigram のフレーズ(連続一致≒部分一致)にして AND で繋ぐ
function buildMatch(q) {
  const parts = [];
  for (const raw of q.slice(0, MAX_Q).split(/[\s　]+/)) {
    const toks = bigrams(normalize(raw));
    if (toks.length) parts.push('"' + toks.join(" ") + '"');
  }
  return parts.length ? parts.join(" AND ") : null;
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
function filters(p) {
  const where = [];
  const args = [];
  const accounts = (p.get("a") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (accounts.length) {
    where.push(`account IN (${accounts.map(() => "?").join(",")})`);
    args.push(...accounts);
  }
  const from = p.get("from") || "";
  const to = p.get("to") || "";
  if (DATE_RE.test(from)) { where.push("ts >= ?"); args.push(from); }
  if (DATE_RE.test(to)) { where.push("ts < ?"); args.push(to + " 99"); } // その日の終わりまで
  const match = buildMatch(p.get("q") || "");
  if (match) {
    where.push("id IN (SELECT id FROM post_fts WHERE post_fts MATCH ?)");
    args.push(match);
  }
  return { where, args };
}

// sort=popular は、メンバーを1人に絞ったときだけ受け付ける(メンバー同士の比べ合いに使わせないため)。
// いいね数の多い順に並べるだけで、数字は返さない。いいね数の無い投稿(非表示・貼り付けで入れた分)は後ろに日付順。
// 続きは o(何件目から)で取る
const MAX_OFFSET = 5000;

async function handlePosts(url, env) {
  const p = url.searchParams;
  const { where, args } = filters(p);
  const one = (p.get("a") || "").split(",").filter(Boolean).length === 1;
  const popular = p.get("sort") === "popular" && one;
  let order = " ORDER BY ts DESC LIMIT ?";
  const tail = [PAGE];
  if (popular) {
    order = " ORDER BY like_count IS NULL, like_count DESC, ts DESC LIMIT ? OFFSET ?";
    tail.push(Math.min(Math.max(parseInt(p.get("o"), 10) || 0, 0), MAX_OFFSET));
  } else {
    const before = p.get("before") || "";
    if (before) { where.push("ts < ?"); args.push(before.slice(0, 16)); }
  }
  const sql =
    "SELECT id, account, ts, permalink, media_type, excerpt FROM post" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + order;
  const { results } = await env.DB.prepare(sql).bind(...args, ...tail).all();
  return json({ posts: results, more: results.length === PAGE }, 200, "public, max-age=300");
}

async function handleCalendar(url, env) {
  const p = new URLSearchParams(url.searchParams);
  const ym = p.get("ym") || "";
  if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: "ym" }, 400);
  p.delete("from");
  p.delete("to");
  const { where, args } = filters(p);
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

async function handleAccounts(env) {
  const [accounts, latest] = await env.DB.batch([
    env.DB.prepare(
      "SELECT a.username, a.name, a.section, a.active, s.last_error AS error, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username) AS posts, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username AND id LIKE 'web:%') AS posts_web, " +
      "(SELECT MAX(ts) FROM post WHERE account = a.username) AS last, " +
      "(SELECT permalink FROM post WHERE account = a.username ORDER BY ts DESC LIMIT 1) AS last_url, " +
      "(SELECT MAX(added_at) FROM post WHERE account = a.username) AS last_added, a.ig_count, a.ig_count_at " +
      "FROM account a LEFT JOIN fetch_state s ON s.username = a.username ORDER BY a.active DESC, a.sort"),
    env.DB.prepare("SELECT MAX(ts) AS ts FROM post"),
  ]);
  return json({
    accounts: accounts.results,
    latest: latest.results[0] ? latest.results[0].ts : null,
  }, 200, "public, max-age=300");
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
      "SELECT s.username, s.after, s.done, s.last_error, s.latest_at, " +
      "(SELECT COUNT(*) FROM post WHERE account = s.username) AS posts FROM fetch_state s")
    .all();
  return json({ state: results });
}

// { accounts: [{ username, name, section, sort }] }
async function crawlAccounts(request, env) {
  const { accounts } = await request.json();
  if (!Array.isArray(accounts) || !accounts.length) return json({ error: "empty" }, 400);
  const stmts = [env.DB.prepare("UPDATE account SET active = 0")];
  for (const a of accounts) {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO account(username, name, section, sort, active) VALUES(?, ?, ?, ?, 1) " +
        "ON CONFLICT(username) DO UPDATE SET name = excluded.name, section = excluded.section, " +
        "sort = excluded.sort, active = 1")
      .bind(String(a.username), String(a.name), String(a.section), Number(a.sort) || 0));
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

// 投稿1件を書く文を stmts に足す。{ id, caption, timestamp, permalink, media_type, like_count, comments_count }
function upsertPost(env, stmts, username, p) {
  const ts = toJst(p.timestamp);
  if (!p.id || !ts) return false;
  const id = String(p.id);
  const caption = p.caption || "";
  const excerpt = makeExcerpt(caption);
  // 公式APIで入る投稿が先に貼り付けで入っていたら(個人→プロに切り替えた人)、そちらを置き換える。
  // added_at はそちらの値を引き継ぐ(毎日の報告で新着に出し直さないため)
  const webId = id.startsWith(WEB_ID) ? null : WEB_ID + shortcode(p.permalink);
  // 取り直しでは added_at を変えない(初めて入った日時を残す)
  stmts.push(env.DB
    .prepare(
      "INSERT INTO post(id, account, ts, permalink, media_type, excerpt, added_at, like_count, comments_count) " +
      "VALUES(?, ?, ?, ?, ?, ?, coalesce((SELECT added_at FROM post WHERE id = ?), ?), ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET account = excluded.account, ts = excluded.ts, permalink = excluded.permalink, " +
      "media_type = excluded.media_type, excerpt = excluded.excerpt, " +
      // いいね数を非表示にされたら値が来ないので、前に取れた数を残す
      "like_count = coalesce(excluded.like_count, like_count), " +
      "comments_count = coalesce(excluded.comments_count, comments_count)")
    .bind(id, username, ts, String(p.permalink || ""), p.media_type || null, excerpt, webId, nowJst(),
      Number.isFinite(p.like_count) ? p.like_count : null,
      Number.isFinite(p.comments_count) ? p.comments_count : null));
  if (webId) {
    stmts.push(env.DB.prepare("DELETE FROM post WHERE id = ?").bind(webId));
    stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(webId));
  }
  stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(id));
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

// { username, posts: [{ id, caption, timestamp, permalink, media_type }], state: { after, done } | null, media_count, latest }
// latest: 新着を見た(最新ページ)なら true。fetch_state.latest_at に覚え、1人1日1回にするのに使う
// 投稿と進み具合を1つの batch(=トランザクション)で書く。途中で落ちても、進み具合だけ進むことはない
async function crawlPosts(request, env) {
  const { username, posts, state, media_count, latest } = await request.json();
  if (!username || !Array.isArray(posts)) return json({ error: "bad_request" }, 400);
  const stmts = [];
  for (const p of posts) upsertPost(env, stmts, username, p);
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
  await env.DB.batch(stmts);
  await setIgCount(env, username, media_count);
  return json({ ok: true, count: posts.length });
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
const MEDIA_TYPE = { 1: "IMAGE", 2: "VIDEO", 8: "CAROUSEL_ALBUM" };

// dry: true なら書き込まず、新規・公式で入っている・取り込み済みに振り分けた件数だけ返す(取り込みページの確認用)
async function crawlPaste(request, env) {
  const { username, posts, dry, ig_count } = await request.json();
  // 書き込みは1回 PASTE_MAX 件まで。数えるだけ(dry)なら1人分をまとめて受ける
  if (!username || !Array.isArray(posts) || posts.length > (dry ? DRY_MAX : PASTE_MAX)) return json({ error: "bad_request" }, 400);
  const [{ results: acc }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT username FROM account WHERE lower(username) = lower(?)").bind(String(username)),
  ]);
  if (!acc.length) return json({ error: "unknown_account", message: `@${username} は対象アカウントにいません` }, 400);
  const user = acc[0].username;
  const { results: existing } = await env.DB
    .prepare("SELECT id, permalink, excerpt FROM post WHERE account = ?").bind(user).all();
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
    return json({ ok: true, username: user, dry: true, ...n });
  }

  const stmts = [];
  let added = 0, updated = 0, skipped = 0, same = 0;
  for (const p of posts) {
    const code = String(p.code || "");
    const taken = Number.isFinite(p.taken_at) ? p.taken_at : takenFromCode(code);
    if (!/^[A-Za-z0-9_-]+$/.test(code) || !taken || official.has(code)) { skipped++; continue; }
    const id = WEB_ID + code;
    // 本文が拾えなかった投稿は、もう入っていれば触らない(入っている本文を空で上書きしない)
    // 取り込み済みの投稿は、本文が前と違うとき(前は拾えなかった本文が今回拾えた、など)だけ書き直す
    if (have.has(id) && (p.caption == null || makeExcerpt(p.caption) === excerptOf.get(id))) { same++; continue; }
    const ok = upsertPost(env, stmts, user, {
      id,
      caption: String(p.caption || ""),
      timestamp: new Date(taken * 1000).toISOString(),
      // サイトでは /p/ にそろえて出すので、最初から /p/ で持つ
      permalink: `https://www.instagram.com/p/${code}/`,
      media_type: MEDIA_TYPE[p.media_type] || (p.kind === "reel" ? "VIDEO" : null),
      like_count: p.like_count,
      comments_count: p.comments_count,
    });
    if (!ok) skipped++;
    else if (have.has(id)) updated++;
    else added++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setIgCount(env, user, ig_count);
  return json({ ok: true, username: user, added, updated, same, skipped });
}

/* ============================ 自分用のランキング ============================ */

// /_rank?t=<CRAWL_TOKEN>&a=<ユーザー名>&y=<年>&by=likes|comments
// いいね数・コメント数の多い順の上位。公開画面・公開APIには出さない数字なので、合言葉が無ければ404のふりをする。
// 数字は最後に取ったときのもの(最新の50件は取得のたびに更新、遡りで入った古い投稿はそのときの値のまま)
const RANK_LIMIT = 100;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sameText(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleRank(url, env) {
  const p = url.searchParams;
  const token = p.get("t") || "";
  if (!sameText(token, env.CRAWL_TOKEN || "")) return new Response("Not found", { status: 404 });

  const by = p.get("by") === "comments" ? "comments_count" : "like_count";
  const account = p.get("a") || "";
  const year = /^\d{4}$/.test(p.get("y") || "") ? p.get("y") : "";
  const where = [`p.${by} IS NOT NULL`];
  const args = [];
  if (account) { where.push("p.account = ?"); args.push(account); }
  if (year) { where.push("p.ts >= ? AND p.ts < ?"); args.push(year, String(Number(year) + 1)); }

  const [{ results: rows }, { results: accounts }, { results: years }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT p.ts, p.permalink, p.excerpt, p.media_type, p.like_count, p.comments_count, " +
      "ifnull(a.name, p.account) AS name FROM post p LEFT JOIN account a ON a.username = p.account " +
      `WHERE ${where.join(" AND ")} ORDER BY p.${by} DESC LIMIT ${RANK_LIMIT}`).bind(...args),
    env.DB.prepare("SELECT username, name FROM account WHERE active = 1 ORDER BY sort"),
    env.DB.prepare("SELECT DISTINCT substr(ts, 1, 4) AS y FROM post ORDER BY y DESC"),
  ]);

  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const n = (x) => (x == null ? "" : Number(x).toLocaleString("ja-JP"));
  const body = rows.map((r, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td class="num">${n(r.like_count)}</td>
    <td class="num">${n(r.comments_count)}</td>
    <td>${esc(r.ts.replace(/-/g, "/"))}</td>
    <td>${esc(r.name)}</td>
    <td><a href="${esc(r.permalink.replace("/reel/", "/p/"))}" target="_blank" rel="noopener noreferrer">${esc(r.excerpt || "（本文なし）")}</a></td>
  </tr>`).join("");

  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ランキング（自分用）</title>
<style>
  body { font-family: "Noto Sans JP", sans-serif; margin: 16px; color: #1f1f1f; background: #fafaf8; }
  form { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  th, td { border-bottom: 1px solid #e4e2dd; padding: 6px; text-align: left; vertical-align: top; }
  th { background: #f0eef8; white-space: nowrap; }
  td.num { text-align: right; white-space: nowrap; }
  td a { color: #8C6BB8; word-break: break-all; }
  p { color: #6b6b6b; font-size: .85rem; }
</style></head><body>
<h1>ランキング（自分用）</h1>
<form method="get">
  <input type="hidden" name="t" value="${esc(token)}">
  <select name="by">${opt("likes", "いいね数", p.get("by") === "comments" ? "" : "likes")}${opt("comments", "コメント数", p.get("by") === "comments" ? "comments" : "")}</select>
  <select name="a">${opt("", "全員", account)}${accounts.map((a) => opt(a.username, a.name, account)).join("")}</select>
  <select name="y">${opt("", "全期間", year)}${years.map((y) => opt(y.y, y.y + "年", year)).join("")}</select>
  <button type="submit">表示</button>
</form>
<p>上位${RANK_LIMIT}件。数字は最後に取ったときのもの（最近の投稿は取得のたびに更新、古い投稿は取ったときの値）。いいね数を非表示にしている投稿は出ません。</p>
<table><thead><tr><th>#</th><th>いいね</th><th>コメント</th><th>日時</th><th>名前</th><th>本文</th></tr></thead>
<tbody>${body || '<tr><td colspan="6">まだデータがありません</td></tr>'}</tbody></table>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
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

  const head =
    `収録 **${total.toLocaleString()}** 件` +
    (diff == null ? "" : `（前回から ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}）`) +
    `\n新着 **${fresh.length}** 件（${since.slice(5).replace("-", "/")} 〜 ${now.slice(5).replace("-", "/")}）`;

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

/* ============================ ルーティング ============================ */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReport(env).catch((e) => console.log("毎日の報告に失敗", String(e))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 鍵: SITE_PASS(Worker のシークレット)があるあいだは、合言葉を知っている人だけ通す(Basic 認証。利用者名は何でもよい)。
    // クローラ用APIは Bearer トークンで守っているので対象外。SITE_PASS を消せば関門ごと無くなる
    if (env.SITE_PASS) {
      if (p === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", {
          headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
        });
      }
      if (!p.startsWith("/api/crawl/") && !unlocked(request, env.SITE_PASS)) {
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
    } catch (e) {
      return json({ error: "failed" }, 500);
    }

    if (p === "/_rank" && request.method === "GET") {
      try {
        return await handleRank(url, env);
      } catch (e) {
        return new Response("error", { status: 500 });
      }
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
        return new Response("Not found", { status: 404 });
      } catch (e) {
        // 例外のままだと Cloudflare の汎用エラー(1101)になって原因が分からないので中身を返す
        return json({ error: "crawl", message: String((e && e.message) || e) }, 500);
      }
    }

    if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    // 取り込みページは /paste から /import に名前を変えた(TikTok とそろえる)。古いブックマークやブックマークレットの「送る」用
    if (p === "/paste" || p === "/paste.html") return Response.redirect(new URL("/import" + url.search, url).toString(), 301);
    return env.ASSETS.fetch(request);
  },
};
