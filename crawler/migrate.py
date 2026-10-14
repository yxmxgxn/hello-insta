#!/usr/bin/env python3
"""
一度だけ使う移行スクリプト: karin-archive 時代の投稿(D1 karin-hello の insta_post / insta_fts)を
このサイトの D1 へ移す。GitHub Actions の migrate.yml から動かす。

  1. karin-hello から wrangler で読み出す(insta_fts は仮想テーブルなので export できず SELECT で読む)
  2. /api/crawl/import へ送る(bigram は作り直さずそのまま入れる。旧DBには本文全体が無いため)
  3. 遡りの進み具合(crawler/legacy_state.json。karin-archive の data/insta_state.json の写し)も入れる
  4. --drop-old のときだけ、件数が揃っているのを確かめてから karin-hello の旧テーブルを消す

環境変数: CRAWL_API, CRAWL_TOKEN(fetch.py と同じ), CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID(wrangler 用)
"""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch import crawl  # noqa: E402

OLD_DB = "karin-hello"
CHUNK = 200   # 1回の import で送る投稿数(1投稿あたり最大3文。D1 の batch 上限1000文に収める)
LEGACY_STATE = Path(__file__).resolve().parent / "legacy_state.json"


def old_query(sql: str) -> list[dict]:
    out = subprocess.run(
        ["npx", "--yes", "wrangler@4", "d1", "execute", OLD_DB, "--remote", "--json", "--command", sql],
        check=True, capture_output=True, text=True, encoding="utf-8",
    ).stdout
    return json.loads(out)[0]["results"]


def main() -> int:
    drop_old = "--drop-old" in sys.argv

    old_count = old_query("SELECT COUNT(*) AS n FROM insta_post")[0]["n"]
    print(f"旧DBの投稿: {old_count}件")

    # 索引(bigram)を先に全部読む。rowid 順に区切って読む
    grams: dict[str, str] = {}
    last = 0
    while True:
        rows = old_query(f"SELECT rowid AS r, id, bigram FROM insta_fts WHERE rowid > {last} ORDER BY rowid LIMIT 500")
        if not rows:
            break
        for r in rows:
            grams[r["id"]] = r["bigram"]
        last = rows[-1]["r"]
    print(f"旧DBの索引: {len(grams)}件")

    sent = 0
    last_id = ""
    while True:
        rows = old_query(
            "SELECT id, account, ts, permalink, media_type, excerpt FROM insta_post "
            f"WHERE id > '{last_id}' ORDER BY id LIMIT {CHUNK}")
        if not rows:
            break
        for r in rows:
            r["bigram"] = grams.get(r["id"])
        crawl("POST", "import", {"posts": rows})
        sent += len(rows)
        last_id = rows[-1]["id"]
        print(f"  移行 {sent}/{old_count}")

    if LEGACY_STATE.exists():
        legacy = json.loads(LEGACY_STATE.read_text(encoding="utf-8"))
        state = [{"username": u, "after": s.get("after"), "done": s.get("done")} for u, s in legacy.items()]
        crawl("POST", "import", {"state": state})
        print(f"進み具合: {len(state)}アカウント")

    if drop_old:
        if sent < old_count:
            print("移した件数が旧DBより少ないので、旧テーブルは消しません", file=sys.stderr)
            return 1
        old_query("DROP TABLE IF EXISTS insta_post")
        old_query("DROP TABLE IF EXISTS insta_fts")
        print("karin-hello の insta_post / insta_fts を削除しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
