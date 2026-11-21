#!/usr/bin/env python3
"""
ハロプロ現役メンバーと一部OGの Instagram 投稿を Graph API の Business Discovery で取得し、
Worker のクローラ用API(/api/crawl/*)経由で D1 に書き込む。

対象アカウント: karin-archive の SNS一覧スプシ(accounts シート)の instagram 行のうち
  - 所属(affiliation)が現役グループの人
  - OG: J.P ROOM・UP-FRONT CREATE は OG_ORDER の名前の順、UP-FRONT PROMOTION は所属がそこの人(加入順)
  - それ以外でも instagram 行がある人は全員「その他のOG」(引退した人も含む。名前の読みのあいうえお順)。
    個人アカウントの人は取れないだけ(ログに出て、週1回試す)
シートを直せば次の実行から対象も変わる。外れた人の投稿は消さない(Worker 側で active=0)。

Business Discovery はビジネス/クリエイターアカウントしか引けず、1回で最大50件、
過去分は after カーソルで遡る。API上限(1時間200回)に収まるよう1回の実行の呼び出し数を
MAX_CALLS に抑え、遡りきれなかった分は D1 の fetch_state に残して次の実行で続ける。
  - 1周目: 新着を見る番の人(LATEST_EVERY_HOURS の中に均等に散らした自分の時刻を過ぎて、まだ見ていない人)の
           最新ページ。1人1回ずつ、見ていない時間が長い人から(INSERT OR REPLACE なので重複は無害)
  - 2周目: 遡りが終わっていないアカウントを、残りの回数の範囲で続ける
  - 3周目: 周回。遡りを終えた人の投稿を、新しい方から全部読み直す(ROUND_EVERY_DAYS ごと、1回 ROUND_CALLS 回まで)。
           書き直された本文・いいね数をそろえ、返ってこなかった投稿を「消えたかも」として出す(消すのは管理人)
投稿と進み具合は Worker 側で1つの batch で書くので、片方だけ進むことはない。

環境変数:
  CRAWL_API        Worker のURL(例: https://insta.karin-archive.com)
  CRAWL_TOKEN      Worker の CRAWL_TOKEN と同じ値
  IG_USER_ID       自分のプロアカウントの Instagram ユーザーID(数字)
  IG_ACCESS_TOKEN  そのアカウントのアクセストークン
  MAX_CALLS        1回の実行で使う Graph API の呼び出し上限(既定 150)
  ROUND_CALLS      1回の実行で周回に使う上限(既定 10)
  ROUND_EVERY_DAYS 1人を周回し直す間隔(日。既定 7)
"""

import csv
import io
import json
import os
import re
import unicodedata
import zlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

GRAPH = "https://graph.facebook.com/v23.0"
PAGE_SIZE = 50
# 「頼むデータが多すぎる」(code 1)と断られたら、この順に頼み直す: (1ページの件数, 頼む項目)。
#   full = 全部(いいね数・持ち主・種類も)、lite = 本文と日時とリンクと種類だけ
# 全部断られた遡りは打ち切る(投稿の多い人の古い方を、Meta がある深さより先は返さないことがある。古い分は IG取得で入れる)
RETRIES = ((25, "full"), (10, "full"), (10, "lite"), (5, "lite"))
CUT = "遡りを打ち切り"
# 遡りを優先する人(一番先に遡る)。前に件数を減らしても断られて打ち切った人は、項目を減らして最初から遡り直す
BACKFILL_FIRST = ["maria_makino.official", "miyaaa0825"]
# 新着を見る間隔(時間)。GitHub の Variables の LATEST_EVERY_HOURS で変えられる。24 = 毎日。
# 全員が同じ時刻に番になると回数制限に当たるので、1人ずつ「自分の時刻」を決めて間隔の中に均等に散らす
# (135人を24時間なら、毎時6人ほど)。大量の遡りをやり直すときは 168(週1回)にすると、その分を遡りに回せる
LATEST_EVERY = float(os.environ.get("LATEST_EVERY_HOURS") or 24) * 3600
# 個人アカウントの人(公式APIでは取れない)を試す間隔。プロに切り替えたら拾うためだけなので週1回
PERSONAL_EVERY = 168 * 3600

