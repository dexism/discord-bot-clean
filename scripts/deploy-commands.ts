import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

// 登録したいスラッシュコマンドの定義
const commands = [
    new SlashCommandBuilder()
        .setName('ver')
        .setDescription('現在のBotのバージョン情報を表示します。'),
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Botが応答可能か確認します。「Pong!」と返します。'),
    new SlashCommandBuilder()
        .setName('menu')
        .setDescription('ホームメニューを表示します。'),
].map(command => command.toJSON());

// 登録処理の実行
const token = process.env.DISCORD_TOKEN || '';
const clientId = process.env.CLIENT_ID || '';

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('... スラッシュコマンドの登録を開始します ...');

        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands }
        );

        console.log('✅ スラッシュコマンドの登録が正常に完了しました。');
    } catch (error) {
        console.error('❌ コマンドの登録中にエラーが発生しました:', error);
    }
})();
