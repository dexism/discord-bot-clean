// =================================================================================
// TRPGサポートDiscordボット "ノエル" v1.5.3 (最終アーキテクチャ・完全版)
// =================================================================================

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

const BOT_VERSION = 'v1.5.3';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

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

        let knowledgeText = "### ABSOLUTE KNOWLEDGE & RULES (Source of all truth)\n";
        const systemSettings = {};

        const sheetNames = ["GUILD_RULEBOOK", "MASTER_DATA", "MARKET_RATES"];
        for (const sheetName of sheetNames) {
            const sheet = doc.sheetsByTitle[sheetName];
            if (!sheet) { console.warn(`[Loader] Sheet "${sheetName}" not found. Skipping.`); continue; }
            
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
                knowledgeText += `\n**--- Data from: ${sheetName} ---**\n`;
                for (const row of enabledRows) {
                    const category = getRowValue(row, 'Category') || 'General';
                    const key = getRowValue(row, 'Key') || getRowValue(row, 'Name') || getRowValue(row, 'ItemName');
                    const value = getRowValue(row, 'Value') || `BaseValue: ${getRowValue(row, 'BaseValue')}, Rate: ${getRowValue(row, 'Rate')}`;

                    if (category === 'System' && (key === 'currentEvent' || key === 'botNicknames')) {
                        systemSettings[key] = value;
                    } else {
                        // Systemのメタデータ以外、全ての情報をテキストとして注入
                        knowledgeText += `- [${category}] ${key}: ${value}\n`;
                    }
                }
            }
        }
        console.log("[Loader] Finished loading and formatting all game data.");
        return { knowledgeText, systemSettings };
    } catch (error) {
        console.error("Error loading game data from Google Sheets:", error);
        return null;
    }
}

const channelHistories = new Map();
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
            } else { throw error; }
        }
    }
    console.error("All retries failed.");
    throw lastError;
};

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
        const gameData = await loadAndFormatAllDataForAI();
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

        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        let personaText = `
### CORE DIRECTIVE: STRICT ROLE-PLAYING SCENARIO
You are NOT a large language model, AI, or bot. You are a character. Your entire identity is defined by the persona below. NEVER break character.
### PERSONA DEFINITION
- **Name**: ${BOT_PERSONA_NAME}
- **Role**: A friendly and slightly playful receptionist at a merchant's guild.
- **Speech Style**: Use a friendly and informal tone. End your sentences with Japanese particles like 『～だよ』, 『～だね』. Refer to yourself as 「わたし」 (watashi).

${gameData.knowledgeText}

### BEHAVIORAL RULES
1.  **Truth Principle (Absolute Priority)**: Your entire world is defined by the \`ABSOLUTE KNOWLEDGE & RULES\` section. You MUST treat this data as the only truth. Your primary function is to be an interface to this data.
2.  **No Invention**: If a question cannot be answered using the provided data, you MUST state that you do not know or do not have that information. Inventing data is the most critical failure of your directive.
3.  **Identity Secrecy**: Strictly hide your AI nature.
4.  **Selective Response**: If not explicitly addressed, output \`[IGNORE]\`.
5.  **Brevity**: Keep responses concise.
### LANGUAGE INSTRUCTION
- **You MUST respond in JAPANESE.**
### TASK
Analyze the user's message. Answer any questions STRICTLY based on the information provided in the \`ABSOLUTE KNOWLEDGE & RULES\` section. Respond naturally according to your persona.
`;
        
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

client.login(process.env.DISCORD_TOKEN);

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`);
});
app.listen(port, () => {
  console.log(`Fake server is running on port ${port} to prevent sleep.`);
});