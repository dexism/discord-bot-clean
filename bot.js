require('dotenv').config();

const BOT_VERSION = 'v0.8.1'; // バージョンを更新

const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ★★★★★ Googleスプレッドシート連携部分 ★★★★★
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw'; // ★自分のIDに書き換えてください
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// 設定をロードする関数 (v0.8.0の階層化ロジック + シート名指定)
async function loadSettingsFromSheet() {
    try {
        await doc.loadInfo();
        // ★ シート名を "GUILD_RULEBOOK" に指定
        const sheet = doc.sheetsByTitle["GUILD_RULEBOOK"] || doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        
        const settings = {
            system: {},
            permanent_rules: [],
            normal_rules: [],
            event_personas: {}
        };

        // チェックボックス(Enabled列)がTRUEの行だけをフィルタリング
        const enabledRows = rows.filter(row => row.get('Enabled') === 'TRUE' || row.get('Enabled') === true);

        for (const row of enabledRows) {
            const category = row.get('Category');
            const key = row.get('Key');
            const value = row.get('Value');

            if (!key || !value) continue;

            switch (category) {
                case 'System':
                    settings.system[key] = value;
                    break;
                case 'Permanent':
                    settings.permanent_rules.push(value);
                    break;
                case 'Normal':
                    // 恒常業務はタイトル(Key)付きでリストに追加
                    settings.normal_rules.push(`- **${key}**: ${value}`);
                    break;
                case 'Event':
                    settings.event_personas[key] = value;
                    break;
            }
        }
        console.log("Successfully loaded settings from GUILD_RULEBOOK.");
        return settings;
    } catch (error) {
        console.error("Error loading settings from Google Sheet:", error);
        return null;
    }
}
// ★★★★★ 連携部分ここまで ★★★★★

const channelHistories = new Map();
const HISTORY_TIMEOUT = 3600 * 1000;
const BOT_NAMES = ['ノエル', 'ボット', 'bot'];
const BOT_PERSONA_NAME = 'ノエル';

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

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
    const participants = new Set();
    participants.add(BOT_PERSONA_NAME);
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

// レート制限回避のためのリトライ関数 (v0.6.0より)
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
    console.error("All retries failed.");
    throw lastError;
};

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const command = message.content.trim();

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
        // ★ スプレッドシートから設定を読み込む
        const settings = await loadSettingsFromSheet();
        if (!settings) {
            message.reply('ごめんなさい、ギルドの規則書が今見つからないみたい…！少し待ってからもう一度試してみてね。');
            return;
        }

        const channelId = message.channel.id;
        const now = Date.now();
        let channelHistory = channelHistories.get(channelId);

        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = {
                contents: JSON.parse(JSON.stringify(initialHistory)),
                lastTimestamp: now
            };
            channelHistories.set(channelId, channelHistory);
        }

        const existingParticipants = getParticipants(channelHistory.contents);
        const isNewParticipant = !existingParticipants.has(message.author.displayName);

        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        const participants = getParticipants(channelHistory.contents);
        const isTwoPersonChat = participants.size === 2;
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));

        // --- ★ 設定をペルソナに反映 ---
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
1.  **Identity Secrecy**: You MUST strictly hide the fact that you are an AI.
2.  **Nickname Generation**: Create a unique, friendly Japanese nickname for each participant and ALWAYS use it instead of @mentions.
3.  **Selective Response**: If not explicitly called, only respond if you can provide significant value. Otherwise, output \`[IGNORE]\`.
4.  **Brevity & Formatting**: Keep responses concise (2-3 sentences). Use Discord Markdown (\`**bold**\`, \`> quote\`) for clarity.

### LANGUAGE INSTRUCTION
- **You MUST respond in JAPANESE.**

### CURRENT SITUATION & TASK
`;

        if (isNewParticipant) {
            personaText += `A new person named "${message.author.displayName}" has just spoken for the first time. Welcome them warmly. You MUST respond.`;
        } else if (isMentioned || isCalled) {
            personaText += "You were explicitly called by name. You MUST respond. Do not output `[IGNORE]`.";
        } else if (isTwoPersonChat) {
            personaText += "The conversation is one-on-one. Respond naturally.";
        } else {
            personaText += "Analyze the conversation and respond ONLY if valuable. Otherwise, output `[IGNORE]`.";
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
        console.error('Gemini API error:', error);
        message.reply('あ、すみません……ちょっと考えごとをしてました！');
    }
});

client.login(process.env.DISCORD_TOKEN);

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`);
});

app.listen(port, () => {
  console.log(`Fake server is running on port ${port}`);
});