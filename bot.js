require('dotenv').config();

const BOT_VERSION = 'v0.6.0';

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

// ★ 履歴の形式を新しい構造化フォーマットに更新
const initialHistory = [
    { role: 'user', parts: [{ text: `User "Newcomer": "こんにちは、あなたがここの担当のノエルさん？"` }] },
    { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "はい、わたしが受付担当の${BOT_PERSONA_NAME}だよ！どうぞよろしくね！"` }] }
];

const getParticipants = (historyContents) => {
    const participants = new Set();
    participants.add(BOT_PERSONA_NAME);
    for (const content of historyContents) {
        if (content.role === 'user') {
            // "User \"Username\": ..." という形式からUsernameを抽出
            const match = content.parts[0].text.match(/User "([^"]+)"/);
            if (match) {
                participants.add(match[1]);
            }
        }
    }
    return participants;
};

/**
 * レート制限エラーを考慮し、指数関数的バックオフとジッターを用いて
 * APIリクエストをリトライするラッパー関数。
 * @param {object} request - ai.models.generateContentに渡すリクエストオブジェクト
 * @param {number} maxRetries - 最大リトライ回数
 * @returns {Promise<any>} - APIからのレスポンス
 */
const generateContentWithRetry = async (request, maxRetries = 5) => {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await ai.models.generateContent(request);
            return response; // 成功したらレスポンスを返す
        } catch (error) {
            lastError = error;
            // エラーがレート制限（HTTPステータス 429）であるかを確認
            if (error.toString().includes('429')) {
                const delay = (2 ** i) * 1000 + Math.random() * 1000; // 指数関数的バックオフ + ジッター
                console.warn(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)}s... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                // レート制限以外のエラーは即座にスローする
                throw error;
            }
        }
    }
    // すべてのリトライが失敗した場合
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

        // ユーザーの発言を構造化された形式で履歴に追加
        const userMessage = { role: 'user', parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        const participants = getParticipants(channelHistory.contents);
        const isTwoPersonChat = participants.size === 2;
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));

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

        if (isNewParticipant) {
            personaText += `A new person named "${message.author.displayName}" has just spoken for the first time. Your task is to welcome them warmly according to your persona. Generate a brief, friendly welcome message. Introduce yourself and welcome them. You MUST respond.`;
        } else if (isMentioned || isCalled) {
            personaText += "You were explicitly called by name. You MUST respond. Do not output `[IGNORE]`.";
        } else if (isTwoPersonChat) {
            personaText += "The conversation is one-on-one. The message is likely for you. Respond naturally.";
        } else {
            personaText += "You were not called by name. Analyze the conversation and respond ONLY if you can provide significant value. Otherwise, output `[IGNORE]`.";
        }

        const persona = { parts: [{ text: personaText }] };

        // 直接APIを呼び出す代わりに、リトライ機能付きのラッパー関数を使用する
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
        
        // AIの応答も構造化された形式で履歴に追加
        // 応答から "Noel: " や引用符を削除して純粋なメッセージのみを送信する
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