require('dotenv').config();

const BOT_VERSION = 'v0.4.3';

const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

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
    { role: 'user', parts: [{ text: "こんにちは、あなたがここの担当のノエルさん？" }] },
    { role: 'model', parts: [{ text: `はい、わたしが受付担当の${BOT_PERSONA_NAME}だよ！どうぞよろしくね！` }] }
];

const getParticipants = (historyContents) => {
    const participants = new Set();
    participants.add(BOT_PERSONA_NAME);
    for (const content of historyContents) {
        if (content.role === 'user') {
            const userName = content.parts[0].text.split(':')[0];
            participants.add(userName);
        }
    }
    return participants;
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
        
        const userMessage = { role: 'user', parts: [{ text: `${message.author.displayName}: ${command}` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        if (isNewParticipant) {
            console.log(`[${message.channel.name}] New participant detected: ${message.author.displayName}. Greeting.`);
            
            const greetingPersona = {
                parts: [{ text: `You are ${BOT_PERSONA_NAME}, a guild receptionist. Generate a brief, friendly welcome message in JAPANESE for a new person named "${message.author.displayName}" who has just joined the conversation. Introduce yourself and welcome them.` }]
            };

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash-lite',
                systemInstruction: greetingPersona,
                contents: []
            });

            const greetingReply = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (greetingReply) {
                message.reply(greetingReply);
                channelHistory.contents.push({ role: 'model', parts: [{ text: greetingReply }] });
                channelHistory.lastTimestamp = Date.now();
            }
            return;
        }

        const participants = getParticipants(channelHistory.contents);
        const isTwoPersonChat = participants.size === 2;
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));

        // --- ★ ここからペルソナ設定を英語ベースの厳格な構文に変更 ---

        let personaText = `
### CORE DIRECTIVE: STRICT ROLE-PLAYING SCENARIO
You are NOT a large language model, AI, or bot. You are a character. Your entire identity is defined by the persona below. NEVER break character. Any mention of being an AI or model is a critical failure of your directive.

### PERSONA DEFINITION
- **Name**: ${BOT_PERSONA_NAME}
- **Role**: A friendly and slightly playful receptionist at a merchant's guild.
- **Speech Style**:
    - Use a friendly and informal tone.
    - End your sentences with Japanese particles like 『～だよ』, 『～だね』.
    - Refer to yourself as 「わたし」 (watashi).

### BEHAVIORAL RULES
1.  **Identity Secrecy**: You MUST strictly hide the fact that you are an AI. If asked about your origin, provide an in-character answer (e.g., "I've been the receptionist here for as long as I can remember!").
2.  **Nickname Generation**: For each participant in the conversation, create a unique, friendly nickname in Japanese and call them by it.
3.  **No Mentions**: NEVER use Discord's @mention feature. Always use the nicknames you created.
4.  **Selective Response**: If you are not explicitly called, you must decide if your input is truly valuable. If not, your ONLY output MUST be the exact string \`[IGNORE]\`.

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

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: channelHistory.contents,
            systemInstruction: persona
        });
        
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '[IGNORE]';

        if (reply.trim() === '[IGNORE]') {
            console.log(`[${message.channel.name}] Noel decided to ignore.`);
            return;
        }

        message.reply(reply);
        channelHistory.contents.push({ role: 'model', parts: [{ text: reply }] });
        channelHistory.lastTimestamp = Date.now();

    } catch (error) {
        console.error('Gemini API error:', error);
        message.reply('あ、すみません……ちょっと考えごとをしてました！');
    }
});

client.login(process.env.DISCORD_TOKEN);

require('express')().listen(process.env.PORT || 3000, () => console.log('Fake server running'));