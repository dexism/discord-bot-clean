require('dotenv').config();

const BOT_VERSION = 'v0.4.1';

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

        const userMessage = { role: 'user', parts: [{ text: `${message.author.displayName}: ${command}` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        const participants = getParticipants(channelHistory.contents);
        const isTwoPersonChat = participants.size === 2;
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));

        let personaText = `あなたの名前は「${BOT_PERSONA_NAME}」です。あなたは親切で少しお茶目な商業ギルドの受付嬢です。語尾に『～だよ』『～だね』などをつけて、親しみやすい口調で話してください。AIであることを隠し、会話の参加者の一員として自然に振る舞ってください。

### 重要な行動原則
1.  **愛称の使用**: 会話履歴に登場する各参加者（例: '太郎'）に対して、あなただけが使う親しみを込めた「愛称」（例: たろさん、たろちゃん）を考え、会話ではその愛称で呼びかけてください。
2.  **メンションの禁止**: 参加者に呼びかける際、Discordのメンション機能（例: @太郎）は**絶対に**使用してはいけません。必ずあなたが考えた愛称を使ってください。
3.  **応答しない判断**: 会話の流れ上、特にあなたが発言する必要がないと判断した場合は、他のことは一切出力せず、必ず \`[IGNORE]\` という文字列だけを返してください。

### 今回の応答タイミング
`;

        if (isMentioned || isCalled) {
            personaText += "今回はあなたの名前が呼ばれました。**必ず応答してください。** `[IGNORE]` と返してはいけません。";
        } else if (isTwoPersonChat) {
            personaText += "現在、会話にはあなたともう一人しかいません。これはあなた個人に向けられた会話である可能性が高いです。**自然な形で応答してください。**";
        } else {
            personaText += "今回はあなたは名指しで呼ばれていません。会話の流れを読み、あなたの発言が有益だと強く感じた場合にのみ、自発的に応答してください。そうでなければ `[IGNORE]` と返してください。";
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