import {
    CacheType,
    Interaction,
    ChatInputCommandInteraction,
    ButtonInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Message
} from 'discord.js';
import { classDetails, menuConfig, generateDynamicMenu, MenuPageData, MenuPageButton } from '../utils/interactionConfig';
import { logUserAction, loadMenuData } from './sheetClient';

// コンテキストの型定義
export interface InteractionContext {
    botVersion: string;
    updateHistoryCallback: (interaction: Interaction, userActionText: string, replyText: string) => void;
}

// パスコードの状態定義
interface PasscodeState {
    value: string;
    mode: 'id' | 'pass';
}

const passcodeStates = new Map<string, PasscodeState>();

/**
 * インタラクションを一括処理するメインハンドラ
 * @param {Interaction} interaction - Discord Interaction Object
 * @param {Object} context - { botVersion, updateHistoryCallback, botPersonaName }
 */
export async function handleInteraction(interaction: Interaction, context: InteractionContext): Promise<void> {
    const { botVersion, updateHistoryCallback } = context;

    // --- Slash Commands ---
    if (interaction.isChatInputCommand()) {
        const commandName = interaction.commandName;
        try {
            await interaction.deferReply({ ephemeral: commandName !== 'menu' });

            if (commandName === 'ping') {
                await interaction.editReply('Pong!');
            }
            else if (commandName === 'ver') {
                await interaction.editReply(`現在の私のバージョンは ${botVersion} です`);
            }
            else if (commandName === 'menu') {
                const allMenuData = await loadMenuData();
                const mainPage = allMenuData ? allMenuData['main'] : null;

                if (mainPage) {
                    const components = generateDynamicMenu(mainPage);
                    const description = mainPage.descriptionTemplate.replace('{{UserName}}', interaction.user.displayName);

                    const embeds: EmbedBuilder[] = [];

                    if (mainPage.imageURL) {
                        const imageEmbed = new EmbedBuilder().setImage(mainPage.imageURL);
                        embeds.push(imageEmbed);
                    }

                    const textEmbed = new EmbedBuilder()
                        .setDescription(description)
                        .setColor((mainPage.embedColor as any) || '#0099ff');

                    if (mainPage.title) textEmbed.setTitle(mainPage.title);
                    if (mainPage.thumbnailURL) textEmbed.setThumbnail(mainPage.thumbnailURL);

                    embeds.push(textEmbed);

                    await interaction.editReply({
                        content: '',
                        embeds: embeds,
                        components: components
                    });
                } else {
                    await interaction.editReply({
                        content: 'いらっしゃいませ！なにをお望みですか？\n(メニューデータの読み込みに失敗しました)',
                        components: [menuConfig.mainMenu()]
                    });
                }
            }
        } catch (error) {
            console.error(`Error handling slash command ${commandName}:`, error);
        }
        return;
    }

    // --- Button Interactions ---
    if (interaction.isButton()) {
        const customId = interaction.customId;
        const [action, subAction, subject] = customId.split('_');
        try {
            if (action === 'menu') {
                if (subAction === 'nav') {
                    // ページ遷移: menu_nav_{pageId}
                    await handleDynamicNavigation(interaction, subject);
                } else if (subAction === 'process') {
                    // 具体的な処理: menu_process_{processKey}
                    await handleDynamicProcess(interaction, subject, updateHistoryCallback);
                } else {
                    // レガシー互換または特定処理
                    await handleMainMenu(interaction, subAction, updateHistoryCallback);
                }
            }
            else if (action === 'class') {
                await handleClassMenu(interaction, subAction, subject, updateHistoryCallback);
            }
            else if (action === 'pass') {
                // pass_0, pass_back, pass_enter など
                // subAction がキーになる
                const key = subAction;
                await handlePasscodeInteraction(interaction, key, updateHistoryCallback);
            }
        } catch (error) {
            console.error('Error in button interaction:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'すみません、エラーが発生しました。', ephemeral: true }).catch(() => { });
            } else {
                await interaction.editReply({ content: 'すみません、エラーが発生しました。', components: [] }).catch(() => { });
            }
        }
    }
}

/**
 * 動的メニューのページ遷移処理
 */
