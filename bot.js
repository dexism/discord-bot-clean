// =agreed================================================================================
// TRPGサポートDiscordボット "ノエル" v3.1.0 (最終アーキテクチャ・完全版)
// =================================================================================

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

// --- ボットの基本設定 ---
const BOT_VERSION = 'v3.1.0';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;
const GUILD_MASTER_NAME = 'ギルドマスター'; // ギルマスの名前を定義

// --- クライアント初期化 ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- Googleスプレッドシート連携設定 ---
const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw';
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

/**
 * 全てのシートから全データを読み込み、単一のテキストブロックに変換する関数
 * @returns {Promise<string|null>}
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

        let knowledgeText = "";
        const sheetNames = ["GUILD_RULEBOOK", "MASTER_DATA", "MARKET_RATES"];

        for (const sheetName of sheetNames) {
            const sheet = doc.sheetsByTitle[sheetName];
            if (!sheet) {
                console.warn(`[Loader] Sheet "${sheetName}" not found. Skipping.`);
                continue;
            }
            
            const rows = await sheet.getRows();
            console.log(`[Loader] Sheet "${sheetName}" has ${rows.length} total rows.`);

            const getRowValue = (row, headerName) => {
                const header = headerName.toLowerCase().trim();
                const key = sheet.headerValues.find(h => h.toLowerCase().trim() === header);
                return key ? row.get(key) : undefined;
            };

            const enabledRows = rows.filter(r => (getRowValue(r, 'Enabled') === 'TRUE' || getRowValue(r, 'Enabled') === true));
            console.log(`[Loader] Found ${enabledRows.length} enabled rows in "${sheetName}".`);
            
            if (enabledRows.length > 0) {
                knowledgeText += `\n**--- ${sheetName}からの情報 ---**\n`;
                for (const row of enabledRows) {
                    const category = getRowValue(row, 'Category') || '一般';
                    const key = getRowValue(row, 'Key') || getRowValue(row, 'Name') || getRowValue(row, 'ItemName');
                    
                    let valueText = "";
                    if (sheetName === "MASTER_DATA") {
                        valueText = `基準価値: ${getRowValue(row, 'BaseValue') || '不明'}`;
                    } else if (sheetName === "MARKET_RATES") {
                        valueText = `都市: ${getRowValue(row, 'City')}, 品名: ${getRowValue(row, 'ItemName')}, レート: ${getRowValue(row, 'Rate') || '不明'}, 需要: ${getRowValue(row, 'Demand') || '不明'}`;
                    } else {
                        valueText = getRowValue(row, 'Value') || '不明';
                    }

                    if (key) {
                        knowledgeText += `- カテゴリ「${category}」の「${key}」について: ${valueText}\n`;
                    }
                }
            }
        }
        console.log("[Loader] Finished loading and formatting all game data.");
        return knowledgeText;
    } catch (error) {
        console.error("Error loading game data from Google Sheets:", error);
        return null;
    }
}

// --- チャンネルごとの会話履歴を保持する変数 ---
const channelHistories = new Map();

// --- ヘルパー関数群 ---
const parseDiceCommand = (input) => {
    const match = input.match(/^(\d+)d(\d+)$/);
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
client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = message.content.trim();

    if (command.startsWith('!')) {
        if (command === '!ver') { message.reply(`現在の私のバージョンは ${BOT_VERSION} です`); }
        else if (command === '!ping') { message.reply('Pong!'); }
        else {
            const parsed = parseDiceCommand(command);
            if (parsed) {
                const { count, sides } = parsed;
                if (count > 100 || sides > 1000) { message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）'); }
                else {
                    const results = rollDice(count, sides);
                    const total = results.reduce((a, b) => a + b, 0);
                    message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
                }
            }
        }
        return;
    }

    try {
        const knowledgeText = await loadAndFormatAllDataForAI();
        if (!knowledgeText) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないみたい……');
            return;
        }

        const channelId = message.channel.id;
        const now = Date.now();
        let channelHistory = channelHistories.get(channelId);
        
        // ★★★★★ 最終アーキテクチャ：会話履歴に「偽の記憶」を注入 ★★★★★
        const initialHistoryWithDirectives = [
            { role: 'user', parts: [{ text: `User "${GUILD_MASTER_NAME}": "ノエル、よく聞きなさい。これが今、君が把握しておくべき全ての情報だ。一字一句違わずに頭に入れ、お客様への対応に活かすように。いいね？\n${knowledgeText}"` }] },
            { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "はい、ギルドマスター！全て承知いたしました！"` }] }
        ];

        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = { contents: JSON.parse(JSON.stringify(initialHistoryWithDirectives)), lastTimestamp: now };
            channelHistories.set(channelId, channelHistory);
        }
        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;
        
        // ★★★★★ ペルソナは、AIとしてのガードレールに徹する ★★★★★
        let personaText = `
### CORE DIRECTIVE: ROLE-PLAYING
You are a character named ${BOT_PERSONA_NAME}. NEVER break character. NEVER mention that you are an AI.
Your personality and all you know about the world are defined by the conversation history.
Your task is to continue the conversation naturally as your character.
You MUST respond in JAPANESE.
`;
        
        const persona = { parts: [{ text: personaText }] };
        const request = {
            model: 'gemini-2.5-flash-lite',
            contents: channelHistory.contents,
            systemInstruction: persona
        };
        
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
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '...';
        
        let finalReply = reply;
        const replyMatch = reply.match(new RegExp(`^${BOT_PERSONA_NAME}:\\s*"(.*)"$`));
        if (replyMatch) finalReply = replyMatch[1];
        
        message.reply(finalReply);
        channelHistory.contents.push({ role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "${finalReply}"` }] });
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