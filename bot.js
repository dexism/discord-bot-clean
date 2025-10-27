require('dotenv').config();

const BOT_VERSION = 'v0.3.0'; // 機能追加のためバージョンを更新

const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ★ ユーザーごと → チャンネルごとの会話履歴に変更
const channelHistories = new Map();
const HISTORY_TIMEOUT = 3600 * 1000; // 1時間

// ★ ボットの名前を設定。この名前がメッセージに含まれていると反応します。
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

        // チャンネルの履歴が古い、または存在しない場合は初期化
        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = {
                contents: [],
                lastTimestamp: now
            };
            channelHistories.set(channelId, channelHistory);
        }
        
        // ★ ユーザーの発言をまず履歴に追加
        channelHistory.contents.push({ role: 'user', parts: [{ text: command }] });
        channelHistory.lastTimestamp = now;


        // --- ★ ここから応答判断とペルソナ設定のロジック ---

        // ★ ボットが呼ばれたかどうかを判定
        const isMentioned = message.mentions.has(client.user.id);
        const isCalled = BOT_NAMES.some(name => command.toLowerCase().includes(name.toLowerCase()));
        
        // ★ ペルソナ（システム命令）を設定
        let personaText = `あなたの名前は「ノエル」です。あなたは親切で少しお茶目な商業ギルドの受付嬢です。語尾に『～だよ』『～だね』などをつけて、親しみやすい口調で話してください。
あなたは、Discordチャンネルに参加しています。会話全体の文脈を理解し、複数の人間が参加するグループディスカッションをサポートしてください。
### 行動原則
1.  **受動的な参加**: 基本的に会話を静観し、自分から積極的に会話を始めることはありません。
2.  **応答タイミング**: 会話の流れから、あなたが専門的な知識で大きく貢献できる、または会話を円滑に進めるために有益な発言ができると判断した場合に限り、自発的に発言してください。
3.  **応答しない場合**: 上記の条件を満たさず、応答する必要がないと判断した場合は、他のことは一切出力せず、必ず \`[IGNORE]\` という文字列だけを返してください。
4.  **自然な対話**: 応答する際は、AIであることを強調せず、会話の参加者の一員として自然に振る舞ってください。`;

        // ★ メンションまたは名前で呼ばれた場合は、必ず応答するように指示を追加
        if (isMentioned || isCalled) {
            personaText += "\n\n### 追加指示\n今回はあなた個人が名指しで呼ばれました。**必ず応答してください。** `[IGNORE]` と返してはいけません。";
        }

        const persona = {
            parts: [{ text: personaText }]
        };

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: channelHistory.contents,
            systemInstruction: persona
        });
        
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // ★ AIが応答しないと判断した場合は、ここで処理を終了
        if (reply.trim() === '[IGNORE]') {
            console.log(`[${message.channel.name}] Gemini decided to ignore the conversation.`);
            // ユーザーの発言は履歴に残っているが、ボットの応答は追加しない
            return;
        }

        // ★ 応答を送信し、ボットの発言も履歴に追加する
        message.reply(reply);
        channelHistory.contents.push({ role: 'model', parts: [{ text: reply }] });
        channelHistory.lastTimestamp = Date.now();

    } catch (error) {
        console.error('Gemini API error:', error);
        message.reply('あ、すみません……聞いてませんでした！');
    }
});

client.login(process.env.DISCORD_TOKEN);

require('express')().listen(process.env.PORT || 3000, () => console.log('Fake server running'));