require('dotenv').config();

const BOT_VERSION = 'v0.3.1'; // バージョンを更新

const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const channelHistories = new Map();
const HISTORY_TIMEOUT = 3600 * 1000;
const BOT_NAMES = ['ノエル', 'ボット', 'bot']; 

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// parseDiceCommand, rollDice 関数は変更なし
const parseDiceCommand = (input) => {
    const match = input.match(/^(\d+)d(\d+)$/);
    if (!match) return null;
    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    return { count, sides };
};

const rollDice = (count, sides) => {
    const rolls = [];
    for (let i = 0; i < count; i++) {
        rolls.push(Math.floor(Math.random() * sides) + 1);
    }
    return rolls;
};


client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const command = message.content.trim();

    // コマンド処理は変更なし
    if (command === '!ver') {
        message.reply(`現在の私のバージョンは ${BOT_VERSION} です`);
        return;
    }
    if (command === '!ping') {
        message.reply('Pong!');
        return;
    }
    const parsed = parseDiceCommand(command);
    if (parsed) {
        const { count, sides } = parsed;
        if (count > 100 || sides > 1000) {
            message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）');
            return;
        }
        const results = rollDice(count, sides);
        const total = results.reduce((a, b) => a + b, 0);
        message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
        return;
    }

    try {
        const channelId = message.channel.id;
        const now = Date.now();
        let channelHistory = channelHistories.get(channelId);

        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = {
                contents: [],
                lastTimestamp: now
            };
            channelHistories.set(channelId);
        }
        
        const userMessage = { role: 'user', parts: [{ text: `${message.author.username}: ${command}` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        // --- ★ ここからロジックを2段階に変更 ---

        // ★ STEP 1: 応答すべきかを判断するAIコール
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));

        let decisionPersonaText = `あなたはDiscordの会話を監視するAIです。会話の流れを読み、アシスタントが応答すべきか否かを判断してください。
### 判断基準
1.  **貢献可能性**: アシスタントが専門知識や情報提供で会話に大きく貢献できる場合。
2.  **円滑化**: 会話が停滞している、または議論が紛糾しており、アシスタントが介入することで円滑に進むと考えられる場合。
3.  **直接の質問**: アシスタントに向けられたと解釈できる質問がある場合。
あなたの回答は必ず \`RESPOND\` または \`IGNORE\` のどちらか一言だけにしてください。`;
        
        if (isMentioned || isCalled) {
             // 呼ばれた場合は判断不要でRESPOND
            decision = 'RESPOND';
        } else {
            const decisionResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash-lite',
                contents: channelHistory.contents,
                systemInstruction: { parts: [{ text: decisionPersonaText }] }
            });
            decision = decisionResponse.candidates?.[0]?.content?.parts?.[0]?.text.trim() || 'IGNORE';
        }
        
        // ★ IGNOREと判断されたら、ここで処理を終了
        if (decision !== 'RESPOND') {
            console.log(`[${message.channel.name}] Noel decided to ignore.`);
            return;
        }

        // ★ STEP 2: ペルソナになりきって応答を生成するAIコール
        const noelPersona = {
            parts: [{ text: "あなたの名前は「ノエル」です。あなたは親切で少しお茶目な商業ギルドの受付嬢です。語尾に『～だよ』『～だね』などをつけて、親しみやすい口調で話してください。AIであることは隠し、会話の参加者の一員として自然に振る舞ってください。" }]
        };

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: channelHistory.contents,
            systemInstruction: noelPersona
        });
        
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        if (!reply) return; // 空の応答は無視

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