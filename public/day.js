// 日付で見る(/day)。選んだ日の投稿を時刻の順に並べ、グループ(アカウントの見出し)で絞る。
// 条件は ?d=日付&g=グループ で URL に残す(今日・すべては書かない)
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var dateEl = $("date"), gnav = $("gnav"), statusEl = $("status"), list = $("results");
  var TYPE = { VIDEO: "動画", CAROUSEL_ALBUM: "複数枚", IMAGE: "画像" };

  var names = {};      // ユーザー名 → 表示名
  var sectionOf = {};  // ユーザー名 → 見出し(グループ名・J.P ROOM など。対象から外れた人は「以前の対象」)
  var sections = [];   // 見出しの並び(アカウント一覧の順)
  var first = "", last = "";   // 入っている投稿の最古・最新の日付
  var day = "", rows = [], pick = "", seq = 0;

  // 日付は日本時間で扱う
  function jstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
  function shift(d, n) {
    var t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function label(d) {
    var p = d.split("-").map(Number);
    var w = "日月火水木金土"[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    return p[0] + "年" + p[1] + "月" + p[2] + "日（" + w + "）";
  }
  // 以前の取り込みで絵文字が途中で割れた抜粋があるので、片割れのサロゲートを除く
  function clean(s) {
    return String(s || "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function sectionOfRow(r) { return sectionOf[r.account] || "以前の対象"; }
  function inPick(r) { return !pick || sectionOfRow(r) === pick; }

  function drawNav() {
    gnav.textContent = "";
    var count = {};
    rows.forEach(function (r) { var s = sectionOfRow(r); count[s] = (count[s] || 0) + 1; });
    function item(key, name, n) {
      var b = el("button", "gitem" + (pick === key ? " on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", pick === key ? "true" : "false");
      var gn = el("span", "gname", name);
      gn.setAttribute("data-label", name);   // 選ぶと太字になっても幅が変わらないように(style.css)
      b.appendChild(gn);
      b.appendChild(el("span", "n", String(n)));
      b.onclick = function () { pick = pick === key && key ? "" : key; sync(); draw(); };
      return b;
    }
    gnav.appendChild(item("", "すべて", rows.length));
    // その日に投稿がある見出しだけ、アカウント一覧の順に出す
    sections.concat(["以前の対象"]).forEach(function (s) {
      if (count[s]) gnav.appendChild(item(s, s, count[s]));
    });
  }

  function drawList() {
    list.textContent = "";
    var shown = rows.filter(inPick);
    shown.forEach(function (r) {
      var li = document.createElement("li");
      var meta = el("p", "meta");
      meta.appendChild(el("time", null, r.ts.slice(11, 16)));
      meta.appendChild(el("span", "who", names[r.account] || r.account));
      if (TYPE[r.media_type]) meta.appendChild(el("span", "type", TYPE[r.media_type]));
      li.appendChild(meta);
      // 本文の抜粋は黒い文字で、リンクにしない。元の投稿へは下の「Instagram で開く ↗」
      li.appendChild(el("p", "text", clean(r.excerpt) || "（本文なし）"));
      li.appendChild(window.postActions(li, r.permalink));
      list.appendChild(li);
    });
    var name = pick ? pick + "・" : "";
    statusEl.textContent = rows.length
      ? label(day) + "　" + name + shown.length + " 件"
      : label(day) + "　この日の投稿はありません";
  }

  function draw() { drawNav(); drawList(); }

  function sync(push) {
    var p = new URLSearchParams();
    if (day !== jstToday()) p.set("d", day);
    if (pick) p.set("g", pick);
    var u = location.pathname + (p.toString() ? "?" + p.toString() : "");
    if (push) history.pushState(null, "", u); else history.replaceState(null, "", u);
  }

  function load(d, push) {
    // 入っている投稿の最古〜最新(今日)の間だけ
    if (first && d < first) d = first;
    if (d > jstToday()) d = jstToday();
    day = d;
    dateEl.value = d;
    $("prev").disabled = !!first && d <= first;
    $("next").disabled = d >= jstToday();
    sync(push);
    var my = ++seq;
    statusEl.textContent = label(d) + "　読み込み中…";
    list.classList.add("loading");
    fetch("/api/day?d=" + d)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (res) {
        if (my !== seq) return;   // 連打したときは最後の日付だけ描く
        rows = res.posts || [];
        draw();
        if (res.truncated) statusEl.textContent += "（多すぎるため一部だけ表示しています）";
      })
      .catch(function () {
        if (my === seq) statusEl.textContent = "読み込めませんでした。時間をおいて開き直してください";
      })
      .then(function () { if (my === seq) list.classList.remove("loading"); });
  }

  function fromUrl() {
    var p = new URLSearchParams(location.search);
    var d = p.get("d") || "";
    pick = p.get("g") || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : jstToday();
  }

  dateEl.max = jstToday();
  dateEl.addEventListener("change", function () { if (dateEl.value) load(dateEl.value, true); });
  $("prev").addEventListener("click", function () { load(shift(day, -1), true); });
  $("next").addEventListener("click", function () { load(shift(day, 1), true); });
  $("today").addEventListener("click", function () { load(jstToday(), true); });
  $("dayform").addEventListener("submit", function (e) { e.preventDefault(); });
  window.addEventListener("popstate", function () { load(fromUrl(), false); });

  // 名前と見出しを先に読んでから一覧を出す
  fetch("/api/accounts")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      (d.accounts || []).forEach(function (a) {
        names[a.username] = a.name;
        if (!a.active) return;
        sectionOf[a.username] = a.section;
        if (sections.indexOf(a.section) < 0) sections.push(a.section);
        if (a.first && (!first || a.first < first)) first = a.first.slice(0, 10);
        if (a.last && (!last || a.last > last)) last = a.last.slice(0, 10);
      });
      if (first) dateEl.min = first;
    })
    .catch(function () {})
    .then(function () { load(fromUrl(), false); });
})();
