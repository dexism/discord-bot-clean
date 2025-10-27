// =================================================================================
// TRPGサポートDiscordボット "ノエル" v0.9.1
// =================================================================================

// 必要なライブラリを読み込む
require('dotenv').config(); // .envファイルから環境変数を読み込む
const { GoogleGenAI } = require('@google/genai'); // Google AI
const { Client, GatewayIntentBits } = require('discord.js'); // Discord.js
const { GoogleSpreadsheet } = require('google-spreadsheet'); // Googleスプレッドシート連携
const { JWT } = require('google-auth-library'); // Google認証
const express = require('express'); // Renderのスリープ対策用Webサーバー

// --- ボットの基本設定 ---
const BOT_VERSION = 'v0.9.1';
const BOT_NAMES = ['ノエル', 'ボット', 'bot'];
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000; // 履歴のリセット時間（1時間）

// --- Google AI & Discordクライアントの初期化 ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- Googleスプレッドシート連携設定 ---
// Renderの環境変数から認証情報を読み込み、JSONとして解釈
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw'; // スプレッドシートID
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

        // 1. GUILD_RULEBOOKシートの読み込み
        const settingsSheet = doc.sheetsByTitle["GUILD_RULEBOOK"];
        if (settingsSheet) {
            const rows = await settingsSheet.getRows();
            const enabledRows = rows.filter(r => r.get('Enabled') === 'TRUE' || r.get('Enabled') === true);
            for (const row of enabledRows) {
                const category = row.get('Category');
                const key = row.get('Key');
                const value = row.get('Value');
                if (!key || !value) continue;

                // 読み込んだ設定を正しいオブジェクトに格納
                switch (category) {
                    case 'System':
                        gameData.settings.system[key] = value;
                        break;
                    case 'Permanent':
                        gameData.settings.permanent_rules.push(value);
                        break;
                    case 'Normal':
                        gameData.settings.normal_rules.push(`- **${key}**: ${value}`);
                        break;
                    case 'Event':
                        gameData.settings.event_personas[key] = value;
                        break;
                }
            }
        }

        // 2. MASTER_DATAシートの読み込み
        const masterDataSheet = doc.sheetsByTitle["MASTER_DATA"];
        if (masterDataSheet) {
            const rows = await masterDataSheet.getRows();
            const enabledRows = rows.filter(r => r.get('Enabled') === 'TRUE' || r.get('Enabled') === true);
            for (const row of enabledRows) {
                const name = row.get('Name');
                if (name) {
                    gameData.masterData.set(name, {
                        baseValue: parseFloat(row.get('BaseValue')) || 0,
                        remarks: row.get('Remarks')
                    });
                }
            }
        }

        // 3. MARKET_RATESシートの読み込み
        const marketRatesSheet = doc.sheetsByTitle["MARKET_RATES"];
        if (marketRatesSheet) {
            const rows = await marketRatesSheet.getRows();
            const enabledRows = rows.filter(r => r.get('Enabled') === 'TRUE' || r.get('Enabled') === true);
            for (const row of enabledRows) {
                const city = row.get('City');
                const itemName = row.get('ItemName');
                if (city && itemName) {
                    if (!gameData.marketRates[city]) gameData.marketRates[city] = {};
                    gameData.marketRates[city][itemName] = {
                        rate: parseFloat(row.get('Rate')) || 1.0,
                        demand: row.get('Demand')
                    };
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

/**
 * ダイスロールコマンドを解釈する (例: "2d6")
 * @param {string} input - メッセージ内容
 * @returns {{count: number, sides: number}|null}
 */
const parseDiceCommand = (input) => {
    const match = input.match(/^(\d+)d(\d+)$/);
    if (!match) return null;
    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    return { count, sides };
};

/**
 * 実際にダイスを振る
 * @param {number} count - ダイスの数
 * @param {number} sides - ダイスの面数
 * @returns {number[]} - 各ダイスの出目の配列
 */
const rollDice = (count, sides) => {
    const rolls = [];
    for (let i = 0; i < count; i++) { rolls.push(Math.floor(Math.random() * sides) + 1); }
    return rolls;
};

// 新しい会話履歴が作られる際の、ノエルの最初の記憶（自己紹介）
const initialHistory = [
    { role: 'user', parts: [{ text: `User "Newcomer": "こんにちは、あなたがここの担当のノエルさん？"` }] },
    { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "はい、わたしが受付担当の${BOT_PERSONA_NAME}だよ！どうぞよろしくね！"` }] }
];

/**
 * 会話履歴から参加者のユニークなリストを取得する
 * @param {object[]} historyContents - 会話履歴の配列
 * @returns {Set<string>} - 参加者名のSet
 */
const getParticipants = (historyContents) => {
    const participants = new Set();
    participants.add(BOT_PERSONA_NAME); // ボット自身も参加者
    for (const content of historyContents) {
        if (content.role === 'user') {
            const match = content.parts[0].text.match(/User "([^"]+)"/);
            if (match) {
                participants.add(match[1]);
            }
        }
    }
    return participants;
};

/**
 * APIのレート制限エラーを考慮し、自動でリトライする関数
 * @param {object} request - APIに渡すリクエストオブジェクト
 * @param {number} maxRetries - 最大リトライ回数
 * @returns {Promise<any>}
 */
const generateContentWithRetry = async (request, maxRetries = 5) => {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await ai.models.generateContent(request);
            return response;
        } catch (error) {
            lastError = error;
            if (error.toString().includes('429')) {
                const delay = (2 ** i) * 1000 + Math.random() * 1000;
                console.warn(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)}s... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    console.error("All retries failed after multiple attempts.");
    throw lastError;
};

// --- Discordイベントリスナー ---

// ボットが起動したときに一度だけ実行
client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

// メッセージが送信されるたびに実行
client.on('messageCreate', async message => {
    // ボット自身の発言は無視
    if (message.author.bot) return;

    const command = message.content.trim();

    // --- "!"で始まるコマンドの処理 ---
    if (command.startsWith('!')) {
        if (command === '!ver') { message.reply(`現在の私のバージョンは ${BOT_VERSION} です`); return; }
        if (command === '!ping') { message.reply('Pong!'); return; }
        const parsed = parseDiceCommand(command);
        if (parsed) {
            const { count, sides } = parsed;
            if (count > 100 || sides > 1000) { message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）'); return; }
            const results = rollDice(count, sides);
            const total = results.reduce((a, b) => a + b, 0);
            message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
            return;
        }
    }

    try {
        // 1. まず、スプレッドシートから最新のゲームデータを読み込む
        const gameData = await loadGameDataFromSheets();
        if (!gameData) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないみたい……少し待ってからもう一度試してみてね。');
            return;
        }

        // 2. チャンネルの会話履歴を取得または初期化
        const channelId = message.channel.id;
        const now = Date.now();
        let channelHistory = channelHistories.get(channelId);
        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = { contents: JSON.parse(JSON.stringify(initialHistory)), lastTimestamp: now };
            channelHistories.set(channelId, channelHistory);
        }

        // 3. 発言前の参加者リストを取得し、新規参加者か判定
        const existingParticipants = getParticipants(channelHistory.contents);
        const isNewParticipant = !existingParticipants.has(message.author.displayName);

        // 4. どのような発言でも、まず履歴に記録する
        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        // 5. 新規参加者だった場合は、挨拶をしてこのメッセージの処理を終了
        if (isNewParticipant) {
            console.log(`New participant detected: ${message.author.displayName}. Greeting.`);
            // ここではAIを使わず、固定の挨拶を返すことで安定性を確保
            message.reply(`あら、${message.author.displayName}さん、はじめまして！ わたしはここの受付担当のノエルだよ。どうぞよろしくね！`);
            return;
        }

        // 6. 特別なコマンド（価格照会）を処理して終了
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

        // 7. 上記のいずれでもなければ、通常のAI応答処理に進む
        const participants = getParticipants(channelHistory.contents);
        const isTwoPersonChat = participants.size === 2;
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));
        
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
${settings.permanent_rules.length > 0 ? settings.permanent_rules.map(rule => `- ${rule}`).join('\n') : '- None'}
**--- Normal Business Protocols ---**
${settings.normal_rules.length > 0 ? settings.normal_rules.join('\n') : '- None'}
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
- **You MUST respond in JAPANESE.** All your outputs must be in the Japanese language.

### CURRENT SITUATION & TASK
`;

        if (isMentioned || isCalled) {
            personaText += "You were explicitly called by name. You MUST respond. Do not output `[IGNORE]`.";
        } else if (isTwoPersonChat) {
            personaText += "The conversation is one-on-one. The message is likely for you. Respond naturally.";
        } else {
            personaText += "You were not called by name. Analyze the conversation and respond ONLY if you can provide significant value. Otherwise, output `[IGNORE]`.";
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
            console.log(`[${message.channel.name}] Noel decided to ignore.`);
            return;
        }
        
        let finalReply = reply;
        const replyMatch = reply.match(new RegExp(`^${BOT_PERSONA_NAME}:\\s*"(.*)"$`));
        if (replyMatch) {
            finalReply = replyMatch[1];
        }
        
        message.reply(finalReply);
        channelHistory.contents.push({ role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "${finalReply}"` }] });
        channelHistory.lastTimestamp = now;

    } catch (error) {
        console.error('Gemini API, Sheet API, or other processing error:', error);
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