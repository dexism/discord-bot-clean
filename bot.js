// =agreed================================================================================
// TRPGサポートDiscordボット "ノエル" v3.2.4 (データ整形ロジック修正版)
// =================================================================================

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

// --- ボットの基本設定 ---
const BOT_VERSION = 'v3.2.4';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;
const GUILD_MASTER_NAME = 'ギルドマスター';

// --- クライアント初期化 ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- Googleスプレッドシート連携設定 ---
const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw';
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

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

        for (const sheet of doc.sheetsByIndex) {
            console.log(`[Loader] Processing sheet: "${sheet.title}"`);
            
            await sheet.loadCells('A1:C1');
            const sheetEnabledValue = sheet.getCell(0, 0).value;
            if (sheetEnabledValue !== true && sheetEnabledValue !== 'TRUE') {
                console.log(`[Loader] Sheet "${sheet.title}" is disabled. Skipping.`);
                continue;
            }

            const userName = sheet.getCell(0, 1).value || GUILD_MASTER_NAME;
            const userMessageTemplate = sheet.getCell(0, 2).value;

            if (!userMessageTemplate) {
                console.warn(`[Loader] Sheet "${sheet.title}" is enabled but has no message template in C1. Skipping.`);
                continue;
            }

            const rows = await sheet.getRows();
            const knowledgeLines = [];
            const headers = sheet.headerValues;

            for (const row of rows) {
                const rowEnabledValue = row.get(headers[0]);
                if (rowEnabledValue !== true && rowEnabledValue !== 'TRUE') {
                    continue;
                }

                const dataParts = [];
                for (let i = 1; i < headers.length; i++) {
                    const header = headers[i];
                    const value = row.get(header);
                    if (value !== null && value !== undefined && value !== '') {
                        dataParts.push({ header, value });
                    }
                }

                if (dataParts.length === 0) continue;

                let line = "";
                if (dataParts.length === 1) {
                    line = `${dataParts[0].value}`;
                } else {
                    // ★★★★★【修正点】最後の列は「値のみ」を書き出すように修正 ★★★★★
                    // 最後の要素を配列から分離する
                    const lastPart = dataParts.pop();
                    // 残りの要素を「項目名「値」」の形式で整形する
                    const headParts = dataParts.map(part => `${part.header}「${part.value}」`);
                    
                    // 正しい形式で連結する
                    line = `${headParts.join('の')}は、${lastPart.value}`;
                }
                knowledgeLines.push(line);
            }

            if (knowledgeLines.length > 0) {
                const knowledgeText = knowledgeLines.join('\n');
                const userMessage = userMessageTemplate + '\n' + knowledgeText;
                
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

const channelHistories = new Map();

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

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = message.content.trim();

    if (command.startsWith('!')) {
        if (command === '!ver') { message.reply(`現在の私のバージョンは ${BOT_VERSION} です`); return; }
        if (command === '!ping') { message.reply('Pong!'); return; }
        
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
        const initialHistoryFromSheets = await loadAndFormatAllDataForAI();
        if (!initialHistoryFromSheets || initialHistoryFromSheets.length === 0) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないか、中身が空っぽみたい……');
            return;
        }

        const channelId = message.channel.id;
        const now = Date.now();
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
        const reply = response.candidates?[0]?.content?.parts?[0]?.text || '...';
        
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

client.login(process.env.DISCORD_TOKEN);

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`);
});
app.listen(port, () => {
  console.log(`Fake server is running on port ${port} to prevent sleep.`);
});