async function handleDynamicNavigation(interaction: ButtonInteraction, targetPageId: string): Promise<void> {
    const allMenuData = await loadMenuData();
    const targetPage = allMenuData ? allMenuData[targetPageId] : null;

    if (!targetPage) {
        await interaction.reply({ content: 'メニューが見つかりません。', ephemeral: true });
        return;
    }

    const components = generateDynamicMenu(targetPage);
    const description = targetPage.descriptionTemplate.replace('{{UserName}}', interaction.user.displayName);

    const embeds: EmbedBuilder[] = [];

    if (targetPage.imageURL) {
        const imageEmbed = new EmbedBuilder().setImage(targetPage.imageURL);
        embeds.push(imageEmbed);
    }

    const textEmbed = new EmbedBuilder()
        .setDescription(description)
        .setColor((targetPage.embedColor as any) || '#0099ff');

    if (targetPage.title) textEmbed.setTitle(targetPage.title);
    if (targetPage.thumbnailURL) textEmbed.setThumbnail(targetPage.thumbnailURL);

    embeds.push(textEmbed);

    await interaction.update({
        content: '',
        embeds: embeds,
        components: components
    });
}

/**
 * 動的メニューからの処理実行
 */
async function handleDynamicProcess(
    interaction: ButtonInteraction,
    processKey: string,
    updateHistoryCallback: InteractionContext['updateHistoryCallback']
): Promise<void> {

    // 登録画面へ
    if (processKey === 'register') {
        const { content, components } = menuConfig.classList();
        await interaction.update({ content, components });
        return;
    }

    // 終了処理
    if (processKey === 'leave') {
        await interaction.deferReply({ ephemeral: true });
        const replyText = '承知いたしました。またお越しくださいませ。';
        await interaction.editReply({ content: replyText });

        if (updateHistoryCallback) updateHistoryCallback(interaction, '「帰る」を選んだ', replyText);
        await logUserAction(interaction.user, '「帰る」を選んだ', replyText);

        const originalMessage = interaction.message;
        // 型アサーション: メッセージコンポーネントを安全に操作
        const disabledRow = ActionRowBuilder.from(originalMessage.components[0] as any);
        disabledRow.components.forEach((component: any) => component.setDisabled(true));
        // ActionRowBuilder<ButtonBuilder> としてキャストして渡す
        await originalMessage.edit({ components: [disabledRow as ActionRowBuilder<ButtonBuilder>] });
        return;
    }

    // パスコード入力開始
    if (processKey === 'inputPass') {
        const userActionText = '「パスコード入力」を開始した';
        passcodeStates.set(interaction.user.id, { value: "", mode: "pass" });

        await interaction.update({
            content: "パスコードを入力してください\n# ",
            embeds: [],
            components: menuConfig.passcodeKeypad()
        });

        if (updateHistoryCallback) updateHistoryCallback(interaction, userActionText, "パスコード入力画面を表示");
        await logUserAction(interaction.user, userActionText, "パスコード入力画面を表示");
        return;
    }

    // ID入力開始
    if (processKey === 'inputID') {
        const userActionText = '「ID入力」を開始した';
        passcodeStates.set(interaction.user.id, { value: "", mode: "id" });

        await interaction.update({
            content: "IDを入力してください\n# ",
            embeds: [],
            components: menuConfig.passcodeKeypad()
        });

        if (updateHistoryCallback) updateHistoryCallback(interaction, userActionText, "ID入力画面を表示");
        await logUserAction(interaction.user, userActionText, "ID入力画面を表示");
        return;
    }

    // その他の機能
    await interaction.deferReply({ ephemeral: true });

    let userActionText = '', replyText = '';

    switch (processKey) {
        case 'status': userActionText = '「ステータス」を選んだ'; replyText = 'ステータス確認ですね。（未実装）'; break;
        case 'inventory': userActionText = '「持ち物」を選んだ'; replyText = '持ち物確認ですね。（未実装）'; break;
        case 'market': userActionText = '「相場情報」を選んだ'; replyText = '現在の市場相場です。（未実装）'; break;
        case 'board': userActionText = '「依頼掲示板」を選んだ'; replyText = '掲示板を確認します。（未実装）'; break;
        case 'shop': userActionText = '「買い物」を選んだ'; replyText = '何を買いますか？（未実装）'; break;
        case 'sell': userActionText = '「買取り」を選んだ'; replyText = '何を売却しますか？（未実装）'; break;
        default:
            userActionText = `「${processKey}」を選んだ`;
            replyText = 'その機能はまだ準備中です。';
            break;
    }

    await interaction.editReply({ content: replyText });

    if (updateHistoryCallback) updateHistoryCallback(interaction, userActionText, replyText);
    await logUserAction(interaction.user, userActionText, replyText);
}

/**
 * メインメニューのボタン処理（レガシー互換用）
 */
