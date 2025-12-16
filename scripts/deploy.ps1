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
Write-Host "Building project..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed. Aborting deployment."
    exit 1
}


# 2. すべての変更を Git に追加
git add .

# 3. コミットメッセージが指定されていれば使用、なければデフォルトを使用
if ($args.Count -eq 0) {
    $commitMessage = "build for deploy"
} else {
    $commitMessage = $args[0]
}

# 4. Git にコミット
if (-not (git diff --cached --quiet)) {
    git commit -m $commitMessage
} else {
    Write-Host "No changes to commit."
}

# 5. リモートの変更を取得（リベース）
Write-Host "Pulling changes from remote (rebase)..."
git pull --rebase
if ($LASTEXITCODE -ne 0) {
    Write-Error "Conflict detected during git pull."
    Write-Host "=========================================" -ForegroundColor Yellow
    Write-Host "【競合解決手順】" -ForegroundColor Yellow
    Write-Host "1. 競合が発生しているファイルを開き、修正してください。"
    Write-Host "2. 修正後、以下のコマンドを実行してステージングします："
    Write-Host "   git add <修正したファイル>"
    Write-Host "3. リベースを続行します："
    Write-Host "   git rebase --continue"
    Write-Host "4. 完了後、このスクリプトを再度実行してください。"
    Write-Host "=========================================" -ForegroundColor Yellow
    exit 1
}

# 6. GitHub に push（Render がこれをトリガーに自動デプロイ）
git push origin main
# 強制的にリモートの内容をローカルのコードで上書きする場合は以下を使用
# git push origin main --force