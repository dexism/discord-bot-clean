// =================================================================================
// TRPGサポートDiscordボット "ノエル" v1.0.1
// =================================================================================

// 必要なライブラリを読み込みます
require('dotenv').config(); // Renderの環境変数を読み込む
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

// --- ボットの基本設定 ---
const BOT_VERSION = 'v1.0.1';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000; // 履歴のリセット時間（1時間）

// --- Google AI & Discordクライアントの初期化 ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- Googleスプレッドシート連携設定 ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw';
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

/**
 * 3つのシートからゲームデータをすべて読み込み、構造化されたオブジェクトとして返す関数
 * @returns {Promise<object|null>} 成功時はゲームデータ、失敗時はnull
 */
async function loadGameDataFromSheets() {
    try {
        await doc.loadInfo();
        const gameData = {
            settings: { system: {}, permanent_rules: [], normal_rules: [], event_personas: {} },
            masterData: new Map(),
            marketRates: {}
        };

        const sheetNames = ["GUILD_RULEBOOK", "MASTER_DATA", "MARKET_RATES"];
        for (const sheetName of sheetNames) {
            const sheet = doc.sheetsByTitle[sheetName];
            if (!sheet) {
                console.warn(`Sheet "${sheetName}" not found. Skipping.`);
                continue;
            }
            
            const rows = await sheet.getRows();
            const enabledRows = rows.filter(r => r.get('Enabled') === 'TRUE' || r.get('Enabled') === true);

            if (sheetName === "GUILD_RULEBOOK") {
                for (const row of enabledRows) {
                    const category = row.get('Category'), key = row.get('Key'), value = row.get('Value');
                    if (!key || !value) continue;
                    switch (category) {
                        case 'System': gameData.settings.system[key] = value; break;
                        case 'Permanent': gameData.settings.permanent_rules.push(value); break;
                        case 'Normal': gameData.settings.normal_rules.push(`- **${key}**: ${value}`); break;
                        case 'Event': gameData.settings.event_personas[key] = value; break;
                    }
                }
            } else if (sheetName === "MASTER_DATA") {
                for (const row of enabledRows) {
                    const name = row.get('Name');
                    if (name) gameData.masterData.set(name, { baseValue: parseFloat(row.get('BaseValue')) || 0, remarks: row.get('Remarks') });
                }
            } else if (sheetName === "MARKET_RATES") {
                for (const row of enabledRows) {
                    const city = row.get('City'), itemName = row.get('ItemName');
                    if (city && itemName) {
                        if (!gameData.marketRates[city]) gameData.marketRates[city] = {};
                        gameData.marketRates[city][itemName] = { rate: parseFloat(row.get('Rate')) || 1.0, demand: row.get('Demand') };
                    }
                }
            }
        }
        console.log("Successfully loaded all game data from Google Sheets.");
        return gameData;
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
    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    return { count, sides };
};
const rollDice = (count, sides) => {
    const rolls = [];
    for (let i = 0; i < count; i++) { rolls.push(Math.floor(Math.random() * sides) + 1); }
    return rolls;
};
const initialHistory = [
    { role: 'user', parts: [{ text: `User "Newcomer": "こんにちは、あなたがここの担当のノエルさん？"` }] },
    { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "はい、わたしが受付担当の${BOT_PERSONA_NAME}だよ！どうぞよろしくね！"` }] }
];
const getParticipants = (historyContents) => {
    const participants = new Set([BOT_PERSONA_NAME]);
    for (const content of historyContents) {
        if (content.role === 'user') {
            const match = content.parts[0].text.match(/User "([^"]+)"/);
            if (match) participants.add(match[1]);
        }
    }
    return participants;
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
            } else {
                throw error;
            }
        }
    }
    console.error("All retries failed.");
    throw lastError;
};

// --- Discordイベントリスナー ---
client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = message.content.trim();

    // ★★★★★ 修正点2：コマンド処理をtry...catchの外に移動し、確実にreturnする ★★★★★
    if (command.startsWith('!')) {
        if (command === '!ver') {
            message.reply(`現在の私のバージョンは ${BOT_VERSION} です`);
        } else if (command === '!ping') {
            message.reply('Pong!');
        } else {
            const parsed = parseDiceCommand(command);
            if (parsed) {
                const { count, sides } = parsed;
                if (count > 100 || sides > 1000) {
                    message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）');
                } else {
                    const results = rollDice(count, sides);
                    const total = results.reduce((a, b) => a + b, 0);
                    message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
                }
            }
        }
        return; // "!"で始まるコマンドはここで処理を完全に終了する
    }

    try {
        const gameData = await loadGameDataFromSheets();
        if (!gameData) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないみたい……');
            return;
        }

        const channelId = message.channel.id;
        const now = Date.now();
        let channelHistory = channelHistories.get(channelId);
        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = { contents: JSON.parse(JSON.stringify(initialHistory)), lastTimestamp: now };
            channelHistories.set(channelId, channelHistory);
        }

        const existingParticipants = getParticipants(channelHistory.contents);
        const isNewParticipant = !existingParticipants.has(message.author.displayName);

        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        const priceQueryMatch = command.match(/「(.+)」の(.+)での(価格|相場)は？/);
        if (priceQueryMatch) {
            const itemName = priceQueryMatch[1];
            const cityName = priceQueryMatch[2];
            const itemData = gameData.masterData.get(itemName);
            if (!itemData) {
                message.reply(`ごめんなさい、「${itemName}」という品物は台帳に載ってないみたいだよ。`);
                return;
            }
            const marketInfo = gameData.marketRates[cityName]?.[itemName];
            if (!marketInfo) {
                message.reply(`うーん、「${cityName}」の「${itemName}」の相場情報はまだギルドに届いてないみたい。ごめんね！`);
                return;
            }
            const baseValue = itemData.baseValue;
            const marketRate = marketInfo.rate;
            const calculatedPrice = Math.round(baseValue * marketRate);
            const demand = marketInfo.demand;
            let replyText = `「${itemName}」の${cityName}での相場だね！\n`;
            replyText += `> **基準価値**: ${baseValue} G\n`;
            replyText += `> **市場レート**: x${marketRate} (需要: ${demand})\n`;
            replyText += `> **計算価格**: **${calculatedPrice} G**\n\n`;
            replyText += `輸送費や手数料を考えると、実際の取引価格はもう少し変わってくると思うから、気をつけてね！`;
            message.reply(replyText);
            return;
        }

        const participants = getParticipants(channelHistory.contents);
        const isTwoPersonChat = participants.size === 2;
        const isMentioned = message.mentions.has(client.user.id);
        
        // ★★★★★ 修正点1：スプレッドシートからニックネームリストを読み込む ★★★★★
        const botNicknames = gameData.settings.system.botNicknames?.split(',').map(name => name.trim().toLowerCase()) || [];
        const isCalledByNickname = botNicknames.some(name => command.toLowerCase().includes(name));

        const settings = gameData.settings;
        const currentEventName = settings.system.currentEvent || "通常";
        const eventPersonaModifier = settings.event_personas[currentEventName] || "平常心でいる。";

        let personaText = `
### CORE DIRECTIVE: STRICT ROLE-PLAYING SCENARIO
You are NOT a large language model, AI, or bot. You are a character. Your entire identity is defined by the persona below. NEVER break character. Any mention of being an AI, model, or "trained by Google" is a critical failure of your directive.

### PERSONA DEFINITION
- **Name**: ${BOT_PERSONA_NAME}
- **Role**: A friendly and slightly playful receptionist at a merchant's guild.
- **Speech Style**:
    - Use a friendly and informal tone.
    - End your sentences with Japanese particles like 『～だよ』, 『～だね』.
    - Refer to yourself as 「わたし」 (watashi).

### GUILD RULEBOOK & WORLD STATE
**--- Permanent Guild Rules (Absolute) ---**
${settings.permanent_rules.join('\n') || '- None'}
**--- Normal Business Protocols ---**
${settings.normal_rules.join('\n') || '- None'}
**--- Current Event & Directives ---**
- **Event Name**: ${currentEventName}
- **Your Current Mood & Directives**: ${eventPersonaModifier}

### BEHAVIORAL RULES
1.  **Identity Secrecy**: You MUST strictly hide the fact that you are an AI. If asked about your origin, provide an in-character answer (e.g., "I've been the receptionist here for as long as I can remember!").
2.  **Nickname Generation**: For each participant in the conversation, create a unique, friendly nickname in Japanese and call them by it.
3.  **No Mentions**: NEVER use Discord's @mention feature. Always use the nicknames you created.
4.  **Selective Response**: If you are not explicitly called and your response is not required by the current task, you must decide if your input is truly valuable. If not, your ONLY output MUST be the exact string \`[IGNORE]\`.
5.  **Brevity**: Keep your responses concise and to the point (2-3 short sentences). Only provide longer explanations if specifically asked for details.
6.  **Discord Formatting**: Use Discord's Markdown formatting (e.g., \`**bold**\`, \`*italics*\`, \`> blockquotes\`) to make your messages, especially explanations, clear and easy to read.

### LANGUAGE INSTRUCTION
- **You MUST respond in JAPANESE.**
### CURRENT SITUATION & TASK
`;
        
        let shouldRespond = false;
        if (isNewParticipant) {
            shouldRespond = true;
            personaText += `A person named "${message.author.displayName}" has joined the conversation for the first time in a while. Greet them lightly and naturally, like a familiar face you haven't seen in a bit. You MUST respond.`;
        } else if (isMentioned || isCalledByNickname) {
            shouldRespond = true;
            personaText += "You were explicitly called. You MUST respond.";
        } else if (isTwoPersonChat) {
            shouldRespond = true;
            personaText += "This is a one-on-one conversation. Respond naturally.";
        } else {
            const aizuchiChance = 0.20; // 20%
            if (Math.random() < aizuchiChance) {
                shouldRespond = true;
                personaText += `You are in a group conversation and not directly addressed. Your task is to provide a very short, natural interjection (an 'aizuchi') of 10-20 characters that fits the current flow. Do NOT ask questions or provide detailed analysis. Just a brief comment. If you can't think of a good one, output \`[IGNORE]\`.`;
            }
        }
        
        if (!shouldRespond) {
            console.log(`[${message.channel.name}] Noel decided to stay silent (probabilistically).`);
            return;
        }
        
        const persona = { parts: [{ text: personaText }] };
        const request = {
            model: 'gemini-2.5-flash-lite',
            contents: channelHistory.contents,
            systemInstruction: persona
        };
        const response = await generateContentWithRetry(request);
        
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '[IGNORE]';

        if (reply.trim() === '[IGNORE]') {
            console.log(`[${message.channel.name}] Noel decided to ignore (AI decision).`);
            return;
        }
        
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