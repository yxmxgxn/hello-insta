(function () {
  "use strict";

  var TYPE = { VIDEO: "動画", CAROUSEL_ALBUM: "複数枚", IMAGE: "画像" };
  var names = {};               // ユーザー名 → 表示名
  var spans = {};               // ユーザー名 → { first, last }(入っている投稿の最古・最新の日時)
  var lastTs = "", listNo = 0, calNo = 0;
  var calYear, calMonth;        // 表示中の月(calMonth は 1-12)
  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var options = function () { return Array.prototype.slice.call($("acc").options); };

  function selected() {
    return options().filter(function (o) { return o.selected; }).map(function (o) { return o.value; });
  }

  function params() {
    var p = new URLSearchParams();
    var sel = selected();
    if (sel.length) p.set("a", sel.join(","));
    if ($("from").value) p.set("from", $("from").value);
    if ($("to").value) p.set("to", $("to").value);
    if ($("q").value.trim()) p.set("q", $("q").value.trim());
    return p;
  }

  function getJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  /* ---------- アカウント ---------- */

  // 取得エラーの文言 → 選択肢に添える理由
  function reason(error) {
    if (/個人アカウント/.test(error)) return "個人アカウント";
    return error;
  }

  // グループのボタン(押すと、その見出しのアカウントがボタンで並ぶ)。見出しの名前の頭で照らし合わせる
  // (モーニング娘。は年で名前が変わるため)。ここに入らない見出しの人は「そのほか」のプルダウンへ
  var GROUP_BUTTONS = ["モーニング娘。", "アンジュルム", "Juice=Juice", "つばきファクトリー", "BEYOOOOONDS",
    "OCHA NORMA", "ロージークロニクル", "J.P ROOM", "UP-FRONT CREATE", "UP-FRONT PROMOTION"];
  var accs = [];      // 選べるアカウント(アカウント一覧の順)
  var openGroup = ""; // いま開いているグループのボタン
  function groupOf(section) {
    for (var i = 0; i < GROUP_BUTTONS.length; i++) if (section.indexOf(GROUP_BUTTONS[i]) === 0) return GROUP_BUTTONS[i];
    return "";
  }
  function isSelected(u) { return selected().indexOf(u) >= 0; }
  function setSelected(u, on) { options().forEach(function (o) { if (o.value === u) o.selected = on; }); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fillAccounts(list) {
    var sel = $("acc"), blocked = [];
    // 表示は「名前（件数）」。同じ名前のアカウントが複数ある人(本人のと書道のなど)だけ「名前（@アカウント）（件数）」にする
    var same = {};
    list.forEach(function (a) { same[a.name] = (same[a.name] || 0) + 1; });
    function label(a) { return a.name + (same[a.name] > 1 ? "（@" + a.username + "）" : ""); }
    list.forEach(function (a) {
      names[a.username] = a.name;
      if (a.first && a.last) spans[a.username] = { first: a.first, last: a.last };
      // 1件も取れていなくて、個人アカウントで取れないと分かっている人は、プルダウンの一番下の「取得不可」にまとめて選べなくする
      // (回数制限などの一時的なエラーの人は、ふつうに「未取得」で並べる)
      if (!a.posts && /個人アカウント/.test(a.error || "")) {
        if (a.active) blocked.push(a);
        return;
      }
      var sec = a.active ? a.section : "以前の対象";
      var text = label(a) + (a.posts ? "（" + a.posts + "）" : "（未取得）");
      accs.push({ username: a.username, section: sec, group: a.active ? groupOf(sec) : "", text: text, off: !a.posts });
      // 選んでいる人は、見えない select に持つ(URL・検索の条件はここから作る)
      var o = document.createElement("option");
      o.value = a.username;
      sel.appendChild(o);
    });

    // グループのボタン
    var bar = $("gbtn");
    function gb(key, name) {
      var b = el("button", "gb", name);
      b.type = "button";
      b.setAttribute("data-g", key);
      b.onclick = function () {
        if (!key) {
          // すべて = 全員(選んでいる人を外して、開いているグループも閉じる)
          options().forEach(function (o) { o.selected = false; });
          openGroup = "";
          changed();
          return;
        }
        openGroup = openGroup === key ? "" : key;
        render();
      };
      bar.appendChild(b);
    }
    gb("", "すべて");
    GROUP_BUTTONS.forEach(function (g) {
      if (accs.some(function (a) { return a.group === g; })) gb(g, g);
    });

    // そのほかのプルダウン(グループのボタンに入らない人)。選ぶと、その人を選んだ人に足す
    var other = $("other"), groups = {}, order = [];
    accs.forEach(function (a) {
      if (a.group) return;
      if (!groups[a.section]) { groups[a.section] = document.createElement("optgroup"); groups[a.section].label = a.section; order.push(a.section); }
      var o = el("option", a.off ? "off" : "", a.text);
      o.value = a.username;
      groups[a.section].appendChild(o);
    });
    order.forEach(function (s) { other.appendChild(groups[s]); });
    if (blocked.length) {
      var g = document.createElement("optgroup");
      g.label = "取得不可（" + blocked.length + "）";
      blocked.forEach(function (a) {
        var o = el("option", "", label(a) + "（" + reason(a.error) + "）");
        o.disabled = true;
        g.appendChild(o);
      });
      other.appendChild(g);
    }
    other.onchange = function () {
      if (other.value) { setSelected(other.value, true); changed(); }
      other.value = "";
    };
  }

  // ボタンと「選んでいる人」の表示を、いま選んでいる人に合わせる
  function render() {
    var sel = selected();
    document.querySelectorAll("#gbtn .gb").forEach(function (b) {
      var g = b.getAttribute("data-g");
      var on = g ? g === openGroup : !sel.length;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      // 開いていなくても、そのグループに選んでいる人がいれば印を付ける
      b.classList.toggle("has", !!g && accs.some(function (a) { return a.group === g && sel.indexOf(a.username) >= 0; }));
    });
    var box = $("gaccs");
    box.textContent = "";
    box.hidden = !openGroup;
    accs.forEach(function (a) {
      if (!openGroup || a.group !== openGroup) return;
      var on = sel.indexOf(a.username) >= 0;
      var b = el("button", "ab" + (on ? " on" : "") + (a.off ? " off" : ""), a.text);
      b.type = "button";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.onclick = function () { setSelected(a.username, !isSelected(a.username)); changed(); };
      box.appendChild(b);
    });
    // 選んでいる人(押すと外れる)。グループを閉じていても、プルダウンで選んだ人も、ここで分かる
    var picked = $("picked");
    picked.textContent = "";
    picked.hidden = !sel.length;
    if (sel.length) picked.appendChild(el("span", "plabel", "選んでいる人："));
    accs.forEach(function (a) {
      if (sel.indexOf(a.username) < 0) return;
      var b = el("button", "pk", a.text + " ×");
      b.type = "button";
      b.title = "外す";
      b.onclick = function () { setSelected(a.username, false); changed(); };
      picked.appendChild(b);
    });
  }

  function changed() { render(); load(false); }

  /* ---------- 検索語のハイライト ---------- */

  // 検索語を <mark> で囲む(大文字小文字・全角半角の違いは無視)
  function highlight(el, text, q) {
    var words = q.split(/[\s　]+/).filter(Boolean);
    if (!words.length) { el.textContent = text; return; }
    var norm = function (s) { return s.normalize("NFKC").toLowerCase(); };
    // NFKC で長さが変わる文字があるとずれるので、1文字ずつ正規化して元の位置と対応を取る
    var chars = Array.from(text), flat = "", map = [];
    chars.forEach(function (c, i) {
      var n = norm(c);
      for (var k = 0; k < n.length; k++) map.push(i);
      flat += n;
    });
    var hit = chars.map(function () { return false; });
    words.forEach(function (w) {
      w = norm(w);
      for (var i = flat.indexOf(w); i >= 0; i = flat.indexOf(w, i + 1)) {
        for (var k = i; k < i + w.length; k++) hit[map[k]] = true;
      }
    });
    var buf = "", on = false;
    function flush() {
      if (!buf) return;
      if (on) { var m = document.createElement("mark"); m.textContent = buf; el.appendChild(m); }
      else el.appendChild(document.createTextNode(buf));
      buf = "";
    }
    chars.forEach(function (c, i) { if (hit[i] !== on) { flush(); on = hit[i]; } buf += c; });
    flush();
  }

  /* ---------- 一覧 ---------- */

  function row(post, q) {
    var li = document.createElement("li");
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = post.ts.replace(/-/g, "/");
    li.appendChild(meta);
    var nm = document.createElement("button");
    nm.type = "button";
    nm.className = "name";
    nm.textContent = names[post.account] || post.account;
    nm.title = "このメンバーだけに絞り込む";
    nm.onclick = function () { only(post.account); };
    li.appendChild(nm);
    if (TYPE[post.media_type]) {
      var t = document.createElement("span");
      t.className = "type";
      t.textContent = TYPE[post.media_type];
      li.appendChild(t);
    }
    var a = document.createElement("a");
    // /reel/ だと別の動画に飛ばされることがあるので、リールも開ける /p/ にそろえる
    a.href = post.permalink.replace("/reel/", "/p/");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    // 以前の取り込みで絵文字が途中で割れた抜粋があるので、片割れのサロゲートを除いて出す
    var text = (post.excerpt || "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
    if (text) highlight(a, text, q); else a.textContent = "（本文なし）";
    li.appendChild(a);
    var see = document.createElement("button");
    see.type = "button";
    see.className = "see";
    see.textContent = "▶ ここで見る";
    see.onclick = function () { window.toggleEmbed(li, see, a.href); };
    li.appendChild(see);
    return li;
  }

  function load(more) {
    var my = ++listNo;
    var p = params();
    var q = p.get("q") || "";
    if (more && lastTs) p.set("before", lastTs);
    if (!more) {
      $("list").innerHTML = "";
      lastTs = "";
      // 条件をURLに残して、共有・再読み込みで同じ結果に戻れるようにする
      history.replaceState(null, "", p.toString() ? "?" + p.toString() : location.pathname);
      // 日付の指定があればカレンダーもその月へ
      var f = $("from").value;
      if (f) { calYear = +f.slice(0, 4); calMonth = +f.slice(5, 7); }
      loadCalendar();
    }
    $("status").textContent = "読み込み中…";
    $("more").hidden = true;
    getJson("/api/posts?" + p.toString())
      .then(function (d) {
        if (my !== listNo) return; // 後から出した条件の結果を優先
        d.posts.forEach(function (post) { $("list").appendChild(row(post, q)); });
        if (d.posts.length) lastTs = d.posts[d.posts.length - 1].ts;
        var n = $("list").children.length;
        $("status").textContent = n ? n + "件表示中" : "該当する投稿はありません";
        $("more").hidden = !d.more;
      })
      .catch(function () {
        if (my === listNo) $("status").textContent = "読み込みに失敗しました。時間をおいて再度お試しください。";
      });
  }

  function only(account) {
    options().forEach(function (o) { o.selected = o.value === account; });
    changed();
    $("f").scrollIntoView({ behavior: "smooth" });
  }

  /* ---------- カレンダー ---------- */

  // 選んでいる人(選んでいなければ全員)の、入っている投稿の最古と最新の日付。カレンダーと日付の欄はこの間だけにする
  function range() {
    var users = selected();
    if (!users.length) users = Object.keys(spans);
    var lo = "", hi = "";
    users.forEach(function (u) {
      var s = spans[u];
      if (!s) return;
      if (!lo || s.first < lo) lo = s.first;
      if (!hi || s.last > hi) hi = s.last;
    });
    return lo ? { lo: lo.slice(0, 10), hi: hi.slice(0, 10) } : null;
  }

  // 月の番号(年*12 + 月-1)
  function ym(date) { return +date.slice(0, 4) * 12 + (+date.slice(5, 7) - 1); }

  // 表示中の月を範囲の中に収め、日付の欄の min/max と、月を動かすボタンの押せる・押せないをそろえる
  function clampMonth() {
    var r = range();
    $("from").min = $("to").min = r ? r.lo : "";
    $("from").max = $("to").max = r ? r.hi : "";
    var cur = calYear * 12 + (calMonth - 1);
    if (r) cur = Math.min(Math.max(cur, ym(r.lo)), ym(r.hi));
    calYear = Math.floor(cur / 12);
    calMonth = cur % 12 + 1;
    document.querySelectorAll("[data-move]").forEach(function (b) {
      var to = cur + +b.getAttribute("data-move");
      // 1年ずつ動かすボタンは、行き先が範囲の外でも端の月まで動けるなら押せる
      b.disabled = !!r && (to < ym(r.lo) && cur === ym(r.lo) || to > ym(r.hi) && cur === ym(r.hi));
    });
  }

  function drawCalendar(days) {
    var grid = $("cal-grid");
    grid.innerHTML = "";
    $("cal-title").textContent = calYear + "年" + calMonth + "月";
    "日月火水木金土".split("").forEach(function (d) {
      var e = document.createElement("div");
      e.className = "dow";
      e.textContent = d;
      grid.appendChild(e);
    });
    var first = new Date(calYear, calMonth - 1, 1).getDay();
    var last = new Date(calYear, calMonth, 0).getDate();
    var max = 1;
    Object.keys(days || {}).forEach(function (k) { if (days[k] > max) max = days[k]; });
    var now = new Date();
    var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var selDay = $("from").value && $("from").value === $("to").value ? $("from").value : "";
    for (var i = 0; i < first; i++) grid.appendChild(document.createElement("div"));
    for (var d = 1; d <= last; d++) {
      var key = calYear + "-" + pad(calMonth) + "-" + pad(d);
      var n = days ? (days[key] || 0) : 0;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "day" + (n ? " has" : "") + (key === selDay ? " sel" : "") + (key === today ? " today" : "");
      b.innerHTML = "<span>" + d + "</span>" + (n ? '<span class="n">' + n + "</span>" : "");
      if (n) b.style.setProperty("--lv", (n / max).toFixed(2));
      b.disabled = !n && key !== selDay;
      b.setAttribute("aria-label", calMonth + "月" + d + "日 " + n + "件");
      b.onclick = (function (k) { return function () { pickDay(k); }; })(key);
      grid.appendChild(b);
    }
  }

  function loadCalendar() {
    clampMonth();
    var p = params();
    p.delete("from");
    p.delete("to");
    p.set("ym", calYear + "-" + pad(calMonth));
    drawCalendar(null);
    var my = ++calNo;
    getJson("/api/calendar?" + p.toString())
      .then(function (d) { if (my === calNo) drawCalendar(d.days); })
      .catch(function () {});
  }

  function move(delta) {
    var m = calYear * 12 + (calMonth - 1) + delta;
    calYear = Math.floor(m / 12);
    calMonth = m % 12 + 1;
    loadCalendar();
  }

  function pickDay(key) {
    var on = !($("from").value === key && $("to").value === key);
    $("from").value = $("to").value = on ? key : "";
    load(false);
  }

  function thisMonth() {
    var now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth() + 1;
  }

  /* ---------- 起動 ---------- */

  $("f").addEventListener("submit", function (e) { e.preventDefault(); load(false); });
  $("from").addEventListener("change", function () { load(false); });
  $("to").addEventListener("change", function () { load(false); });
  $("more").addEventListener("click", function () { load(true); });
  $("reset").addEventListener("click", function () {
    options().forEach(function (o) { o.selected = false; });
    openGroup = "";
    $("from").value = $("to").value = $("q").value = "";
    thisMonth();
    changed();
  });
  document.querySelectorAll("[data-move]").forEach(function (b) {
    b.addEventListener("click", function () { move(+b.getAttribute("data-move")); });
  });

  getJson("/api/accounts")
    .then(function (d) {
      fillAccounts(d.accounts);
      // 収録しているアカウント(投稿が1件以上ある、いまの対象の人)と投稿の数
      var got = d.accounts.filter(function (a) { return a.active && a.posts > 0; });
      var total = got.reduce(function (n, a) { return n + a.posts; }, 0);
      if (got.length) $("stats").textContent = "収録 " + total.toLocaleString("ja-JP") + " 投稿 / " + got.length + " アカウント";
    })
    .catch(function () {})
    .then(function () {
      // URLの条件を復元してから初回表示
      var q = new URLSearchParams(location.search);
      var acc = (q.get("a") || "").split(",");
      options().forEach(function (o) { o.selected = acc.indexOf(o.value) >= 0; });
      render();
      $("from").value = q.get("from") || "";
      $("to").value = q.get("to") || "";
      $("q").value = q.get("q") || "";
      thisMonth();
      load(false);
    });
})();
