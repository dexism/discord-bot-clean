# ============================================
# deploy.ps1 - Render 自動デプロイスクリプト
# ============================================
# 使用方法：
#   PowerShell で以下のように実行
#     .\deploy.ps1 "任意のコミットメッセージ"
#     .\deploy.ps1           ← メッセージが空なら "build for deploy" を使用
#
# 前提条件：
#   - GitHub に push すると Render が自動デプロイする設定済み
#   - Render のビルドコマンドが "npm install" に設定されている
#   - 実行ポリシーが許可されている（必要なら Set-ExecutionPolicy RemoteSigned）

# 1. プロジェクトをビルド（本番用に最適化）
# npm install

# 2. すべての変更を Git に追加
git add .

# 3. コミットメッセージが指定されていれば使用、なければデフォルトを使用
if ($args.Count -eq 0) {
    $commitMessage = "build for deploy"
} else {
    $commitMessage = $args[0]
}

# 4. Git にコミット
git commit -m $commitMessage

# 5. リモートの変更を取得
git pull

# 6. GitHub に push（Netlify がこれをトリガーに自動デプロイ）
git push