# 何があっても新着を常に最新にしておく人(サイトの編集に使う)。LATEST_EVERY にかかわらず
# PRIORITY_EVERY ごとに見て、新着を見る番の一番先に回す(回数制限で止まる前に必ず見る)。1回1呼び出しなので軽い。
# 宮本佳林さんは絶対。個人アカウントの miyamoto_mg は公式APIでは取れないので、ここには入れない(Apify か IG取得)
PRIORITY = ["karin_miyamoto.official"]
# 周回: 遡りを終えた人の投稿を、新着とも遡りとも別のカーソルで、新しい方から全部読み直す。
# 1回の実行で使うのは ROUND_CALLS 回まで(回数制限まで使い切ると、次の回の新着、とくに宮本さんが止まるため)。
# 毎時10回なら1日240回ほどで、10万件(約2,000回)を1週間ほどで一周する
ROUND_CALLS = int(os.environ.get("ROUND_CALLS") or 10)
ROUND_EVERY = float(os.environ.get("ROUND_EVERY_DAYS") or 7) * 86400
# 宮本さんは毎日周回する(書き直しも消したのも、すぐそろえる)
PRIORITY_ROUND_EVERY = 86400
PRIORITY_EVERY = 3 * 3600

# karin-archive の SNS一覧スプシ(accounts シート)。
# 列: 0=member番号 1=名前 2=platform 3=ID 4=MEMBER(位置で読む。ヘッダーに重複があるため)
ACCOUNTS_CSV = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vSLHCVWWxyVI5GS9SSohSNYL4U-uY4jekuMXbaKYXYjWrSZlgSxGV0BFvnCWRrd-A4Z5sqkoRwRyDqD/pub"
    "?gid=1522035537&single=true&output=csv"
)

# 現役グループ(affiliation slug → 見出し。この順が並び順)。
# karin-archive の Python/generate_sns.py の GROUPS と同じものを保つ(改名・増減時は両方直す)
GROUPS: dict[str, str] = {
    "morningmusume":  "モーニング娘。'26",
    "angerme":        "アンジュルム",
    "juicejuice":     "Juice=Juice",
    "tsubakifactory": "つばきファクトリー",
    "beyooooonds":    "BEYOOOOONDS",
    "ochanorma":      "OCHA NORMA",
    "rosychronicle":  "ロージークロニクル",
}
OG_SECTIONS = ["J.P ROOM", "UP-FRONT CREATE", "UP-FRONT PROMOTION", "その他のOG"]
# J.P ROOM・UP-FRONT CREATE の見出しに並べる人と、その順番(スプシの名前で)。管理人が決めた順で、加入順ではない。
# スプシの所属と違っても、ここに書いた見出しに入る(飯窪春菜・辻希美・藤本美貴は CREATE に並べる)
OG_ORDER: dict[str, list[str]] = {
    "J.P ROOM": [
        "譜久村聖", "竹内朱莉", "石田亜佑美", "佐藤優樹", "宮崎由加", "宮本佳林",
        "植村あかり", "佐々木莉佳子", "稲場愛香", "森戸知沙希", "小関舞", "浅倉樹々",
    ],
    "UP-FRONT CREATE": [
        "安倍なつみ", "飯田圭織", "石川梨華", "勝田里奈", "熊井友理奈", "里田まい", "鈴木愛理",
        "須藤茉麻", "高橋愛", "田中れいな", "中澤裕子", "中島早貴", "牧野真莉愛", "真野恵里菜",
        "矢口真里", "矢島舞美", "保田圭", "山岸理子", "飯窪春菜", "辻希美", "藤本美貴",
    ],
}

# スプシの GroupNo / SubGroup の値 → 現役グループの名前(グループのボタンと同じ名前)。
# OG(その他のOG など)を、「そのグループにいたことがある人」で絞るのに使う。ほかの番号(昔のグループなど)は使わない
GROUP_NAMES: dict[int, str] = {
    2: "モーニング娘。", 11: "アンジュルム", 12: "Juice=Juice", 15: "つばきファクトリー",
    16: "BEYOOOOONDS", 17: "OCHA NORMA", 18: "ロージークロニクル",
}

