#!/bin/bash
# GitHub Pages への初回デプロイスクリプト
# 前提: gh CLI がインストール済みで `gh auth login` 済みであること
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="podcast-player"

if ! command -v gh >/dev/null; then
  if [ -x "$HOME/.local/bin/gh" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "gh CLI が見つかりません。https://cli.github.com/ からインストールしてください。" >&2
    exit 1
  fi
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh が未認証です。先に 'gh auth login' を実行してください。" >&2
  exit 1
fi

# リポジトリ作成 & push（既存ならスキップして push のみ）
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -b main
  git add -A
  git commit -m "Initial commit: podcast player app"
fi

OWNER=$(gh api user --jq .login)

if gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  git push -u origin main
else
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
fi

# GitHub Pages を有効化（main ブランチのルートから配信）
if ! gh api "repos/$OWNER/$REPO_NAME/pages" >/dev/null 2>&1; then
  gh api -X POST "repos/$OWNER/$REPO_NAME/pages" \
    -f "source[branch]=main" -f "source[path]=/" >/dev/null
  echo "GitHub Pages を有効化しました。"
fi

echo ""
echo "デプロイ完了（反映まで1〜2分かかります）:"
echo "  https://$OWNER.github.io/$REPO_NAME/"
