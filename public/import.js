// 取り込みページ(自分用、/import)。合言葉(CRAWL_TOKEN)は欄に入れるか /import?t= で開いて、このブラウザに覚えさせる(Git には置かない)。
// ブックマークレット(grab)は instagram.com の上で動き、画面に出ている投稿を拾うだけ。Instagram へ自分から問い合わせない。
// 「送る」でこのページを開いて postMessage で受け取る。渡らないときのためにコピーもしておき、欄に貼っても入れられる。
(function () {
  "use strict";

  // ---------- ブックマークレット(instagram.com で動く。外の変数は使えない。__SITE__ はこのサイトの URL に置き換える) ----------
  // 中のコメントは行まるごとにすること(行末に付けない)。リンクにするときにコメント行を除いて1行につなぐため
  function grab(W) {
    // IG窓から渡されたときは、その窓(W)の上で動かす。ブックマークレットとして押したときは今の窓
    W = W || globalThis;
    var window = W, document = W.document, location = W.location, navigator = W.navigator;
    var setInterval = W.setInterval.bind(W), clearInterval = W.clearInterval.bind(W);
    var setTimeout = W.setTimeout.bind(W), clearTimeout = W.clearTimeout.bind(W);
    var SITE = "__SITE__";
    // 拾ってよい人(対象アカウント全員。公式APIで取れる人も遡りの先回りに入れてよい)。取り込みページがリンクを作るときに埋め込む。ほかの人の投稿は画面にあっても数えもしない
    // ユーザー名(小文字) → 表示名。パネルの見出しにも使う
    var NAMES = __NAMES__;
    var ALLOW = {};
    Object.keys(NAMES).forEach(function (u) { ALLOW[u] = true; });
    if (window.__helloInsta) { window.__helloInsta.show(); return; }

    // shortcode → { code, account, kind, caption }
    var items = new Map();
    // /p/CODE/ /reel/CODE/ のほか、/ユーザー名/p/CODE/ の形もある
    var LINK = /^\/(?:([A-Za-z0-9._]+)\/)?(p|reel)\/([A-Za-z0-9_-]{5,})/;
    var NOT_USER = /^(p|reel|reels|explore|stories|direct|accounts|tv)$/;
    // 最後に開いていたプロフィール(投稿を開くと URL が /p/ に変わるので覚えておく)
    var profile = null;
    // プロフィールの上に出ている投稿数(小文字のアカウント → 件数)。入っている件数と比べて、取り込みが要るか見る
    var counts = {}, countedPath = null;
    function numOf(s) {
      var n = parseFloat(s.replace(/,/g, ""));
      if (/万$/.test(s)) n *= 10000;
      else if (/[Kk]$/.test(s)) n *= 1000;
      else if (/[Mm]$/.test(s)) n *= 1000000;
      return Math.round(n);
    }
    // プロフィールのページ(投稿・リール・タグ付けのタブ)を開いているときだけ、上の「投稿 N件」を読む
    function readCount() {
      var path = location.pathname;
      if (!profile || !ALLOW[profile.toLowerCase()] || path === countedPath) return;
      if (!new RegExp("^/" + profile.replace(/\./g, "\\.") + "/?(reels/|tagged/)?$").test(path)) return;
      var head = (document.querySelector("main") || document.body).innerText.slice(0, 3000);
      var m = head.match(/投稿\s*([\d,.]+万?)\s*件/) || head.match(/([\d,.]+[KkMm]?)\s*posts?\b/);
      if (!m) return;
      counts[profile.toLowerCase()] = numOf(m[1]);
      countedPath = path;
    }

    // サムネイルの alt は、本文そのものか、自動で付いた説明(「Photo by …」など)。自動の方は本文として使わない
    var AUTO_ALT = /^(Photo|Video|Image)s?( shared)? by |^May be |さんによる(写真|動画|投稿)|の(画像|写真)のようです|^(写真|動画)(の説明|はありません)/;
    function captionFromAlt(alt) {
      if (!alt || AUTO_ALT.test(alt)) return null;
      return alt.trim() || null;
    }

    function put(code, account, kind, caption) {
      if (!code || !account) return;
      account = account.toLowerCase();
      if (!ALLOW[account]) return;
      var old = items.get(code);
      // 本文は、取れているものを null で消さない。両方あれば長い方(途中で切れた表示より全文)
      if (old && old.caption != null && (caption == null || old.caption.length >= caption.length)) caption = old.caption;
      items.set(code, { code: code, account: account, kind: (old && old.kind === "reel") ? "reel" : kind, caption: caption });
    }

    // ホームのフィードでは URL からも開いているページからも持ち主が分からないので、投稿のカードの上の投稿者の名前から取る
    function ownerOf(link) {
      var card = link.closest("article");
      if (!card) return null;
      var links = card.querySelectorAll('a[href^="/"]');
      for (var i = 0; i < links.length; i++) {
        var m = (links[i].getAttribute("href") || "").match(/^\/([A-Za-z0-9._]+)\/?$/);
        if (m && !NOT_USER.test(m[1])) return m[1];
      }
      return null;
    }

    function text(el) { return el ? (el.innerText || el.textContent || "").trim() : null; }

    function scan() {
      var first = location.pathname.split("/").filter(Boolean)[0];
      if (!first) profile = null;
      else if (!NOT_USER.test(first)) profile = first;
      // プロフィールの一覧(投稿タブ・リールタブ)。リンクとサムネイル
      document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(function (a) {
        var m = (a.getAttribute("href") || "").match(LINK);
        if (!m) return;
        var img = a.querySelector("img[alt]");
        put(m[3], m[1] || ownerOf(a) || profile, m[2], captionFromAlt(img && img.getAttribute("alt")));
      });
      // 投稿を1つ開いた画面(ポップアップか /p/ のページ)。本文は h1 にある
      var here = location.pathname.match(LINK);
      if (here) {
        var root = document.querySelector('div[role="dialog"] article') || document.querySelector("main article") || document;
        var h1 = root.querySelector("h1");
        var owner = here[1];
        if (!owner) {
          var a = root.querySelector('header a[href^="/"]');
          owner = a && (a.getAttribute("href").match(/^\/([A-Za-z0-9._]+)\/?$/) || [])[1];
        }
        put(here[3], owner || profile, here[2], h1 ? text(h1) : null);
      }
      readCount();
      render();
    }

    /* ---------- 画面右下のパネル(innerHTML は使わない) ---------- */

    var panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:210px;padding:5px 7px;" +
      "background:#fff;color:#1f1f1f;border:1px solid #8C6BB8;border-radius:8px;" +
      "font:11px/1.5 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    function el(tag, css, txt) {
      var e = document.createElement(tag);
      if (css) e.style.cssText = css;
      if (txt) e.textContent = txt;
      return e;
    }
    // 細い窓を並べても邪魔にならないよう、見出し(誰・件数)・お知らせ・ボタンの3行に収める
    var head = el("div", "white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
    var title = el("b", "", "hello-insta");
    var count = el("span", "margin-left:6px;color:#6b6b6b");
    head.appendChild(title); head.appendChild(count);
    var note = el("div", "color:#6b6b6b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.5em");
    var row = el("div", "display:flex;gap:4px;margin-top:2px");
    function button(label, main) {
      var b = el("button", "font:inherit;padding:0 6px;border:1px solid #8C6BB8;border-radius:4px;cursor:pointer;" +
        (main ? "background:#8C6BB8;color:#fff" : "background:#fff;color:#8C6BB8"), label);
      row.appendChild(b);
      return b;
    }
    var bSend = button("送る", true), bScroll = button("Scroll"), bCopy = button("コピー"), bClose = button("×");
    bClose.title = "閉じる";
    // 件数を3で割った行数と余り。グリッドは3列なので、余り1なら一番下の行が左に1枚だけで終わり
    var by3 = el("span", "margin-left:auto;color:#6b6b6b;white-space:nowrap");
    row.appendChild(by3);
    [head, note, row].forEach(function (e) { panel.appendChild(e); });
    document.body.appendChild(panel);

    function msg(s) { note.textContent = s; note.title = s; }

    function render() {
      var n = 0, c = 0, who = {};
      items.forEach(function (p) { n++; if (p.caption != null) c++; who[p.account] = 1; });
      var k = Object.keys(who).length;
      var ig = profile && counts[profile.toLowerCase()];
      count.textContent = n + "件（本文" + c + "）" + (k > 1 ? " " + k + "人" : "") + (ig ? " IG " + ig : "");
      var t = ig || n;
      by3.textContent = t ? Math.floor(t / 3) + "行+" + t % 3 : "";
      by3.title = (ig ? "IG の件数 " : "集めた件数 ") + t + " ÷ 3";
      if (profile && !ALLOW[profile.toLowerCase()]) msg("対象外。何も拾いません");
      // 見出しは開いているページの人(窓を並べたときに見分けられるように)
      var me = profile && profile.toLowerCase();
      title.textContent = !me ? "ホーム" : ALLOW[me] ? "@" + profile : "@" + profile + "（対象外）";
      head.title = me && NAMES[me] ? NAMES[me] : "";
    }

    function list() { return Array.from(items.values()); }

    // 送る: 取り込みページへ、受け取ったと返事が来るまで渡し続ける。受け取られたらこの窓のパネルは閉じる
    // (ほかの窓のパネルはそのまま)。渡せなかったときのために、先にクリップボードにも写しておく
    var sending = null;
    function push() {
      if (!sending) return;
      if (++sending.tries > 40) { sending = null; msg("渡せませんでした。コピー済みなので欄に貼る"); return; }
      try { sending.win.postMessage({ type: "hello-insta-posts", id: sending.id, posts: list(), counts: counts }, SITE); } catch (e) { /* 読み込み中 */ }
      sending.timer = setTimeout(push, 500);
    }
    function onMessage(e) {
      if (e.origin !== SITE || !e.data || !e.source || !sending) return;
      if (e.data.type === "hello-insta-ready") { sending.win = e.source; push(); }
      if (e.data.type === "hello-insta-got" && (e.data.id == null || e.data.id === sending.id)) { clearTimeout(sending.timer); sending = null; close(); }
    }
    window.addEventListener("message", onMessage);

    function copy() {
      return navigator.clipboard.writeText(JSON.stringify({ v: 2, posts: list(), counts: counts }))
        .then(function () { return true; }, function () { return false; });
    }

    bSend.onclick = function () {
      if (!items.size) { msg("まだ何も拾えていません"); return; }
      copy();
      // 取り込みページがもう開いていれば読み込み直さない(まだ登録していない分が消えるので)。無ければ開く
      var win = window.open("", "hello-insta-import");
      if (!win) { msg("窓が止められました。コピー済みなので欄に貼る"); return; }
      try { if (win.location.href === "about:blank") win.location.href = SITE + "/import"; } catch (e) { /* 開いている取り込みページ */ }
      if (sending) clearTimeout(sending.timer);
      sending = { win: win, id: String(Date.now()) + Math.random(), tries: 0 };
      msg("取り込みページへ渡しています…");
      push();
    };

    bCopy.onclick = function () {
      copy().then(function (ok) { msg(ok ? "コピーしました。欄に貼る" : "コピーできませんでした"); });
    };

    // 自動スクロール: 人が眺めるくらいの間隔(3〜5秒、毎回ばらつかせる)で一番下へ。伸びなくなったら終わる
    var scrollTimer = null, still = 0, lastH = 0;
    function stopScroll(s) {
      clearTimeout(scrollTimer); scrollTimer = null;
      bScroll.textContent = "Scroll";
      if (s) msg(s);
    }
    // Instagram の読み込みが遅いだけで止まらないよう粘る。伸びないときは少し戻してから下へ送り直して、続きを読み込ませる。
    // 止めるのは、約40秒(10回)伸びなかったときだけ
    function step() {
      var h = document.documentElement.scrollHeight;
      still = h === lastH ? still + 1 : 0;
      lastH = h;
      if (still >= 10) { stopScroll("一番下です。「送る」を押す"); return; }
      if (still && still % 3 === 0) {
        window.scrollBy(0, -1200);
        setTimeout(function () { window.scrollTo(0, document.documentElement.scrollHeight); }, 800);
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
      msg("Scroll中" + (still ? "（読み込み待ち " + still + "/10）" : "…"));
      scrollTimer = setTimeout(step, 3000 + Math.random() * 2000);
    }
    bScroll.onclick = function () {
      if (scrollTimer) { stopScroll("止めました"); return; }
      still = 0; lastH = 0;
      bScroll.textContent = "止める";
      msg("Scroll中…");
      step();
    };

    var timer = setInterval(scan, 800);
    function close() {
      stopScroll();
      clearInterval(timer);
      if (sending) clearTimeout(sending.timer);
      window.removeEventListener("message", onMessage);
      panel.remove();
      delete window.__helloInsta;
    }
    bClose.onclick = close;

    window.__helloInsta = { show: function () { panel.style.display = ""; scan(); }, msg: msg };
    scan();
  }

  // スマホの Chrome はアドレスバーから実行すると改行を消して1行にするので、// のコメントがあると後ろが全部コメントになる。
  // コメント行を除き、1行につないでからリンクにする(文の終わりはすべて ; で書いてある)。
  // 対象アカウントの一覧を埋め込むので、一覧を読み込んでから作る(対象が変わったらドラッグし直す)
  function toLink(fn, repl) {
    var oneLine = fn.toString().split("\n")
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^(\/\/|\/\*)/.test(l); })
      .join(" ");
    Object.keys(repl || {}).forEach(function (k) {
      oneLine = oneLine.replace(k, function () { return repl[k]; });
    });
    return "javascript:(" + encodeURIComponent(oneLine) + ")()";
  }
  var bm = document.getElementById("bm");
  bm.onclick = function (e) { e.preventDefault(); };
  // names: ユーザー名(小文字) → 表示名
  function buildLink(names) {
    var users = Object.keys(names);
    var fill = { __SITE__: location.origin, __NAMES__: JSON.stringify(names) };
    bm.href = toLink(grab, fill);
    // IG窓には、同じ中身の IG取得を埋め込む
    bmWin.href = toLink(popout, { __GRAB__: decodeURIComponent(bm.href.slice("javascript:(".length, -")()".length)) });
    bm.title = "対象 " + users.length + " 人: " + users.join(", ");
  }

  // ---------- 窓を並べるブックマークレット(instagram.com で動く) ----------
  // 今のページを、画面を COLS×ROWS に割った大きさの窓で開き直す。押すたびに左上から順に並び、COLS×ROWS 個で一周する
  // 開いた窓はブックマークバーが出ない(ポップアップ型)ので、IG取得も窓の中で自動で始める
  function popout() {
    var grab = __GRAB__;
    var COLS = 4, ROWS = 4;
    var k = 0;
    try {
      k = (parseInt(localStorage.getItem("helloInstaWin"), 10) || 0) % (COLS * ROWS);
      localStorage.setItem("helloInstaWin", String(k + 1));
    } catch (e) { k = 0; }
    // 1920×(1080−タスクバー) なら 480×約260。open の幅と高さは中身の大きさなので、開いたあと外枠込みで合わせ直す
    var w = Math.floor(screen.availWidth / COLS), h = Math.floor(screen.availHeight / ROWS);
    var left = (screen.availLeft || 0) + (k % COLS) * w;
    var top = (screen.availTop || 0) + Math.floor(k / COLS) * h;
    var win = window.open(location.href, "hi_win_" + Date.now(), "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    function fit() { try { win.resizeTo(w, h); win.moveTo(left, top); } catch (e) { /* 合わせられなくても動く */ } }
    if (!win) { alert("ポップアップが止められました。このサイトのポップアップを許可してください"); return; }
    fit();
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (tries > 60) { clearInterval(t); return; }
      try {
        if (win.closed) { clearInterval(t); return; }
        if (win.location.href === "about:blank" || win.document.readyState !== "complete" || !win.document.body) return;
      } catch (e) { return; }
      clearInterval(t);
      fit();
      // 窓の中で独立して動かす(こちらの窓が別のページへ移っても止まらない)。できなければ、こちらから窓を操作する
      try { win.eval("(" + grab.toString() + ")()"); } catch (e) {
        grab(win);
        try { win.__helloInsta.msg("元の窓を再読み込みすると止まります"); } catch (e2) { /* 出せなくても動く */ }
      }
    }, 500);
  }
  var bmWin = document.getElementById("bmWin");
  bmWin.onclick = function (e) { e.preventDefault(); };

  // ---------- 合言葉(欄に入れるか ?t= で開いたら、このブラウザに覚えておく。「送る」で開くときは ?t= が付かないため) ----------
  var KEY = "crawlToken";
  var token = "";
  var tokenInput = document.getElementById("token");
  var tokenState = document.getElementById("tokenState");
  function remember(t) {
    token = t;
    try {
      if (t) localStorage.setItem(KEY, t);
      else localStorage.removeItem(KEY);
    } catch (e) { /* 保存できないブラウザでは、このページを開いているあいだだけ使う */ }
    tokenInput.value = "";
    tokenState.textContent = t ? "合言葉: 覚えています（…" + t.slice(-4) + "）" : "合言葉: まだ入っていません（登録に要る）";
    // 入っていなければ開いておく
    document.getElementById("tokenBox").open = !t;
  }
  try { token = localStorage.getItem(KEY) || ""; } catch (e) { /* 読めないときは空のまま */ }
  var fromUrl = new URLSearchParams(location.search).get("t");
  if (fromUrl) {
    // URL に合言葉を残さない(履歴やブックマークに残るので)
    history.replaceState(null, "", location.pathname);
    remember(fromUrl);
  } else {
    remember(token);
  }
  document.getElementById("saveToken").addEventListener("click", function () { remember(tokenInput.value.trim()); });
  document.getElementById("clearToken").addEventListener("click", function () { remember(""); });

  // ---------- 貼り付け ----------
  var data = document.getElementById("data");
  var preview = document.getElementById("preview");
  var send = document.getElementById("send");
  var result = document.getElementById("result");
  var CHUNK = 100;  // Worker 側の上限(PASTE_MAX)と同じ
  var groups = null;  // アカウント → 投稿の配列
  var targets = null; // 受け付ける対象アカウント(小文字)。読み込むまでは null で、そのあいだは絞らない
  var lastData = null;
  var busy = false;
  var igCounts = {};
  var lines = {};     // 未登録の表示の、アカウントごとの行(登録を押したら、この行が結果に変わる)

  // ホームのフィードで拾うと、ファンなど対象外の人の投稿も混ざるので、対象アカウントの分だけ送る
  function take(d) {
    groups = null;
    // 登録中の表示は、登録が終わるまで残す
    if (!busy) result.textContent = "";
    if (!d || !Array.isArray(d.posts)) throw new Error("形が違います");
    lastData = d;
    var g = {}, outside = 0;
    d.posts.forEach(function (p) {
      var who = String(p.account || d.username || "").toLowerCase();
      if (!who || !p.code) return;
      if (targets && !targets[who]) { outside++; return; }
      (g[who] = g[who] || []).push(p);
    });
    var names = Object.keys(g);
    var note = outside ? "\n対象外（ファンなど）" + outside + "件は送りません" : "";
    if (!names.length) {
      preview.textContent = "対象アカウントの投稿がありません" + note;
      send.disabled = true;
      return;
    }
    groups = g;
    // プロフィールの上に出ている投稿数(IG取得が拾えたときだけ)。登録のときに一緒に送る
    igCounts = {};
    Object.keys(d.counts || {}).forEach(function (k) {
      var v = d.counts[k];
      if (Number.isInteger(v) && v >= 0) igCounts[k.toLowerCase()] = v;
    });
    var head = "未登録（「登録」を押すまで入りません）\n";
    function show(counts) {
      lines = {};
      preview.textContent = head + names.map(function (n) {
        var c = g[n].filter(function (p) { return p.caption != null; }).length;
        var line = "@" + n + " " + g[n].length + "件（本文あり " + c + "）" + (igCounts[n] ? " IG " + igCounts[n] + "件" : "");
        var k = counts && counts[n];
        if (k) line += " → 新規 " + k.fresh + " / 公式で入っている " + k.official + " / 取り込み済み " + k.imported + (k.invalid ? " / 読めない " + k.invalid : "");
        lines[n] = line;
        return line;
      }).join("\n") + note;
    }
    show(null);
    send.disabled = false;
    // 登録したらどうなるかを、書き込まずにサイトに数えてもらう
    if (token) classify(g, show);
  }

  var classifyNo = 0;
  // 1人1回、全員分を同時に聞く(数えるだけなので件数の上限は大きい)
  function classify(g, show) {
    var my = ++classifyNo;
    var counts = {};
    Object.keys(g).forEach(function (who) {
      fetch("/api/crawl/paste", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ username: who, posts: g[who], dry: true }),
      }).then(function (res) { return res.ok ? res.json() : null; }).then(function (r) {
        if (!r || my !== classifyNo) return;
        counts[who] = r;
        show(counts);
      }).catch(function () { /* 数えられなくても登録はできる */ });
    });
  }

  // 開いたときは必ず空から(ブラウザが前の中身を戻すと、送り忘れと見分けがつかないため)
  data.value = "";
  window.addEventListener("pageshow", function (e) {
    if (e.persisted && !groups) { data.value = ""; preview.textContent = ""; send.disabled = true; }
  });

  data.addEventListener("input", function () {
    var v = data.value.trim();
    // 欄は読み取ったあと空にするので、空になっても読み取った分(未登録)は消さない
    if (!v) return;
    try {
      take(JSON.parse(v));
      // 中身は読み取って下の「未登録」に移したので、欄は空にする(大きな文字を表示し続けると重い)
      data.value = "";
    } catch (e) {
      preview.textContent = "読めません: " + e.message;
      send.disabled = true;
    }
  });

  // ブックマークレットの「送る」で開かれたとき: 準備ができたと伝え、投稿を受け取る
  var got = {};
  window.addEventListener("message", function (e) {
    if (!/^https:\/\/(www\.)?instagram\.com$/.test(e.origin) || !e.data || e.data.type !== "hello-insta-posts") return;
    try {
      // 受け取るまで何度も送ってくるので、同じ送りは1回だけ読む
      if (e.data.id && got[e.data.id]) { if (e.source) e.source.postMessage({ type: "hello-insta-got", id: e.data.id }, e.origin); return; }
      if (e.data.id) got[e.data.id] = true;
      // 欄には入れずに、そのまま読み取る(大きな文字を表示すると重い)。
      // まだ登録していない分があれば足す(窓を並べて順に送ったとき)
      var posts = e.data.posts;
      if (groups && lastData) posts = lastData.posts.filter(function (p) {
        return !posts.some(function (q) { return q.code === p.code; });
      }).concat(posts);
      var cs = Object.assign({}, groups && lastData && lastData.counts, e.data.counts);
      take({ posts: posts, counts: cs });
      if (e.source) e.source.postMessage({ type: "hello-insta-got", id: e.data.id, n: e.data.posts.length }, e.origin);
    } catch (err) {
      preview.textContent = "受け取れませんでした: " + err.message;
    }
  });
  if (window.opener) {
    try { window.opener.postMessage({ type: "hello-insta-ready" }, "https://www.instagram.com"); } catch (e) { /* 開き元と切れている */ }
  }

  send.addEventListener("click", async function () {
    if (!groups || busy) return;
    if (!token) { result.textContent = "下の「合言葉」を開いて CRAWL_TOKEN を入れ、覚えさせてください"; return; }
    send.disabled = true;
    // 押したら「未登録」の表示を、同じ行のまま「登録中」に移す(未登録は空になる)。
    // 登録しているあいだに別の窓から送られてきた分は、また「未登録」に並ぶ
    var sending = groups, rows = lines, igs = igCounts;
    busy = true;
    data.value = "";
    groups = null;
    classifyNo++;  // まだ数えている途中の確認があれば、移した表示を上書きさせない
    preview.textContent = "";
    var who, head = "", done = {}, failed = false;
    function draw() {
      result.textContent = head + "\n" + Object.keys(sending).map(function (n) { return done[n] || rows[n] || "@" + n; }).join("\n");
    }
    for (who in sending) {
      var sum = { added: 0, updated: 0, same: 0, skipped: 0 };
      var list = sending[who];
      try {
        for (var i = 0; i < list.length; i += CHUNK) {
          head = "登録中… @" + who + " " + i + " / " + list.length;
          draw();
          var res = await fetch("/api/crawl/paste", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + token },
            body: JSON.stringify({ username: who, posts: list.slice(i, i + CHUNK), ig_count: i === 0 ? igs[who] : undefined }),
          });
          var r = await res.json().catch(function () { return {}; });
          // 合言葉が違うと、Worker は存在しないふりをして 404 を返す
          if (res.status === 404) throw new Error("合言葉が違います（覚えさせた CRAWL_TOKEN が、サイトのものと合っていません）");
          if (!res.ok) throw new Error(r.message || r.error || "HTTP " + res.status);
          sum.added += r.added; sum.updated += r.updated; sum.same += r.same || 0; sum.skipped += r.skipped;
        }
        done[who] = "✓ @" + who + " 新規 " + sum.added + " / 本文を更新 " + sum.updated + " / そのまま " + sum.same + " / 飛ばした " + sum.skipped;
      } catch (e) {
        failed = true;
        done[who] = "✗ @" + who + " 失敗: " + e.message;
      }
    }
    var t = new Date();
    head = (failed ? "登録しました（失敗あり。失敗した分は送り直してください）" : "登録しました") +
      " " + t.getHours() + ":" + String(t.getMinutes()).padStart(2, "0");
    busy = false;
    send.disabled = !groups;
    draw();
    result.textContent += "\n（飛ばしたのは、公式APIで入っている投稿と、日時が読めないもの）";
    loadTargets();
  });

  // '2026-10-16 21:03' → 今年なら '10/16 21:03'、それ以外は '2025/10/16 21:03'
  function lastLabel(ts) {
    var s = ts.replace(/-/g, "/");
    return ts.slice(0, 4) === String(new Date().getFullYear()) ? s.slice(5) : s;
  }

  // ---------- 対象の一覧(公開APIの accounts から、個人アカウントの人だけ) ----------
  function loadTargets() {
    // サイト側(Worker)のキャッシュは URL ごとなので、毎回違う URL にして最新の件数を取る
    fetch("/api/accounts?fresh=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      // 拾う・受け付けるのは対象アカウント全員。表は個人アカウントの人と公式APIで取れる人に分けて出す
      targets = {};
      var names = {};
      (d.accounts || []).forEach(function (a) {
        if (!a.active) return;
        targets[a.username.toLowerCase()] = true;
        names[a.username.toLowerCase()] = a.name;
      });
      buildLink(names);
      var active = (d.accounts || []).filter(function (a) { return a.active; });
      fillTable(document.getElementById("targets"), active.filter(function (a) { return /個人アカウント/.test(a.error || ""); }));
      fillTable(document.getElementById("officials"), active.filter(function (a) { return !/個人アカウント/.test(a.error || ""); }));
      // 対象の読み込みより先に投稿が渡ってきていたら、絞り直す
      if (groups && lastData) take(lastData);
    }).catch(function () {
      document.getElementById("targets").innerHTML = "<tr><td>読み込めませんでした</td></tr>";
    });
  }

  function fillTable(tbody, list) {
      tbody.textContent = "";
      if (!list.length) { tbody.innerHTML = "<tr><td>いません</td></tr>"; return; }
      // 1セルを2行(上が主、下が小さく)にして横幅を詰める。second は文字か要素
      function cell(main, second) {
        var td = document.createElement("td");
        if (typeof main === "string") td.appendChild(document.createTextNode(main)); else td.appendChild(main);
        var sm = document.createElement("small");
        if (typeof second === "string") sm.textContent = second; else sm.appendChild(second);
        td.appendChild(sm);
        return td;
      }
      function link(href, label) {
        var aa = document.createElement("a");
        aa.href = href;
        aa.target = "_blank";
        aa.rel = "noopener noreferrer";
        aa.textContent = label;
        aa.title = label;
        return aa;
      }
      list.forEach(function (a) {
        var tr = document.createElement("tr");
        tr.appendChild(cell(a.name, link("https://www.instagram.com/" + encodeURIComponent(a.username) + "/", "@" + a.username)));
        // 合計と、そのうち公式APIで入った分・手で取り込んだ分
        var web = a.posts_web || 0;
        tr.appendChild(cell(a.posts + "件", "公式" + (a.posts - web) + "・取込" + web));
        // Instagram のプロフィールに出ている投稿数と比べる(追いついていれば取り込みは要らない)
        var ig;
        if (a.ig_count != null) {
          var pct = a.ig_count ? Math.floor(a.posts / a.ig_count * 100) : 100;
          var ok = a.posts >= a.ig_count;
          ig = cell("IG " + a.ig_count + (ok ? " ✓" : " " + pct + "%"), ok ? "追いついた" : "あと " + (a.ig_count - a.posts));
          ig.title = "Instagram の件数を取った日時: " + (a.ig_count_at || "");
          if (!ok) ig.style.color = "var(--accent)";
        } else {
          ig = cell("IG ?", "件数まだ");
          ig.title = "まだ Instagram の件数を取っていません（プロフィールを IG取得 で開くと取れます）";
        }
        tr.appendChild(ig);
        // 上は入っている一番新しい投稿の日時(押すとその投稿を開く)、下は最後に取り込んだ日時(このDBに入った日時)
        tr.appendChild(cell(a.last && a.last_url ? link(a.last_url.replace("/reel/", "/p/"), lastLabel(a.last)) : "まだ無し",
          a.last_added ? "取込 " + lastLabel(a.last_added) : ""));
        tbody.appendChild(tr);
      });
  }
  loadTargets();
})();
