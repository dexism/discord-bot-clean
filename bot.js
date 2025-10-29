// =agreed================================================================================
// TRPGサポートDiscordボット "ノエル" v3.8.1 (インタラクション安定化版)
// =================================================================================

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionType } = require('discord.js'); // InteractionTypeを追加
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const express = require('express');

// --- ボットの基本設定 ---
const BOT_VERSION = 'v3.8.1';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;
const GUILD_MASTER_NAME = 'ギルドマスター';
const PARTICIPANT_TRACKING_DURATION = 10 * 60 * 1000;

// (既存の loadPersonaText, loadAndFormatAllDataForAI, ヘルパー関数に変更はありません)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw';
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// (既存の loadPersonaText, loadAndFormatAllDataForAI 関数に変更はありません)
async function loadPersonaText() {
    try {
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const personaSheet = doc.sheetsByTitle['PERSONA'];
        if (!personaSheet) {
            console.warn('[Persona Loader] Sheet "PERSONA" not found. Using default persona.');
            return null;
        }
        const rows = await personaSheet.getRows();
        const headers = personaSheet.headerValues;
        const personaLines = [];
        for (const row of rows) {
            const isEnabled = row.get(headers[0]);
            if (isEnabled === true || isEnabled === 'TRUE') {
                const text = row.get(headers[1]);
                if (text) personaLines.push(text);
            }
        }
        console.log(`[Persona Loader] Successfully loaded ${personaLines.length} persona lines.`);
        return personaLines.join('\n');
    } catch (error) {
        console.error("Error loading persona from Google Sheets:", error);
        return null;
    }
}
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
        const initialHistoryWithDirectives = [];
        for (const sheet of doc.sheetsByIndex) {
            if (sheet.title === 'PERSONA') {
                console.log(`[Loader] Skipping special sheet: "${sheet.title}"`);
                continue;
            }
            console.log(`[Loader] Processing sheet: "${sheet.title}"`);
            await sheet.loadCells('A1:C1');
            const sheetEnabledValue = sheet.getCell(0, 0).value;
            if (sheetEnabledValue !== true && sheetEnabledValue !== 'TRUE') {
                console.log(`[Loader] Sheet "${sheet.title}" is disabled. Skipping.`);
                continue;
            }
            const userName = sheet.getCell(0, 1).value || GUILD_MASTER_NAME;
            const userMessageTemplate = sheet.getCell(0, 2).value;
            if (!userMessageTemplate) {
                console.warn(`[Loader] Sheet "${sheet.title}" is enabled but has no message template in C1. Skipping.`);
                continue;
            }
            const rows = await sheet.getRows();
            const headers = sheet.headerValues;
            const knowledgeLines = [];
            for (const row of rows) {
                const rowEnabledValue = row.get(headers[0]);
                if (rowEnabledValue !== true && rowEnabledValue !== 'TRUE') continue;
                const dataParts = [];
                for (let i = 1; i < headers.length; i++) {
                    const header = headers[i];
                    if (!header) continue;
                    const value = row.get(header);
                    if (value !== null && value !== undefined && value !== '') dataParts.push({ header, value });
                }
                if (dataParts.length === 0) continue;
                let line = "";
                if (dataParts.length === 1) {
                    line = `${dataParts[0].value}`;
                } else {
                    const lastPart = dataParts[dataParts.length - 1];
                    const headPartsRaw = dataParts.slice(0, dataParts.length - 1);
                    const headPartsFormatted = headPartsRaw.map(part => `${part.header}「${part.value}」`);
                    line = `${headPartsFormatted.join('の')}は、${lastPart.value}`;
                }
                knowledgeLines.push(line);
            }
            if (knowledgeLines.length > 0) {
                const knowledgeText = knowledgeLines.join('\n');
                const userMessage = userMessageTemplate + '\n' + knowledgeText;
                initialHistoryWithDirectives.push(
                    { role: 'user', parts: [{ text: `User "${userName}": "${userMessage}"` }] },
                    { role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "はい、${userName}！全て承知いたしました！"` }] }
                );
                console.log(`[Loader] Successfully loaded ${knowledgeLines.length} records from "${sheet.title}".`);
            }
        }
        console.log(`[Loader] Finished loading all data. Generated ${initialHistoryWithDirectives.length / 2} sets of memories.`);
        return initialHistoryWithDirectives;
    } catch (error) {
        console.error("Error loading game data from Google Sheets:", error);
        return null;
    }
}

const channelHistories = new Map();
const channelParticipants = new Map();

const parseDiceCommand = (input) => {
    const match = input.match(/^!(\d+)d(\d+)$/i);
    if (!match) return null;
    const count = parseInt(match[1], 10), sides = parseInt(match[2], 10);
    return { count, sides };
};

const rollDice = (count, sides) => {
    let rolls = [];
    for (let i = 0; i < count; i++) { rolls.push(Math.floor(Math.random() * sides) + 1); }
    return rolls;
};

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = message.content.trim();

    // --- コマンド判定 ---
    if (command.startsWith('!')) {
        const parsed = parseDiceCommand(command);
        if (parsed) {
            const { count, sides } = parsed;
            if (count > 100 || sides > 1000) { message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）'); }
            else {
                const results = rollDice(count, sides);
                const total = results.reduce((a, b) => a + b, 0);
                message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
            }
            return;
        }
    }

    // --- AI応答ロジック (既存のまま) ---
    try {
        // ... (AI応答ロジックは一切変更ありません) ...
    } catch (error) {
        console.error('Error in messageCreate:', error);
        message.reply('あ、すみません……ちょっと考えごとをしてました！');
    }
});

client.on('interactionCreate', async interaction => {
    // --- スラッシュコマンドの処理 (変更なし) ---
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        if (commandName === 'ping') { await interaction.reply('Pong!'); }
        else if (commandName === 'ver') { await interaction.reply(`現在の私のバージョンは ${BOT_VERSION} です`); }
        else if (commandName === 'menu') {
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('menu_register').setLabel('キャラクターを登録する').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('menu_status').setLabel('ステータスを確認する').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('menu_board').setLabel('依頼掲示板を見る').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('menu_leave').setLabel('帰る').setStyle(ButtonStyle.Secondary)
                );
            await interaction.reply({ content: 'いらっしゃいませ！なにをお望みですか？', components: [row] });
        }
        return;
    }

    // ★★★★★【修正】ボタン処理を拡張 ★★★★★
    if (interaction.isButton()) {
        // customIdに応じて処理を振り分ける
        const [action, subAction] = interaction.customId.split('_');

        try {
            // --- メインメニューの処理 ---
            if (action === 'menu') {
                await handleMainMenu(interaction);
            }
            // --- クラス選択メニューの処理 ---
            else if (action === 'class') {
                await handleClassSelection(interaction);
            }
        } catch (error) {
            console.error('Error in button interaction:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'すみません、エラーが発生しました。', ephemeral: true }).catch(() => {});
            } else {
                await interaction.editReply({ content: 'すみません、エラーが発生しました。', components: [] }).catch(() => {});
            }
        }
    }
});

// ★★★★★【機能追加】メインメニューのボタン処理を関数化 ★★★★★
async function handleMainMenu(interaction) {
    const { customId } = interaction;

    if (customId === 'menu_register') {
        // クラス選択メニューを作成
        const classDescription = "キャラクタークラスを選択してください。\nあなたの経営者としての第一歩は、いずれかの「プライムクラス」から始まります。\nプライムクラスは、健全で信頼される経営スタイルを体現する存在です。\nあなたの選択は、今後の戦略・人脈・評判・そして“闇”への可能性をも左右します。";
        
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('class_merchant').setLabel('商人：交渉力と市場感覚に優れ、原価を徹底的に削ることで利益を最大化する合理的経営者。信用を重んじ、実利を追求する。').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('class_artisan').setLabel('職人：技術力と創造力に秀でた職人。展示会で名声を高め、唯一無二のブランドを築く。芸術と品質を両立する匠。').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('class_leader').setLabel('リーダー：地域との絆を活かし、専属契約や地元資源の活用に長けた統率者。信用度が非常に高く、地元民からの信頼も厚い。').setStyle(ButtonStyle.Primary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('class_researcher').setLabel('研究者：技術力と創造力が突出した研究者。新素材や魔道具の融合で産業革命を起こす可能性を秘めた挑戦者。').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('class_magnate').setLabel('マグナート：複数事業を同時に展開する経済貴族。組織適応力と市場感覚に優れ、雇用・育成・投資に長ける。').setStyle(ButtonStyle.Primary)
        );
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('class_trader').setLabel('トレーダー：交渉力と市場感覚に長け、為替や関税を操る交易の達人。国際的な信頼を築き、外交と経済の架け橋となる。').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('menu_return').setLabel('キャンセルしてメニューに戻る').setStyle(ButtonStyle.Secondary)
        );

        // 元のメッセージを編集して、クラス選択メニューに差し替える
        await interaction.update({ content: classDescription, components: [row1, row2, row3] });
        return;
    }

    if (customId === 'menu_return') {
        // メインメニューを再表示
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('menu_register').setLabel('キャラクターを登録する').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('menu_status').setLabel('ステータスを確認する').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('menu_board').setLabel('依頼掲示板を見る').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('menu_leave').setLabel('帰る').setStyle(ButtonStyle.Secondary)
            );
        await interaction.update({ content: 'いらっしゃいませ！なにをお望みですか？', components: [row] });
        return;
    }


    await interaction.deferReply({ ephemeral: true });

    let userActionText = '';
    let replyText = '';
    switch (customId) {
        case 'menu_status':
            userActionText = '「ステータスを確認する」を選んだ';
            replyText = 'はい、ステータスの確認ですね。承知いたしました。（以降の処理は未実装です）';
            break;
        case 'menu_board':
            userActionText = '「依頼掲示板を見る」を選んだ';
            replyText = 'はい、こちらが依頼掲示板です。（以降の処理は未実装です）';
            break;
        case 'menu_leave':
            userActionText = '「帰る」を選んだ';
            replyText = '承知いたしました。またお越しくださいませ。';
            break;
        default:
            await interaction.deleteReply(); return;
    }

    await interaction.editReply({ content: replyText });
    updateInteractionHistory(interaction, userActionText, replyText); // 履歴更新処理を共通化
    const originalMessage = interaction.message;
    const disabledRow = ActionRowBuilder.from(originalMessage.components[0]);
    disabledRow.components.forEach(component => component.setDisabled(true));
    await originalMessage.edit({ components: [disabledRow] });
}


// ★★★★★【機能追加】クラス選択のボタン処理をする関数 ★★★★★
async function handleClassSelection(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const { customId } = interaction;
    let className = '';
    
    // customIdからクラス名を取得
    switch (customId) {
        case 'class_merchant': className = '商人'; break;
        case 'class_artisan': className = '職人'; break;
        case 'class_leader': className = 'リーダー'; break;
        case 'class_researcher': className = '研究者'; break;
        case 'class_magnate': className = 'マグナート'; break;
        case 'class_trader': className = 'トレーダー'; break;
        default: await interaction.deleteReply(); return;
    }

    const userActionText = `クラスとして「${className}」を選んだ`;
    const replyText = `はい、クラス「${className}」ですね。承知いたしました。（以降の処理は未実装です）`;

    await interaction.editReply({ content: replyText });
    updateInteractionHistory(interaction, userActionText, replyText);
    
    // ボタンを無効化
    const originalMessage = interaction.message;
    const disabledComponents = originalMessage.components.map(row => {
        const newRow = ActionRowBuilder.from(row);
        newRow.components.forEach(component => component.setDisabled(true));
        return newRow;
    });
    await originalMessage.edit({ components: disabledComponents });
}


// ★★★★★【機能追加】インタラクションの履歴を保存する共通関数 ★★★★★
function updateInteractionHistory(interaction, userActionText, replyText) {
    const channelId = interaction.channel.id;
    let channelHistory = channelHistories.get(channelId);
    if (!channelHistory) {
        channelHistory = { contents: [], lastTimestamp: Date.now() };
        channelHistories.set(channelId, channelHistory);
    }
    const now = Date.now();
    const userMessage = { 
        role: 'user', parts: [{ text: `User "${interaction.user.displayName}": "${userActionText}"` }] 
    };
    channelHistory.contents.push(userMessage);
    channelHistory.lastTimestamp = now;
    const modelMessage = { 
        role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "${replyText}"` }] 
    };
    channelHistory.contents.push(modelMessage);
    channelHistory.lastTimestamp = now;
    console.log(`[Interaction Logic] User ${interaction.user.displayName} action: "${userActionText}". History updated.`);
}

// (Discordボットログイン、Webサーバーのコードに変更はありません)
client.login(process.env.DISCORD_TOKEN);
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`); 
});
app.listen(port, () => { 
    console.log(`Fake server is running on port ${port} to prevent sleep.`); 
});