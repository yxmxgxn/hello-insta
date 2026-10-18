// 貼り付けページ(自分用)。合言葉(CRAWL_TOKEN)は欄に入れるか /paste?t= で開いて、このブラウザに覚えさせる(Git には置かない)。
// ブックマークレット(grab)は instagram.com の上で動き、画面に出ている投稿を拾うだけ。Instagram へ自分から問い合わせない。
// 「送る」でこのページを開いて postMessage で受け取る。渡らないときのためにコピーもしておき、欄に貼っても入れられる。
(function () {
  "use strict";

  // ---------- ブックマークレット(instagram.com で動く。外の変数は使えない。__SITE__ はこのサイトの URL に置き換える) ----------
  // 中のコメントは行まるごとにすること(行末に付けない)。リンクにするときにコメント行を除いて1行につなぐため
  function grab() {
    var SITE = "__SITE__";
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
      var old = items.get(code);
      // 本文は、取れているものを null で消さない。両方あれば長い方(途中で切れた表示より全文)
      if (old && old.caption != null && (caption == null || old.caption.length >= caption.length)) caption = old.caption;
      items.set(code, { code: code, account: account, kind: (old && old.kind === "reel") ? "reel" : kind, caption: caption });
    }

    function text(el) { return el ? (el.innerText || el.textContent || "").trim() : null; }

    function scan() {
      var first = location.pathname.split("/").filter(Boolean)[0];
      if (first && !NOT_USER.test(first)) profile = first;
      // プロフィールの一覧(投稿タブ・リールタブ)。リンクとサムネイル
      document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(function (a) {
        var m = (a.getAttribute("href") || "").match(LINK);
        if (!m) return;
        var img = a.querySelector("img[alt]");
        put(m[3], m[1] || profile, m[2], captionFromAlt(img && img.getAttribute("alt")));
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
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:260px;padding:12px;" +
      "background:#fff;color:#1f1f1f;border:2px solid #8C6BB8;border-radius:12px;" +
      "font:13px/1.6 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
    function el(tag, css, txt) {
      var e = document.createElement(tag);
      if (css) e.style.cssText = css;
      if (txt) e.textContent = txt;
      return e;
    }
    var title = el("div", "font-weight:700;margin-bottom:4px", "hello-insta 収集中");
    var count = el("div");
    var note = el("div", "color:#6b6b6b;font-size:12px;margin:4px 0;white-space:pre-wrap");
    var row = el("div", "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px");
    function button(label, main) {
      var b = el("button", "font:inherit;padding:4px 10px;border:1px solid #8C6BB8;border-radius:6px;cursor:pointer;" +
        (main ? "background:#8C6BB8;color:#fff" : "background:#fff;color:#8C6BB8"), label);
      row.appendChild(b);
      return b;
    }
    var bSend = button("送る", true), bScroll = button("自動スクロール"), bCopy = button("コピー"), bClose = button("閉じる");
    [title, count, note, row].forEach(function (e) { panel.appendChild(e); });
    document.body.appendChild(panel);

    function msg(s) { note.textContent = s; }

    function render() {
      var n = 0, c = 0, who = {};
      items.forEach(function (p) { n++; if (p.caption != null) c++; who[p.account] = 1; });
      count.textContent = n + " 件（本文あり " + c + "）・" + Object.keys(who).length + " アカウント";
    }

    function list() { return Array.from(items.values()); }

    // 送る: 貼り付けページを開き、準備ができたと言ってきたら渡す(返事の送り主 e.source に渡す)。
    // 渡せなかったときのために、開く前にクリップボードにも写しておく
    window.addEventListener("message", function (e) {
      if (e.origin !== SITE || !e.data || !e.source) return;
      if (e.data.type === "hello-insta-ready") e.source.postMessage({ type: "hello-insta-posts", posts: list() }, SITE);
      if (e.data.type === "hello-insta-got") msg(e.data.n + " 件を渡しました。開いたページで「登録」を押してください");
    });

    function copy() {
      return navigator.clipboard.writeText(JSON.stringify({ v: 2, posts: list() }))
        .then(function () { return true; }, function () { return false; });
    }

    bSend.onclick = function () {
      if (!items.size) { msg("まだ何も拾えていません"); return; }
      copy();
      var win = window.open(SITE + "/paste", "hello-insta-paste");
      msg(win === null
        ? "ポップアップが止められました。コピーはしたので、貼り付けページを開いて欄に貼ってください"
        : "貼り付けページを開いています…（渡らないときは、コピー済みなので欄に貼ってください）");
    };

    bCopy.onclick = function () {
      copy().then(function (ok) { msg(ok ? "コピーしました。貼り付けページの欄に貼ってください" : "コピーできませんでした"); });
    };

    // 自動スクロール: 人が眺めるくらいの間隔(3〜5秒、毎回ばらつかせる)で一番下へ。伸びなくなったら終わる
    var scrollTimer = null, still = 0, lastH = 0;
    function stopScroll(s) {
      clearTimeout(scrollTimer); scrollTimer = null;
      bScroll.textContent = "自動スクロール";
      if (s) msg(s);
    }
    function step() {
      window.scrollTo(0, document.documentElement.scrollHeight);
      var h = document.documentElement.scrollHeight;
      still = h === lastH ? still + 1 : 0;
      lastH = h;
      if (still >= 3) { stopScroll("一番下まで来ました。「送る」を押してください"); return; }
      scrollTimer = setTimeout(step, 3000 + Math.random() * 2000);
    }
    bScroll.onclick = function () {
      if (scrollTimer) { stopScroll("止めました"); return; }
      still = 0; lastH = 0;
      bScroll.textContent = "止める";
      msg("ゆっくり一番下まで送っています…");
      step();
    };

    var timer = setInterval(scan, 800);
    bClose.onclick = function () {
      stopScroll();
      clearInterval(timer);
      panel.remove();
      delete window.__helloInsta;
    };

    window.__helloInsta = { show: function () { panel.style.display = ""; scan(); } };
    scan();
  }

  // スマホの Chrome はアドレスバーから実行すると改行を消して1行にするので、// のコメントがあると後ろが全部コメントになる。
  // コメント行を除き、1行につないでからリンクにする(文の終わりはすべて ; で書いてある)
  var oneLine = grab.toString().split("\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && !/^(\/\/|\/\*)/.test(l); })
    .join(" ")
    .replace("__SITE__", location.origin);
  document.getElementById("bm").href = "javascript:(" + encodeURIComponent(oneLine) + ")()";

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
    tokenState.textContent = t ? "覚えています（…" + t.slice(-4) + "）" : "まだ入っていません。登録には合言葉が要ります";
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

  function take(d) {
    groups = null;
    result.textContent = "";
    if (!d || !Array.isArray(d.posts)) throw new Error("形が違います");
    var g = {};
    d.posts.forEach(function (p) {
      var who = p.account || d.username;
      if (!who || !p.code) return;
      (g[who] = g[who] || []).push(p);
    });
    var names = Object.keys(g);
    if (!names.length) throw new Error("投稿がありません");
    groups = g;
    preview.textContent = "未登録（「登録」を押すまで入りません）\n" + names.map(function (n) {
      var c = g[n].filter(function (p) { return p.caption != null; }).length;
      return "@" + n + " " + g[n].length + "件（本文あり " + c + "）";
    }).join("\n");
    send.disabled = false;
  }

  // 開いたときは必ず空から(ブラウザが前の中身を戻すと、送り忘れと見分けがつかないため)
  data.value = "";
  window.addEventListener("pageshow", function (e) {
    if (e.persisted && !groups) { data.value = ""; preview.textContent = ""; send.disabled = true; }
  });

  data.addEventListener("input", function () {
    var v = data.value.trim();
    if (!v) { preview.textContent = ""; send.disabled = true; groups = null; return; }
    try {
      take(JSON.parse(v));
    } catch (e) {
      preview.textContent = "読めません: " + e.message;
      send.disabled = true;
    }
  });

  // ブックマークレットの「送る」で開かれたとき: 準備ができたと伝え、投稿を受け取る
  window.addEventListener("message", function (e) {
    if (!/^https:\/\/(www\.)?instagram\.com$/.test(e.origin) || !e.data || e.data.type !== "hello-insta-posts") return;
    try {
      take({ posts: e.data.posts });
      data.value = JSON.stringify({ v: 2, posts: e.data.posts });
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
    var lines = [];
    var failed = false;
    for (var who in groups) {
      var sum = { added: 0, updated: 0, skipped: 0 };
      var list = groups[who];
      try {
        for (var i = 0; i < list.length; i += CHUNK) {
          result.textContent = "登録中… @" + who + " " + i + " / " + list.length;
          var res = await fetch("/api/crawl/paste", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + token },
            body: JSON.stringify({ username: who, posts: list.slice(i, i + CHUNK) }),
          });
          var r = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(r.message || r.error || "HTTP " + res.status);
          sum.added += r.added; sum.updated += r.updated; sum.skipped += r.skipped;
        }
        lines.push("@" + who + ": 新規 " + sum.added + "件 / 更新 " + sum.updated + "件 / 飛ばした " + sum.skipped + "件");
      } catch (e) {
        failed = true;
        lines.push("@" + who + ": 失敗 " + e.message);
      }
    }
    result.textContent = lines.join("\n") +
      "\n（飛ばしたのは、公式APIで入っている投稿と、入っている投稿で本文が拾えなかったもの）";
    // 失敗があっても欄は空にする(続けて次のアカウントを貼れるように。失敗した分は上の結果に出るので、貼り直せばよい)
    data.value = "";
    groups = null;
    preview.textContent = "";
    if (failed) result.textContent += "\n失敗した分は、もう一度コピーして貼り直してください";
    loadTargets();
  });

  // ---------- 対象の一覧(公開APIの accounts から、個人アカウントの人だけ) ----------
  function loadTargets() {
    fetch("/api/accounts", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      var tbody = document.getElementById("targets");
      tbody.textContent = "";
      var list = (d.accounts || []).filter(function (a) { return a.active && /個人アカウント/.test(a.error || ""); });
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
        n.textContent = a.posts + "件";
        tr.appendChild(name); tr.appendChild(link); tr.appendChild(n);
        tbody.appendChild(tr);
      });
    }).catch(function () {
      document.getElementById("targets").innerHTML = "<tr><td>読み込めませんでした</td></tr>";
    });
  }
  loadTargets();
})();
