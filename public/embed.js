// Instagram 公式の埋め込みを、押したときだけ、暗い背景のポップアップで開く(トップと /day で共通)。
// window.postActions(li, permalink) は、投稿の下の「▶ ここで見る」「Instagram で開く ↗」の行を作る。
// ポップアップの中では、「‹」「›」・キーボードの ← → で、一覧の前後の投稿に移れる。閉じるのは「×」・背景・Esc
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
  var suppressClick = false;   // スワイプの終わりで、背景を押したことにしない

  function urlOf(li) { return li.getAttribute("data-url"); }

  // 一覧の中の、見られる投稿(前後に移る範囲)
  function items(li) {
    return Array.prototype.filter.call(li.parentNode.children, function (e) { return e.getAttribute && e.getAttribute("data-url"); });
  }

  function show(li) {
    current = li;
    var card = modal.querySelector(".emodal-card");
    card.textContent = "";
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
    card.appendChild(bq);
    card.scrollTop = 0;
    loadEmbedJs()
      .then(function () { if (window.instgrm) window.instgrm.Embeds.process(); })
      .catch(function () { /* 読み込めなくても「Instagram で見る」は押せる */ });
    // 前後の投稿(なければ「‹」「›」は押せない)。後ろの投稿が無くても、「さらに古い投稿」があれば押して読み込む
    var all = items(li), i = all.indexOf(li);
    modal.querySelector(".emodal-prev").disabled = i <= 0;
    var more = document.getElementById("more");
    modal.querySelector(".emodal-next").disabled = i >= all.length - 1 && !(more && !more.hidden);
    modal.querySelector(".emodal-count").textContent = (i + 1) + " / " + all.length + (more && !more.hidden ? "+" : "");
    // 右下の「Instagram で開く ↗」も、この投稿に(動画はこちらのほうがきれい。コメントもできる)
    modal.querySelector(".emodal-link").href = urlOf(li);
    // 後ろの一覧も、いま出している投稿に合わせて動かす
    li.scrollIntoView({ block: "nearest" });
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
    modal.remove();
    modal = null;
    current = null;
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

  // 暗い背景(カードの外)でのスワイプ・ホイールで、前後の投稿へ。左・上へのスワイプ、下へのホイールが「次」。
  // カードの中は Instagram の画面なので、スクロール(長いキャプション)や横のスワイプ(複数枚の写真)は Instagram が受ける
  function gestures(root, card) {
    var x0 = 0, y0 = 0, on = false, wheelAt = 0;
    root.addEventListener("pointerdown", function (e) {
      if (card.contains(e.target) || e.target.closest("button, a")) return;
      on = true; x0 = e.clientX; y0 = e.clientY;
    });
    root.addEventListener("pointerup", function (e) {
      if (!on) return;
      on = false;
      var dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 50) return;   // 短いのは、背景を押しただけ
      step((Math.abs(dx) > Math.abs(dy) ? dx : dy) < 0 ? 1 : -1);
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
    });
    root.addEventListener("pointercancel", function () { on = false; });
    root.addEventListener("wheel", function (e) {
      if (card.contains(e.target)) return;
      e.preventDefault();
      var now = Date.now();
      if (now - wheelAt < 450 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 8) return;   // 勢いのある1回で1つだけ
      wheelAt = now;
      step((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1);
    }, { passive: false });
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
    bg.onclick = function () { if (!suppressClick) close(); };
    var card = document.createElement("div");
    card.className = "emodal-card";
    var count = document.createElement("div");
    count.className = "emodal-count";
    count.setAttribute("aria-live", "polite");
    var link = document.createElement("a");
    link.className = "emodal-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Instagram で開く ↗";
    modal.appendChild(bg);
    modal.appendChild(btn("emodal-x", "閉じる", "×", close));
    modal.appendChild(btn("emodal-prev", "前の投稿", "‹", function () { step(-1); }));
    modal.appendChild(card);
    modal.appendChild(btn("emodal-next", "次の投稿", "›", function () { step(1); }));
    modal.appendChild(link);
    modal.appendChild(count);
    gestures(modal, card);
    document.body.appendChild(modal);
    document.documentElement.classList.add("emodal-open");
    document.addEventListener("keydown", onKey, true);
    modal.querySelector(".emodal-x").focus({ preventScroll: true });
    show(li);
  }

  // 投稿の下の操作の行:「▶ ここで見る」(ポップアップで開く)と「Instagram で開く ↗」(元の投稿へ)
  function actions(li, permalink) {
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
    link.textContent = "Instagram で開く ↗";
    row.appendChild(see);
    row.appendChild(link);
    return row;
  }

  window.postActions = actions;
})();
