// 貼り付けページ(自分用)。/paste?t=<CRAWL_TOKEN> で開く。
// ブックマークレット(grab)は instagram.com の上で動き、ログイン中のブラウザから Web版と同じ通り道で投稿を取る。
// instagram.com からこのサイトへは直接送れない(Instagram の CSP)ので、コピーして貼る。
(function () {
  "use strict";

  // ---------- ブックマークレット(instagram.com で動く。外の変数は使えない) ----------
  function grab() {
    var APP_ID = "936619743392459";  // Web版の Instagram が自分で付けているもの
    var WAIT = [3000, 6000];         // ページの間をあける(ミリ秒)。人が見ている速さに寄せる
    var user = location.pathname.split("/").filter(Boolean)[0];
    if (!/(^|\.)instagram\.com$/.test(location.hostname) || !user || /^(p|reel|reels|explore|stories|direct|accounts)$/.test(user)) {
      alert("Instagram のプロフィール（instagram.com/ユーザー名/）を開いてから押してください");
      return;
    }
    var ans = prompt("@" + user + " の投稿をどこまで取りますか？\n件数（例: 100）か、日付（例: 2024-01-01 ならその日まで遡る）", "100");
    if (ans == null) return;
    ans = ans.trim();
    var until = /^\d{4}-\d{2}-\d{2}$/.test(ans) ? new Date(ans + "T00:00:00+09:00").getTime() / 1000 : null;
    var max = until ? Infinity : (parseInt(ans, 10) || 100);

    // 進み具合と結果の表示(Instagram の画面の上に重ねる。innerHTML は使わない)
    var box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;width:360px;max-width:calc(100vw - 32px);" +
      "background:#fff;color:#1f1f1f;border:2px solid #8C6BB8;border-radius:8px;padding:12px;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)";
    var msg = document.createElement("div");
    box.appendChild(msg);
    document.body.appendChild(box);
    var say = function (t) { msg.textContent = t; };
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    var out = [];
    var stopped = "";
    // JSON が返らない(ログイン画面などの HTML が来た)ときは、何が来たか分かるように止める
    async function getJson(path) {
      var res = await fetch(path, { headers: { "x-ig-app-id": APP_ID, "x-requested-with": "XMLHttpRequest" }, credentials: "include" });
      var text = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status + "（" + path.split("?")[0] + "）");
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error("JSON でないものが返りました（" + path.split("?")[0] + "）: " + text.slice(0, 60));
      }
    }

    (async function () {
      say("@" + user + " のユーザーIDを確認中…");
      var prof = await getJson("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(user));
      var uid = prof && prof.data && prof.data.user && prof.data.user.id;
      if (!uid) throw new Error("ユーザーIDが取れません（非公開か、ユーザー名が違う）");
      var maxId = "";
      for (var page = 1; out.length < max; page++) {
        say("@" + user + " を取得中… " + out.length + "件（" + page + "ページ目）");
        await sleep(page === 1 ? 1000 : WAIT[0] + Math.random() * (WAIT[1] - WAIT[0]));
        var d = await getJson("/api/v1/feed/user/" + uid + "/?count=12" + (maxId ? "&max_id=" + encodeURIComponent(maxId) : ""));
        var done = false;
        for (var i = 0; i < (d.items || []).length; i++) {
          var it = d.items[i];
          // 固定された投稿は古くても先頭に来るので、日付で止める判断には使わない
          var pinned = (it.timeline_pinned_user_ids || []).length > 0;
          if (until && !pinned && it.taken_at < until) { done = true; break; }
          if (until && pinned && it.taken_at < until) continue;
          out.push({
            code: it.code,
            caption: it.caption ? it.caption.text : "",
            taken_at: it.taken_at,
            media_type: it.media_type,
            like_count: it.like_and_view_counts_disabled ? null : it.like_count,
            comments_count: it.comment_count,
          });
          if (out.length >= max) break;
        }
        if (done || !d.more_available || !d.next_max_id) break;
        maxId = d.next_max_id;
        await sleep(WAIT[0] + Math.random() * (WAIT[1] - WAIT[0]));
      }
    })().catch(function (e) { stopped = "エラーで止まりました: " + e; }).then(function () {
      var text = JSON.stringify({ v: 1, username: user, posts: out });
      say("@" + user + " " + out.length + "件" + (stopped ? "（" + stopped + "。ここまでの分）" : "") + "\n「コピー」を押して、貼り付けページに貼ってください");
      msg.style.whiteSpace = "pre-wrap";
      var btn = document.createElement("button");
      btn.textContent = "コピー";
      btn.style.cssText = "margin:8px 8px 0 0;padding:4px 12px";
      btn.onclick = function () {
        navigator.clipboard.writeText(text).then(function () { btn.textContent = "コピーしました"; },
          function () { ta.style.display = "block"; ta.select(); btn.textContent = "下を手でコピー"; });
      };
      var close = document.createElement("button");
      close.textContent = "閉じる";
      close.style.cssText = "margin-top:8px;padding:4px 12px";
      close.onclick = function () { box.remove(); };
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.readOnly = true;
      ta.style.cssText = "display:none;width:100%;height:80px;margin-top:8px;font:11px monospace";
      box.appendChild(btn);
      box.appendChild(close);
      box.appendChild(ta);
    });
  }

  document.getElementById("bm").href = "javascript:(" + encodeURIComponent(grab.toString()) + ")()";

  // ---------- 貼り付け ----------
  var token = new URLSearchParams(location.search).get("t") || "";
  var data = document.getElementById("data");
  var preview = document.getElementById("preview");
  var send = document.getElementById("send");
  var result = document.getElementById("result");
  var CHUNK = 100;  // Worker 側の上限(PASTE_MAX)と同じ
  var parsed = null;

  function jst(sec) {
    return new Date(sec * 1000 + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  }

  data.addEventListener("input", function () {
    parsed = null;
    result.textContent = "";
    var v = data.value.trim();
    if (!v) { preview.textContent = ""; send.disabled = true; return; }
    try {
      var d = JSON.parse(v);
      if (!d.username || !Array.isArray(d.posts)) throw new Error("形が違います");
      parsed = d;
      var ts = d.posts.map(function (p) { return p.taken_at; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
      preview.textContent = "@" + d.username + " " + d.posts.length + "件" +
        (ts.length ? "（" + jst(ts[0]) + " 〜 " + jst(ts[ts.length - 1]) + "）" : "");
      send.disabled = !d.posts.length;
    } catch (e) {
      preview.textContent = "読めません: " + e.message;
      send.disabled = true;
    }
  });

  send.addEventListener("click", async function () {
    if (!parsed) return;
    if (!token) { result.textContent = "URL に ?t=<CRAWL_TOKEN> を付けて開いてください"; return; }
    send.disabled = true;
    var sum = { added: 0, updated: 0, skipped: 0 };
    try {
      for (var i = 0; i < parsed.posts.length; i += CHUNK) {
        result.textContent = "登録中… " + i + " / " + parsed.posts.length;
        var res = await fetch("/api/crawl/paste", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ username: parsed.username, posts: parsed.posts.slice(i, i + CHUNK) }),
        });
        var r = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(r.message || r.error || "HTTP " + res.status);
        sum.added += r.added; sum.updated += r.updated; sum.skipped += r.skipped;
      }
      result.textContent = "登録しました: 新規 " + sum.added + "件 / 更新 " + sum.updated + "件 / 飛ばした " + sum.skipped + "件" +
        (sum.skipped ? "\n（飛ばしたのは、公式APIで入っている投稿か、日時の無いもの）" : "");
      data.value = "";
      parsed = null;
      preview.textContent = "";
      loadTargets();
    } catch (e) {
      result.textContent = "失敗しました: " + e.message;
      send.disabled = false;
    }
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
