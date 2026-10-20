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
    var bSend = button("送る", true), bScroll = button("Scroll"), bCopy = button("コピー"), bClose = button("閉じる");
    [head, note, row].forEach(function (e) { panel.appendChild(e); });
    document.body.appendChild(panel);

    function msg(s) { note.textContent = s; note.title = s; }

    function render() {
      var n = 0, c = 0, who = {};
      items.forEach(function (p) { n++; if (p.caption != null) c++; who[p.account] = 1; });
      var k = Object.keys(who).length;
      count.textContent = n + "件（本文" + c + "）" + (k > 1 ? " " + k + "人" : "");
      if (profile && !ALLOW[profile.toLowerCase()]) msg("対象外。何も拾いません");
      // 見出しは開いているページの人(窓を並べたときに見分けられるように)
      var me = profile && profile.toLowerCase();
      title.textContent = !me ? "ホーム" : ALLOW[me] ? "@" + profile : "@" + profile + "（対象外）";
      head.title = me && NAMES[me] ? NAMES[me] : "";
    }

    function list() { return Array.from(items.values()); }

    // 送る: 貼り付けページを開き、準備ができたと言ってきたら渡す(返事の送り主 e.source に渡す)。
    // 渡せなかったときのために、開く前にクリップボードにも写しておく
    window.addEventListener("message", function (e) {
      if (e.origin !== SITE || !e.data || !e.source) return;
      if (e.data.type === "hello-insta-ready") e.source.postMessage({ type: "hello-insta-posts", posts: list() }, SITE);
      if (e.data.type === "hello-insta-got") msg(e.data.n + "件渡しました。「登録」を押す");
    });

    function copy() {
      return navigator.clipboard.writeText(JSON.stringify({ v: 2, posts: list() }))
        .then(function () { return true; }, function () { return false; });
    }

    bSend.onclick = function () {
      if (!items.size) { msg("まだ何も拾えていません"); return; }
      copy();
      var win = window.open(SITE + "/import", "hello-insta-import");
      msg(win === null
        ? "窓が止められました。コピー済みなので欄に貼る"
        : "取り込みページを開いています（コピー済み）");
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
    bClose.onclick = function () {
      stopScroll();
      clearInterval(timer);
      panel.remove();
      delete window.__helloInsta;
    };

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
  // 今のページを、画面幅の COLS 分の1の細い窓で開き直す。押すたびに左から順に並び、COLS 個で一周する
  // 開いた窓はブックマークバーが出ない(ポップアップ型)ので、IG取得も窓の中で自動で始める
  function popout() {
    var grab = __GRAB__;
    var COLS = 4;
    var k = 0;
    try {
      k = (parseInt(localStorage.getItem("helloInstaWin"), 10) || 0) % COLS;
      localStorage.setItem("helloInstaWin", String(k + 1));
    } catch (e) { k = 0; }
    var w = Math.floor(screen.availWidth / COLS);
    var left = (screen.availLeft || 0) + k * w;
    var top = screen.availTop || 0;
    var win = window.open(location.href, "hi_win_" + Date.now(), "popup=yes,width=" + w + ",height=" + screen.availHeight + ",left=" + left + ",top=" + top);
    if (!win) { alert("ポップアップが止められました。このサイトのポップアップを許可してください"); return; }
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (tries > 60) { clearInterval(t); return; }
      try {
        if (win.closed) { clearInterval(t); return; }
        if (win.location.href === "about:blank" || win.document.readyState !== "complete" || !win.document.body) return;
      } catch (e) { return; }
      clearInterval(t);
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

  // ホームのフィードで拾うと、ファンなど対象外の人の投稿も混ざるので、対象アカウントの分だけ送る
  function take(d) {
    groups = null;
    result.textContent = "";
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
    var head = "未登録（「登録」を押すまで入りません）\n";
    function show(counts) {
      preview.textContent = head + names.map(function (n) {
        var c = g[n].filter(function (p) { return p.caption != null; }).length;
        var line = "@" + n + " " + g[n].length + "件（本文あり " + c + "）";
        var k = counts && counts[n];
        if (k) line += " → 新規 " + k.fresh + " / 公式で入っている " + k.official + " / 取り込み済み " + k.imported + (k.invalid ? " / 読めない " + k.invalid : "");
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
  window.addEventListener("message", function (e) {
    if (!/^https:\/\/(www\.)?instagram\.com$/.test(e.origin) || !e.data || e.data.type !== "hello-insta-posts") return;
    try {
      // 欄には入れずに、そのまま読み取る(大きな文字を表示すると重い)
      take({ posts: e.data.posts });
      if (e.source) e.source.postMessage({ type: "hello-insta-got", n: e.data.posts.length }, e.origin);
    } catch (err) {
      preview.textContent = "受け取れませんでした: " + err.message;
    }
  });
  if (window.opener) {
    try { window.opener.postMessage({ type: "hello-insta-ready" }, "https://www.instagram.com"); } catch (e) { /* 開き元と切れている */ }
  }

  send.addEventListener("click", async function () {
    if (!groups) return;
    if (!token) { result.textContent = "上の「合言葉」の欄に CRAWL_TOKEN を入れて、覚えさせてください"; return; }
    send.disabled = true;
    // 押したらすぐ空にする(送る分は手元に持っておく)。失敗した分は結果に出るので、貼り直せばよい
    var sending = groups;
    data.value = "";
    groups = null;
    classifyNo++;  // まだ数えている途中の確認があれば、空にした表示を上書きさせない
    preview.textContent = "";
    var lines = [];
    var failed = false;
    for (var who in sending) {
      var sum = { added: 0, updated: 0, same: 0, skipped: 0 };
      var list = sending[who];
      try {
        for (var i = 0; i < list.length; i += CHUNK) {
          result.textContent = "登録中… @" + who + " " + i + " / " + list.length;
          var res = await fetch("/api/crawl/paste", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + token },
            body: JSON.stringify({ username: who, posts: list.slice(i, i + CHUNK) }),
          });
          var r = await res.json().catch(function () { return {}; });
          // 合言葉が違うと、Worker は存在しないふりをして 404 を返す
          if (res.status === 404) throw new Error("合言葉が違います（覚えさせた CRAWL_TOKEN が、サイトのものと合っていません）");
          if (!res.ok) throw new Error(r.message || r.error || "HTTP " + res.status);
          sum.added += r.added; sum.updated += r.updated; sum.same += r.same || 0; sum.skipped += r.skipped;
        }
        lines.push("@" + who + ": 新規 " + sum.added + "件 / 本文を更新 " + sum.updated + "件 / 取り込み済みでそのまま " + sum.same + "件 / 飛ばした " + sum.skipped + "件");
      } catch (e) {
        failed = true;
        lines.push("@" + who + ": 失敗 " + e.message);
      }
    }
    result.textContent = lines.join("\n") +
      "\n（飛ばしたのは、公式APIで入っている投稿と、日時が読めないもの）";
    if (failed) result.textContent += "\n失敗した分は、もう一度コピーして貼り直してください";
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
      list.forEach(function (a) {
        var tr = document.createElement("tr");
        var name = document.createElement("td");
        name.textContent = a.name;
        var link = document.createElement("td");
        var aa = document.createElement("a");
        aa.href = "https://www.instagram.com/" + encodeURIComponent(a.username) + "/";
        aa.target = "_blank";
        aa.rel = "noopener noreferrer";
        aa.textContent = "@" + a.username;
        link.appendChild(aa);
        var n = document.createElement("td");
        // 合計と、そのうち公式APIで入った分・手で取り込んだ分
        var web = a.posts_web || 0;
        n.textContent = a.posts + "件（公式 " + (a.posts - web) + " / 取り込み " + web + "）";
        // 入っている一番新しい投稿の日時(押すとその投稿を開く)。Instagram でここまで遡って送れば抜けは出ない
        var last = document.createElement("td");
        if (a.last && a.last_url) {
          var la = document.createElement("a");
          la.href = a.last_url.replace("/reel/", "/p/");
          la.target = "_blank";
          la.rel = "noopener noreferrer";
          la.textContent = "最新 " + lastLabel(a.last);
          last.appendChild(la);
        } else {
          last.textContent = "まだ無し";
        }
        // 最後に取り込んだ日時(このDBに入った日時)
        var added = document.createElement("td");
        added.textContent = a.last_added ? "取り込み " + lastLabel(a.last_added) : "";
        tr.appendChild(name); tr.appendChild(link); tr.appendChild(n); tr.appendChild(last); tr.appendChild(added);
        tbody.appendChild(tr);
      });
  }
  loadTargets();
})();
