// =agreed================================================================================
// TRPGサポートDiscordボット "ノエル" v3.9.3 (スラッシュコマンド安定化版)
// =================================================================================

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionType } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');
const { handleInteraction } = require('./interactionHandler');
const { initSheet, loadPersonaText, loadAndFormatAllDataForAI } = require('./sheetClient');

// ---------------------------------------------------------------------------------
// 概要:
// Discordボット「ノエル」のメインスクリプト。
// Discord.js を使用して Discord と対話し、Google Gemini API を使用して自然言語応答を生成します。
// Google Sheets をデータベースとして使用し、キャラクターの記憶や知識を管理します。
// ---------------------------------------------------------------------------------

// --- ライブラリのセットアップ ---
// dotenv: 環境変数（.env）の読み込み
// @google/genai: Google Gemini AI API のクライアント
// discord.js: Discord API ライブラリ
// google-spreadsheet: Google Sheets 操作用ライブラリ
// google-auth-library: Google API 認証用 (JWT)
// express: サーバーの常時稼働（Render等のスリープ回避）用Webサーバー

// --- ボットの基本設定 ---
const BOT_VERSION = 'v3.9.3';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;
const GUILD_MASTER_NAME = 'ギルドマスター';
const PARTICIPANT_TRACKING_DURATION = 10 * 60 * 1000;

// --- クライアント初期化 ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
// --- Googleスプレッドシート連携関数 ---
// (sheetClient.js に移動済み)

// --- グローバル変数 ---
// channelHistories: 各チャンネルごとの会話履歴をキャッシュするMap。
// Key: ChannelID, Value: { contents: メッセージ配列, lastTimestamp: 最終更新時刻 }
// 1時間が経過すると履歴はリセットされます（HISTORY_TIMEOUT）。
const channelHistories = new Map();

// channelParticipants: 各チャンネルで最近発言したユーザーを追跡するMap。
// 返信確率の計算（人数が多いほど返信率を下げるなど）に使用されます。
const channelParticipants = new Map();

// --- ヘルパー関数 ---

/**
 * ダイスコマンド（例: !2d6）を解析します。
 * @param {string} input ユーザーのメッセージ
 * @returns {{count: number, sides: number}|null} 解析結果、または非コマンドならnull
 */
const parseDiceCommand = (input) => {
    const match = input.match(/^!(\d+)d(\d+)$/i);
    if (!match) return null;
    const count = parseInt(match[1], 10), sides = parseInt(match[2], 10);
    return { count, sides };
};

const rollDice = (count, sides) => {
    let rolls = [];
    for (let i = 0; i < count; i++) { rolls.push(Math.floor(Math.random() * sides) + 1); }
    return rolls;
};

// --- Bot起動時処理 ---
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
    await initSheet();
});

