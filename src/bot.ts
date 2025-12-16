import 'dotenv/config';
import { GoogleGenAI, Part } from '@google/genai';
import { Client, GatewayIntentBits, Message, MessageFlags } from 'discord.js';
import express from 'express';
import { handleInteraction } from './services/interactionHandler';
import { initSheet, loadPersonaText, loadAndFormatAllDataForAI } from './services/sheetClient';

// --- ボットの基本設定 ---
const BOT_VERSION = 'v3.10.0';
const BOT_PERSONA_NAME = 'ノエル';
const HISTORY_TIMEOUT = 3600 * 1000;
// Unused but kept for reference or future use layout
// const GUILD_MASTER_NAME = 'ギルドマスター'; 
const PARTICIPANT_TRACKING_DURATION = 10 * 60 * 1000;

// --- クライアント初期化 ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- グローバル変数 ---
interface ChannelHistory {
    contents: { role: 'user' | 'model'; parts: { text: string }[] }[];
    lastTimestamp: number;
}

const channelHistories = new Map<string, ChannelHistory>();

// channelParticipants: ChannelID -> Map<UserId, Timestamp>
const channelParticipants = new Map<string, Map<string, number>>();

// --- ヘルパー関数 ---

/**
 * ダイスコマンド（例: !2d6）を解析します。
 */
const parseDiceCommand = (input: string): { count: number; sides: number } | null => {
    const match = input.match(/^!(\d+)d(\d+)$/i);
    if (!match) return null;
    const count = parseInt(match[1], 10), sides = parseInt(match[2], 10);
    return { count, sides };
};

const rollDice = (count: number, sides: number): number[] => {
    let rolls: number[] = [];
    for (let i = 0; i < count; i++) { rolls.push(Math.floor(Math.random() * sides) + 1); }
    return rolls;
};

// --- Bot起動時処理 ---
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user?.tag} | Version: ${BOT_VERSION}`);
    await initSheet();
});

// --- メッセージ受信時処理 ---
client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    const command = message.content.trim();

    // Dice Command
    if (command.startsWith('!')) {
        const parsed = parseDiceCommand(command);
        if (parsed) {
            const { count, sides } = parsed;
            if (count > 100 || sides > 1000) {
                message.reply('ダイスの数や面数が多すぎます（上限：100個、1000面）');
            }
            else {
                const results = rollDice(count, sides);
                const total = results.reduce((a, b) => a + b, 0);
                message.reply(`🎲 ${count}d${sides} の結果: [${results.join(', ')}] → 合計: ${total}`);
            }
            return;
        }
    }

    try {
        const now = Date.now();
        const channelId = message.channel.id;

        if (!channelParticipants.has(channelId)) {
            channelParticipants.set(channelId, new Map());
        }
        const participants = channelParticipants.get(channelId)!;
        participants.set(message.author.id, now);

        // クリーンアップ
        const recentParticipants = new Set<string>();
        for (const [userId, timestamp] of participants.entries()) {
            if (now - timestamp < PARTICIPANT_TRACKING_DURATION) {
                recentParticipants.add(userId);
            } else {
                participants.delete(userId);
            }
        }
        const participantCount = recentParticipants.size;
        console.log(`[Participant Logic] Active participants: ${participantCount}`);

        const isAddressedToNoelle = message.content.includes(BOT_PERSONA_NAME) || message.mentions.has(client.user!);

        const loadedPersonaText = await loadPersonaText();
        const initialHistoryFromSheets = await loadAndFormatAllDataForAI();

        if (!initialHistoryFromSheets) {
            message.reply('ごめんなさい、ギルドの台帳が今見つからないみたい……');
            return;
        }

        let channelHistory = channelHistories.get(channelId);

        if (!channelHistory || (now - channelHistory.lastTimestamp > HISTORY_TIMEOUT)) {
            channelHistory = {
                contents: JSON.parse(JSON.stringify(initialHistoryFromSheets)),
                lastTimestamp: now
            };
            channelHistories.set(channelId, channelHistory);
        }

        const userMessage = { role: 'user' as const, parts: [{ text: `User "${message.author.displayName}": "${command}"` }] };
        channelHistory.contents.push(userMessage);
        channelHistory.lastTimestamp = now;

        let personaText = loadedPersonaText;
        if (!personaText) {
            personaText = `