async function handleMainMenu(
    interaction: ButtonInteraction,
    subAction: string,
    updateHistoryCallback: InteractionContext['updateHistoryCallback']
): Promise<void> {

    if (subAction === 'register') {
        const { content, components } = menuConfig.classList();
        await interaction.update({ content, components });
        return;
    }
    if (subAction === 'return') {
        await interaction.update({
            content: 'いらっしゃいませ！なにをお望みですか？',
            components: [menuConfig.mainMenu()]
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    let userActionText = '', replyText = '';
    switch (subAction) {
        case 'status':
            userActionText = '「ステータスを確認する」を選んだ';
            replyText = 'はい、ステータスの確認ですね。承知いたしました。（以降の処理は未実装です）';
            break;
        case 'board':
            userActionText = '「依頼掲示板を見る」を選んだ';
            replyText = 'はい、こちらが依頼掲示板です。（以降の処理は未実装です）';
            break;
        case 'leave':
            userActionText = '「帰る」を選んだ';
            replyText = '承知いたしました。またお越しくださいませ。';
            break;
        default:
            await interaction.deleteReply();
            return;
    }

    await interaction.editReply({ content: replyText });

    if (updateHistoryCallback) {
        updateHistoryCallback(interaction, userActionText, replyText);
    }

    await logUserAction(interaction.user, userActionText, replyText);

    const originalMessage = interaction.message;
    const disabledRow = ActionRowBuilder.from(originalMessage.components[0] as any);
    disabledRow.components.forEach((component: any) => component.setDisabled(true));
    await originalMessage.edit({ components: [disabledRow as ActionRowBuilder<ButtonBuilder>] });
}

/**
 * クラス選択メニューのボタン処理
 */
async function handleClassMenu(
    interaction: ButtonInteraction,
    subAction: string,
    subject: string,
    updateHistoryCallback: InteractionContext['updateHistoryCallback']
): Promise<void> {

    if (subAction === 'return' && subject === 'list') {
        const { content, components } = menuConfig.classList();
        await interaction.update({ content, components });
        return;
    }

    if (subAction === 'details') {
        const classInfo = classDetails[subject];
        if (!classInfo) return;

        const row = menuConfig.classDetailsButtons(subject, classInfo.name);
        await interaction.update({ content: classInfo.description, components: [row] });
        return;
    }

    if (subAction === 'select') {
        await interaction.deferReply({ ephemeral: true });
        const classInfo = classDetails[subject];
        if (!classInfo) return;

        const userActionText = `クラスとして「${classInfo.name}」を最終選択した`;
        const replyText = `はい、あなたのクラスは「${classInfo.name}」に決定しました。ようこそ！（以降の処理は未実装です）`;

        await interaction.editReply({ content: replyText });

        if (updateHistoryCallback) {
            updateHistoryCallback(interaction, userActionText, replyText);
        }

        await logUserAction(interaction.user, userActionText, replyText);

        const originalMessage = interaction.message;
        const disabledComponents = originalMessage.components.map(row => {
            const newRow = ActionRowBuilder.from(row as any);
            newRow.components.forEach((component: any) => component.setDisabled(true));
            return newRow;
        });
        // ActionRowBuilder<ButtonBuilder>[] にキャスト
        await originalMessage.edit({ components: disabledComponents as any });
    }
}

/**
 * パスコード入力のボタン処理
 */
async function handlePasscodeInteraction(
    interaction: ButtonInteraction,
    key: string,
    updateHistoryCallback: InteractionContext['updateHistoryCallback']
): Promise<void> {
    const userId = interaction.user.id;
    let state = passcodeStates.get(userId);

    // 古い形式の状態管理がもしあれば互換性維持...はTSなので今回は厳密に
    if (!state) {
        state = { value: "", mode: "pass" };
    }

    let currentCode = state.value;

    if (!isNaN(parseInt(key))) {
        if (currentCode.length < 4) {
            currentCode += key;
        }
    }
    else if (key === 'back') {
        currentCode = currentCode.slice(0, -1);
    }
    else if (key === 'enter') {
        await interaction.deferReply({ ephemeral: true });

        const label = state.mode === 'id' ? 'ID' : 'パスコード';
        const replyText = `入力された${label}: ${currentCode}\n（認証ロジックは未実装です）`;
        await interaction.editReply({ content: replyText });

        await interaction.message.edit({
            content: `${label}入力を終了しました。`,
            components: []
        });

        passcodeStates.delete(userId);

        if (updateHistoryCallback) updateHistoryCallback(interaction, `${label}「${currentCode}」を入力した`, replyText);
        await logUserAction(interaction.user, `${label}「${currentCode}」を入力した`, replyText);
        return;
    }

    state.value = currentCode;
    passcodeStates.set(userId, state);

    const isPass = (state.mode === 'pass');
    let displayCode = "";
    if (isPass) {
        displayCode = currentCode.length > 0 ? "*".repeat(currentCode.length) : "";
    } else {
        displayCode = currentCode;
    }

    const prompt = isPass ? "パスコードを入力してください" : "IDを入力してください";

    await interaction.update({
        content: `${prompt}\n# ${displayCode}`
    });
}
