require('dotenv').config();

// 使用するパッケージを@google/genaiに統一
const { GoogleGenerativeAI } = require('@google/genai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// 使用するモデルを指定（モデル名は実際の有効なものにしてください）
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const BOT_VERSION = 'v0.2.2';

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

    // Gemini 応答
    try {
        const result = await model.generateContent(command);
        const response = await result.response;
        const text = response.text();
        message.reply(text);
    } catch (error) {
        console.error('Gemini API error:', error);
        message.reply('すみません、応答に失敗しました。');
    }
});

client.login(process.env.DISCORD_TOKEN);

// Renderのスリープ対策
require('express')().listen(3000, () => console.log('Fake server running'));