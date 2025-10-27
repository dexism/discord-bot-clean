// =================================================================================
// デバッグ用 最小構成コード (v1.0.1-debug1)
// =================================================================================
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

const BOT_VERSION = 'v1.0.1-debug1';
const BOT_PERSONA_NAME = 'ノエル';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('clientReady', () => {
    console.log(`[DEBUG] Logged in as ${client.user.tag} | Version: ${BOT_VERSION}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.content === '!ping') {
        message.reply('Pong! I am alive in minimal mode.');
    }
});

client.login(process.env.DISCORD_TOKEN);

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send(`Hello! I am ${BOT_PERSONA_NAME}, Bot version ${BOT_VERSION}. I am awake!`);
});
app.listen(port, () => {
  console.log(`Fake server is running on port ${port} to prevent sleep.`);
});