# グループの公式アカウント(affiliation slug → ユーザー名)。各グループの見出しの一番上に、グループの名前で並べる(モーニング娘。'26 は、年を外して「モーニング娘。」)
GROUP_OFFICIAL: dict[str, str] = {
    "morningmusume":  "morningmusume_official",
    "angerme":        "angerme_official",
    "juicejuice":     "juice_juice_official",
    "tsubakifactory": "tsubakifactory_official",
    "beyooooonds":    "beyooooonds_official",
    "ochanorma":      "ocha_norma_official",
    "rosychronicle":  "rosy_chronicle_official",
}

# スプシに instagram 行があっても対象にしないアカウント: ユーザー名 → 理由。
# ここに書いた人は、D1 からもアカウントと投稿を消す(Worker の /api/crawl/accounts の remove)
EXCLUDED: dict[str, str] = {
    "kanami_ishiguri.official": "鍵アカウント(非公開)で、公式APIでも IG取得でも何も取れない",
    "chabu_kannagi": "猫の写真のアカウントで、本人の投稿ではない",
    "liqinyao0111": "ごく個人的な日常のアカウントなので、載せない",
    # 以下、管理人の判断で載せない(個人アカウントで集めていなかった人)
    "rio_kitagawa_tx": "管理人の判断で載せない(北川莉央)",
    "attchu": "管理人の判断で載せない(稲葉貴子)",
    "mikataressa": "管理人の判断で載せない(ミカ)",
    "muratamegumi33": "管理人の判断で載せない(村田めぐみ)",
    "meg_5683": "管理人の判断で載せない(村上愛)",
    "helloproject_stream": "管理人の判断で載せない(HELLO!PROJECT STREAM)",
    "hello_shop_official": "管理人の判断で載せない(ハロショ。グッズの情報のため)",
    "reina_ichioka": "管理人の判断で載せない(一岡伶奈)",
}

# 対象は「現役メンバー」「公式APIで取れる人」と、次の個人アカウントのOGだけ(管理人が決めた)。
# ほかの個人アカウントのOGは、個人アカウントと分かった時点で外し、D1 からも消す(公式APIで入った投稿がある人は消さない)。
# 宮本佳林さんのアカウントは何があっても外さない
PERSONAL_OG_KEEP = {
    "kurumi_takase.official",       # 高瀬くるみ
    "shiori_yagi.official",         # 八木栞
    "akaritakeuchi_calligraphy",    # 竹内朱莉の書道のアカウント
    "karin_miyamoto.official", "miyamoto_mg",  # 宮本佳林(絶対)
    # 個人アカウントだが、IG取得で入れると決めた人(これが無いと、個人アカウントと分かった次の回で、対象から外れて消える)
    "ishiguroaya.official",         # 石黒彩
    "kobushifactory_official",      # こぶしファクトリー公式
    "countrygirls_official",        # カントリー・ガールズ公式
    "taiyo_and_ciscomoon",          # 太陽とシスコムーン公式
}

# スプシの判定に乗らないが対象にするアカウント: ユーザー名 → (表示名, 見出し)。一覧の一番下に並ぶ
EXTRA_ACCOUNTS: dict[str, tuple[str, str]] = {
    # スプシでは引退(retirement)扱いなどで外れるが、入れておきたいOG
    "kanon_fukuda": ("福田花音", "その他のOG"),
    "hp_officialfanclub": ("hp_officialfanclub", "その他"),
    "odybooks": ("オデッセー出版", "その他"),
    "mlinesp.official": ("M-line Specialの楽屋", "その他"),
    # 現役のグループではなくなった(解散・活動休止の)グループの公式アカウント
    # 並びは、このとおり(太陽とシスコムーン → カントリー・ガールズ → こぶしファクトリー)
    "taiyo_and_ciscomoon": ("太陽とシスコムーン", "その他のグループ"),
    "countrygirls_official": ("カントリー・ガールズ", "その他のグループ"),
    "kobushifactory_official": ("こぶしファクトリー", "その他のグループ"),
}