### CORE DIRECTIVE: ROLE-PLAYING
You are a character named ${BOT_PERSONA_NAME}. NEVER break character. NEVER mention that you are an AI.
Your personality and all you know about the world are defined by the conversation history.
Your task is to continue the conversation naturally as your character.
You MUST respond in JAPANESE.
`;
        }

        const persona: Part = { text: personaText }; // systemInstruction needs Part or Content

        // Gemini API Request
        // Note: The SDK types might be slighty different depending on version. 
        // Adjusting to common usage for @google/genai
        const request = {
            model: 'gemini-2.5-flash-lite',
            contents: channelHistory.contents,
            systemInstruction: { parts: [persona] }
        };

        const generateContentWithRetry = async (req: any, maxRetries = 5) => {
            let lastError: any = null;
            for (let i = 0; i < maxRetries; i++) {
                try {
                    return await ai.models.generateContent(req);
                } catch (error: any) {
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

        const response = await generateContentWithRetry(request);
        const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '[IGNORE]';

        if (reply.includes('[IGNORE]')) {
            console.log('[Participant Logic] AI decided to ignore.');
            return;
        }

        if (isAddressedToNoelle) {
            console.log('[Participant Logic] Addressed to Noelle. Replying.');
        } else {
            const replyProbability = 1 / (participantCount || 1);
            if (Math.random() > replyProbability) {
                console.log(`[Participant Logic] Not replying due to probability check (${replyProbability.toFixed(2)}).`);
                return;
            }
            console.log(`[Participant Logic] Replying based on probability (${replyProbability.toFixed(2)}).`);
        }

        let finalReply = reply.trim();
        const match = finalReply.match(/^(?:"?ノエル"?:\s*)?"?(.*?)"?$/);
        if (match && match[1]) {
            finalReply = match[1].trim();
        }

        message.reply(finalReply);
        channelHistory.contents.push({ role: 'model', parts: [{ text: `${BOT_PERSONA_NAME}: "${finalReply}"` }] });
        channelHistory.lastTimestamp = now;

    } catch (error) {
        console.error('Error in messageCreate:', error);
        message.reply('あ、すみません……ちょっと考えごとをしてました！');
    }
});

// --- インタラクション（コマンド・ボタン）受信時処理 ---
client.on('interactionCreate', async interaction => {
    // 履歴更新用コールバック
    const updateHistoryCallback = (int: any, userActionText: string, replyText: string) => {
        updateInteractionHistory(int, userActionText, replyText);
    };

    const context = {
        botVersion: BOT_VERSION,
        updateHistoryCallback: updateHistoryCallback
    };

    await handleInteraction(interaction, context);
});

/**
 * インタラクション結果を会話履歴に注入
 */
function updateInteractionHistory(interaction: any, userActionText: string, replyText: string) {
    const channelId = interaction.channel.id;
    let channelHistory = channelHistories.get(channelId);
    if (!channelHistory) {
        channelHistory = { contents: [], lastTimestamp: Date.now() };
        channelHistories.set(channelId, channelHistory);
    }
    const now = Date.now();
    const userMessage = { role: 'user' as const, parts: [{ text: `User "${interaction.user.displayName}": "${userActionText}"` }] };
    channelHistory.contents.push(userMessage);
    channelHistory.lastTimestamp = now;
    const modelMessage = { role: 'model' as const, parts: [{ text: `${BOT_PERSONA_NAME}: "${replyText}"` }] };
    channelHistory.contents.push(modelMessage);
    channelHistory.lastTimestamp = now;
    console.log(`[Interaction Logic] User ${interaction.user.displayName} action: "${userActionText}". History updated.`);
}

client.login(process.env.DISCORD_TOKEN);

// --- Renderスリープ対策用Webサーバー ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`);
});
app.listen(port, () => {
    console.log(`Fake server is running on port ${port} to prevent sleep.`);
});
