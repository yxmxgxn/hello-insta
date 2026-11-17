// Instagram 公式の埋め込みを、押したときだけ開く(トップと /day で共通)。
// window.toggleEmbed(li, ボタン, 投稿のURL) で、li の下に開く/閉じる
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

  function toggleEmbed(li, btn, url) {
    var open = li.querySelector(".embed");
    if (open) {
      open.remove();
      btn.textContent = "▶ ここで見る";
      return;
    }
    var box = document.createElement("div");
    box.className = "embed";
    var bq = document.createElement("blockquote");
    bq.className = "instagram-media";
    bq.setAttribute("data-instgrm-permalink", url);
    bq.setAttribute("data-instgrm-version", "14");
    bq.setAttribute("data-instgrm-captioned", "");
    var link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Instagram で見る";
    bq.appendChild(link);
    box.appendChild(bq);
    li.appendChild(box);
    btn.textContent = "▼ 閉じる";
    loadEmbedJs()
      .then(function () { if (window.instgrm) window.instgrm.Embeds.process(); })
      .catch(function () { /* 読み込めなくても「Instagram で見る」は押せる */ });
  }

  window.toggleEmbed = toggleEmbed;
})();
