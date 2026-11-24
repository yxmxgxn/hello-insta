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
    // "scroll"(ふつうの IG取得: 一覧を Scroll で下まで)か "step"(投稿を開いて、次へを1件ずつ押し、数十件ずつ送る)
    var MODE = "__MODE__";
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

    function put(code, account, kind, caption, force) {
      if (!code || !account) return;
      account = account.toLowerCase();
      if (!ALLOW[account]) return;
      var old = items.get(code);
      // 本文は、取れているものを null で消さない。両方あれば長い方(途中で切れた表示より全文)。
      // 一つ一つのときは、開いている投稿の本文だけを読むので、新しく読めた本文を使う(前の投稿の本文が残っていたときの取り違えを避ける)
      // force(一つ一つで、いま開いている投稿)のときは、画面にいま出ているとおりにする(本文のない投稿で、前の投稿の本文が残らないように)
      if (!force && old && old.caption != null && (caption == null || (MODE !== "step" && old.caption.length >= caption.length))) caption = old.caption;
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

    // 一つ一つで、開いている投稿の画面を、いつもの形(article の中に時刻がある)で読めたか。
    // 読めたときだけ、本文がないことを「確かめた」と言える(共同投稿など、作りが違う画面では言えない)
    var openStructured = false, openHasH1 = false;
    function scan() {
      var first = location.pathname.split("/").filter(Boolean)[0];
      if (!first) profile = null;
      else if (!NOT_USER.test(first)) profile = first;
      // プロフィールの一覧(投稿タブ・リールタブ)。リンクとサムネイル
      // 投稿タブ・リールタブなら、持ち主が対象外の人の共同投稿(リンクが /持ち主/p/…)は、開いている人の投稿として拾う
      // (その人も連名で出ている投稿なので、サイトに無いと困る)。タグ付け・リポストのタブは他の人の投稿なのでしない
      var grid = profile && ALLOW[profile.toLowerCase()] && /^\/[^/]+(\/reels)?\/?$/.test(location.pathname);
      Array.prototype.slice.call(MODE === "step" ? [] : document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).forEach(function (a) {
        var m = (a.getAttribute("href") || "").match(LINK);
        if (!m) return;
        var img = a.querySelector("img[alt]");
        var owner = m[1] && grid && !ALLOW[m[1].toLowerCase()] ? profile : m[1] || ownerOf(a) || profile;
        put(m[3], owner, m[2], captionFromAlt(img && img.getAttribute("alt")));
      });
      // 投稿を1つ開いた画面(ポップアップか /p/ のページ)。本文は h1 にある
      var here = location.pathname.match(LINK);
      if (here) {
        var root = document.querySelector('div[role="dialog"] article') || document.querySelector("main article") || document;
        var h1 = root.querySelector("h1");
        openStructured = root !== document && !!root.querySelector("time");
        openHasH1 = !!h1;
        var owner = here[1];
        if (!owner) {
          var a = root.querySelector('header a[href^="/"]');
          owner = a && (a.getAttribute("href").match(/^\/([A-Za-z0-9._]+)\/?$/) || [])[1];
        }
        // 一つ一つで、プロフィールから開いて進んでいるとき: 共同投稿は、持ち主(最初に出る名前)が別の人のことがある。
        // 持ち主が対象外の人なら、開いているプロフィールの人の投稿として入れる(持ち主を使うと、対象外で捨てられ、本文が入らない)。
        // 持ち主が対象の人でも、連名にプロフィールの人がいれば、その人の投稿にする
        if (MODE === "step" && profile && ALLOW[profile.toLowerCase()] && owner && owner.toLowerCase() !== profile.toLowerCase()) {
          var authors = Array.prototype.map.call(root.querySelectorAll('header a[href^="/"]'), function (x) {
            return ((x.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]+)\/?$/) || [])[1];
          });
          var inCredits = authors.some(function (n) { return n && n.toLowerCase() === profile.toLowerCase(); });
          if (!ALLOW[owner.toLowerCase()] || inCredits) owner = profile;
        }
        // h1 があるのに文字が空のとき(記号や「.」で始まる本文など)は、「読めなかった」(null)にする。空の本文("")として送ると、入っている本文を消してしまう
        put(here[3], owner || profile, here[2], (h1 && text(h1)) || null, MODE === "step");
      }
      readCount();
      render();
    }

    /* ---------- 画面右下のパネル(innerHTML は使わない) ---------- */

    var panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:336px;padding:5px 7px;" +
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
      var b = el("button", "font:inherit;padding:0 6px;white-space:nowrap;flex:none;border:1px solid #8C6BB8;border-radius:4px;cursor:pointer;" +
        (main ? "background:#8C6BB8;color:#fff" : "background:#fff;color:#8C6BB8"), label);
      row.appendChild(b);
      return b;
    }
    var bSend = button("送る", true), bScroll = button("Scroll"), bStep = button("次へ自動"), bCopy = button("コピー"), bClose = button("×");
    bStep.style.display = MODE === "step" ? "" : "none";
    bScroll.style.display = MODE === "step" ? "none" : "";
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
    var sentTotal = 0, batchWait = false;
    function push() {
      if (!sending) return;
      if (++sending.tries > 40) { sending = null; msg("渡せませんでした。コピー済みなので欄に貼る"); return; }
      try { sending.win.postMessage({ type: "hello-insta-posts", id: sending.id, posts: list(), counts: counts, auto: sending.auto === true }, SITE); } catch (e) { /* 読み込み中 */ }
      sending.timer = setTimeout(push, 500);
    }
    function onMessage(e) {
      if (e.origin !== SITE || !e.data || !e.source || !sending) return;
      if (e.data.type === "hello-insta-ready") { sending.win = e.source; push(); }
      if (e.data.type === "hello-insta-got" && (e.data.id == null || e.data.id === sending.id)) {
        clearTimeout(sending.timer);
        sending = null;
        if (MODE === "step") { sentTotal += e.data.n || 0; items.clear(); batchWait = false; msg("送りました（計 " + sentTotal + " 件）。続けます"); } else close();
      }
    }
    window.addEventListener("message", onMessage);

    function copy() {
      return navigator.clipboard.writeText(JSON.stringify({ v: 2, posts: list(), counts: counts }))
        .then(function () { return true; }, function () { return false; });
    }

    function doSend(auto) {
      if (!items.size) { msg("まだ何も拾えていません"); return false; }
      if (!auto) copy();
      // 取り込みページがもう開いていれば読み込み直さない(まだ登録していない分が消えるので)。無ければ開く
      var win = window.open("", "hello-insta-import");
      if (!win) { msg("窓が止められました。取り込みページを開いてから、もう一度"); return false; }
      try { if (win.location.href === "about:blank") win.location.href = SITE + "/import"; } catch (e) { /* 開いている取り込みページ */ }
      if (sending) clearTimeout(sending.timer);
      sending = { win: win, id: String(Date.now()) + Math.random(), tries: 0, auto: !!auto };
      msg("取り込みページへ渡しています…");
      push();
      return true;
    }
    bSend.onclick = function () { doSend(false); };

    bCopy.onclick = function () {
      copy().then(function (ok) { msg(ok ? "コピーしました。欄に貼る" : "コピーできませんでした"); });
    };

    // 自動スクロール: 止められないよう、人が眺めるくらいゆっくり(5〜8秒、毎回ばらつかせる)一番下へ。伸びなくなったら終わる
    var scrollTimer = null, still = 0, lastH = 0;
    function stopScroll(s) {
      clearTimeout(scrollTimer); scrollTimer = null;
      bScroll.textContent = "Scroll";
      if (s) msg(s);
    }
    // 伸びないときは少し戻してから下へ送り直して、続きを読み込ませる。
    // 読み込めないときはどの窓でも読み込めないので、粘りすぎず5回(約30秒)伸びなかったら止める
    function step() {
      var h = document.documentElement.scrollHeight;
      still = h === lastH ? still + 1 : 0;
      lastH = h;
      if (still >= 5) { stopScroll("一番下です。「送る」を押す"); return; }
      if (still && still % 2 === 0) {
        window.scrollBy(0, -1200);
        setTimeout(function () { window.scrollTo(0, document.documentElement.scrollHeight); }, 800);
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
      msg("Scroll中" + (still ? "（読み込み待ち " + still + "/5）" : "…"));
      scrollTimer = setTimeout(step, 5000 + Math.random() * 3000);
    }
    bScroll.onclick = function () {
      if (scrollTimer) { stopScroll("止めました"); return; }
      still = 0; lastH = 0;
      bScroll.textContent = "止める";
      msg("Scroll中…");
      step();
    };

    // ---------- 一つ一つ(MODE が step のとき): 開いている投稿から「次へ」を1件ずつ押し、数十件ずつ送る ----------
    // 人が眺めるくらいの速さ(1件 2〜4.5秒、ときどき6〜12秒の休み)。Instagram が制限のような表示を出したら、すぐ止める
    var BATCH = 40, MAX_RUN = 300;
    var DWELL_MIN = 2000, DWELL_SPAN = 2500, LONG_P = 0.06, LONG_MIN = 6000, LONG_SPAN = 6000, NOCAP_WAIT = 3500;
    var prevCaption = null;
    var stepOn = false, stepTimer = null, stepCode = "", stepSince = 0, dwell = 0, stepCount = 0, stuck = 0, noBtn = 0, clickedAt = 0, counted = {};
    function nextButton() {
      var scope = document.querySelector('div[role="dialog"]') || document;
      var el = scope.querySelector('[aria-label="次へ"], [aria-label="Next"]');
      return el ? (el.closest('button, [role="button"], a') || el) : null;
    }
    function stepStop(s, sendRest) {
      stepOn = false;
      clearTimeout(stepTimer); stepTimer = null;
      bStep.textContent = "次へ自動";
      if (sendRest && items.size && !sending) doSend(true);
      if (s) msg(s + "（" + stepCount + "件進みました）");
    }
    function stepTick() {
      stepTimer = null;
      if (!stepOn) return;
      var here = location.pathname.match(LINK);
      if (!here) { stepStop("投稿の画面ではなくなったので止めました", true); return; }
      var body = ((document.body && document.body.innerText) || "").slice(0, 5000);
      if (/しばらくしてからもう一度|Try again later|Action Blocked|アクションがブロック/i.test(body)) { stepStop("Instagram が制限のような表示を出したので止めました。しばらく休んでください", true); return; }
      if (batchWait) {
        if (Date.now() - batchWait > 30000) { stepStop("取り込みページから返事がありません。取り込みページが開いているか見てください", false); return; }
        stepTimer = setTimeout(stepTick, 700);
        return;
      }
      if (here[3] !== stepCode) {
        stepCode = here[3];
        stepSince = Date.now();
        stuck = 0;
        clickedAt = 0;
        dwell = DWELL_MIN + Math.random() * DWELL_SPAN + (Math.random() < LONG_P ? LONG_MIN + Math.random() * LONG_SPAN : 0);
      }
      scan();
      var it = items.get(stepCode);
      var waited = Date.now() - stepSince;
      var stale = it && it.caption != null && prevCaption != null && it.caption === prevCaption && waited < NOCAP_WAIT;
      var ready = !stale && ((it && it.caption != null && waited >= dwell) || waited >= Math.max(dwell, NOCAP_WAIT));
      if (!ready) { stepTimer = setTimeout(stepTick, 400); return; }
      if (!counted[stepCode]) { counted[stepCode] = true; stepCount++; }
      // 開いて待っても本文が出なかった投稿は、「確かめたが本文がない」として空の本文("")で送る
      // (まだ開いていない投稿は、本文なし(null)のまま。取り込みページで「本文未取得」と分けて数える)
      // (画面の作りが違って読めなかった投稿は、本文なしと決めつけず、本文未取得のままにする)
      // (h1 があるのに読めなかった投稿は、本文なしにしない)
      if (it && it.caption == null && openStructured && !openHasH1) it.caption = "";
      prevCaption = it && it.caption ? it.caption : null;
      msg("自動で進めています… " + stepCount + "件目（本文を読んだ " + (sentTotal + Array.from(items.values()).filter(function (p) { return p.caption != null; }).length) + "）");
      if (stepCount >= MAX_RUN) { stepStop(MAX_RUN + "件で止めました。しばらく休んでから、続けてください", true); return; }
      if (items.size >= BATCH && !sending) {
        batchWait = Date.now();
        if (!doSend(true)) { batchWait = false; stepStop("送れませんでした", false); return; }
        stepTimer = setTimeout(stepTick, 700);
        return;
      }
      var btn = nextButton();
      if (!btn) {
        noBtn++;
        if (noBtn >= 3) { stepStop("次の投稿がありません(最後まで来ました)", true); return; }
        stepTimer = setTimeout(stepTick, 1500);
        return;
      }
      noBtn = 0;
      if (!clickedAt || Date.now() - clickedAt > 6000) {
        if (clickedAt && ++stuck >= 3) { stepStop("次へ進めなくなったので止めました", true); return; }
        clickedAt = Date.now();
        btn.click();
      }
      stepTimer = setTimeout(stepTick, 400);
    }
    bStep.onclick = function () {
      if (stepOn) { stepStop("止めました", true); return; }
      if (!LINK.test(location.pathname)) { msg("投稿を1つ開いてから、押す"); return; }
      // 押した操作のうちに、取り込みページの窓を用意しておく(あとの自動の送りは、開いてある窓へ渡す)
      msg("取り込みページが前に出ます。Instagram のタブに戻ってください(最初の1回だけ)");
      var w = window.open("", "hello-insta-import");
      if (!w) { msg("窓が止められました。ポップアップを許可してください"); return; }
      try { if (w.location.href === "about:blank") w.location.href = SITE + "/import"; } catch (e) { /* 開いている取り込みページ */ }
      try { window.focus(); } catch (e) { /* 戻せなくてもよい */ }
      stepOn = true; stepCount = 0; stuck = 0; noBtn = 0; clickedAt = 0; counted = {}; sentTotal = 0; batchWait = false; stepCode = "";
      bStep.textContent = "止める";
      msg("自動で進めます…");
      stepTick();
    };

    var timer = setInterval(scan, 800);
    function close() {
      stopScroll();
      stepStop();
      clearInterval(timer);
      if (sending) clearTimeout(sending.timer);
      window.removeEventListener("message", onMessage);
      panel.remove();
      delete window.__helloInsta;
    }
    bClose.onclick = close;

    window.__helloInsta = { show: function () { panel.style.display = ""; scan(); }, msg: msg };
    scan();
    // 対象の人のプロフィールで押したら、Scroll を押した状態で始める(ホームや対象外のページでは始めない)。一つ一つのときは、案内だけ出す
    if (MODE === "step") msg(LINK.test(location.pathname) ? "「次へ自動」を押すと、この投稿から1件ずつ進めます" : "投稿を1つ開いてから、「次へ自動」を押す");
    else if (profile && ALLOW[profile.toLowerCase()] && !LINK.test(location.pathname)) bScroll.onclick();
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
  var bmStep = document.getElementById("bmStep");
  bmStep.onclick = function (e) { e.preventDefault(); };
  // names: ユーザー名(小文字) → 表示名
  function buildLink(names) {
    var users = Object.keys(names);
    var fill = { __SITE__: location.origin, __NAMES__: JSON.stringify(names), __MODE__: "scroll" };
    bm.href = toLink(grab, fill);
    bmStep.href = toLink(grab, { __SITE__: location.origin, __NAMES__: JSON.stringify(names), __MODE__: "step" });
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
    // 1920×(1080−タスクバー) なら 480×約260。open の幅と高さは中身の大きさなので、開いたあと外枠で合わせ直す
    var w = Math.floor(screen.availWidth / COLS), h = Math.floor(screen.availHeight / ROWS);
    var left = (screen.availLeft || 0) + (k % COLS) * w;
    var top = (screen.availTop || 0) + Math.floor(k / COLS) * h;
    var win = window.open(location.href, "hi_win_" + Date.now(), "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    // Windows の窓は左右と下に見えない枠(影)があり、その分だけ隙間ができる。枠の幅を測って、はみ出させて並べる
    function fit() {
      try {
        var b = Math.max(0, Math.round((win.outerWidth - win.innerWidth) / 2));
        win.resizeTo(w + 2 * b, h + b);
        win.moveTo(left - b, top);
      } catch (e) { /* 合わせられなくても動く */ }
    }
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
  var extraBox = document.getElementById("extra");
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
    extraBox.textContent = "";
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
    // 他の人が持ち主の共同投稿はその人の分になるので、送った全員分の shortcode を「見えていた」として渡す
    var seen = [];
    Object.keys(g).forEach(function (who) { g[who].forEach(function (p) { seen.push(p.code); }); });
    Object.keys(g).forEach(function (who) {
      fetch("/api/crawl/paste", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        // 比べるのはプロフィールを開いて送った人だけ(IG の投稿数が拾えている人)。
        // 共同投稿で数件まざっただけの人まで比べると、その人の投稿が全部「無い」と出てしまう
        body: JSON.stringify({ username: who, posts: g[who], dry: true, seen: seen, want_extra: !!igCounts[who] }),
      }).then(function (res) { return res.ok ? res.json() : null; }).then(function (r) {
        if (!r || my !== classifyNo) return;
        counts[who] = r;
        show(counts);
        showExtra(counts);
      }).catch(function () { /* 数えられなくても登録はできる */ });
    });
  }

  // サイトにはあるのに、今回送られてきた一覧に無い投稿。プロフィールの一番下まで送ったときだけ意味がある
  // (公式APIはプロフィールに出ない投稿も返すので、それが何かを開いて確かめる)
  function showExtra(counts) {
    extraBox.textContent = "";
    Object.keys(counts).forEach(function (who) {
      var list = counts[who].extra || [];
      if (!list.length) return;
      var box = document.createElement("details");
      var sum = document.createElement("summary");
      sum.textContent = "@" + who + " サイトにあって今回の一覧に無い " + list.length + "件（一番下まで送ったときだけ意味があります）";
      box.appendChild(sum);
      var ol = document.createElement("ol");
      list.forEach(function (p) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = p.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = p.ts;
        li.appendChild(a);
        li.appendChild(document.createTextNode((p.web ? " 取込 " : " 公式 ") + p.excerpt));
        ol.appendChild(li);
      });
      box.appendChild(ol);
      extraBox.appendChild(box);
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
      // 「一つ一つ」の自動の送りは、受け取ったらそのまま登録する(次の分が来て、前の分が入れ替わらないように)
      if (e.data.auto) autoRegister();
    } catch (err) {
      preview.textContent = "受け取れませんでした: " + err.message;
    }
  });
  if (window.opener) {
    try { window.opener.postMessage({ type: "hello-insta-ready" }, "https://www.instagram.com"); } catch (e) { /* 開き元と切れている */ }
  }

  var pendingAuto = false;
  function autoRegister() {
    if (!token || !groups) return;
    if (busy) { pendingAuto = true; return; }
    send.click();
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
    extraBox.textContent = "";
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
          // D1 が混んでいて断られたら(overloaded)、15・30・60秒あけてやり直す(同じ分を送り直しても結果は同じ)
          var res, r;
          for (var wait of [15, 30, 60, 0]) {
            res = await fetch("/api/crawl/paste", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer " + token },
              body: JSON.stringify({ username: who, posts: list.slice(i, i + CHUNK), ig_count: i === 0 ? igs[who] : undefined }),
            });
            r = await res.json().catch(function () { return {}; });
            if (res.ok || !wait || !/overloaded/i.test(r.message || "")) break;
            head = "D1 が混んでいるので " + wait + " 秒待ってやり直します… @" + who + " " + i + " / " + list.length;
            draw();
            await new Promise(function (ok) { setTimeout(ok, wait * 1000); });
          }
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
    // 登録しているあいだに、自動の送りが届いていたら、続けて登録する
    if (pendingAuto) { pendingAuto = false; autoRegister(); }
  });

  // '2026-10-16 21:03' → 今年なら '10/16 21:03'、それ以外は '2025/10/16 21:03'
  function lastLabel(ts) {
    var s = ts.replace(/-/g, "/");
    return ts.slice(0, 4) === String(new Date().getFullYear()) ? s.slice(5) : s;
  }

  // ---------- いちばん上のまとめ(押すとその欄へ) ----------
  // 各欄が読み込めたら、その分を埋めて描き直す。null はまだ分からない(出さない)
  var sum = { cap: null, capLeft: null, personal: null, nocap: null, official: null, err: null, gone: null, suspects: null, td: null, tokenDays: null };
  function drawSum() {
    var ul = document.getElementById("sum");
    ul.textContent = "";
    function chip(href, html, warn) {
      var li = document.createElement("li");
      if (warn) li.className = "warn";
      var a = document.createElement("a");
      a.href = href;
      a.innerHTML = html;
      li.appendChild(a);
      ul.appendChild(li);
    }
    var n = function (x) { return "<b>" + Number(x).toLocaleString("ja-JP") + "</b>"; };
    if (sum.tokenDays != null && sum.tokenDays <= 14) {
      chip("#tokenBox", sum.tokenDays < 0 ? "⚠ アクセストークンの期限切れ" : "⚠ アクセストークン あと " + n(sum.tokenDays) + " 日", true);
    }
    if (sum.td) chip("#tdBox", "削除依頼 未対応 " + n(sum.td), true);
    if (sum.personal != null) chip("#personal", "個人 " + n(sum.personal) + "人" + (sum.nocap ? "・本文未取得 " + n(sum.nocap) + "件" : ""), false);
    if (sum.gone != null) chip("#goneBox", "消えたかも <b>" + sum.gone + "</b>件" + (sum.suspects ? "（ほかに要確認 " + n(sum.suspects) + "人）" : ""), sum.gone !== "0");
    // 本文(検索で当たった箇所の前後を出すのに使う)を持っている件数。本文なしの投稿は数えない
    if (sum.cap != null) chip("#officialBox", "本文の保存 " + n(sum.cap) + (sum.capLeft ? "・残り " + n(sum.capLeft) + "件" : "件 ✓"), false);
    if (sum.official != null) chip("#officialBox", "公式 " + n(sum.official) + "人" + (sum.err ? "・エラー " + n(sum.err) + "人" : ""), sum.err > 0);
    if (sum.tokenDays != null && sum.tokenDays > 14) chip("#tokenBox", "トークン あと " + n(sum.tokenDays) + " 日", false);
    if (!ul.children.length) chip("#personal", "読み込み中…", false);
  }
  // 閉じた欄へ飛ぶときは開く
  document.getElementById("sum").addEventListener("click", function (e) {
    var a = e.target.closest("a");
    var box = a && document.querySelector(a.getAttribute("href"));
    if (box && box.tagName === "DETAILS") box.open = true;
  });
  // 「公式APIで取れる人」を開いたか閉じたかを覚えておく
  var officialBox = document.getElementById("officialBox");
  try { officialBox.open = localStorage.getItem("officialOpen") === "1"; } catch (e) { /* 覚えられなくてもよい */ }
  officialBox.addEventListener("toggle", function () {
    try { localStorage.setItem("officialOpen", officialBox.open ? "1" : "0"); } catch (e) { /* 覚えられなくてもよい */ }
  });

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
      fillManualAccounts(d.accounts || []);
      var active = (d.accounts || []).filter(function (a) { return a.active; });
      var personal = active.filter(function (a) { return /個人アカウント/.test(a.error || ""); });
      var officials = active.filter(function (a) { return !/個人アカウント/.test(a.error || ""); });
      fillTable(document.getElementById("targets"), personal);
      fillTable(document.getElementById("officials"), officials);
      sum.personal = personal.length;
      sum.nocap = personal.reduce(function (s, a) { return s + Math.max(0, (a.nocap_web || 0) - (a.nocap_chk || 0)); }, 0);
      sum.official = officials.length;
      sum.cap = active.reduce(function (s, a) { return s + (a.withcap || 0); }, 0);
      sum.capLeft = active.reduce(function (s, a) { return s + Math.max(0, a.posts - (a.nocap || 0) - (a.withcap || 0)); }, 0);
      sum.err = officials.filter(function (a) { return a.error; }).length;
      document.getElementById("personalCount").textContent = personal.length + "人" + (sum.nocap ? "・本文未取得 " + sum.nocap + "件" : "");
      document.getElementById("officialCount").textContent = officials.length + "人" + (sum.err ? "・エラー " + sum.err + "人" : "");
      drawSum();
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
        var cnt = cell(a.posts + "件", "公式" + (a.posts - web) + "・取込" + web);
        // 本文を持っていない投稿の数(本文なしの投稿は除く)。周回・取り込み直しで減る
        var left = Math.max(0, a.posts - (a.nocap || 0) - (a.withcap || 0));
        // 押すと、その人の、まだ本文が入っていない投稿の一覧(開いて本文を入れる)
        function listBtn(label, acct, name) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "nocapl-btn";
          b.textContent = label;
          b.title = "まだ本文が入っていない投稿の一覧を出す";
          b.onclick = function () { loadNocap(acct, name); };
          return b;
        }
        if (left) {
          var cl = document.createElement("small");
          cl.appendChild(listBtn("本文の保存 残り " + left, a.username, a.name));
          cnt.appendChild(cl);
        }
        // 本文が入っていない投稿の数(IG取得（一つ一つ）で埋める目安)
        // 公式APIで本文が空だった投稿は「本文なし」(本当にない)。画面から拾って本文が空の投稿は「本文未取得」
        // (本当にないのか、拾えなかったのかは分からない。IG取得（一つ一つ）で開き直すと分かる)
        var ncChk = a.nocap_chk || 0, ncWeb = (a.nocap_web || 0) - ncChk, ncApi = (a.nocap || 0) - (a.nocap_web || 0) + ncChk;
        if (ncWeb) {
          var nw = document.createElement("small");
          nw.className = "warnc";
          nw.appendChild(listBtn("本文未取得 " + ncWeb, a.username, a.name));
          nw.title = "IG取得で拾った投稿のうち、まだ開いて確かめていないもの（本当に本文がないものも含む）。IG取得（一つ一つ）で開くと、本文が入るか、「本文なし」になる";
          cnt.appendChild(nw);
        }
        if (ncApi) {
          var nc = document.createElement("small");
          nc.textContent = "本文なし " + ncApi;
          nc.title = "本当に本文がない投稿（公式APIで空だったもの・開いて確かめたもの）";
          cnt.appendChild(nc);
        }
        tr.appendChild(cnt);
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

  // ---------- 本文を手で入れる(共同投稿など、IG取得で本文が読めない投稿) ----------
  // 人を選び、投稿のURLと、Instagram の画面で選んでコピーした本文を貼って、登録する。本文は、貼ったとおり(書き換えない)
  function fillManualAccounts(accounts) {
    var sel = document.getElementById("mAcct");
    var keep = sel.value;
    sel.textContent = "";
    // 個人アカウントの人を先に
    var act = accounts.filter(function (a) { return a.active; });
    act.sort(function (a, b) { return (/個人アカウント/.test(b.error || "") ? 1 : 0) - (/個人アカウント/.test(a.error || "") ? 1 : 0); });
    act.forEach(function (a) {
      var o = document.createElement("option");
      o.value = a.username;
      o.textContent = a.name + "（@" + a.username + "）";
      sel.appendChild(o);
    });
    if (keep) sel.value = keep;
  }
  document.getElementById("manual").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = document.getElementById("mMsg"), btn = document.getElementById("mSend");
    var url = document.getElementById("mUrl").value.trim();
    var m = url.match(/instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/) || url.match(/^\/?(?:p|reel)\/([A-Za-z0-9_-]{5,})/) || url.match(/^([A-Za-z0-9_-]{5,})$/);
    var none = document.getElementById("mNone").checked;
    var cap = document.getElementById("mCap").value;
    if (!token) { msg.textContent = "下の「合言葉」を開いて CRAWL_TOKEN を入れ、覚えさせてください"; return; }
    if (!m) { msg.textContent = "投稿のURLが読めません（https://www.instagram.com/p/…/ の形）"; return; }
    if (!none && !cap.trim()) { msg.textContent = "本文を貼るか、「本文がない投稿」にチェックを入れてください"; return; }
    var who = document.getElementById("mAcct").value;
    btn.disabled = true;
    msg.textContent = "登録中…";
    // 本文がない投稿は、確かめ済みの印(空の本文)を送る
    fetch("/api/crawl/paste", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ username: who, posts: [{ code: m[1], caption: none ? "" : cap }] }),
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (x) {
        if (x.status === 404) throw new Error("合言葉が違います");
        if (!x.ok) throw new Error(x.d.message || x.d.error || "HTTP " + x.status);
        var d = x.d;
        msg.textContent = d.skipped ? "飛ばしました（公式APIで入っている投稿か、日時が読めない投稿です）"
          : d.same ? "もう同じ本文が入っています"
          : d.added ? "新しく登録しました" : "本文を更新しました";
        if (!d.skipped) { document.getElementById("mUrl").value = ""; document.getElementById("mCap").value = ""; document.getElementById("mNone").checked = false; }
        loadTargets();
      })
      .catch(function (err) { msg.textContent = "できませんでした: " + err.message; })
      .then(function () { btn.disabled = false; });
  });

  // ---------- まだ本文が入っていない投稿の一覧(個人アカウントの人。開いて本文を入れる) ----------
  function loadNocap(account, name) {
    var box = document.getElementById("nocapBox"), head = document.getElementById("nocapHead"), ol = document.getElementById("nocapList");
    if (!token) { alert("下の「合言葉」を開いて CRAWL_TOKEN を入れ、覚えさせてください"); return; }
    box.hidden = false;
    head.textContent = name + " の、まだ本文が入っていない投稿（読み込み中…）";
    ol.textContent = "";
    box.scrollIntoView({ block: "nearest" });
    fetch("/api/crawl/nocap?account=" + encodeURIComponent(account), { headers: { authorization: "Bearer " + token }, cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) {
        head.textContent = name + " の、まだ本文が入っていない投稿 " + d.posts.length + (d.more ? "件以上（新しい順）" : "件") + "（押すと開く。開いて本文が出たら IG取得（一つ一つ）で取り込む）";
        d.posts.forEach(function (p) {
          var li = document.createElement("li");
          var a = document.createElement("a");
          a.href = p.permalink.replace("/reel/", "/p/");
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = lastLabel(p.ts);
          li.appendChild(a);
          var sp = document.createElement("span");
          // 本文の保存が残っている投稿は、前に取った先頭が見える。本文未取得は、まだ何も取れていない
          sp.textContent = " " + (p.excerpt ? p.excerpt : "（本文未取得）");
          li.appendChild(sp);
          ol.appendChild(li);
        });
        if (!d.posts.length) { head.textContent = name + " は、本文がまだ入っていない投稿が 0 件です"; }
      })
      .catch(function (e) { head.textContent = name + " の一覧を読み込めませんでした（" + e.message + "）"; });
  }

  // ---------- 消えたかもしれない投稿(周回で公式APIから返ってこなかったもの)。消すかどうかは管理人が決める ----------
  // 候補が多すぎる人(APIの異常かも)の行。「全部残す」か「一覧を出す」
  function suspectRow(s) {
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.textContent = "⚠ " + s.name + " の候補が " + s.n + " 件あります。多すぎるので、Meta が期間ごと飛ばして返しただけかもしれません（一覧には出していません）。";
    tr.appendChild(td);
    var act = document.createElement("td");
    [["全部残す", "keep_all", ""], ["一覧を出す", "show", "ghost"]].forEach(function (b) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = b[0];
      if (b[2]) btn.className = b[2];
      btn.onclick = function () {
        if (b[1] === "show") { loadGone(s.account); return; }
        if (!confirm(s.name + " の候補 " + s.n + " 件を、全部「残す」にします")) return;
        act.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
        fetch("/api/crawl/gone", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ action: "keep_all", account: s.account }),
        }).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          act.textContent = "残します";
        }).catch(function (e) {
          act.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
          alert("できませんでした: " + e.message);
        });
      };
      act.appendChild(btn);
    });
    tr.appendChild(act);
    return tr;
  }

  // account を渡すと、その人の候補だけを(多くても)出す
  function loadGone(account) {
    var box = document.getElementById("goneBox");
    var tbody = document.getElementById("gone");
    if (!token) { box.hidden = true; return; }   // 合言葉(token)が無いときは出さない
    fetch("/api/crawl/gone" + (account ? "?account=" + encodeURIComponent(account) : ""), { headers: { authorization: "Bearer " + token }, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        box.hidden = false;
        tbody.textContent = "";
        if (d && !account) {
          sum.gone = d.posts.length + (d.more ? "+" : "");
          sum.suspects = (d.suspects || []).length;
          drawSum();
        }
        (d && d.suspects || []).forEach(function (s) { tbody.appendChild(suspectRow(s)); });
        // 0件・読み込めなかったときも、欄は出して理由を書く(「何も出ない」だけだと、0件なのか失敗なのか分からないため)
        if (d && !d.posts.length && d.suspects && d.suspects.length) return;
        // 0件なら欄ごと隠す(上のまとめに「消えたかも 0件」と出る)
        if (d && !d.posts.length && !account) { box.hidden = true; return; }
        if (!d || !d.posts.length) {
          var er = document.createElement("tr");
          var ec = document.createElement("td");
          ec.textContent = d ? "いま、消えたかもしれない投稿は 0 件です。" : "一覧を読み込めませんでした(合言葉が違うか、通信の失敗です)。";
          er.appendChild(ec);
          tbody.appendChild(er);
          return;
        }
        d.posts.forEach(function (p) {
          var tr = document.createElement("tr");
          var td = document.createElement("td");
          td.textContent = p.name + " ";
          var a = document.createElement("a");
          a.href = p.permalink.replace("/reel/", "/p/");
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = lastLabel(p.ts);
          td.appendChild(a);
          var sm = document.createElement("small");
          sm.textContent = (p.excerpt || "（本文なし）") + (p.seen_at ? "　最後にあった " + lastLabel(p.seen_at) : "　周回でまだ一度も返っていない");
          td.appendChild(sm);
          tr.appendChild(td);
          var act = document.createElement("td");
          [["消す", "delete", ""], ["残す", "keep", "ghost"]].forEach(function (b) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = b[0];
            if (b[2]) btn.className = b[2];
            btn.onclick = function () {
              if (b[1] === "delete" && !confirm(p.name + " " + p.ts + " の投稿をこのサイトから消します")) return;
              act.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
              fetch("/api/crawl/gone", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer " + token },
                body: JSON.stringify({ id: p.id, action: b[1] }),
              }).then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                act.textContent = b[1] === "delete" ? "消しました" : "残します";
              }).catch(function (e) {
                act.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
                alert("できませんでした: " + e.message);
              });
            };
            act.appendChild(btn);
          });
          tr.appendChild(act);
          tbody.appendChild(tr);
        });
        if (d.more) {
          var tr = document.createElement("tr");
          tr.innerHTML = "<td colspan=2>ほかにもあります（片づけると次が出ます）</td>";
          tbody.appendChild(tr);
        }
      })
      .catch(function () { box.hidden = true; });
  }
  loadGone();

  // ---------- 削除依頼の一覧と、アクセストークンの期限 ----------
  function loadAdmin() {
    var box = document.getElementById("tdBox");
    if (!token) { box.hidden = true; return; }
    fetch("/api/crawl/admin", { headers: { authorization: "Bearer " + token }, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        // トークンの期限(0 は期限なし)
        var t = d.token || {};
        if (t.expires_at) {
          sum.tokenDays = Math.floor((t.expires_at * 1000 - Date.now()) / 86400e3);
          var when = new Date(t.expires_at * 1000 + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
          document.getElementById("tokenState").title = "IG_ACCESS_TOKEN の期限: " + when + "（調べた日時: " + (t.checked_at || "") + "）";
        }
        // 削除依頼
        var list = d.takedown || [];
        var open = list.filter(function (x) { return !x.done; }).length;
        sum.td = open;
        drawSum();
        box.hidden = !list.length;
        box.open = open > 0;
        document.getElementById("tdCount").textContent = "未対応 " + open + " / 全 " + list.length;
        var ul = document.getElementById("tdList");
        ul.textContent = "";
        list.forEach(function (x) {
          var li = document.createElement("li");
          if (x.done) li.className = "done";
          var m = document.createElement("p");
          m.className = "m";
          m.textContent = "#" + x.id + "　" + x.created_at + (x.done ? "　対応済み" : "");
          li.appendChild(m);
          var tg = document.createElement("p");
          // 対象が URL なら押して開けるように
          if (/^https?:\/\//.test(x.target)) {
            var a = document.createElement("a");
            a.href = x.target;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = x.target;
            tg.appendChild(a);
          } else tg.textContent = x.target;
          li.appendChild(tg);
          if (x.contact) { var c = document.createElement("p"); c.textContent = "連絡先: " + x.contact; li.appendChild(c); }
          if (x.message) { var g = document.createElement("p"); g.textContent = x.message; li.appendChild(g); }
          var act = document.createElement("p");
          [[x.done ? "未対応に戻す" : "対応済みにする", x.done ? "undo" : "done", ""], ["削除", "delete", "ghost"]].forEach(function (b) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = b[0];
            if (b[2]) btn.className = b[2];
            btn.onclick = function () {
              if (b[1] === "delete" && !confirm("依頼 #" + x.id + " を一覧から消します")) return;
              btn.disabled = true;
              fetch("/api/crawl/takedown", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer " + token },
                body: JSON.stringify({ id: x.id, action: b[1] }),
              }).then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                loadAdmin();
              }).catch(function (e) {
                btn.disabled = false;
                alert("できませんでした: " + e.message);
              });
            };
            act.appendChild(btn);
          });
          li.appendChild(act);
          ul.appendChild(li);
        });
      })
      .catch(function () { /* 読めなくても、ほかの欄は使える */ });
  }
  loadAdmin();
  // 合言葉を入れ直したら、合言葉が要る欄を読み直す
  document.getElementById("saveToken").addEventListener("click", function () { loadGone(); loadAdmin(); });
})();
