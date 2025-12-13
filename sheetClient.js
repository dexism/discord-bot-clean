require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = '1ZnpNdPhm_Q0IYgZAVFQa5Fls7vjLByGb3nVqwSRgBaw';
const GUILD_MASTER_NAME = 'ギルドマスター';
const BOT_PERSONA_NAME = 'ノエル';

// 認証情報の準備
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// メニュー定義キャッシュ
let cachedMenuData = null;
let lastMenuLoadTime = 0;
const MENU_CACHE_DURATION = 60 * 1000; // 1分間キャッシュ

/**
 * Googleスプレッドシートの初期化（ロード）
 */
async function initSheet() {
    try {
        await doc.loadInfo();
        console.log(`[SheetClient] Connected to spreadsheet: ${doc.title}`);
    } catch (error) {
        console.error("[SheetClient] Failed to load spreadsheet info:", error);
    }
}

/**
 * Googleスプレッドシートの 'PERSONA' シートからボットの人格（システムプロンプト）を読み込みます。
 */
async function loadPersonaText() {
    try {
        await doc.loadInfo(); // 念のためロード
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

/**
 * Googleスプレッドシートの全シート（PERSONAおよびUSER_で始まるシート以外）から知見データを読み込み、
 * AIのコンテキスト（会話履歴形式）に整形して返します。
 */
async function loadAndFormatAllDataForAI() {
    try {
        await doc.loadInfo();
        const initialHistoryWithDirectives = [];
        for (const sheet of doc.sheetsByIndex) {
            // 除外対象のシート
            if (sheet.title === 'PERSONA') {
                continue;
            }
            if (sheet.title.startsWith('USER_')) {
                console.log(`[Loader] Skipping user log sheet: "${sheet.title}"`);
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

/**
 * ユーザーのアクションを個別のシートにログとして記録します。
 * シート名: USER_{discordUserId}
 * ヘッダー: Timestamp, User, Action, Response
 */
async function logUserAction(user, actionText, responseText) {
    try {
        const sheetTitle = `USER_${user.id}`;
        let userSheet = doc.sheetsByTitle[sheetTitle];

        if (!userSheet) {
            console.log(`[Logger] Creating new sheet for user: ${sheetTitle}`);
            userSheet = await doc.addSheet({ headerValues: ['Timestamp', 'UserName', 'Action', 'Response'], title: sheetTitle });
        }

        const timestamp = new Date().toISOString();
        await userSheet.addRow({
            Timestamp: timestamp,
            UserName: user.tag || user.displayName,
            Action: actionText,
            Response: responseText
        });
        console.log(`[Logger] Logged action to ${sheetTitle}`);

    } catch (error) {
        console.error(`[Logger] Failed to log action for user ${user.id}:`, error);
    }
}

/**
 * MENU_DEF シートからメニュー定義を読み込みます。
 * キャッシュ機能付き（1分間）。
 */
async function loadMenuData() {
    try {
        const now = Date.now();
        if (cachedMenuData && (now - lastMenuLoadTime < MENU_CACHE_DURATION)) {
            return cachedMenuData;
        }

        await doc.loadInfo();
        let menuSheet = doc.sheetsByTitle['MENU_DEF'];

        // シートが無い場合は作成してテンプレートを入れる（初回用）
        if (!menuSheet) {
            console.log('[Menu Loader] Creating MENU_DEF sheet...');
            menuSheet = await doc.addSheet({ 
                headerValues: ['PageID', 'Title', 'DescriptionTemplate', 'ButtonLabel', 'ButtonStyle', 'ActionType', 'Target', 'Row', 'ImageURL', 'ThumbnailURL', 'EmbedColor'],
                title: 'MENU_DEF' 
            });
            // 初期データ投入
            await menuSheet.addRows([
                { PageID: 'main', Title: 'メインメニュー', DescriptionTemplate: 'おかえりなさい {{UserName}} さん！\n今日は何をしますか？', ButtonLabel: 'キャラクター登録', ButtonStyle: 'Success', ActionType: 'PROCESS', Target: 'register', Row: 1, EmbedColor: '#00AAFF' },
                { PageID: 'main', Title: 'メインメニュー', DescriptionTemplate: 'おかえりなさい {{UserName}} さん！\n今日は何をしますか？', ButtonLabel: 'ステータス', ButtonStyle: 'Primary', ActionType: 'PROCESS', Target: 'status', Row: 1 },
                { PageID: 'main', Title: 'メインメニュー', DescriptionTemplate: 'おかえりなさい {{UserName}} さん！\n今日は何をしますか？', ButtonLabel: '持ち物', ButtonStyle: 'Primary', ActionType: 'PROCESS', Target: 'inventory', Row: 1 },
                { PageID: 'main', Title: 'メインメニュー', DescriptionTemplate: 'おかえりなさい {{UserName}} さん！\n今日は何をしますか？', ButtonLabel: 'ギルド', ButtonStyle: 'Primary', ActionType: 'NAVIGATE', Target: 'guild', Row: 2 },
                { PageID: 'main', Title: 'メインメニュー', DescriptionTemplate: 'おかえりなさい {{UserName}} さん！\n今日は何をしますか？', ButtonLabel: 'ヘルプ', ButtonStyle: 'Link', ActionType: 'LINK', Target: 'https://discord.com', Row: 3 },
                { PageID: 'main', Title: 'メインメニュー', DescriptionTemplate: 'おかえりなさい {{UserName}} さん！\n今日は何をしますか？', ButtonLabel: '終了', ButtonStyle: 'Secondary', ActionType: 'PROCESS', Target: 'leave', Row: 3 },
                { PageID: 'guild', Title: 'ギルド', DescriptionTemplate: 'いらっしゃい {{UserName}} さん！\n何かお手伝いしましょうか？', ButtonLabel: '相場情報', ButtonStyle: 'Primary', ActionType: 'PROCESS', Target: 'market', Row: 1, EmbedColor: '#FFAA00' },
                { PageID: 'guild', Title: 'ギルド', DescriptionTemplate: 'いらっしゃい {{UserName}} さん！\n何かお手伝いしましょうか？', ButtonLabel: '依頼掲示板', ButtonStyle: 'Primary', ActionType: 'PROCESS', Target: 'board', Row: 1 },
                { PageID: 'guild', Title: 'ギルド', DescriptionTemplate: 'いらっしゃい {{UserName}} さん！\n何かお手伝いしましょうか？', ButtonLabel: '買い物', ButtonStyle: 'Primary', ActionType: 'PROCESS', Target: 'shop', Row: 2 },
                { PageID: 'guild', Title: 'ギルド', DescriptionTemplate: 'いらっしゃい {{UserName}} さん！\n何かお手伝いしましょうか？', ButtonLabel: '買取りカウンター', ButtonStyle: 'Primary', ActionType: 'PROCESS', Target: 'sell', Row: 2 },
                { PageID: 'guild', Title: 'ギルド', DescriptionTemplate: 'いらっしゃい {{UserName}} さん！\n何かお手伝いしましょうか？', ButtonLabel: '帰る', ButtonStyle: 'Secondary', ActionType: 'NAVIGATE', Target: 'main', Row: 3 }
            ]);
            console.log('[Menu Loader] Created default MENU_DEF data.');
        }

        const rows = await menuSheet.getRows();
        const headers = menuSheet.headerValues;

        const menuMap = {};

        for (const row of rows) {
            const pageId = row.get('PageID');
            if (!pageId) continue;

            if (!menuMap[pageId]) {
                menuMap[pageId] = {
                    title: row.get('Title') || '',
                    descriptionTemplate: row.get('DescriptionTemplate') || '',
                    imageURL: row.get('ImageURL') || '',
                    thumbnailURL: row.get('ThumbnailURL') || '',
                    embedColor: row.get('EmbedColor') || '',
                    buttons: []
                };
            }

            const label = row.get('ButtonLabel');
            if (label) {
                menuMap[pageId].buttons.push({
                    label: label,
                    style: row.get('ButtonStyle') || 'Primary',
                    actionType: row.get('ActionType') || 'PROCESS',
                    target: row.get('Target'),
                    row: parseInt(row.get('Row') || '1', 10)
                });
            }
        }

        cachedMenuData = menuMap;
        lastMenuLoadTime = now;
        console.log(`[Menu Loader] Loaded menu configuration for ${Object.keys(menuMap).length} pages.`);
        return menuMap;

    } catch (error) {
        console.error("Error loading menu data:", error);
        return null;
    }
}

module.exports = {
    initSheet,
    loadPersonaText,
    loadAndFormatAllDataForAI,
    logUserAction,
    loadMenuData
};
