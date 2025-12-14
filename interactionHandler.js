const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { classDetails, menuConfig, generateDynamicMenu } = require('./interactionConfig');
const { logUserAction, loadMenuData } = require('./sheetClient');

// Botのバージョン（bot.jsから渡すか、共有設定にするのが理想だが、引数で受け取る形を想定）
// ここでは簡易的に定数として定義、または必要に応じて引数で受け取る設計にする
// 今回は bot.js 側でハンドラ呼び出し時に必要なテキストは渡す想定で実装するか、
// あるいはここでインポート済みの定数を使う。
// ※ bot.js の BOT_VERSION と同期させるため、handleInteraction の context に version を含める設計にします。

// パスコード入力状態管理 { userId: "1234" }
const passcodeStates = new Map();

/**
 * インタラクションを一括処理するメインハンドラ
 * @param {Interaction} interaction - Discord Interaction Object
 * @param {Object} context - { botVersion, updateHistoryCallback, botPersonaName }
 */
async function handleInteraction(interaction, context) {
    const { botVersion, updateHistoryCallback } = context;

    // --- Slash Commands ---
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        try {
            // deferReply (menuのみ通常表示、他はephemeralの可能性も考慮、今回はbot.jsの仕様に合わせる)
            // 元のコード: menu以外も deferReply しているが、menuはephemeral:false、他はtrueにしていないコードだった(bot.js:326)。
            // bot.js の修正版: ephemeral: commandName !== 'menu'
            await interaction.deferReply({ ephemeral: commandName !== 'menu' });

            if (commandName === 'ping') {
                await interaction.editReply('Pong!');
            }
            else if (commandName === 'ver') {
                await interaction.editReply(`現在の私のバージョンは ${botVersion} です`);
            }
            else if (commandName === 'menu') {
                // 初回はメインメニューを表示
                // シートから最新データを取得（キャッシュ有効）
                const allMenuData = await loadMenuData();
                const mainPage = allMenuData ? allMenuData['main'] : null;

                if (mainPage) {
                    const components = generateDynamicMenu(mainPage);
                    // テンプレート変数の置換
                    const description = mainPage.descriptionTemplate.replace('{{UserName}}', interaction.user.displayName);

                    const embeds = [];

                    // 画像用Embed（上部）
                    if (mainPage.imageURL) {
                        const imageEmbed = new EmbedBuilder()
                            .setImage(mainPage.imageURL);
                        embeds.push(imageEmbed);
                    }

                    // テキスト用Embed（下部）
                    const textEmbed = new EmbedBuilder()
                        .setDescription(description)
                        .setColor(mainPage.embedColor || '#0099ff');

                    if (mainPage.title) textEmbed.setTitle(mainPage.title);
                    if (mainPage.thumbnailURL) textEmbed.setThumbnail(mainPage.thumbnailURL);

                    embeds.push(textEmbed);

                    await interaction.editReply({
                        content: '',
                        embeds: embeds,
                        components: components
                    });
                } else {
                    // フォールバック（データロード失敗時など）
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
        const [action, subAction, subject] = interaction.customId.split('_');
        try {
            if (action === 'menu') {
                if (subAction === 'nav') {
                    // ページ遷移: menu_nav_{pageId}
                    await handleDynamicNavigation(interaction, subject, updateHistoryCallback);
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
                await handlePasscodeInteraction(interaction, subAction, updateHistoryCallback);
            }
        } catch (error) {
            console.error('Error in button interaction:', error);
            // エラー時の安全なリプライ
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
async function handleDynamicNavigation(interaction, targetPageId, updateHistoryCallback) {
    const allMenuData = await loadMenuData();
    const targetPage = allMenuData ? allMenuData[targetPageId] : null;

    if (!targetPage) {
        await interaction.reply({ content: 'メニューが見つかりません。', ephemeral: true });
        return;
    }

    const components = generateDynamicMenu(targetPage);
    const description = targetPage.descriptionTemplate.replace('{{UserName}}', interaction.user.displayName);

    const embeds = [];

    // 画像用Embed（上部）
    if (targetPage.imageURL) {
        const imageEmbed = new EmbedBuilder()
            .setImage(targetPage.imageURL);
        embeds.push(imageEmbed);
    }

    // テキスト用Embed（下部）
    const textEmbed = new EmbedBuilder()
        .setDescription(description)
        .setColor(targetPage.embedColor || '#0099ff');

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
async function handleDynamicProcess(interaction, processKey, updateHistoryCallback) {
    // 登録画面へ（既存ロジックへのブリッジ）
    if (processKey === 'register') {
        await interaction.update(menuConfig.classList());
        return;
    }

    // 終了処理
    if (processKey === 'leave') {
        await interaction.deferReply({ ephemeral: true });
        const replyText = '承知いたしました。またお越しくださいませ。';
        await interaction.editReply({ content: replyText });

        // ログ記録
        if (updateHistoryCallback) updateHistoryCallback(interaction, '「帰る」を選んだ', replyText);
        await logUserAction(interaction.user, '「帰る」を選んだ', replyText);

        // ボタン無効化
        const originalMessage = interaction.message;
        const disabledRow = ActionRowBuilder.from(originalMessage.components[0]);
        disabledRow.components.forEach(component => component.setDisabled(true));
        await originalMessage.edit({ components: [disabledRow] });
        return;
    }

    // パスコード入力開始
    if (processKey === 'inputPass') {
        const userActionText = '「パスコード入力」を開始した';
        // 状態初期化
        passcodeStates.set(interaction.user.id, "");

        // UI送信
        await interaction.update({
            content: "パスコードを入力してください\n`#`",
            embeds: [],
            components: menuConfig.passcodeKeypad()
        });

        if (updateHistoryCallback) updateHistoryCallback(interaction, userActionText, "パスコード入力画面を表示");
        await logUserAction(interaction.user, userActionText, "パスコード入力画面を表示");
        return;
    }

    // その他の未実装機能など
    await interaction.deferReply({ ephemeral: true });

    let userActionText = '', replyText = '';

    // keyに応じたテキスト定義
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
 * ※動的メニュー移行後は徐々に不要になるが、コード内に残っている古い呼び出しのために残す
 */
async function handleMainMenu(interaction, subAction, updateHistoryCallback) {
    // 登録画面へ
    if (subAction === 'register') {
        await interaction.update(menuConfig.classList());
        return;
    }
    // 戻る（クラス選択などからメインメニューへ）
    if (subAction === 'return') {
        await interaction.update({
            content: 'いらっしゃいませ！なにをお望みですか？',
            components: [menuConfig.mainMenu()]
        });
        return;
    }

    // それ以外のアクション（ステータス、掲示板、帰る）→ 完了メッセージを表示してボタン無効化
    await interaction.deferReply({ ephemeral: true });

    let userActionText = '', replyText = '';
    switch (subAction) { // menu_xxx の xxx 部分
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

    // 履歴更新コールバックを実行
    if (updateHistoryCallback) {
        updateHistoryCallback(interaction, userActionText, replyText);
    }

    // スプレッドシートにログを記録
    await logUserAction(interaction.user, userActionText, replyText);

    // 元のメッセージのボタンを無効化
    const originalMessage = interaction.message;
    const disabledRow = ActionRowBuilder.from(originalMessage.components[0]);
    disabledRow.components.forEach(component => component.setDisabled(true));
    await originalMessage.edit({ components: [disabledRow] });
}

/**
 * クラス選択メニューのボタン処理
 */
async function handleClassMenu(interaction, subAction, subject, updateHistoryCallback) {
    // リストへ戻る
    if (subAction === 'return' && subject === 'list') {
        await interaction.update(menuConfig.classList());
        return;
    }

    // 詳細表示
    if (subAction === 'details') {
        const classInfo = classDetails[subject];
        if (!classInfo) return;

        const row = menuConfig.classDetailsButtons(subject, classInfo.name);
        await interaction.update({ content: classInfo.description, components: [row] });
        return;
    }

    // 選択確定
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

        // スプレッドシートにログを記録
        await logUserAction(interaction.user, userActionText, replyText);

        // 全ボタン無効化
        const originalMessage = interaction.message;
        const disabledComponents = originalMessage.components.map(row => {
            const newRow = ActionRowBuilder.from(row);
            newRow.components.forEach(component => component.setDisabled(true));
            return newRow;
        });
        await originalMessage.edit({ components: disabledComponents });
    }
}

/**
 * パスコード入力のボタン処理
 */
async function handlePasscodeInteraction(interaction, key, updateHistoryCallback) {
    const userId = interaction.user.id;
    let currentCode = passcodeStates.get(userId) || "";

    // 文字入力キー (0-9)
    if (!isNaN(key)) {
        if (currentCode.length < 4) {
            currentCode += key;
            passcodeStates.set(userId, currentCode);
        }
    }
    // Backボタン
    else if (key === 'back') {
        currentCode = currentCode.slice(0, -1);
        passcodeStates.set(userId, currentCode);
    }
    // Enterボタン
    else if (key === 'enter') {
        // パスコード確定処理
        await interaction.deferReply({ ephemeral: true });

        const replyText = `入力されたコード: ${currentCode}\n（認証ロジックは未実装です）`;
        await interaction.editReply({ content: replyText });

        // メッセージ更新（元のキーパッドを無効化または削除）
        // ここでは簡単に完了メッセージに書き換える
        await interaction.message.edit({
            content: "パスコード入力を終了しました。",
            components: []
        });

        // 状態クリア
        passcodeStates.delete(userId);

        if (updateHistoryCallback) updateHistoryCallback(interaction, `パスコード「${currentCode}」を入力した`, replyText);
        await logUserAction(interaction.user, `パスコード「${currentCode}」を入力した`, replyText);
        return;
    }

    // 表示更新
    // 入力文字数分だけ "*" を表示。空なら "#"
    const displayCode = currentCode.length > 0 ? "*".repeat(currentCode.length) : "#";
    await interaction.update({
        content: `パスコードを入力してください\n\`${displayCode}\``
    });
}


module.exports = {
    handleInteraction
};
