require('dotenv').config();

const BOT_VERSION = 'v0.2.4';

const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ★ 会話履歴を保存するためのMapオブジェクトを定義
const conversationHistories = new Map();
// ★ 履歴のタイムアウト時間（1時間 = 3600秒 * 1000ミリ秒）
const HISTORY_TIMEOUT = 3600 * 1000;

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
    for (let i = 0; i < count; i++) {
        rolls.push(Math.floor(Math.random() * sides) + 1);
    }
    return rolls;
};

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const command = message.content.trim();

    // バージョン確認
    if (command === '!ver') {
        message.reply(`現在の私のバージョンは ${BOT_VERSION} です`);
        return;
    }

    // ping 応答
    if (command === '!ping') {
        message.reply('Pong!');
        return;
    }

    // ダイスロール
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

    // Gemini 2.5 応答（ver, ping, dice に該当しない場合）
    try {
        const userId = message.author.id;
        const now = Date.now();
        let userHistory = conversationHistories.get(userId);

        // 履歴が存在しない、または最後の会話から1時間以上経過している場合は履歴を初期化
        if (!userHistory || (now - userHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            userHistory = {
                contents: [],
                lastTimestamp: now
            };
            conversationHistories.set(userId, userHistory);
        }

        // 今回のユーザーの発言を履歴に追加
        userHistory.contents.push({ role: 'user', parts: [{ text: command }] });

        // --- ペルソナ設定 ---
        const persona = {
            role: "system",
            parts: [{ text: "あなたの名前は「ノエル」です。あなたは親切で少しお茶目なギルドの受付嬢です。語尾に『～だよ』『～だね』などをつけて、親しみやすい口調で話してください。" }]
        };

        // Gemini APIに会話履歴とペルソナを渡して応答を生成
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: userHistory.contents,
            systemInstruction: persona
        });

        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '応答が取得できませんでした。';

        // Botの応答も履歴に追加
        userHistory.contents.push({ role: 'model', parts: [{ text: reply }] });

        // タイムスタンプを更新
        userHistory.lastTimestamp = Date.now();

        message.reply(reply);

    } catch (error) {
        console.error('Gemini API error:', error);
        message.reply('あ、すみません……聞いてませんでした！');
    }
});

client.login(process.env.DISCORD_TOKEN);

// require('express')().listen(3000, () => console.log('Fake server running'));
require('express')().listen(process.env.PORT || 3000, () => console.log('Fake server running'));