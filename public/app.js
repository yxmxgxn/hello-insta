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
    if ($("act").checked) p.set("act", "1");
    if ($("order").value) p.set("order", $("order").value);
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
  var ACTIVE_GROUPS = ["モーニング娘。", "アンジュルム", "Juice=Juice", "つばきファクトリー", "BEYOOOOONDS", "OCHA NORMA", "ロージークロニクル"];
  var GROUP_BUTTONS = ["モーニング娘。", "アンジュルム", "Juice=Juice", "つばきファクトリー", "BEYOOOOONDS",
    "OCHA NORMA", "ロージークロニクル", "J.P ROOM", "UP-FRONT CREATE", "UP-FRONT PROMOTION"];
  var accs = [];      // 選べるアカウント(アカウント一覧の順)
  var redrawOther = function () {};   // 「その他のアカウント」のプルダウンを作り直す(開いているグループに合わせる)
  var otherCount = 0;                 // いまプルダウンに入っている人数
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
      accs.push({ username: a.username, section: sec, group: a.active ? groupOf(sec) : "", text: text, off: !a.posts, groups: a.groups || "" });
      // 選んでいる人は、見えない select に持つ(URL・検索の条件はここから作る)
      var o = document.createElement("option");
      o.value = a.username;
      sel.appendChild(o);
    });

    // グループのボタン
    var bar = $("gbtn");
    function gb(key, name) {
      var b = el("button", "gb", name);
      b.setAttribute("data-label", name);
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

    // 「その他のアカウント」のプルダウン(グループのボタンに入らない人)。選ぶと、その人を選んだ人に足す。
    // グループのボタンを開いているときは、そのグループにいたことがある人だけに絞る
    var other = $("other");
    redrawOther = function () {
      var inG = function (a) { return !openGroup || (a.groups || "").indexOf("," + openGroup + ",") >= 0; };
      var groups = {}, order = [], count = 0;
      other.textContent = "";
      other.appendChild(el("option", "", "その他のアカウント"));
      other.firstChild.value = "";
      accs.forEach(function (a) {
        if (a.group || !inG(a)) return;
        if (!groups[a.section]) { groups[a.section] = []; order.push(a.section); }
        var o = el("option", a.off ? "off" : "", a.text);
        o.value = a.username;
        groups[a.section].push(o);
        count++;
      });
      // 並び: OG → グループ → その他(公式・オデッセー出版など。線は入れず、見出し「その他」の下に並べる) → 以前の対象 → 取得不可
      // 見出しは optgroup(ブラウザの標準の見出し。太字で、選べない。スマホでも丸い印は出ない)。
      // 「その他のアカウント」の中に「その他の…」が重ならないよう、「その他のOG」は「OG」、「その他のグループ」は「グループ」と出す
      var HEAD = { "その他のOG": "OG", "その他のグループ": "グループ" };
      function addGroup(label, opts) {
        if (!opts.length) return;
        var g = document.createElement("optgroup");
        g.label = label;
        opts.forEach(function (o) { g.appendChild(o); });
        other.appendChild(g);
      }
      addGroup("OG", groups["その他のOG"] || []);
      addGroup("グループ", groups["その他のグループ"] || []);
      var rest = [];
      order.forEach(function (s) { if (!HEAD[s] && s !== "以前の対象") rest = rest.concat(groups[s]); });
      addGroup("その他", rest);
      addGroup("以前の対象", groups["以前の対象"] || []);
      var bl = blocked.filter(inG);
      if (bl.length) {
        var bo = bl.map(function (a) {
          var o = el("option", "", label(a) + "（" + reason(a.error) + "）");
          o.disabled = true;
          return o;
        });
        addGroup("取得不可（" + bl.length + "）", bo);
        count += bl.length;
      }
      otherCount = count;
      other.value = "";
    };
    redrawOther();
    other.onchange = function () {
      if (other.value) { setSelected(other.value, true); changed(); }
      other.value = "";
    };
  }

  // ボタンと「選んでいる人」の表示を、いま選んでいる人に合わせる
  function render() {
    var sel = selected();
    var act = $("act").checked;
    $("pick-label").textContent = sel.length ? "メンバー選択　現在" + sel.length + "人" : "メンバー選択";
    // 現役のみのときは、現役グループのボタンだけ(OG のグループと「その他のアカウント」は隠す)
    redrawOther();
    $("other").hidden = act || !otherCount;
    if (act && openGroup && ACTIVE_GROUPS.indexOf(openGroup) < 0) openGroup = "";
    document.querySelectorAll("#gbtn .gb").forEach(function (b) {
      var g = b.getAttribute("data-g");
      b.hidden = act && !!g && ACTIVE_GROUPS.indexOf(g) < 0;
      var on = g ? g === openGroup : !sel.length;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      // 開いていなくても、そのグループに選んでいる人がいれば印を付ける
      b.classList.toggle("has", !!g && accs.some(function (a) { return a.group === g && sel.indexOf(a.username) >= 0; }));
    });
    var box = $("gaccs");
    box.textContent = "";
    box.hidden = !openGroup;
    // 開いているグループの全員を、まとめて選ぶ・外す(右上)
    if (openGroup) {
      var members = accs.filter(function (a) { return a.group === openGroup; });
      var allOn = members.length > 0 && members.every(function (a) { return sel.indexOf(a.username) >= 0; });
      var head = el("div", "gall");
      var allBtn = el("button", "ghost", allOn ? "全員外す" : "全員選ぶ");
      allBtn.type = "button";
      allBtn.onclick = function () { members.forEach(function (a) { setSelected(a.username, !allOn); }); changed(); };
      head.appendChild(allBtn);
      box.appendChild(head);
    }
    accs.forEach(function (a) {
      if (!openGroup || a.group !== openGroup) return;
      var on = sel.indexOf(a.username) >= 0;
      var b = el("button", "ab" + (on ? " on" : "") + (a.off ? " off" : ""), a.text);
      b.setAttribute("data-label", a.text);
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

  // メンバーの選び方が変わったら、期間の指定(いつから・いつまで・押した月や日)は外す(アメブロ検索と同じ)
  var lastSel = null;
  function changed() {
    var now = selected().join(",");
    if (lastSel !== null && now !== lastSel) $("from").value = $("to").value = "";
    lastSel = now;
    render();
    load(false);
  }

  /* ---------- 検索語のハイライト ---------- */

  // 検索語を <mark> で囲む(大文字小文字・全角半角の違いは無視)
  function highlight(el, text, q) {
    var words = q.split(/[\s　]+/).filter(function (w) { return w && !/^[-－‐−]/.test(w); });   // 「-」の語(含まない語)は色を付けない
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

  /* ---------- 名前を押したときの小さなメニュー(暫定) ---------- */
  // 「この人の投稿だけ見る」(サイトの中で絞り込む)か「Instagram のプロフィールを開く ↗」かを選ぶ。
  // はい・いいえで聞かず、押せば何が起きるかを書いた2つから選ぶ。外を押すか Esc で閉じる
  var menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function nameMenu(btn, account) {
    var same = menu && menu.getAttribute("data-for") === account && menu.previousSibling === btn;
    closeMenu();
    if (same) return;   // もう一度押したら閉じるだけ
    menu = document.createElement("div");
    menu.className = "nmenu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-for", account);
    var only1 = document.createElement("button");
    only1.type = "button";
    only1.setAttribute("role", "menuitem");
    only1.textContent = (names[account] || account) + " の投稿だけ見る";
    only1.onclick = function () { closeMenu(); only(account); };
    var prof = document.createElement("a");
    prof.setAttribute("role", "menuitem");
    prof.href = "https://www.instagram.com/" + encodeURIComponent(account) + "/";
    prof.target = "_blank";
    prof.rel = "noopener noreferrer";
    prof.textContent = "Instagram のプロフィールを開く ↗";
    prof.onclick = closeMenu;
    menu.appendChild(only1);
    menu.appendChild(prof);
    btn.insertAdjacentElement("afterend", menu);
    only1.focus();
  }
  document.addEventListener("click", function (e) { if (menu && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });

  /* ---------- 一覧 ---------- */

  function row(post, q) {
    var li = document.createElement("li");
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = post.ts;   // 2026-11-18 21:01(アメブロ検索と同じハイフン。秒は持たない)
    li.appendChild(meta);
    var nm = document.createElement("button");
    nm.type = "button";
    nm.className = "name";
    nm.textContent = names[post.account] || post.account;
    nm.setAttribute("aria-haspopup", "menu");
    nm.onclick = function (e) { e.stopPropagation(); nameMenu(nm, post.account); };
    li.appendChild(nm);
    if (TYPE[post.media_type]) {
      var t = document.createElement("span");
      t.className = "type";
      t.textContent = TYPE[post.media_type];
      li.appendChild(t);
    }
    // 本文の抜粋は黒い文字で、リンクにしない(選んでコピーでき、触っただけで外へ飛ばない)
    var p = document.createElement("p");
    p.className = "text";
    // 以前の取り込みで絵文字が途中で割れた抜粋があるので、片割れのサロゲートを除いて出す
    var text = (post.excerpt || "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
    if (text) highlight(p, text, q); else p.textContent = "（本文なし）";
    li.appendChild(p);
    li.appendChild(window.postActions(li, post.permalink));
    return li;
  }

  // 「test ／ ハロプロ現役のみ ／ 40 件表示」の前半(いまの条件。アメブロ検索と同じ言い方)
  function periodLabel(f, t) {
    function lab(v, day) { var a = v.split("-"); return a[0] + "年" + (+a[1]) + "月" + (day ? (+a[2]) + "日" : ""); }
    var last = function (v) { return +v.slice(8, 10) === new Date(+v.slice(0, 4), +v.slice(5, 7), 0).getDate(); };
    if (f && t && f === t) return lab(f, true);
    var fm = !f || f.slice(8, 10) === "01", tm = !t || last(t);
    if (f && t && fm && tm) {
      if (f.slice(0, 4) === t.slice(0, 4) && f.slice(5, 7) === "01" && t.slice(5, 7) === "12") return f.slice(0, 4) + "年";
      if (f.slice(0, 7) === t.slice(0, 7)) return lab(f);
    }
    return (f ? lab(f, !fm) : "") + "〜" + (t ? lab(t, !tm) : "");
  }
  function condText() {
    var parts = [], q = $("q").value.trim(), sel = selected();
    if (q) parts.push("「" + q + "」");
    if (sel.length) {
      var nm = sel.map(function (u) { return names[u] || u; });
      parts.push(nm.length > 3 ? nm.slice(0, 3).join("・") + " ほか" + (nm.length - 3) + "人" : nm.join("・"));
    } else if ($("act").checked) {
      parts.push("ハロプロ現役のみ");
    }
    var f = $("from").value, t = $("to").value;
    if (f || t) parts.push(periodLabel(f, t));
    return parts.join(" ／ ");
  }

  function load(more) {
    var my = ++listNo;
    var p = params();
    var q = p.get("q") || "";
    var cond = condText();
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
        if (d.error === "notonly") {
          $("status").textContent = "「-」の付いた語（含まない語）だけでは探せません。含む語と一緒に使ってください";
          return;
        }
        var n = $("list").children.length;
        $("status").textContent = n
          ? (cond ? cond + " ／ " : "") + n.toLocaleString("ja-JP") + " 件表示" + (d.more ? "（まだあります）" : "")
          : (cond ? cond + " ／ " : "") + "該当する投稿はありません";
        $("more").hidden = !d.more;
        $("more").textContent = $("order").value === "old" ? "さらに新しい投稿" : "さらに古い投稿";
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

  /* ---------- 月ごとの件数 ---------- */
  // 選んでいる人・検索語の条件での { "YYYY-MM": 件数 }。年×月の表、いつから・いつまでの選択肢、カレンダーの移動に使う
  var months = null, monthsKey = null, monthsNo = 0;
  function yms() { return months ? Object.keys(months).sort() : []; }
  // いつから・いつまでで絞った月の範囲(月の番号)。月や日を押して1か月の中だけにしたときは、表とカレンダーは絞らない
  function period() {
    var f = $("from").value, t = $("to").value;
    if (!f && !t) return null;
    if (f && t && f.slice(0, 7) === t.slice(0, 7)) return null;
    return { lo: f ? ym(f) : -Infinity, hi: t ? ym(t) : Infinity };
  }
  // 表とカレンダーに出す、投稿のある月(いつから・いつまでの範囲の中だけ)
  function shownYms() {
    var r = period();
    return yms().filter(function (k) { return !r || ym(k) >= r.lo && ym(k) <= r.hi; });
  }
  function loadMonths() {
    var p = params();
    p.delete("from");
    p.delete("to");
    p.delete("order");
    var key = p.toString();
    if (key === monthsKey) return Promise.resolve();
    monthsKey = key;
    var my = ++monthsNo;
    return getJson("/api/calendar?" + key)
      .then(function (d) {
        if (my !== monthsNo) return;
        months = {};
        d.months.forEach(function (r) { months[r[0]] = r[1]; });
      })
      .catch(function () { if (my === monthsNo) { months = null; monthsKey = null; } });
  }

  /* ---------- いつから・いつまで(年・月を選ぶ) ---------- */
  // 日はカレンダーで選ぶので、ここは年と月だけ。ブラウザの日付の欄は端末によって令和の表示になるので使わない。
  // 値は見えない #from / #to に YYYY-MM-DD で持つ(URL・検索の条件はここから作る)。
  // 年だけでも選べる: いつからは その年(月)の初め、いつまでは その年(月)の終わり になる
  function lastDay(y, m) { return new Date(Date.UTC(+y, +m, 0)).getUTCDate(); }
  function opt(sel, value, text) {
    var o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  function boxOf(id) { return document.querySelector('.dsel[data-for="' + id + '"]'); }
  // プルダウンの年・月から #from / #to の値を作る
  function dateValue(id, y, m) {
    if (!y) return "";
    var mm = m || (id === "from" ? "1" : "12");
    return y + "-" + pad(+mm) + "-" + pad(id === "from" ? 1 : lastDay(y, mm));
  }
  // 年は投稿のある年だけ、月はその年の投稿のある月だけを選択肢にし、#from / #to の値をプルダウンに映す
  function syncDates() {
    var list = yms(), years = [];
    list.forEach(function (k) { var y = k.slice(0, 4); if (years.indexOf(y) < 0) years.push(y); });
    if (!list.length) {
      var r = range();
      if (r) for (var k = +r.lo.slice(0, 4); k <= +r.hi.slice(0, 4); k++) years.push(String(k));
    }
    years.reverse();   // 新しい年を上に
    ["from", "to"].forEach(function (id) {
      var v = $(id).value, box = boxOf(id);
      var y = box.querySelector(".y"), m = box.querySelector(".m");
      var vy = v.slice(0, 4), vm = v ? String(+v.slice(5, 7)) : "";
      // 年だけで選んだとき(1月1日〜 / 〜12月31日)は、月を空のままにしておく
      if (y.value === vy && !m.value && dateValue(id, vy, "") === v) vm = "";
      y.textContent = "";
      opt(y, "", "年");
      var ys = years.slice();
      if (vy && ys.indexOf(vy) < 0) ys.push(vy), ys.sort().reverse();
      ys.forEach(function (k) { opt(y, k, k + "年"); });
      m.textContent = "";
      opt(m, "", "月");
      var ms = list.filter(function (k) { return k.slice(0, 4) === vy; }).map(function (k) { return String(+k.slice(5, 7)); });
      if (!list.length && vy) for (k = 1; k <= 12; k++) ms.push(String(k));
      if (vm && ms.indexOf(vm) < 0) ms.push(vm), ms.sort(function (a, b) { return a - b; });
      ms.forEach(function (k) { opt(m, k, k + "月"); });
      m.disabled = !vy;
      y.value = vy;
      m.value = vm;
    });
  }
  // プルダウンを選んだら、#from / #to の値を作って一覧を出し直す
  function dateChanged(id, changedYear) {
    var box = boxOf(id);
    var y = box.querySelector(".y").value, m = box.querySelector(".m").value;
    // 年を変えて、その年に投稿のない月になったら、月は外す
    if (changedYear && m && months && !months[y + "-" + pad(+m)]) { m = ""; box.querySelector(".m").value = ""; }
    $(id).value = dateValue(id, y, m);
    load(false);
  }
  document.querySelectorAll(".dsel").forEach(function (box) {
    var id = box.getAttribute("data-for");
    box.querySelector(".y").addEventListener("change", function () { dateChanged(id, true); });
    box.querySelector(".m").addEventListener("change", function () { dateChanged(id, false); });
  });

  /* ---------- 年×月の表とカレンダー(アメブロ検索と同じ形) ---------- */

  // 月の番号(年*12 + 月-1)。YYYY-MM でも YYYY-MM-DD でもよい
  function ym(date) { return +date.slice(0, 4) * 12 + (+date.slice(5, 7) - 1); }
  function curYm() { return calYear * 12 + (calMonth - 1); }
  function setYm(n) { calYear = Math.floor(n / 12); calMonth = n % 12 + 1; }

  // 前・次の投稿がある月(月ごとの件数がまだ無いときは隣の月)
  function stepYm(cur, dir) {
    var list = shownYms().map(ym);
    if (!list.length) return cur + dir;
    if (dir < 0) { for (var i = list.length - 1; i >= 0; i--) if (list[i] < cur) return list[i]; }
    else { for (i = 0; i < list.length; i++) if (list[i] > cur) return list[i]; }
    return null;
  }

  // 表示中の月を、投稿のある範囲の中に収める
  function clampMonth() {
    var list = shownYms(), r = range();
    var lo = list.length ? ym(list[0]) : r ? ym(r.lo) : null;
    var hi = list.length ? ym(list[list.length - 1]) : r ? ym(r.hi) : null;
    var cur = curYm();
    if (lo !== null) cur = Math.min(Math.max(cur, lo), hi);
    setYm(cur);
  }

  // 色の濃さ: 少ないほどアイコンのベージュ、多いほど茶色。濃いところは字を白に
  // 色の濃さは4段階(アメブロ検索と同じ)。少ないほどアイコンのベージュ、多いほど茶色
  function shade(b, n, max) {
    if (n) b.classList.add("l" + Math.min(4, Math.ceil(n / max * 4)));
  }

  // 年が左、月が上の表。数字はその月の投稿数。押すとその月だけを表示し、もう一度押すと外す
  function drawYears() {
    var box = $("years");
    box.textContent = "";
    var list = shownYms();
    // 2人以上を選んでいるときは出さない(何人も混ぜた月ごとの数は見ても使いどころがない)。日のカレンダーは出す
    if (!list.length || selected().length > 1) return;
    var max = 1;
    list.forEach(function (k) { if (months[k] > max) max = months[k]; });
    var f = $("from").value, t = $("to").value;
    box.appendChild(document.createElement("span"));
    for (var m = 1; m <= 12; m++) {
      var h = document.createElement("span");
      h.className = "mh";
      h.textContent = m;
      box.appendChild(h);
    }
    for (var y = +list[list.length - 1].slice(0, 4); y >= +list[0].slice(0, 4); y--) {
      var yl = document.createElement("span");
      yl.className = "yl";
      yl.textContent = y;
      box.appendChild(yl);
      for (m = 1; m <= 12; m++) {
        var key = y + "-" + pad(m), n = list.indexOf(key) >= 0 ? months[key] : 0;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ymc" + (f === key + "-01" && t === key + "-" + pad(lastDay(y, m)) ? " sel" : "") +
          (y === calYear && m === calMonth ? " cur" : "");
        b.textContent = n ? n : "";
        b.disabled = !n;
        b.title = y + "年" + m + "月 " + n + "件";
        b.setAttribute("aria-label", b.title);
        shade(b, n, max);
        b.onclick = (function (k, yy, mm) { return function () { pickMonth(k, yy, mm); }; })(key, y, m);
        box.appendChild(b);
      }
    }
  }

  function pickMonth(key, y, m) {
    var f = key + "-01", t = key + "-" + pad(lastDay(y, m));
    var on = !($("from").value === f && $("to").value === t);
    $("from").value = on ? f : "";
    $("to").value = on ? t : "";
    setYm(y * 12 + m - 1);
    load(false);
  }

  function drawCalendar(days) {
    var grid = $("cal-grid");
    grid.innerHTML = "";
    var total = months ? months[calYear + "-" + pad(calMonth)] : null;
    $("cal-title").textContent = calYear + "年" + calMonth + "月" + (total != null ? "（" + total.toLocaleString("ja-JP") + "件）" : "");
    var cur = curYm();
    $("prev").disabled = stepYm(cur, -1) === null;
    $("next").disabled = stepYm(cur, 1) === null;
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
      b.className = "day" + (key === selDay ? " sel" : "") + (key === today ? " today" : "");
      // 日付の横に件数(アメブロ検索と同じ「日/件数件」)
      b.innerHTML = "<span>" + d + "</span>" + (n ? "<small>/" + n + '<span class="u">件</span></small>' : "");
      shade(b, n, max);
      b.disabled = !n && key !== selDay;
      b.setAttribute("aria-label", calMonth + "月" + d + "日 " + n + "件");
      b.onclick = (function (k) { return function () { pickDay(k); }; })(key);
      grid.appendChild(b);
    }
  }

  // 表とカレンダーは、メンバーを選んでいるときだけ(アメブロ検索と同じ)。いつから・いつまでは、いつも出しておく
  function loadCalendar() {
    var my = ++calNo;
    var on = selected().length > 0;
    $("cal").hidden = !on;
    if (!on) { months = null; monthsKey = null; syncDates(); return; }
    loadMonths().then(function () {
      if (my !== calNo) return;
      clampMonth();
      syncDates();
      drawYears();
      drawCalendar(null);
      var p = params();
      p.delete("from");
      p.delete("to");
      p.delete("order");
      p.set("ym", calYear + "-" + pad(calMonth));
      return getJson("/api/calendar?" + p.toString())
        .then(function (d) { if (my === calNo) drawCalendar(d.days); });
    }).catch(function () {});
  }

  function move(dir) {
    var to = stepYm(curYm(), dir);
    if (to === null) return;
    setYm(to);
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

  // メンバー選択のパネル(開く・閉じる)。検索したら畳む(結果を見せるため)
  function panel(open) {
    $("panel").hidden = !open;
    $("pick-open").setAttribute("aria-expanded", open ? "true" : "false");
  }
  $("pick-open").addEventListener("click", function () { panel($("panel").hidden); });
  $("pick-close").addEventListener("click", function () { panel(false); });
  $("order").addEventListener("change", function () { load(false); });
  $("f").addEventListener("submit", function (e) { e.preventDefault(); panel(false); load(false); });
  $("more").addEventListener("click", function () { load(true); });
  $("reset").addEventListener("click", function () {
    options().forEach(function (o) { o.selected = false; });
    openGroup = "";
    $("act").checked = false;
    $("order").value = "";
    $("from").value = $("to").value = $("q").value = "";
    thisMonth();
    changed();
  });
  // 日付をリセット: いつから・いつまで(カレンダーで押した日も)だけを外す。メンバーや検索語はそのまま
  $("reset-date").addEventListener("click", function () {
    $("from").value = $("to").value = "";
    load(false);
  });
  // ハロプロ現役のみ: 入れたら、現役グループ以外の人の選択は外す。期間の指定も外す
  $("act").addEventListener("change", function () {
    if ($("act").checked) {
      accs.forEach(function (a) { if (ACTIVE_GROUPS.indexOf(a.group) < 0) setSelected(a.username, false); });
    }
    $("from").value = $("to").value = "";
    lastSel = null;
    changed();
  });
  $("prev").addEventListener("click", function () { move(-1); });
  $("next").addEventListener("click", function () { move(1); });

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
      lastSel = selected().join(",");
      $("act").checked = q.get("act") === "1";
      $("order").value = q.get("order") === "old" ? "old" : "";
      render();
      $("from").value = q.get("from") || "";
      $("to").value = q.get("to") || "";
      $("q").value = q.get("q") || "";
      thisMonth();
      load(false);
    });
})();