def warn(msg: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        msg = msg.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::warning title=Instagram::{msg}")
    else:
        print(f"[warn] {msg}")


# ---------- 対象アカウント ----------

def gojuon(kana: str) -> tuple[str, str]:
    """あいうえお順に並べるためのキー。濁点・半濁点を外し(ご→こ)、カタカナはひらがなにして比べる。
    濁点だけが違うときは、濁点の無い方を先にする"""
    hira = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in kana)
    plain = "".join(c for c in unicodedata.normalize("NFD", hira) if c not in "\u3099\u309a")
    return (plain, hira)


def load_targets() -> list[dict]:
    """[{username, name, section, sort}]。現役(グループ順→加入順)のあとにOG(見出しごと→加入順)。"""
    with urllib.request.urlopen(ACCOUNTS_CSV, timeout=60) as res:
        rows = list(csv.reader(io.StringIO(res.read().decode("utf-8"))))[1:]

    members: dict[int, dict] = {}
    for row in rows:
        row = [c.strip() for c in row] + [""] * 5
        num_s, name, platform, id_ = row[0], row[1], row[2], row[3]
        if not num_s.isdigit() or not platform:
            continue
        m = members.setdefault(int(num_s), {"num": int(num_s), "name": name, "aff": "", "ig": [], "kana": "", "groups": []})
        if not m["name"] and name:
            m["name"] = name
        # 名前のひらがなの読みは、platform の欄にひらがなだけが入った行(ID は空)
        if not id_ and re.fullmatch(r"[ぁ-ゖァ-ヺー・]+", platform):
            m["kana"] = platform
        elif platform == "affiliation":
            m["aff"] = id_
        elif platform in ("GroupNo", "SubGroup") and id_.isdigit() and int(id_) in GROUP_NAMES:
            if GROUP_NAMES[int(id_)] not in m["groups"]:
                m["groups"].append(GROUP_NAMES[int(id_)])
        elif platform == "instagram" and id_:
            m["ig"].append(id_.strip("/").lower())

    group_order = list(GROUPS)
    picked = []
    for m in members.values():
        if m["aff"] in GROUPS:
            picked.append(((0, group_order.index(m["aff"]), m["num"]), m, GROUPS[m["aff"]]))
            continue
        if not m["ig"]:
            continue
        name = m["name"].replace(" ", "").replace("　", "")
        listed = [(sec, names.index(name)) for sec, names in OG_ORDER.items() if name in names]
        if listed:
            sec, pos = listed[0]
        elif m["aff"] == "upfrontpromotion":
            sec, pos = "UP-FRONT PROMOTION", m["num"]
        else:
            # 引退した人・ほかの事務所の人なども、Instagram があれば入れる。所属がばらばらなので、名前の読みのあいうえお順
            sec, pos = "その他のOG", gojuon(m["kana"] or m["name"])
        picked.append(((1, OG_SECTIONS.index(sec), pos), m, sec))
    # グループ公式は、そのグループのメンバーより前(加入順の番号 -1)に置く
    for slug, user in GROUP_OFFICIAL.items():
        picked.append(((0, group_order.index(slug), -1), {"name": re.sub(r"'\d+$", "", GROUPS[slug]), "ig": [user]}, GROUPS[slug]))

    out: dict[str, dict] = {}
    for _, m, sec in sorted(picked, key=lambda t: t[0]):
        # 載せないアカウント(EXCLUDED)は、数えない(福田花音のように、片方を載せない人は、名前にユーザー名を添えない)
        shown = [u for u in m["ig"] if u not in EXCLUDED]
        for user in m["ig"]:
            # 載せるアカウントを複数持つ人(例: 書道用の別アカウント)は、ユーザー名を添えて区別する
            name = m["name"] if len(shown) <= 1 else f"{m['name']}（@{user}）"
            out.setdefault(user, {"username": user, "name": name, "section": sec,
                                  "groups": ("," + ",".join(m.get("groups", [])) + ",") if m.get("groups") else ""})
    for user, (name, sec) in EXTRA_ACCOUNTS.items():
        out.setdefault(user, {"username": user, "name": name, "section": sec})
    targets = [t for t in out.values() if t["username"] not in EXCLUDED]
    for i, t in enumerate(targets):
        t["sort"] = i
    return targets


