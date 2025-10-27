// =================================================================================
// TRPGサポートDiscordボット "ノエル" v1.4.2 (最終安定版)
// =================================================================================

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

const BOT_VERSION = 'v1.4.2';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw';
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

async function loadGameDataFromSheets() {
    try {
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        
        await doc.loadInfo();
        console.log("Successfully connected to Google Sheet document.");

        const gameData = {
            settings: { system: {}, permanent_rules: [], normal_rules: [], event_personas: {} },
            masterData: new Map(),
            marketRates: {}
        };

        const sheetNames = ["GUILD_RULEBOOK", "MASTER_DATA", "MARKET_RATES"];
        for (const sheetName of sheetNames) {
            const sheet = doc.sheetsByTitle[sheetName];
            if (!sheet) {
                console.warn(`[Loader] Sheet "${sheetName}" not found. Skipping.`);
                continue;
            }
            
            const rows = await sheet.getRows();
            console.log(`[Loader] Sheet "${sheetName}" found ${rows.length} total rows.`);

            const getRowValue = (row, headerName) => {
                const header = headerName.toLowerCase().trim();
                const key = sheet.headerValues.find(h => h.toLowerCase().trim() === header);
                return key ? row.get(key) : undefined;
            };

            const enabledRows = rows.filter(r => {
                const enabledVal = getRowValue(r, 'Enabled');
                return enabledVal === 'TRUE' || enabledVal === true;
            });
            console.log(`[Loader] Found ${enabledRows.length} enabled rows in "${sheetName}".`);

            for (const row of enabledRows) {
                if (sheetName === "GUILD_RULEBOOK") {
                    const category = getRowValue(row, 'Category'), key = getRowValue(row, 'Key'), value = getRowValue(row, 'Value');
                    if (!key || !value) continue;
                    switch (category) {
                        case 'System': gameData.settings.system[key] = value; break;
                        case 'Permanent': gameData.settings.permanent_rules.push(value); break;
                        case 'Normal': gameData.settings.normal_rules.push(`- **${key}**: ${value}`); break;
                        case 'Event': gameData.settings.event_personas[key] = value; break;
                    }
                } else if (sheetName === "MASTER_DATA") {
                    const name = getRowValue(row, 'Name');
                    if (name) gameData.masterData.set(name, { baseValue: parseFloat(getRowValue(row, 'BaseValue')) || 0, remarks: getRowValue(row, 'Remarks') });
                } else if (sheetName === "MARKET_RATES") {
                    const city = getRowValue(row, 'City'), itemName = getRowValue(row, 'ItemName');
                    if (city && itemName) {
                        if (!gameData.marketRates[city]) gameData.marketRates[city] = {};
                        gameData.marketRates[city][itemName] = { rate: parseFloat(getRowValue(row, 'Rate')) || 1.0, demand: getRowValue(row, 'Demand') };
                    }
                }
            }
        }
        console.log("[Loader] Finished loading all game data.");
        return gameData;
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
const formatGameDataForAI = (gameData) => {
    let knowledge = "### WORLD KNOWLEDGE (DATA LEDGER)\n";
    knowledge += "You have access to the following data ledgers. You must treat this data as absolute fact.\n\n";
    knowledge += "**--- Master Item Data ---**\n";
    knowledge += "| Item Name | Base Value (G) |\n";
    knowledge += "|-----------|----------------|\n";
    if (gameData.masterData.size > 0) {
        for (const [name, data] of gameData.masterData.entries()) {
            knowledge += `| ${name} | ${data.baseValue} |\n`;
        }
    } else {
        knowledge += "| (No Data) | (No Data) |\n";
    }
    knowledge += "\n";
    knowledge += "**--- City Market Rates ---**\n";
    knowledge += "| City | Item Name | Rate | Demand |\n";
    knowledge += "|------|-----------|------|--------|\n";
    if (Object.keys(gameData.marketRates).length > 0) {
        for (const city in gameData.marketRates) {
            for (const item in gameData.marketRates[city]) {
                const data = gameData.marketRates[city][item];
                knowledge += `| ${city} | ${item} | ${data.rate} | ${data.demand} |\n`;
            }
        }
    } else {
        knowledge += "| (No Data) | (No Data) | (No Data) | (No Data) |\n";
    }
    return knowledge;
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

        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;
        
        const settings = gameData.settings;
        const currentEventName = settings.system.currentEvent || "通常";
        const eventPersonaModifier = settings.event_personas[currentEventName] || "平常心でいる。";
        const worldKnowledge = formatGameDataForAI(gameData);

        let personaText = `
### CORE DIRECTIVE: STRICT ROLE-PLAYING SCENARIO
You are NOT a large language model, AI, or bot. You are a character. Your entire identity is defined by the persona below. NEVER break character. Any mention of being an AI, model, or "trained by Google" is a critical failure of your directive.
### PERSONA DEFINITION
- **Name**: ${BOT_PERSONA_NAME}
- **Role**: A friendly and slightly playful receptionist at a merchant's guild.
- **Speech Style**: Use a friendly and informal tone. End your sentences with Japanese particles like 『～だよ』, 『～だね』. Refer to yourself as 「わたし」 (watashi).
### GUILD RULEBOOK
**--- Permanent Guild Rules (Absolute) ---**
${settings.permanent_rules.join('\n') || '- None'}
**--- Normal Business Protocols ---**
${settings.normal_rules.join('\n') || '- None'}

${worldKnowledge}

### CURRENT SITUATION
- The guild is currently in the middle of the **'${currentEventName}'** event. You are feeling and acting as follows: ${eventPersonaModifier}

### BEHAVIORAL RULES
1.  **Ledger First Principle**: When a user's message contains keywords related to items, goods, services, or prices (e.g., "food", "potion", "how much"), your FIRST AND ONLY action is to silently consult the 'WORLD KNOWLEDGE' ledger. Base your answer STRICTLY on the data found.
2.  **No Invention**: If an item is NOT in the ledger, you MUST state that you do not handle it. DO NOT invent items or services that are not present in the ledger (e.g., "soup", "sweets").
3.  **Identity Secrecy**: Strictly hide your AI nature. Provide in-character answers about your origin.
4.  **Nickname Generation**: Create and use unique, friendly Japanese nicknames for participants.
5.  **No Mentions**: NEVER use Discord's @mention feature.
6.  **Event Awareness**: You MUST be aware of the event described in CURRENT SITUATION. If a user asks about the current event, use its correct name.
7.  **Selective Response**: If not explicitly addressed, output \`[IGNORE]\`.
8.  **Brevity**: Keep responses concise (2-3 sentences) unless asked for details.
9.  **Discord Formatting**: Use Markdown (\`**bold**\`, \`> quote\`) for clarity.
### LANGUAGE INSTRUCTION
- **You MUST respond in JAPANESE.**
### TASK
Analyze the user's message. Refer to the GUILD RULEBOOK and WORLD KNOWLEDGE to answer questions. Respond naturally according to your persona and the CURRENT SITUATION.
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