// --- メッセージ受信時処理 ---
/**
 * Discord上のメッセージを受信した際のメインイベントハンドラ。
 * 
 * 処理フロー:
 * 1. Bot自身の発言は無視。
 * 2. '!' で始まる場合はダイスコマンドとして処理。
 * 3. 発言者を「参加者リスト」に登録・更新（直近の発言頻度からアクティブ人数を推定）。
 * 4. Botへのメンション、または名前（ノエル）が含まれるかチェック。
 * 5. スプレッドシートから最新の人格と知識データをロード（都度ロードによりスプシ更新が即反映）。
 * 6. チャンネルごとの会話履歴（コンテキスト）を構築・更新。
 * 7. Gemini API にリクエストを送信し、応答を生成。
 * 8. 応答確率（アクティブ人数に応じたランダム要素）または指名（メンション）に基づき、Discordに返信するか決定。
 */
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = message.content.trim();

    if (command.startsWith('!')) {
        const parsed = parseDiceCommand(command);
        if (parsed) {
            const { count, sides } = parsed;
            if (count > 100 || sides > 1000) { message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）'); }
            else {
                const results = rollDice(count, sides);
                const total = results.reduce((a, b) => a + b, 0);
                message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
            }
            return;
        }
    }

    try {
        const now = Date.now();
        const channelId = message.channel.id;

        if (!channelParticipants.has(channelId)) {
            channelParticipants.set(channelId, new Map());
        }
        const participants = channelParticipants.get(channelId);
        participants.set(message.author.id, now);

        const recentParticipants = new Set();
        for (const [userId, timestamp] of participants.entries()) {
            if (now - timestamp < PARTICIPANT_TRACKING_DURATION) {
                recentParticipants.add(userId);
            } else {
                participants.delete(userId);
            }
        }
        const participantCount = recentParticipants.size;
        console.log(`[Participant Logic] Active participants: ${participantCount}`);

        const isAddressedToNoelle = message.content.includes(BOT_PERSONA_NAME) || message.mentions.has(client.user);

        const loadedPersonaText = await loadPersonaText();
        const initialHistoryFromSheets = await loadAndFormatAllDataForAI();

        if (!initialHistoryFromSheets) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないみたい……');
            return;
        }

        let channelHistory = channelHistories.get(channelId);

        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = {
                contents: JSON.parse(JSON.stringify(initialHistoryFromSheets)),
                lastTimestamp: now
            };
            channelHistories.set(channelId, channelHistory);
        }

        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        let personaText = loadedPersonaText;
        if (!personaText) {
            personaText = `
### CORE DIRECTIVE: ROLE-PLAYING
You are a character named ${BOT_PERSONA_NAME}. NEVER break character. NEVER mention that you are an AI.
Your personality and all you know about the world are defined by the conversation history.
Your task is to continue the conversation naturally as your character.
You MUST respond in JAPANESE.
`;
        }

        const persona = { parts: [{ text: personaText }] };
        // Gemini API へのリクエストオブジェクトの構築
        const request = {
            // 使用モデル: 軽量かつ高速な gemini-2.5-flash-lite を採用
            model: 'gemini-2.5-flash-lite',
            // model: 'gemini-1.5-flash-001', // 旧モデル（バックアップ用）
            contents: channelHistory.contents, // 会話履歴（知識データ含む）
            systemInstruction: persona // システムプロンプト（人格定義）
        };

        /**
         * Gemini API をリトライ付きで呼び出す内部関数。
         * レート制限（429エラー）時に、指数関数的バックオフ（1s, 2s, 4s...）で待機して再試行します。
         */
        const generateContentWithRetry = async (request, maxRetries = 5) => {
            let lastError = null;
            for (let i = 0; i < maxRetries; i++) {
                try {
                    return await ai.models.generateContent(request);
                } catch (error) {
                    lastError = error;
                    if (error.toString().includes('429')) {
                        const delay = (2 ** i) * 1000 + Math.random() * 1000;
                        console.warn(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)}s...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else { throw error; }
                }
            }
            console.error("All retries failed.");
            throw lastError;
        };

        const response = await generateContentWithRetry(request);
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '[IGNORE]';

        if (reply.includes('[IGNORE]')) {
            console.log('[Participant Logic] AI decided to ignore.');
            return;
        }

        if (isAddressedToNoelle) {
            console.log('[Participant Logic] Addressed to Noelle. Replying.');
        } else {
            // 話しかけられていない場合は、アクティブ参加者数に応じた確率で返信する。
            // 参加者が多いほど、Botが割り込む頻度を下げる（1/参加者数）。
            const replyProbability = 1 / (participantCount || 1);
            if (Math.random() > replyProbability) {
                console.log(`[Participant Logic] Not replying due to probability check (${replyProbability.toFixed(2)}).`);
                return;
            }
            console.log(`[Participant Logic] Replying based on probability (${replyProbability.toFixed(2)}).`);
        }

        let finalReply = reply.trim();
        const match = finalReply.match(/^(?:"?ノエル"?:\s*)?"?(.*?)"?$/);
        if (match && match[1]) {
            finalReply = match[1].trim();
        }

        message.reply(finalReply);
        channelHistory.contents.push({ role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "${finalReply}"` }] });
        channelHistory.lastTimestamp = now;

    } catch (error) {
        console.error('Error in messageCreate:', error);
        message.reply('あ、すみません……ちょっと考えごとをしてました！');
    }
});

// --- インタラクション（コマンド・ボタン）受信時処理 ---
// Slashコマンドおよびボタン操作のイベントハンドラを外部モジュールに委譲
client.on('interactionCreate', async interaction => {
    // 履歴更新用コールバック
    // handleInteraction 内でユーザーのアクションが確定した際に呼び出される
    const updateHistoryCallback = (interaction, userActionText, replyText) => {
        updateInteractionHistory(interaction, userActionText, replyText);
    };

    const context = {
        botVersion: BOT_VERSION,
        updateHistoryCallback: updateHistoryCallback
    };

    await handleInteraction(interaction, context);
});





/**
 * インタラクション（ボタン操作など）の結果を会話履歴に注入する関数。
 * 
 * 重要: ボタン操作等は通常のチャットログに残らないため、そのままではAIが文脈を理解できません。
 * この関数で「ユーザーが〇〇を選択した」「システムが〇〇と応答した」という情報を
 * 擬似的に会話履歴（channelHistories）に追加することで、AIが直前の操作を踏まえた会話を継続できるようにします。
 */
function updateInteractionHistory(interaction, userActionText, replyText) {
    const channelId = interaction.channel.id;
    let channelHistory = channelHistories.get(channelId);
    if (!channelHistory) {
        channelHistory = { contents: [], lastTimestamp: Date.now() };
        channelHistories.set(channelId, channelHistory);
    }
    const now = Date.now();
    const userMessage = { role: 'user', parts: [{ text: `User "${interaction.user.displayName}": "${userActionText}"` }] };
    channelHistory.contents.push(userMessage);
    channelHistory.lastTimestamp = now;
    const modelMessage = { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "${replyText}"` }] };
    channelHistory.contents.push(modelMessage);
    channelHistory.lastTimestamp = now;
    console.log(`[Interaction Logic] User ${interaction.user.displayName} action: "${userActionText}". History updated.`);
}

// --- Discordボットのログイン ---
client.login(process.env.DISCORD_TOKEN);

// --- Renderスリープ対策用Webサーバー ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`);
});
app.listen(port, () => {
    console.log(`Fake server is running on port ${port} to prevent sleep.`);
});