# ---------- Worker のクローラ用API ----------

def crawl(method: str, path: str, body: dict | None = None) -> dict:
    api = os.environ["CRAWL_API"].rstrip("/")
    req = urllib.request.Request(
        f"{api}/api/crawl/{path}",
        method=method,
        data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "authorization": f"Bearer {os.environ['CRAWL_TOKEN']}",
            "content-type": "application/json",
            # Cloudflare の Bot 判定に引っかからないよう、素性の分かる UA にする
            "user-agent": "hello-insta-crawler",
        },
    )
    # D1 が混んでいると 500(D1 DB is overloaded)が返る。書き込みは何度やっても同じ結果になる形なので、
    # 間を空けてやり直す(取り込みページからの登録と重なったときなど)
    for wait in (15, 30, 60, None):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            msg = f"{method} {path}: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}"
            if e.code < 500 or wait is None:
                raise RuntimeError(msg) from None
            print(f"[retry {wait}s] {msg}")
            time.sleep(wait)


# ---------- Graph API ----------

# 必ず要るわけではないが聞いておく項目。API が受け付けなかったら、その回はその項目だけ聞かずに続ける
#   username: 投稿の持ち主。共同投稿は持ち主と共同投稿者の両方の一覧に出てくるので、Worker 側で持ち主に固定する
#   media_product_type: 通常の投稿(FEED)かリール(REELS)か。media_type(写真・動画・複数枚)とは別
OPTIONAL = {"username": "投稿の持ち主", "media_product_type": "投稿の種類(通常の投稿・リール)"}
asking = list(OPTIONAL)


def fetch_page(username: str, after: str | None, limit: int = PAGE_SIZE, items: str = "full") -> dict:
    media = f"media.limit({limit})" + (f".after({after})" if after else "")
    want = "id,caption,timestamp,permalink,media_type"
    if items == "full":
        want += ",like_count,comments_count" + "".join("," + f for f in asking)
    fields = f"business_discovery.username({username}){{media_count,{media}{{{want}}}}}"
    q = urllib.parse.urlencode({"fields": fields, "access_token": os.environ["IG_ACCESS_TOKEN"]})
    try:
        with urllib.request.urlopen(f"{GRAPH}/{os.environ['IG_USER_ID']}?{q}", timeout=60) as res:
            text = res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            err = json.loads(body.decode("utf-8")).get("error", {})
        except ValueError:
            err = {}
        # 項目が無いと言われた(code 100)ときだけ、その項目を聞くのをやめてやり直す
        bad = [f for f in asking if err.get("code") == 100 and f in str(err.get("message", ""))]
        if bad:
            for f in bad:
                asking.remove(f)
                warn(f"{OPTIONAL[f]}({f})を API が返さないので、今回は聞かずに続けます: {err.get('message')}")
            return fetch_page(username, after)
        raise urllib.error.HTTPError(e.url, e.code, e.msg, e.headers, io.BytesIO(body)) from None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        # 正しい JSON のあとに余計な文字が付いて返ってくることがあった(Extra data)。前の部分だけ使う
        try:
            data, end = json.JSONDecoder().raw_decode(text)
        except json.JSONDecodeError:
            raise BadResponse(f"API の返事が読めない({e})") from None
        warn(f"{username}: API の返事の後ろに余計な文字が {len(text) - end} 文字あったので、前の部分だけ使いました"
             f"(後ろの始まり: {text[end:end + 80]!r})")
    bd = data.get("business_discovery", {})
    # プロフィールに出ている投稿数。入っている件数と比べて、取り込みが要るか見るのに使う
    return {**bd.get("media", {}), "media_count": bd.get("media_count")}


def next_state(page: dict) -> dict:
    """次に遡るカーソルと、遡りきったか。
    続きがあっても1ページの件数が上限に満たないことがある(年齢制限の投稿などを除いた結果)ので、
    件数では判断しない。カーソルが無いか、中身が0件のページが返ってきたら最後とみなす。
    最後のときはカーソルも捨てる(残すと、下の立て直しで毎回確認しに行ってしまうため)。"""
    after = page.get("paging", {}).get("cursors", {}).get("after")
    if not after or not page.get("data"):
        return {"after": None, "done": True}
    return {"after": after, "done": False}


