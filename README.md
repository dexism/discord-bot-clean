# Discord Bot "Noelle" (TypeScript)

![CI Status](https://github.com/dexism/discord-bot-clean/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

TRPG/SLGサポート用Discordボット「ノエル」のTypeScript版プロジェクトです。
Google Gemini APIによる自然言語対話、Google Sheetsによるデータ管理機能を備えています。

## プロジェクト構成

```
project-root/
├─ src/                  # ソースコード（TypeScript）
│  ├─ bot.ts             # Bot本体 (Entry Point)
│  ├─ services/          # 連携処理 (Google Sheets, Interaction Handler)
│  └─ utils/             # 共通関数・設定 (Interaction Config)
├─ tests/                # テストコード（Vitest）
├─ docs/                 # 公開用ドキュメント（GitHubにアップロード）
│  ├─ README.md          # プロジェクト概要
│  ├─ CONTRIBUTING.md    # 開発参加ガイド
│  └─ API.md             # 公開可能な仕様書
├─ internal-docs/        # チーム内専用ドキュメント（非公開）
│  ├─ architecture.md    # 詳細な設計図
│  ├─ operations.md      # 運営チーム用手順書
│  ├─ gameplay-rules.md  # TRPG/SLGルール詳細
│  └─ secrets.md         # 機密情報（APIキーの扱い方など）
├─ scripts/              # デプロイや補助スクリプト
│  ├─ deploy.ps1         # 自動デプロイスクリプト
│  └─ deploy-commands.ts # コマンド登録スクリプト
├─ .github/workflows/    # GitHub Actions CI/CD設定
├─ .gitignore
├─ package.json
├─ tsconfig.json
├─ README.md             # プロジェクト概要（必須）
├─ LICENSE               # ライセンス（必須）
└─ dist/                 # ビルド生成物
```

## 開発環境のセットアップ

1. 依存関係のインストール
   ```bash
   npm install
   ```
2. 環境変数 `.env` の設定
   - `DISCORD_TOKEN`: Botトークン
   - `GEMINI_API_KEY`: Google Gemini APIキー
   - `SPREADSHEET_ID`: データ用スプレッドシートID
   - `GOOGLE_CREDENTIALS_JSON`: GoogleサービスアカウントJSON
   - `CLIENT_ID`: Discord Application ID

## 開発コマンド

- **開発サーバー起動**: `npm run dev`
- **ビルド**: `npm run build`
- **テスト**: `npm test`
- **スラッシュコマンド登録**:
  ```bash
  npx ts-node scripts/deploy-commands.ts
  ```

## デプロイ

PowerShellスクリプトを使用します。ビルド・コミット・プッシュを一括で行います。

```powershell
.\scripts\deploy.ps1 "コミットメッセージ"
```
Render Web Service と UptimeRobot による稼働維持を利用しています。

## ドキュメント
- [機能概要 (Description)](docs/DESCRIPTION.md)
- [開発参加ガイド (Contributing Guide)](docs/CONTRIBUTING.md)
- [行動規範 (Code of Conduct)](docs/CODE_OF_CONDUCT.md)
- [セキュリティポリシー (Security Policy)](docs/SECURITY.md)

## ライセンス
[MIT License](LICENSE)


本ソフトウェアは MIT ライセンスの下で提供されています。詳細については [LICENSE](LICENSE) ファイルを参照してください。

### 日本語参考訳

MITライセンスの日本語訳を [LICENSE_JP](./LICENSE_JP) に記載しています。
