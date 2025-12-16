# プロジェクト概要 (Description Draft)

## Repository Description (GitHub用)
**TRPG/SLG Support Discord Bot with Gemini AI & Google Sheets Integration**
Google Sheetsによるデータ管理とGemini APIによるAIロールプレイ対話を統合した、TRPG/SLGコミュニティ運営支援ボット。

## About (詳細)
「Noelle（ノエル）」は、Discordサーバー上でのテーブルトークRPG (TRPG) やシミュレーションゲーム (SLG) の運営を強力にサポートするために開発されたボットです。

### 主な特徴
* 🧠 **AI Roleplay**: Google Gemini APIを活用し、設定された人格（ペルソナ）に基づいた自然な対話を行います。
* 📊 **Spreadsheet Integration**: Google Sheetsをデータベースとして使用し、アイテムデータ、ユーザーログ、設定マスタをリアルタイムに管理・同期します。
* 🎲 **Dice Roller**: TRPGに必須のダイスロール機能 (`!2d6` など) を標準搭載。
* 🕹️ **Interactive Menus**: Discordのボタンやドロップダウンを使用したリッチなメニューシステムで、直感的な操作を提供します。

### Tech Stack
* TypeScript / Node.js
* Discord.js v14
* Google Gemini API
* Google Spreadsheet API
* GitHub Actions (CI/CD)
