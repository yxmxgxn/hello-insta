"""
クローラ用APIの合言葉(CRAWL_TOKEN)を作り直す。忘れたとき用。

GitHub の Secret はあとから読めないので、忘れたら作り直すしかない。
合言葉は画面に出すだけでファイルには書かない(Git に入れない)。

  python tools/new_crawl_token.py
      合言葉を作って、登録のしかたと貼り付けページの URL を出す

  python tools/new_crawl_token.py --repo yxmxgxn/hello-insta --site https://insta.karin-archive.com
      gh で Secret の CRAWL_TOKEN を差し替え、Deploy を流して Worker の Secret にも入れる。
      終わったら出てくる URL を一度開けば、ブラウザが合言葉を覚える(public/paste.js の localStorage)

同じ形のリポジトリ(hello-tiktok など)にも --repo と --site を替えて使える。
"""

import argparse
import secrets
import subprocess
import sys


def main() -> None:
    ap = argparse.ArgumentParser(description="CRAWL_TOKEN を作り直す")
    ap.add_argument("--repo", help="Secret を差し替えるリポジトリ(owner/name)。省くと作るだけ")
    ap.add_argument("--site", default="https://insta.karin-archive.com", help="貼り付けページのあるサイト")
    ap.add_argument("--workflow", default="deploy.yml", help="Worker の Secret に流し込むワークフロー")
    args = ap.parse_args()

    token = secrets.token_urlsafe(32)

    if args.repo:
        # 合言葉はコマンドラインに載せず標準入力で渡す(ps やシェル履歴に残さない)
        subprocess.run(["gh", "secret", "set", "CRAWL_TOKEN", "--repo", args.repo],
                       input=token, text=True, check=True)
        subprocess.run(["gh", "workflow", "run", args.workflow, "--repo", args.repo], check=True)
        print(f"{args.repo} の CRAWL_TOKEN を差し替え、{args.workflow} を流しました。", file=sys.stderr)
        print("デプロイが終わったら、次の URL を一度開いてブラウザに覚えさせてください:", file=sys.stderr)
    else:
        print("GitHub の Secrets の CRAWL_TOKEN に登録し、Deploy を流してください。", file=sys.stderr)
        print("合言葉:", file=sys.stderr)
        print(token)
        print("デプロイが終わったら、次の URL を一度開いてブラウザに覚えさせてください:", file=sys.stderr)

    print(f"{args.site.rstrip('/')}/paste?t={token}")


if __name__ == "__main__":
    main()
