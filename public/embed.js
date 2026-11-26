// Instagram 公式の埋め込みを、押したときだけ、暗い背景のポップアップで開く(トップと /day で共通)。
// window.postActions(li, permalink) は、投稿の下の「▶ ここで見る」「Instagram で見る ↗」の行を作る。
// ポップアップの中では、「‹」「›」・キーボードの ← → ・(パソコンは)暗い背景でのホイールで、一覧の前後の投稿に移れる。
// 閉じるのは「×」・背景・Esc。前後の投稿は、開いた投稿が表示し終わってから、裏で先に読み込んでおく
(function () {
  "use strict";

  // Instagram の「埋め込み」と同じ blockquote を置き、公式の embed.js に iframe へ変えてもらう(高さも合わせてくれる)。
  // embed.js は最初に押したときに1回だけ読み込む。押さない人には Instagram の読み込みは何も起きない。
  // 非公開・埋め込み禁止の投稿は変換されず、中の「Instagram で見る」のリンクがそのまま残る
  var embedJs = null;
  function loadEmbedJs() {
    if (!embedJs) {
      embedJs = new Promise(function (ok, ng) {
        var s = document.createElement("script");
        s.src = "https://www.instagram.com/embed.js";
        s.async = true;
        s.onload = ok;
        s.onerror = ng;
        document.head.appendChild(s);
      });
      // 読み込めなかったら、次に押したときにもう一度試す
      embedJs.catch(function () { embedJs = null; });
    }
    return embedJs;
  }

  var modal = null;      // ポップアップ(開いている間だけ)
  var current = null;    // いま出している投稿の li
  var opener = null;     // 開いたボタン(閉じたらここに戻す)
  var cards = [];        // 読み込み済みのカード [{ li, el }]。いま出している投稿と、その前後だけ持つ
  var warmTimer = 0;

  function urlOf(li) { return li.getAttribute("data-url"); }

  // 一覧の中の、見られる投稿(前後に移る範囲)
  function items(li) {
    return Array.prototype.filter.call(li.parentNode.children, function (e) { return e.getAttribute && e.getAttribute("data-url"); });
  }

  // li の埋め込みのカードを作る(あれば、それを返す)。まだ出さない
  function ensure(li) {
    for (var i = 0; i < cards.length; i++) if (cards[i].li === li) return cards[i].el;
    var el = document.createElement("div");
    el.className = "emodal-card";
    var bq = document.createElement("blockquote");
    bq.className = "instagram-media";
    bq.setAttribute("data-instgrm-permalink", urlOf(li));
    bq.setAttribute("data-instgrm-version", "14");
    bq.setAttribute("data-instgrm-captioned", "");
    var link = document.createElement("a");
    link.href = urlOf(li);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Instagram で見る";
    bq.appendChild(link);
    el.appendChild(bq);
    modal.querySelector(".emodal-stage").appendChild(el);
    cards.push({ li: li, el: el });
    // パソコンで、両側にうすく見えている前後のカードは、押すとそこへ移る(中は Instagram の画面なので、上に重ねた幕が受ける)
    el.addEventListener("click", function () {
      if (el.classList.contains("side-prev")) step(-1);
      else if (el.classList.contains("side-next")) step(1);
    });
    // 8秒たっても埋め込みにならなければ(非公開・埋め込み禁止・読み込めないなど)、右下の「Instagram で開く」を案内する
    setTimeout(function () { if (!el.querySelector("iframe.instagram-media-rendered")) el.classList.add("fail"); }, 8000);
    loadEmbedJs()
      .then(function () { if (window.instgrm) window.instgrm.Embeds.process(); })
      .catch(function () { /* 読み込めなくても「Instagram で見る」は押せる */ });
    return el;
  }

  // 前後の投稿を、裏で先に読み込む(動かすときに、待たずに出るように)。回線を節約したい設定のときはしない。
  // いま出している投稿が先に出るよう、少し待ってから。次を先に、そのあと前
  function warm(li) {
    clearTimeout(warmTimer);
    var save = navigator.connection && navigator.connection.saveData;
    warmTimer = setTimeout(function () {
      if (!modal || current !== li) return;
      var all = items(li), i = all.indexOf(li);
      var keep = [li];
      if (!save) {
        if (all[i + 1]) { keep.push(all[i + 1]); ensure(all[i + 1]); }
        if (all[i - 1]) { keep.push(all[i - 1]); ensure(all[i - 1]); }
      }
      // 離れた投稿のカードは捨てる(増やし続けない)
      cards = cards.filter(function (c) {
        if (keep.indexOf(c.li) >= 0) return true;
        c.el.remove();
        return false;
      });
      mark(li);
    }, 1500);
  }

  // 枠の高さは、投稿によらず同じに決めておく(早く動かしても枠が縮んだり開いたりしない。右下の「Instagram で見る ↗」の位置も動かない)。
  // 埋め込みの高さは投稿ごとに違うので、よくある縦長の写真(4:5)とその下の分(約200px)を見込み、画面に収まる高さまで。
  // それより長い投稿は、枠の中だけがスクロールする。読み込み中は、枠の真ん中に「くるくる」を出す
  function reserve(el) {
    var stage = el.parentNode, w = stage.clientWidth;
    var max = parseFloat(getComputedStyle(el).maxHeight) || 0;
    var h = Math.round(1.25 * w + 200);
    el.style.height = (max ? Math.min(h, max) : h) + "px";
  }

  // いま出している投稿(on)と、一覧の前(side-prev)・後(side-next)のカードに印を付ける。
  // 前後は、広い画面(パソコン)だけ、カードの両側にうすく見せる(style.css)。枠の高さは、3枚とも同じに決めておく
  function mark(li) {
    var all = items(li), i = all.indexOf(li);
    cards.forEach(function (c) {
      var k = all.indexOf(c.li) - i;
      c.el.classList.toggle("on", k === 0);
      c.el.classList.toggle("side-prev", k === -1);
      c.el.classList.toggle("side-next", k === 1);
      reserve(c.el);
    });
  }

  function show(li) {
    current = li;
    ensure(li);
    mark(li);
    var el = ensure(li);
    el.scrollTop = 0;
    // 前後の投稿(なければ「‹」「›」は押せない)。後ろの投稿が無くても、「さらに古い投稿」があれば押して読み込む
    var all = items(li), i = all.indexOf(li);
    modal.querySelector(".emodal-prev").disabled = i <= 0;
    var more = document.getElementById("more");
    modal.querySelector(".emodal-next").disabled = i >= all.length - 1 && !(more && !more.hidden);
    modal.querySelector(".emodal-count").textContent = (i + 1) + " / " + all.length + (more && !more.hidden ? "+" : "");
    // 右下の「Instagram で見る ↗」も、この投稿に(動画はこちらのほうがきれい。コメントもできる)
    modal.querySelector(".emodal-link").href = urlOf(li);
    modal.querySelector(".emodal-who").textContent = li.getAttribute("data-who") || "";
    // 後ろの一覧も、いま出している投稿に合わせて動かす
    li.scrollIntoView({ block: "nearest" });
    warm(li);
  }

  function step(d) {
    if (!modal || !current) return;
    var all = items(current), i = all.indexOf(current) + d;
    if (i >= 0 && i < all.length) { show(all[i]); return; }
    // いちばん後ろで「›」: 「さらに古い投稿」を読み込んで、増えたら次へ
    var more = document.getElementById("more");
    if (d > 0 && more && !more.hidden) {
      var n = all.length, from = current;
      more.click();
      var t0 = Date.now();
      (function wait() {
        if (!modal || current !== from) return;
        var now = items(from);
        if (now.length > n) { show(now[n]); return; }
        if (Date.now() - t0 < 6000) setTimeout(wait, 150);
      })();
    }
  }

  function close() {
    if (!modal) return;
    document.removeEventListener("keydown", onKey, true);
    clearTimeout(warmTimer);
    modal.remove();
    modal = null;
    current = null;
    cards = [];
    document.documentElement.classList.remove("emodal-open");
    if (opener) { try { opener.focus({ preventScroll: true }); } catch (e) { /* 無くてもよい */ } }
    opener = null;
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  }

  function btn(cls, label, text, onclick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.setAttribute("aria-label", label);
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  function open(li, from) {
    close();
    opener = from;
    modal = document.createElement("div");
    modal.className = "emodal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "投稿");
    var bg = document.createElement("div");
    bg.className = "emodal-bg";
    bg.onclick = close;
    var stage = document.createElement("div");
    stage.className = "emodal-stage";
    var count = document.createElement("div");
    count.className = "emodal-count";
    count.setAttribute("aria-live", "polite");
    var link = document.createElement("a");
    link.className = "emodal-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Instagram で見る ↗";
    // カードの下の行: 左に「2026/11/26 宮本佳林@ID」、右に「Instagram で見る ↗」
    var who = document.createElement("span");
    who.className = "emodal-who";
    var foot = document.createElement("div");
    foot.className = "emodal-foot";
    foot.appendChild(who);
    foot.appendChild(link);
    modal.appendChild(bg);
    modal.appendChild(btn("emodal-x", "閉じる", "×", close));
    modal.appendChild(btn("emodal-prev", "前の投稿", "‹", function () { step(-1); }));
    modal.appendChild(stage);
    modal.appendChild(btn("emodal-next", "次の投稿", "›", function () { step(1); }));
    modal.appendChild(foot);
    modal.appendChild(count);
    // パソコン: 暗い背景(カードの外)でマウスのホイールを回すと、前後の投稿へ。下に回すと次。
    // カードの中は Instagram の画面なので、スクロール(長いキャプション)は Instagram が受ける
    var wheelAt = 0;
    modal.addEventListener("wheel", function (e) {
      if (e.target.closest && e.target.closest(".emodal-card.on")) return;   // 出している投稿の中は Instagram が受ける(両側のうすいカードの上は、前後へ移る)
      e.preventDefault();
      var now = Date.now();
      if (now - wheelAt < 450 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 8) return;   // 勢いのある1回で1つだけ
      wheelAt = now;
      step((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1);
    }, { passive: false });
    document.body.appendChild(modal);
    document.documentElement.classList.add("emodal-open");
    document.addEventListener("keydown", onKey, true);
    modal.querySelector(".emodal-x").focus({ preventScroll: true });
    show(li);
  }

  // 投稿の下の操作の行:「▶ ここで見る」(ポップアップで開く)と「Instagram で見る ↗」(元の投稿へ)
  // 「2026/11/26 宮本佳林@ID」(共同投稿は「 × 」でつなぐ)。ポップアップのカードの下に出す
  window.postLabel = function (ts, accounts, names) {
    return String(ts).slice(0, 10).replace(/-/g, "/") + " " + accounts.map(function (u) { return (names[u] || u) + "@" + u; }).join(" × ");
  };

  function actions(li, permalink, label) {
    if (label) li.setAttribute("data-who", label);
    // /reel/ だと別の動画に飛ばされることがあるので、リールも開ける /p/ にそろえる
    var url = permalink.replace("/reel/", "/p/");
    li.setAttribute("data-url", url);
    var row = document.createElement("div");
    row.className = "acts";
    var see = document.createElement("button");
    see.type = "button";
    see.className = "see";
    see.textContent = "▶ ここで見る";
    see.onclick = function () { open(li, see); };
    var link = document.createElement("a");
    link.className = "open";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Instagram で見る ↗";
    row.appendChild(see);
    row.appendChild(link);
    return row;
  }

  window.postActions = actions;
})();
