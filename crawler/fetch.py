#!/usr/bin/env python3
"""
ハロプロ現役メンバーと一部OGの Instagram 投稿を Graph API の Business Discovery で取得し、
Worker のクローラ用API(/api/crawl/*)経由で D1 に書き込む。

対象アカウント: karin-archive の SNS一覧スプシ(accounts シート)の instagram 行のうち
  - 所属(affiliation)が現役グループの人
  - OG: 所属が J.P ROOM / UP-FRONT PROMOTION の人、M-line 会員ページ(m-line 行)を持つ人
    (所属が retirement の人は除く)
シートを直せば次の実行から対象も変わる。外れた人の投稿は消さない(Worker 側で active=0)。

Business Discovery はビジネス/クリエイターアカウントしか引けず、1回で最大50件、
過去分は after カーソルで遡る。API上限(1時間200回)に収まるよう1回の実行の呼び出し数を
MAX_CALLS に抑え、遡りきれなかった分は D1 の fetch_state に残して次の実行で続ける。
  - 1周目: 全アカウントの最新ページ(INSERT OR REPLACE なので重複は無害)
  - 2周目: 遡りが終わっていないアカウントを、残りの回数の範囲で続ける
投稿と進み具合は Worker 側で1つの batch で書くので、片方だけ進むことはない。

環境変数:
  CRAWL_API        Worker のURL(例: https://insta.karin-archive.com)
  CRAWL_TOKEN      Worker の CRAWL_TOKEN と同じ値
  IG_USER_ID       自分のプロアカウントの Instagram ユーザーID(数字)
  IG_ACCESS_TOKEN  そのアカウントのアクセストークン
  MAX_CALLS        1回の実行で使う Graph API の呼び出し上限(既定 150)
"""

import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

GRAPH = "https://graph.facebook.com/v23.0"
PAGE_SIZE = 50

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
OG_SECTIONS = ["J.P ROOM", "M-line", "UP-FRONT PROMOTION"]

# グループの公式アカウント(affiliation slug → ユーザー名)。各グループの見出しの一番上に「○○ 公式」で並べる
GROUP_OFFICIAL: dict[str, str] = {
    "morningmusume":  "morningmusume_official",
    "angerme":        "angerme_official",
    "juicejuice":     "juice_juice_official",
    "tsubakifactory": "tsubakifactory_official",
    "beyooooonds":    "beyooooonds_official",
    "ochanorma":      "ocha_norma_official",
    "rosychronicle":  "rosy_chronicle_official",
}

# スプシの判定に乗らないが対象にするアカウント: ユーザー名 → (表示名, 見出し)。一覧の一番下に並ぶ
EXTRA_ACCOUNTS: dict[str, tuple[str, str]] = {
    user: (user, "その他")
    for user in ("hello_shop_official", "hp_officialfanclub", "helloproject_stream", "odybooks")
}


def warn(msg: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        msg = msg.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::warning title=Instagram::{msg}")
    else:
        print(f"[warn] {msg}")


# ---------- 対象アカウント ----------

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
        m = members.setdefault(int(num_s), {"num": int(num_s), "name": name, "aff": "", "ig": [], "mline": False})
        if not m["name"] and name:
            m["name"] = name
        if platform == "affiliation":
            m["aff"] = id_
        elif platform == "instagram" and id_:
            m["ig"].append(id_.strip("/").lower())
        elif platform == "m-line" and id_:
            m["mline"] = True

    group_order = list(GROUPS)
    picked = []
    for m in members.values():
        if m["aff"] in GROUPS:
            picked.append(((0, group_order.index(m["aff"]), m["num"]), m, GROUPS[m["aff"]]))
            continue
        if m["aff"] == "retirement":
            continue
        if m["aff"] == "jproom":
            sec = "J.P ROOM"
        elif m["aff"] == "upfrontpromotion":
            sec = "UP-FRONT PROMOTION"
        elif m["mline"]:
            sec = "M-line"
        else:
            continue
        picked.append(((1, OG_SECTIONS.index(sec), m["num"]), m, sec))
    # グループ公式は、そのグループのメンバーより前(加入順の番号 -1)に置く
    for slug, user in GROUP_OFFICIAL.items():
        picked.append(((0, group_order.index(slug), -1), {"name": f"{GROUPS[slug]} 公式", "ig": [user]}, GROUPS[slug]))

    out: dict[str, dict] = {}
    for _, m, sec in sorted(picked, key=lambda t: t[0]):
        for user in m["ig"]:
            # 複数アカウントを持つ人(例: 書道用の別アカウント)はユーザー名を添えて区別する
            name = m["name"] if len(m["ig"]) == 1 else f"{m['name']}（@{user}）"
            out.setdefault(user, {"username": user, "name": name, "section": sec})
    for user, (name, sec) in EXTRA_ACCOUNTS.items():
        out.setdefault(user, {"username": user, "name": name, "section": sec})
    targets = list(out.values())
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
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}") from None


