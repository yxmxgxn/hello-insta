// X のフォロー・フォロワー一覧を保存する(自分用)。x.com の上で動かす。
// ブックマークレットにするか、F12 のコンソールに丸ごと貼る。
// 画面が裏で読む GraphQL の応答(Followers / Following)を横取りするので、公式APIもログイン情報の持ち出しも要らない。
// 応答には変わらない数字の user_id があるので、@ID を変えた人も同じ人として追える。
// 先に仕掛けてから一覧を開く(開いた後だと最初の約20人が取れない)。
(function () {
  "use strict";
  if (window.__xFollowers) { window.__xFollowers.show(); return; }

  var OPS = { Followers: "フォロワー", Following: "フォロー" };
  var WAIT = [1500, 3000];   // スクロールの間(ミリ秒)
  var IDLE = 6;              // 一番下で増えない回数がこれだけ続いたら終わり
  var STORE = "xFollowers:last:";  // + 区分。前回分(このブラウザの x.com にだけ残る)
  var HEAD = ["日付", "区分", "user_id", "ID", "名前", "プロフィール", "場所", "URL", "フォロワー数", "フォロー数"];

  var lists = { "フォロワー": new Map(), "フォロー": new Map() };
  var today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);  // JST

  // ---------- 応答から人を取り出す ----------
  function unescape(s) { return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
  // TSV に入れるので、タブと改行は 1 行に潰す(比べるときも同じ形で比べる)
  function flat(s) { return String(s == null ? "" : s).replace(/\t/g, " ").replace(/\r?\n/g, "⏎"); }

  function add(kind, r) {
    if (r && r.__typename === "UserWithVisibilityResults") r = r.user;
    if (!r || !r.rest_id) return;
    var L = r.legacy || {}, C = r.core || {};
    var bio = unescape(L.description);
    ((L.entities && L.entities.description && L.entities.description.urls) || []).forEach(function (u) {
      if (u.url && u.expanded_url) bio = bio.split(u.url).join(u.expanded_url);  // t.co を元のURLに戻す
    });
    var url = (L.entities && L.entities.url && L.entities.url.urls && L.entities.url.urls[0] || {}).expanded_url || L.url || "";
    lists[kind].set(r.rest_id, {
      id: r.rest_id,
      sn: C.screen_name || L.screen_name || "",
      name: flat(C.name || L.name),
      bio: flat(bio),
      loc: flat((r.location && r.location.location) || L.location),
      url: flat(url),
      followers: L.followers_count == null ? "" : L.followers_count,
      following: L.friends_count == null ? "" : L.friends_count,
    });
  }

  function walk(kind, o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(function (x) { walk(kind, x); }); return; }
    if (typeof o.entryId === "string" && o.entryId.indexOf("user-") === 0) {
      add(kind, o.content && o.content.itemContent && o.content.itemContent.user_results && o.content.itemContent.user_results.result);
      return;
    }
    for (var k in o) walk(kind, o[k]);
  }

  function kindOf(url) {
    var m = /\/graphql\/[^/]+\/(\w+)/.exec(url || "");
    return m && OPS[m[1]];
  }
  function take(kind, text) {
    try { walk(kind, JSON.parse(text)); } catch (e) { return; }
    seen = Date.now();
    render();
  }

  // ---------- 横取り(fetch と XHR の両方) ----------
  var origFetch = window.fetch;
  window.fetch = function (input) {
    var p = origFetch.apply(this, arguments);
    var kind = kindOf(typeof input === "string" ? input : input && input.url);
    if (kind) p.then(function (res) { res.clone().text().then(function (t) { take(kind, t); }); }).catch(function () {});
    return p;
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var kind = kindOf(String(url));
    if (kind) this.addEventListener("load", function () { take(kind, this.responseText); });
    return origOpen.apply(this, arguments);
  };

  // ---------- 前回との比較 ----------
  function diff(prev, cur) {
    var out = [];
    cur.forEach(function (u, id) {
      var p = prev.get(id);
      if (!p) { out.push(["増えた", u, "", "@" + u.sn + " " + u.name]); return; }
      if (p.sn !== u.sn) out.push(["ID変更", u, "@" + p.sn, "@" + u.sn]);
      if (p.name !== u.name) out.push(["名前変更", u, p.name, u.name]);
      if (p.bio !== u.bio) out.push(["プロフ変更", u, p.bio, u.bio]);
    });
    prev.forEach(function (p, id) {
      if (!cur.has(id)) out.push(["減った", p, "@" + p.sn + " " + p.name, ""]);  // 解除・凍結・削除の区別はつかない
    });
    return out;
  }

  function rowsTsv(kind) {
    var lines = [HEAD.join("\t")];
    lists[kind].forEach(function (u) {
      // 19桁の user_id はスプシで数値にされると桁が落ちるので x: を付けて文字にする
      lines.push([today, kind, "x:" + u.id, "@" + u.sn, u.name, u.bio, u.loc, u.url, u.followers, u.following].join("\t"));
    });
    return lines.join("\n");
  }
  function diffTsv(kind, d) {
    var lines = [["日付", "区分", "変化", "user_id", "ID", "前", "今"].join("\t")];
    d.forEach(function (x) { lines.push([today, kind, x[0], "x:" + x[1].id, "@" + x[1].sn, x[2], x[3]].join("\t")); });
    return lines.join("\n");
  }

  // スプシからコピーした TSV(記録シートを丸ごとでもよい)を読む。同じ区分の一番新しい日付の分だけ使う
  function parseTsv(kind, text) {
    var col = null, rows = [];
    text.split(/\r?\n/).forEach(function (line) {
      var c = line.split("\t");
      if (c.indexOf("user_id") >= 0) { col = {}; c.forEach(function (h, i) { col[h.trim()] = i; }); return; }
      if (col && c.length > 2) rows.push(c);
    });
    if (!col) throw new Error("見出し行（user_id など）が見つかりません");
    var get = function (c, h) { return col[h] == null ? "" : (c[col[h]] || "").trim(); };
    rows = rows.filter(function (c) { return !get(c, "区分") || get(c, "区分") === kind; });
    var last = rows.reduce(function (m, c) { return get(c, "日付") > m ? get(c, "日付") : m; }, "");
    var map = new Map();
    rows.forEach(function (c) {
      if (get(c, "日付") !== last) return;
      var id = get(c, "user_id").replace(/^x:/, "");
      if (id) map.set(id, { id: id, sn: get(c, "ID").replace(/^@/, ""), name: get(c, "名前"), bio: get(c, "プロフィール") });
    });
    return { date: last, map: map };
  }

  function loadLast(kind) {
    try {
      var s = JSON.parse(localStorage.getItem(STORE + kind) || "null");
      return s && { date: s.date, map: new Map(s.users.map(function (u) { return [u.id, u]; })) };
    } catch (e) { return null; }
  }
  function saveLast(kind) {
    try {
      var users = [];
      lists[kind].forEach(function (u) { users.push({ id: u.id, sn: u.sn, name: u.name, bio: u.bio }); });
      localStorage.setItem(STORE + kind, JSON.stringify({ date: today, users: users }));
    } catch (e) {}
  }

  // ---------- 今どの一覧を開いているか・自動スクロール ----------
  var seen = 0, idle = 0, done = false, scrolling = false, stopped = false;
  function current() {
    var m = /^\/[^/]+\/(followers|following)\/?$/.exec(location.pathname);
    return m && (m[1] === "followers" ? "フォロワー" : "フォロー");
  }
  var openedLate = !!current() && document.querySelector('[data-testid="UserCell"]');
  var lastPath = location.pathname;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function scroll() {
    if (scrolling) return;
    scrolling = true; done = false; idle = 0; stopped = false;
    var kind = current();
    var n = lists[kind].size;
    while (current() === kind && !stopped) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(WAIT[0] + Math.random() * (WAIT[1] - WAIT[0]));
      var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 50;
      if (lists[kind].size > n) { n = lists[kind].size; idle = 0; } else if (atBottom) idle++;
      if (idle >= IDLE) { done = true; break; }
      render();
    }
    scrolling = false;
    render();
  }
  setInterval(function () {
    if (location.pathname !== lastPath) { lastPath = location.pathname; openedLate = false; done = false; render(); }
    var k = current();
    if (k && !scrolling && !done && !stopped && lists[k].size) scroll();
  }, 500);

  // ---------- 画面(X の上に重ねる。X は Trusted Types なので innerHTML は使わない) ----------
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  var box = el("div", "position:fixed;z-index:2147483647;top:16px;right:16px;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;" +
    "background:#fff;color:#0f1419;border:2px solid #1d9bf0;border-radius:12px;padding:12px;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)");
  var msg = el("div", "white-space:pre-wrap");
  var btns = el("div", "margin-top:8px");
  var out = el("div", "white-space:pre-wrap;margin-top:8px;font-size:13px");
  var ta = el("textarea", "display:none;width:100%;height:90px;margin-top:8px;font:11px monospace;box-sizing:border-box");
  box.appendChild(msg); box.appendChild(btns); box.appendChild(out); box.appendChild(ta);
  document.body.appendChild(box);

  function button(label, fn) {
    var b = el("button", "margin:0 6px 6px 0;padding:4px 10px;border:1px solid #cfd9de;border-radius:999px;background:#fff;color:#0f1419;cursor:pointer", label);
    b.onclick = function () { fn(b); };
    btns.appendChild(b);
    return b;
  }
  function copy(text, b, label) {
    var ok = function () { b.textContent = "コピーしました"; setTimeout(function () { b.textContent = label; }, 2000); };
    navigator.clipboard.writeText(text).then(ok, function () {
      ta.readOnly = true; ta.value = text; ta.style.display = "block"; ta.select(); b.textContent = "下を手でコピー";
    });
  }

  var compared = { "フォロワー": null, "フォロー": null };  // 区分 → { from, d }

  function summary(kind) {
    var c = compared[kind];
    if (!c) return "";
    if (!c.d.length) return "前回（" + c.from + "）から変化なし";
    var by = {};
    c.d.forEach(function (x) { (by[x[0]] = by[x[0]] || []).push(x); });
    var s = "前回（" + c.from + "）との違い";
    ["増えた", "減った", "ID変更", "名前変更", "プロフ変更"].forEach(function (t) {
      if (!by[t]) return;
      s += "\n■ " + t + " " + by[t].length + "人";
      by[t].slice(0, 30).forEach(function (x) {
        s += "\n　" + (t === "ID変更" ? x[2] + " → " + x[3] : t === "減った" ? x[2] : "@" + x[1].sn + (t === "増えた" ? " " + x[1].name : ""));
      });
      if (by[t].length > 30) s += "\n　…ほか " + (by[t].length - 30) + "人";
    });
    return s;
  }

  function render() {
    var kind = current();
    btns.textContent = "";
    var head = "X フォロー・フォロワー保存\n";
    if (!kind) {
      msg.textContent = head + "プロフィールの「フォロー中」か「フォロワー」を開いてください。開くと自動で下までスクロールします。" +
        status();
    } else if (openedLate) {
      msg.textContent = head + "一覧を開いた後に押したので、最初の約20人が取れません。\n一度プロフィールに戻ってから、もう一度「" +
        (kind === "フォロワー" ? "フォロワー" : "フォロー中") + "」を開いてください（ページの再読み込みはしない）。";
    } else {
      var n = lists[kind].size;
      msg.textContent = head + kind + ": " + n + "人" +
        (done ? "（終わり）" : stopped ? "（止めました）" : n ? "（スクロール中…）" : "（読み込み待ち。少し下にスクロールしてみてください）");
      if (n && !done && !stopped) button("止める", function () { stopped = true; render(); });
      if (n && (done || stopped)) {
        button("今回分をコピー", function (b) { saveLast(kind); copy(rowsTsv(kind), b, "今回分をコピー"); });
        var last = loadLast(kind);
        if (last) button("前回（" + last.date + "）と比べる", function () { compared[kind] = { from: last.date, d: diff(last.map, lists[kind]) }; render(); });
        button("スプシの前回分を貼って比べる", function () { ta.readOnly = false; ta.value = ""; ta.placeholder = "スプシの記録をコピーして貼る（見出し行ごと。一番新しい日付の分と比べます）"; ta.style.display = "block"; ta.focus(); ta.dataset.mode = "prev"; });
        if (compared[kind] && compared[kind].d.length) button("違いをコピー", function (b) { copy(diffTsv(kind, compared[kind].d), b, "違いをコピー"); });
      }
    }
    button("閉じる", function () { box.style.display = "none"; });
    out.textContent = kind ? summary(kind) : "";
  }
  function status() {
    var s = "";
    Object.keys(lists).forEach(function (k) { if (lists[k].size) s += "\n" + k + ": " + lists[k].size + "人 取得済み"; });
    return s;
  }
  ta.addEventListener("input", function () {
    var kind = current();
    if (ta.dataset.mode !== "prev" || !kind || !ta.value.trim()) return;
    try {
      var p = parseTsv(kind, ta.value);
      if (!p.map.size) throw new Error(kind + " の行がありません");
      compared[kind] = { from: p.date + "・スプシ", d: diff(p.map, lists[kind]) };
      ta.style.display = "none"; ta.dataset.mode = "";
      render();
    } catch (e) { out.textContent = "読めません: " + e.message; }
  });

  window.__xFollowers = { show: function () { box.style.display = "block"; render(); } };
  render();
})();