def err_text(e: urllib.error.HTTPError) -> str:
    """APIエラーを短く。ビジネス/クリエイターでないアカウントは subcode 2207013 で返る。"""
    try:
        err = json.loads(e.read().decode("utf-8")).get("error", {})
    except ValueError:
        return f"HTTP {e.code}"
    if err.get("error_subcode") == 2207013:
        return PERSONAL
    if err.get("code") == 190:
        # subcode で理由が分かる(460=パスワード変更、463=期限切れ、467=ログアウトなどでセッション無効)
        return f"アクセストークンが無効(190/{err.get('error_subcode')} {err.get('message', '')})"
    if err.get("code") in (4, 17, 32, 613):
        return f"回数制限({err.get('code')} {err.get('message', '')})"
    return f"{err.get('code')}/{err.get('error_subcode')} {err.get('message', '')}"


PERSONAL = "個人アカウント(取得不可)"


def is_token_error(msg: str) -> bool:
    return msg.startswith("アクセストークン")


class BadResponse(Exception):
    """API の返事が JSON として読めなかった。その人だけ今回は飛ばし、ほかの人は続ける。"""


class RateLimited(Exception):
    """API の回数制限(code 4 / 17 / 32 / 613)。その回はそこで止め、続きは次の回に回す。"""


# ---------- 本体 ----------