# ---------- Graph API ----------

def fetch_page(username: str, after: str | None) -> dict:
    media = f"media.limit({PAGE_SIZE})" + (f".after({after})" if after else "")
    fields = (f"business_discovery.username({username})"
              f"{{{media}{{id,caption,timestamp,permalink,media_type,like_count,comments_count}}}}")
    q = urllib.parse.urlencode({"fields": fields, "access_token": os.environ["IG_ACCESS_TOKEN"]})
    with urllib.request.urlopen(f"{GRAPH}/{os.environ['IG_USER_ID']}?{q}", timeout=60) as res:
        data = json.loads(res.read().decode("utf-8"))
    return data.get("business_discovery", {}).get("media", {})


def next_state(page: dict) -> dict:
    """次に遡るカーソルと、遡りきったか。
    Business Discovery の入れ子の media には paging.next が付かないので、
    カーソルが無いか、件数が1ページ分に満たなければ最後のページとみなす。"""
    after = page.get("paging", {}).get("cursors", {}).get("after")
    return {"after": after, "done": not after or len(page.get("data", [])) < PAGE_SIZE}


def err_text(e: urllib.error.HTTPError) -> str:
    """APIエラーを短く。ビジネス/クリエイターでないアカウントは subcode 2207013 で返る。"""
    try:
        err = json.loads(e.read().decode("utf-8")).get("error", {})
    except ValueError:
        return f"HTTP {e.code}"
    if err.get("error_subcode") == 2207013:
        return "個人アカウント(取得不可)"
    if err.get("code") == 190:
        # subcode で理由が分かる(460=パスワード変更、463=期限切れ、467=ログアウトなどでセッション無効)
        return f"アクセストークンが無効(190/{err.get('error_subcode')} {err.get('message', '')})"
    return f"{err.get('code')}/{err.get('error_subcode')} {err.get('message', '')}"


def is_token_error(msg: str) -> bool:
    return msg.startswith("アクセストークン")


# ---------- 本体 ----------

def main() -> int:
    for k in ("CRAWL_API", "CRAWL_TOKEN", "IG_USER_ID", "IG_ACCESS_TOKEN"):
        if not os.environ.get(k):
            print(f"環境変数 {k} が未設定です(CRAWL_API は Variables、ほかは Secrets に登録)", file=sys.stderr)
            return 1
    max_calls = int(os.environ.get("MAX_CALLS") or 150)

    targets = load_targets()
    crawl("POST", "accounts", {"accounts": targets})
    state = {s["username"]: s for s in crawl("GET", "state")["state"]}
    # 以前の判定(paging.next の有無)で、最初の1ページだけで「遡り完了」にされてしまった人を立て直す。
    # カーソルが残っていて収録数がちょうど1ページ分の倍数なら、まだ続きがあるとみなして遡りを再開する
    # (本当に終わっていた人は、次の1ページが空で返って正しく完了に戻る)
    for st in state.values():
        if st["done"] and st["after"] and st.get("posts") and st["posts"] % PAGE_SIZE == 0:
            st["done"] = 0

    calls = 0
    saved = 0
    failed: list[str] = []

    def get(user: str, after: str | None) -> dict | None:
        nonlocal calls
        calls += 1
        try:
            return fetch_page(user, after)
        except urllib.error.HTTPError as e:
            msg = err_text(e)
            failed.append(f"{user}{'(遡り)' if after else ''}: {msg}")
            crawl("POST", "error", {"username": user, "error": msg})
            if is_token_error(msg):
                raise
            return None
        finally:
            time.sleep(0.5)

    try:
        # 1周目: 全アカウントの最新ページ。遡りの起点(カーソル)が無い人はここで決まる
        for t in targets:
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
            crawl("POST", "posts", {"username": user, "posts": media.get("data", []), "state": new_state})
            saved += len(media.get("data", []))

        # 2周目: 遡りが終わっていないアカウントを、残りの回数で続ける
        for t in targets:
            user = t["username"]
            st = state.get(user)
            while st and not st["done"] and st["after"] and calls < max_calls:
                media = get(user, st["after"])
                if media is None:
                    break
                st = {"username": user, **next_state(media)}
                state[user] = st
                crawl("POST", "posts", {"username": user, "posts": media.get("data", []),
                                        "state": {"after": st["after"], "done": st["done"]}})
                saved += len(media.get("data", []))
    except urllib.error.HTTPError:
        # failed の最後が、止まる原因になったトークンのエラー(Meta が返した文言つき)
        warn("アクセストークンが無効です。Graph API エクスプローラーで発行し直して IG_ACCESS_TOKEN を更新してください\n"
             + (failed[-1] if failed else ""))
        return 1

    pending = sum(1 for t in targets if not state.get(t["username"], {}).get("done"))
    print(f"対象 {len(targets)} / API {calls}回 / 保存 {saved}件 / 遡り未完了 {pending}アカウント")
    if failed:
        warn("取得できなかったアカウント:\n" + "\n".join(failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
