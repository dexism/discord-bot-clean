require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', message => {
  if (message.content === '!ping') {
    message.reply('Pong!');
  }
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

client.on('messageCreate', message => {
  if (message.author.bot) return;

  const command = message.content.trim();
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
  }
});

client.login(process.env.DISCORD_TOKEN);