def main() -> int:
    for k in ("CRAWL_API", "CRAWL_TOKEN", "IG_USER_ID", "IG_ACCESS_TOKEN"):
        if not os.environ.get(k):
            print(f"環境変数 {k} が未設定です(CRAWL_API は Variables、ほかは Secrets に登録)", file=sys.stderr)
            return 1
    max_calls = int(os.environ.get("MAX_CALLS") or 150)

    targets = load_targets()
    state = {s["username"]: s for s in crawl("GET", "state")["state"]}
    # 個人アカウントと分かっている OG(現役のグループにいない人)は、PERSONAL_OG_KEEP の人だけ残す
    current = set(GROUPS.values())
    drop = [t["username"] for t in targets
            if t["section"] not in current and t["username"] not in PERSONAL_OG_KEEP
            and state.get(t["username"], {}).get("last_error") == PERSONAL]
    targets = [t for t in targets if t["username"] not in drop]
    crawl("POST", "accounts", {"accounts": targets, "remove": list(EXCLUDED), "drop": drop})
    # 以前の判定(paging.next の有無や、件数が1ページに満たないこと)で途中なのに「遡り完了」にされた人を立て直す。
    # 完了なのにカーソルが残っている人は、まだ続きがあるかもしれないので遡りを再開する
    # (本当に終わっていた人は、次の1ページが空で返ってカーソルごと消え、正しく完了に戻る)
    for st in state.values():
        if st["done"] and st["after"]:
            st["done"] = 0
    # BACKFILL_FIRST の人で、前のやり方(件数だけ減らす)で打ち切った人は、最初から遡り直す。
    # 新着を見る番に入れて最新ページからカーソルを取り直す(項目も減らすやり方で打ち切ったら、もう戻さない)
    restart = set()
    for user in BACKFILL_FIRST:
        st = state.get(user)
        if st and st["done"] and str(st.get("last_error") or "").startswith(CUT + "(古い投稿"):
            st.update(done=0, after=None)
            restart.add(user)

    # 新着は、1人ずつ決めた「自分の時刻」(間隔の中に均等に散らしたもの)を過ぎて、まだその回の分を見ていない人だけ見る。
    # 回数制限や起動の抜けで見そびれても、次の回で拾う(見ていない時間が長い人から)。
    # 個人アカウントの人もここでだけ試す(プロに切り替えたら拾うため)。それ以外の回数は遡りと周回に回す
    def jst(sec: float) -> str:
        return time.strftime("%Y-%m-%d %H:%M", time.gmtime(sec + 9 * 3600))
    def before(sec: float) -> str:
        return jst(time.time() - sec)
    priority_before = before(PRIORITY_EVERY)
    # 自分の時刻: ユーザー名の指紋の順に並べて、間隔を人数で等分する(人が増減すると少しずれるが、1回多いか少ないだけ)
    order = {u: i for i, u in enumerate(sorted((t["username"] for t in targets), key=lambda u: zlib.crc32(u.encode())))}
    def slot_before(user: str, every: float) -> str:
        """この人の、いちばん最近に過ぎた「自分の時刻」(JST)。日本時間の0時を起点に every ごと"""
        offset = every * order[user] / max(len(order), 1)
        now = time.time() + 9 * 3600
        last = (now - offset) // every * every + offset
        return jst(last - 9 * 3600)
    def is_due(t: dict) -> bool:
        st = state.get(t["username"], {})
        seen = st.get("latest_at") or ""
        if t["username"] in PRIORITY:
            return seen < priority_before
        if t["username"] in restart:
            return True
        every = PERSONAL_EVERY if st.get("last_error") == PERSONAL else LATEST_EVERY
        return seen < slot_before(t["username"], every)
    # PRIORITY の人を一番先に、あとは見ていない時間が長い人から
    due = sorted((t for t in targets if is_due(t)),
                 key=lambda t: (t["username"] not in PRIORITY, state.get(t["username"], {}).get("latest_at") or ""))

    calls = 0
    saved = 0
    failed: list[str] = []
    round_from: int | None = None  # 周回を始めたときの回数(内訳を出すため)
    rounded: set[str] = set()
    finished: list[str] = []

    def fetch_small(user: str, after: str | None) -> dict:
        """1ページ50件で全部の項目を頼み、code 1 で断られたら RETRIES の順に小さくして頼み直す。"""
        nonlocal calls
        tries = ((PAGE_SIZE, "full"), *RETRIES)
        for limit, items in tries:
            try:
                return fetch_page(user, after, limit, items)
            except urllib.error.HTTPError as e:
                body = e.read()
                try:
                    code = json.loads(body.decode("utf-8")).get("error", {}).get("code")
                except ValueError:
                    code = None
                if code != 1 or (limit, items) == tries[-1]:
                    raise urllib.error.HTTPError(e.url, e.code, e.msg, e.headers, io.BytesIO(body)) from None
                calls += 1
                time.sleep(0.5)
        raise AssertionError("unreachable")

    def get(user: str, after: str | None, kind: str = "") -> dict | None:
        """kind: "" = 新着・遡り、"round" = 周回。周回で失敗しても、遡りの進み具合やエラーの記録は変えない"""
        nonlocal calls
        calls += 1
        label = "(周回)" if kind == "round" else "(遡り)" if after else ""
        try:
            return fetch_small(user, after)
        except BadResponse as e:
            failed.append(f"{user}{label}: {e}")
            return None
        except urllib.error.HTTPError as e:
            msg = err_text(e)
            # 回数制限は一時的なものなので、アカウントのエラーとしては記録せずにその回を終える
            if msg.startswith("回数制限"):
                raise RateLimited(msg) from None
            if kind == "round":
                if is_token_error(msg):
                    failed.append(f"{user}{label}: {msg}")
                    raise
                if msg.startswith("1/"):
                    # 遡りと同じく、これより古い分は API が返さない。周回はここで読みきったことにする
                    return {"data": [], "cut": True}
                failed.append(f"{user}{label}: {msg}")
                return None
            if after and msg.startswith("1/"):
                # 一番小さいページでも断られた遡りは、毎回同じ場所で失敗して回数を使うだけなので打ち切る
                msg = f"{CUT}(件数と項目を減らしても古い投稿を API が返さない: {msg})"
                crawl("POST", "posts", {"username": user, "posts": [], "state": {"after": None, "done": True}})
            failed.append(f"{user}{label}: {msg}")
            crawl("POST", "error", {"username": user, "error": msg, "latest": not after})
            if is_token_error(msg):
                raise
            return None
        finally:
            time.sleep(0.5)

    try:
        # 1周目: 新着を見る番の人の最新ページ。遡りの起点(カーソル)が無い人はここで決まる
        for t in due:
            if calls >= max_calls:
                break
            user = t["username"]
            media = get(user, None)
            if media is None:
                continue
            st = state.get(user)
            new_state = None
            if not st or (not st["after"] and not st["done"]):
                new_state = next_state(media)
                state[user] = {"username": user, **new_state}
            crawl("POST", "posts", {"username": user, "posts": media.get("data", []), "state": new_state,
                                    "media_count": media.get("media_count"), "latest": True})
            saved += len(media.get("data", []))

        # 2周目: 遡りが終わっていないアカウントを、残りの回数で続ける(個人アカウントの人は取れないので飛ばす)。
        # BACKFILL_FIRST の人を一番先に
        for t in sorted(targets, key=lambda t: t["username"] not in BACKFILL_FIRST):
            user = t["username"]
            st = state.get(user)
            if st and st.get("last_error") == PERSONAL:
                continue
            while st and not st["done"] and st["after"] and calls < max_calls:
                media = get(user, st["after"])
                if media is None:
                    break
                st = {"username": user, **next_state(media)}
                state[user] = st
                crawl("POST", "posts", {"username": user, "posts": media.get("data", []),
                                        "state": {"after": st["after"], "done": st["done"]},
                                        "media_count": media.get("media_count")})
                saved += len(media.get("data", []))

        # 3周目: 周回。遡りを終えた人を、周回の途中の人 → 前に周回してから長い人の順に。宮本さんは一番先・毎日
        round_from = calls
        round_before, priority_round_before = before(ROUND_EVERY), before(PRIORITY_ROUND_EVERY)
        def round_due(t: dict) -> bool:
            st = state.get(t["username"], {})
            if not st.get("done") or st.get("last_error") == PERSONAL or not st.get("latest_at"):
                return False
            if st.get("round_after"):
                return True
            last = st.get("round_at") or ""
            return last < (priority_round_before if t["username"] in PRIORITY else round_before)
        rounds = sorted((t for t in targets if round_due(t)),
                        key=lambda t: (t["username"] not in PRIORITY,
                                       not state[t["username"]].get("round_after"),
                                       state[t["username"]].get("round_at") or ""))
        round_limit = min(max_calls, calls + ROUND_CALLS)
        for t in rounds:
            user = t["username"]
            st = state[user]
            while calls < round_limit:
                cursor = st.get("round_after")
                media = get(user, cursor, "round")
                if media is None:
                    break
                nxt = next_state(media) if not media.get("cut") else {"after": None, "done": True}
                crawl("POST", "posts", {"username": user, "posts": media.get("data", []),
                                        "media_count": media.get("media_count"),
                                        "round": {"start": not cursor, "after": nxt["after"], "done": nxt["done"]}})
                saved += len(media.get("data", []))
                rounded.add(user)
                st["round_after"] = nxt["after"]
                if nxt["done"]:
                    finished.append(user)
                    break
            if calls >= round_limit:
                break
    except RateLimited as e:
        # 失敗にはしない(次の回が続きから取る)。ここまでに取った分は保存済み
        warn(f"API の回数制限に達したので、今回はここまで(API {calls}回 / 保存 {saved}件)。続きは次の回に取ります\n{e}")
    except urllib.error.HTTPError:
        # failed の最後が、止まる原因になったトークンのエラー(Meta が返した文言つき)
        warn("アクセストークンが無効です。Graph API エクスプローラーで発行し直して IG_ACCESS_TOKEN を更新してください\n"
             + (failed[-1] if failed else ""))
        return 1

    # 個人アカウントの人は遡れないので数えない
    pending = sum(1 for t in targets
                  if not state.get(t["username"], {}).get("done") and state.get(t["username"], {}).get("last_error") != PERSONAL)
    round_calls = calls - round_from if round_from is not None else 0
    print(f"対象 {len(targets)} / 新着を見る番 {len(due)} / API {calls}回(うち周回 {round_calls}回) / 保存 {saved}件 / "
          f"遡り未完了 {pending}アカウント")
    if rounded:
        print(f"周回: {', '.join(sorted(rounded))}" + (f"(読みきった: {', '.join(finished)})" if finished else ""))
    if failed:
        warn("取得できなかったアカウント:\n" + "\n".join(failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
