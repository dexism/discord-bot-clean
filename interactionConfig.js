const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * クラス（職業）の詳細データ定義
 */
const classDetails = {
    merchant: {
        name: '商人',
        description: "## **商人**\n交渉力と市場感覚に優れ、原価を徹底的に削ることで利益を最大化する**合理的経営者**。信用を重んじ、実利を追求します。"
    },
    artisan: {
        name: '職人',
        description: "## **職人**\n技術力と創造力に秀でた職人。展示会で名声を高め、唯一無二のブランドを築きます。**芸術と品質を両立する匠**です。"
    },
    leader: {
        name: 'リーダー',
        description: "## **リーダー**\n地域との絆を活かし、専属契約や地元資源の活用に長けた**統率者**。信用度が非常に高く、地元民からの信頼も厚いのが特徴です。"
    },
    engineer: {
        name: 'エンジニア',
        description: "## **エンジニア**\n技術力と創造力が突出した研究者。新素材や魔道具の融合で産業革命を起こす可能性を秘めた**挑戦者**です。"
    },
    magnate: {
        name: 'マグナート',
        description: "## **マグナート**\n複数事業を同時に展開する**経済貴族**。組織適応力と市場感覚に優れ、雇用・育成・投資に長けています。"
    },
    trader: {
        name: 'トレーダー',
        description: "## **トレーダー**\n交渉力と市場感覚に長け、為替や関税を操る**交易の達人**。国際的な信頼を築き、外交と経済の架け橋となります。"
    },
};

/**
 * 汎用的なボタン生成ヘルパー
 */
const createButton = (id, label, style = ButtonStyle.Primary) => {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
};

/**
 * 動的なメニューデータを元にActionRow配列を生成します。
 * @param {Object} menuPageData - loadMenuData() で取得した特定ページのデータ
 * @returns {Array<ActionRowBuilder>}
 */
const generateDynamicMenu = (menuPageData) => {
    if (!menuPageData || !menuPageData.buttons) return [];

    const rows = {};
    menuPageData.buttons.forEach(btn => {
        const rowIndex = btn.row || 1;
        if (!rows[rowIndex]) rows[rowIndex] = new ActionRowBuilder();

        if (btn.actionType === 'LINK') {
            // LINKボタンは customId を持たず、URLを持つ
            customId = null;
        } else if (btn.actionType === 'NAVIGATE') {
            customId = `menu_nav_${btn.target}`;
        } else {
            // PROCESS or EXIT
            customId = `menu_process_${btn.target}`;
        }

        const buttonStyle = btn.actionType === 'LINK' ? ButtonStyle.Link : (ButtonStyle[btn.style] || ButtonStyle.Primary);

        let buttonComponent = new ButtonBuilder().setLabel(btn.label).setStyle(buttonStyle);

        if (btn.actionType === 'LINK') {
            buttonComponent.setURL(btn.target);
        } else {
            buttonComponent.setCustomId(customId);
        }

        rows[rowIndex].addComponents(buttonComponent);
    });

    // 行番号順にソートして配列化
    return Object.keys(rows).sort().map(key => rows[key]);
};

/**
 * メニュー構成定義
 * 各機能へのアクセサを提供
 */
const menuConfig = {
    // メニュー初期表示のボタン群
    mainMenu: () => {
        return new ActionRowBuilder().addComponents(
            createButton('menu_register', 'キャラクターを登録する', ButtonStyle.Success),
            createButton('menu_status', 'ステータスを確認する', ButtonStyle.Primary),
            createButton('menu_board', '依頼掲示板を見る', ButtonStyle.Primary),
            createButton('menu_leave', '帰る', ButtonStyle.Secondary)
        );
    },

    // クラス選択リストの表示用コンポーネント
    classList: () => {
        const content = "## **キャラクタークラス選択**\nあなたの経営者としての第一歩は、いずれかの「プライムクラス」から始まります。\nプライムクラスは、健全で信頼される経営スタイルを体現する存在です。\nあなたの選択は、今後の戦略・人脈・評判・そして“闇”への可能性をも左右します。\n\n**詳しく知りたいクラスを選択してください。**";
        const row1 = new ActionRowBuilder().addComponents(
            createButton('class_details_merchant', '商人について詳しく聞く', ButtonStyle.Primary),
            createButton('class_details_artisan', '職人について詳しく聞く', ButtonStyle.Primary),
            createButton('class_details_leader', 'リーダーについて詳しく聞く', ButtonStyle.Primary),
        );
        const row2 = new ActionRowBuilder().addComponents(
            createButton('class_details_engineer', 'エンジニアについて詳しく聞く', ButtonStyle.Primary),
            createButton('class_details_magnate', 'マグナートについて詳しく聞く', ButtonStyle.Primary),
            createButton('class_details_trader', 'トレーダーについて詳しく聞く', ButtonStyle.Primary),
        );
        const row3 = new ActionRowBuilder().addComponents(
            createButton('menu_return', 'メインメニューに戻る', ButtonStyle.Secondary)
        );
        return { content, components: [row1, row2, row3] };
    },

    // クラス詳細表示時のボタン群
    classDetailsButtons: (subject, className) => {
        return new ActionRowBuilder().addComponents(
            createButton(`class_select_${subject}`, `${className}を選択する`, ButtonStyle.Success),
            createButton('class_return_list', '選択メニューに戻る', ButtonStyle.Secondary)
        );
    }
};

module.exports = {
    classDetails,
    menuConfig,
    generateDynamicMenu
};

