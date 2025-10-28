// =agreed================================================================================
// TRPGサポートDiscordボット "ノエル" v3.2.0 (動的知識ベース対応版)
// =================================================================================

require('dotenv').config();
// google-genai は @google/generative-ai にパッケージ名が変更されています
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

// --- ボットの基本設定 ---
const BOT_VERSION = 'v3.2.0';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;
const GUILD_MASTER_NAME = 'ギルドマスター'; // デフォルトのギルマス名

// --- クライアント初期化 ---
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- Googleスプレッドシート連携設定 ---
const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw'; // ユーザー提供のスプレッドシートID
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

/**
 * 全ての有効なシートからデータを読み込み、AI用の「偽の記憶」会話履歴配列を生成する関数
 * @returns {Promise<Array<object>|null>}
 */
async function loadAndFormatAllDataForAI() {
    try {
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        
        await doc.loadInfo();
        console.log("Successfully connected to Google Sheet document.");

        const initialHistoryWithDirectives = [];

        // --- 全てのシートを走査 ---
        for (const sheet of doc.sheetsByIndex) {
            console.log(`[Loader] Processing sheet: "${sheet.title}"`);
            
            // --- A1:C1セルを読み込んでシートの有効性と設定を取得 ---
            await sheet.loadCells('A1:C1');
            const isSheetEnabled = sheet.getCell(0, 0).value === true; // A1
            
            if (!isSheetEnabled) {
                console.log(`[Loader] Sheet "${sheet.title}" is disabled. Skipping.`);
                continue;
            }

            const userName = sheet.getCell(0, 1).value || GUILD_MASTER_NAME; // B1
            const userMessageTemplate = sheet.getCell(0, 2).value; // C1

            if (!userMessageTemplate) {
                console.warn(`[Loader] Sheet "${sheet.title}" is enabled but has no message template in C1. Skipping.`);
                continue;
            }

            const rows = await sheet.getRows();
            const knowledgeLines = [];
            const headers = sheet.headerValues; // 2行目がヘッダーになる

            for (const row of rows) {
                // --- A列のチェックボックスでレコードの有効性を判断 ---
                const isRowEnabled = row.get(headers[0]) === true;
                if (!isRowEnabled) continue;

                const dataParts = [];
                // B列以降のデータを処理
                for (let i = 1; i < headers.length; i++) {
                    const header = headers[i];
                    const value = row.get(header);
                    // 値が空でない場合のみパーツを追加
                    if (value !== null && value !== undefined && value !== '') {
                        dataParts.push({ header, value });
                    }
                }

                if (dataParts.length === 0) continue;

                let line = "";
                // --- 新しい整形ルールに基づき文字列を生成 ---
                if (dataParts.length === 1) {
                    // データが1つだけの場合は、連結詞を使わず値のみを書き出す
                    line = `${dataParts[0].value}`;
                } else {
                    const lastIndex = dataParts.length - 1;
                    const formattedParts = dataParts.map((part, index) => {
                        if (index === lastIndex) {
                            // 最後の列は「は、」で連結
                            return `${part.header}「${part.value}」`;
                        } else {
                            // それ以外の列は「の」で連結
                            return `${part.header}「${part.value}」`;
                        }
                    });
                    
                    const head = formattedParts.slice(0, lastIndex).join('の');
                    const tail = formattedParts[lastIndex];
                    line = `${head}は、${tail}`;
                }
                knowledgeLines.push(line);
            }

            if (knowledgeLines.length > 0) {
                const knowledgeText = knowledgeLines.join('\n');
                const userMessage = userMessageTemplate + '\n' + knowledgeText;
                
                // --- 会話履歴セットを生成 ---
                initialHistoryWithDirectives.push(
                    { role: 'user', parts: [{ text: `User "${userName}": "${userMessage}"` }] },
                    { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "はい、${userName}！全て承知いたしました！"` }] }
                );
                console.log(`[Loader] Successfully loaded ${knowledgeLines.length} records from "${sheet.title}".`);
            }
        }

        console.log(`[Loader] Finished loading all data. Generated ${initialHistoryWithDirectives.length / 2} sets of memories.`);
        return initialHistoryWithDirectives;

    } catch (error) {
        console.error("Error loading game data from Google Sheets:", error);
        return null;
    }
}

// --- チャンネルごとの会話履歴を保持する変数 ---
const channelHistories = new Map();

// --- ヘルパー関数群 ---
const parseDiceCommand = (input) => {
    const match = input.match(/^!(\d+)d(\d+)$/i); // 先頭の!を許容し、大文字小文字を区別しない
    if (!match) return null;
    const count = parseInt(match[1], 10), sides = parseInt(match[2], 10);
    return { count, sides };
};
const rollDice = (count, sides) => {
    const rolls = [];
    for (let i = 0; i < count; i++) { rolls.push(Math.floor(Math.random() * sides) + 1); }
    return rolls;
};

// --- Discordイベントリスナー ---
client.once('ready', client => { // 'clientReady' は v14 で 'ready' に変更されました
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // --- コマンド処理を最初に移動 ---
    const command = message.content.trim();
    if (command.startsWith('!')) {
        if (command === '!ver') {
            message.reply(`現在の私のバージョンは ${BOT_VERSION} です`);
            return;
        }
        if (command === '!ping') {
            message.reply('Pong!');
            return;
        }
        
        const parsedDice = parseDiceCommand(command);
        if (parsedDice) {
            const { count, sides } = parsedDice;
            if (count > 100 || sides > 1000) {
                message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）');
            } else {
                const results = rollDice(count, sides);
                const total = results.reduce((a, b) => a + b, 0);
                message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
            }
            return; // コマンド処理後はAI応答をしない
        }
    }

    // --- AI応答処理 ---
    try {
        const initialHistoryFromSheets = await loadAndFormatAllDataForAI();
        if (!initialHistoryFromSheets || initialHistoryFromSheets.length === 0) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないか、中身が空っぽみたい……');
            return;
        }

        const channelId = message.channel.id;
        const now = Date.now();
        let channelHistory = channelHistories.get(channelId);

        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            // ★★★★★ 改修点: スプレッドシートから生成した会話履歴を直接利用 ★★★★★
            channelHistory = { 
                contents: JSON.parse(JSON.stringify(initialHistoryFromSheets)), 
                lastTimestamp: now 
            };
            channelHistories.set(channelId, channelHistory);
        }

        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;
        
        // --- システムプロンプト (ペルソナ設定) ---
        const systemInstruction = {
            parts: [{ text: `### CORE DIRECTIVE: ROLE-PLAYING
You are a character named ${BOT_PERSONA_NAME}. NEVER break character. NEVER mention that you are an AI.
Your personality and all you know about the world are defined by the conversation history.
Your task is to continue the conversation naturally as your character.
You MUST respond in JAPANESE.`
            }]
        };

        const model = ai.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction: systemInstruction,
        });

        const chat = model.startChat({
            history: channelHistory.contents.slice(0, -1), // 最後（現在のユーザー発言）を除いた履歴
        });
        
        // --- 指数バックオフ付きのリトライ処理 ---
        const generateContentWithRetry = async (prompt, maxRetries = 5) => {
            let lastError = null;
            for (let i = 0; i < maxRetries; i++) {
                try {
                    const result = await chat.sendMessage(prompt);
                    return result.response;
                } catch (error) {
                    lastError = error;
                    // APIからのエラーレスポンスに 429 が含まれているかチェック
                    if (error.toString().includes('429') || (error.status && error.status === 429)) {
                        const delay = (2 ** i) * 1000 + Math.random() * 1000;
                        console.warn(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)}s...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        // 429以外のエラーは再スロー
                        throw error;
                    }
                }
            }
            console.error("All retries failed.");
            throw lastError;
        };
        
        const response = await generateContentWithRetry(command);
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '...';
        
        // --- 応答からペルソナ名などを取り除く処理を簡素化 ---
        // Geminiは `BOT_PERSONA_NAME}: "..."` のような形式で応答することが少ないため、
        // 念の為の処理とし、よりシンプルにします。
        let finalReply = reply.trim();
        if (finalReply.startsWith(`${BOT_PERSONA_NAME}:`)) {
            finalReply = finalReply.substring(BOT_PERSONA_NAME.length + 1).trim();
        }
        if (finalReply.startsWith('"') && finalReply.endsWith('"')) {
            finalReply = finalReply.substring(1, finalReply.length - 1);
        }
        
        message.reply(finalReply);

        // --- 実際のボットの応答を履歴に追加 ---
        channelHistory.contents.push({ role: 'model', parts: [{ text: finalReply }] });
        channelHistory.lastTimestamp = now;

    } catch (error) {
        console.error('Error in messageCreate:', error);
        message.reply('あ、すみません……ちょっと考えごとをしてました！');
    }
});

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