require('dotenv').config();

const { GoogleGenAI } = require('@google/genai'); // ← importではなく require に変更
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const BOT_VERSION = 'v0.1.2';

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
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

const { GoogleGenerativeAI } = require('@google/generative-ai');
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-light' });

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
        const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: command }] }]
        });
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '応答が取得できませんでした。';
        message.reply(reply);
    } catch (error) {
        console.error('Gemini API error:', error);
        message.reply('すみません、応答に失敗しました。');
    }
});

client.login(process.env.DISCORD_TOKEN);

require('express')().listen(3000, () => console.log('Fake server running'));