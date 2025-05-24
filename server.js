'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK for Firestore
const serviceAccount = require('./linebot-0511-9a3a5-firebase-adminsdk-fbsvc-4d78e33d6f.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// LINE channel configuration
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '<YOUR_CHANNEL_ACCESS_TOKEN>',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '<YOUR_CHANNEL_SECRET>'
};
const client = new line.Client(config);

const app = express();

// Middleware for verifying LINE signature and parsing webhook events
app.post('/webhook', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(event => handleEvent(event)))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

// In-memory state for ongoing language selection (per group)
const selectionState = {};

// Mapping of language codes to display names (in Chinese)
const LANG_NAME = {
    en: '英文',    // English
    th: '泰文',    // Thai
    vi: '越南文',  // Vietnamese
    id: '印尼文'   // Indonesian
};

/**
 * Helper to build the quick reply message for language selection.
 * @param {string[]} selectedLangs - Array of currently selected language codes.
 * @returns {Object} LINE message object with quickReply options.
 */
function buildLanguageQuickReply(selectedLangs) {
    const items = [];
    // Add quick reply buttons for each language option
    for (const [code, name] of Object.entries(LANG_NAME)) {
        const isSelected = selectedLangs.includes(code);
        const label = isSelected ? `${name} ✅` : name;
        // Set displayText to show the user’s action in chat:
        // If selecting (not previously selected), show "Name ✅"; if deselecting, show "Name ❎".
        const displayText = isSelected ? `${name} ❎` : `${name} ✅`;
        items.push({
            type: 'action',
            action: {
                type: 'postback',
                label: label,
                data: 'lang_' + code,
                displayText: displayText
            }
        });
    }
    // Add the "Done" button
    items.push({
        type: 'action',
        action: {
            type: 'postback',
            label: '完成',
            data: 'lang_done',
            displayText: '設定完成'
        }
    });
    // Add the "Cancel" button
    items.push({
        type: 'action',
        action: {
            type: 'postback',
            label: '取消',
            data: 'lang_cancel',
            displayText: '取消設定'
        }
    });
    // Construct the text message with quickReply
    return {
        type: 'text',
        text: '請選擇要接收的語言（可複選，選完按「完成」或「取消」）',
        quickReply: { items: items }
    };
}

/**
 * Main event handler for LINE webhook events.
 */
async function handleEvent(event) {
    const sourceType = event.source.type;  // "user", "group", or "room"
    const sourceId = event.source.groupId || event.source.roomId || event.source.userId;

    // Handle the bot being invited to a group (join event)
    if (event.type === 'join') {
        // Only proceed for group or room contexts
        if (sourceType !== 'group' && sourceType !== 'room') {
            return Promise.resolve(null);
        }
        try {
            // Retrieve any existing language settings for this group
            const docRef = db.collection('groupLanguages').doc(sourceId);
            const doc = await docRef.get();
            let currentLangs = [];
            if (doc.exists && doc.data().languages) {
                currentLangs = doc.data().languages;
            }
            // Store original and current selection in memory for this group
            selectionState[sourceId] = {
                original: [...currentLangs],
                current: [...currentLangs]
            };
            // Reply with the language selection quick reply message
            const replyMessage = buildLanguageQuickReply(currentLangs);
            await client.replyMessage(event.replyToken, replyMessage);
        } catch (err) {
            console.error('Error handling join event:', err);
            // (Optional) reply with an error message if needed
        }
        return;
    }

    // Handle a text message from a user
    if (event.type === 'message' && event.message.type === 'text') {
        const messageText = event.message.text.trim();
        // Check if this is the settings command to open language menu
        if (messageText === '!設定') {
            if (sourceType !== 'group' && sourceType !== 'room') {
                // If the bot is in a 1-on-1 chat (not group), the command is not applicable
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '此指令僅適用於群組聊天。'  // "This command is only for group chats."
                });
            }
            try {
                // Fetch current languages from Firestore (if any)
                const docRef = db.collection('groupLanguages').doc(sourceId);
                const doc = await docRef.get();
                let currentLangs = [];
                if (doc.exists && doc.data().languages) {
                    currentLangs = doc.data().languages;
                }
                // Initialize selection state for this session
                selectionState[sourceId] = {
                    original: [...currentLangs],
                    current: [...currentLangs]
                };
                // Reply with the quick reply menu for language selection
                const replyMessage = buildLanguageQuickReply(currentLangs);
                await client.replyMessage(event.replyToken, replyMessage);
            } catch (err) {
                console.error('Error handling !設定 command:', err);
            }
            return;
        }

        // Otherwise, handle other text messages (DeepSeek translation, etc.)
        try {
            // **DeepSeek Translation & other features (preserve original behavior)** 
            // (Pseudo-code/example integration; this should be replaced with actual logic)
            if ((sourceType === 'group' || sourceType === 'room') && sourceId) {
                // If group has languages configured, auto-translate the user message into those languages
                const doc = await db.collection('groupLanguages').doc(sourceId).get();
                if (doc.exists) {
                    const targetLangs = doc.data().languages || [];
                    if (targetLangs.length > 0) {
                        // Call the DeepSeek translation API or other service for each target language
                        // e.g., const translations = await deepSeekTranslate(messageText, targetLangs);
                        // Prepare messages for each translated text
                        // const translationMessages = translations.map(t => ({ type: 'text', text: t }));
                        // Reply or push the translated messages to the group
                        // await client.replyMessage(event.replyToken, translationMessages);
                    }
                }
            }
            // If needed, handle one-on-one chat or other commands here
        } catch (err) {
            console.error('Error in processing message event:', err);
        }
        // (No explicit reply sent here if translation logic is handled asynchronously or via push)
        return;
    }

    // Handle postback events from quick reply buttons
    if (event.type === 'postback') {
        const data = event.postback.data;
        // Only handle our language setting related postbacks
        if (!data.startsWith('lang_')) {
            return;
        }
        // Make sure we have an active selection session for this source
        if (!selectionState[sourceId]) {
            // No active selection (maybe session already finalized), ignore or reply nothing
            return;
        }
        const state = selectionState[sourceId];

        if (data === 'lang_done') {
            // User finished selection
            const finalLangs = state.current;
            try {
                // Save the final selected languages to Firestore (overwrite or create new)
                await db.collection('groupLanguages').doc(sourceId).set(
                    { languages: finalLangs },
                    { merge: true }
                );
            } catch (err) {
                console.error('Failed to save language settings:', err);
            }
            // Build confirmation message
            let langListText;
            if (finalLangs.length > 0) {
                // Convert language codes to names, joined by comma
                langListText = finalLangs.map(code => LANG_NAME[code]).join('、');
            } else {
                langListText = '（未選語言）';
            }
            const confirmationMsg = {
                type: 'text',
                text: `✅ 設定完成，目前已選：${langListText}`
            };
            await client.replyMessage(event.replyToken, confirmationMsg);
            // Clear the selection session
            delete selectionState[sourceId];
            return;
        }

        if (data === 'lang_cancel') {
            // User cancelled selection
            const originalLangs = state.original;
            let langListText;
            if (originalLangs && originalLangs.length > 0) {
                langListText = originalLangs.map(code => LANG_NAME[code]).join('、');
            } else {
                langListText = '（未選語言）';
            }
            const cancelMsg = {
                type: 'text',
                text: `❎ 已取消設定，目前維持：${langListText}`
            };
            await client.replyMessage(event.replyToken, cancelMsg);
            // Do not change Firestore (keep original settings)
            delete selectionState[sourceId];
            return;
        }

        // If we reach here, it's a language toggle (e.g. "lang_en", "lang_th", etc.)
        const langCode = data.replace('lang_', '');  // extract code after "lang_"
        if (!LANG_NAME[langCode]) {
            return; // unknown code (shouldn't happen)
        }
        // Toggle selection
        const currSelected = state.current;
        const idx = currSelected.indexOf(langCode);
        if (idx === -1) {
            // Not currently selected, so add it
            currSelected.push(langCode);
        } else {
            // Already selected, so remove it (deselect)
            currSelected.splice(idx, 1);
        }
        // Update the state
        state.current = currSelected;
        selectionState[sourceId] = state;
        // Respond with updated quick reply menu (so user can continue selecting)
        const updatedMenu = buildLanguageQuickReply(currSelected);
        await client.replyMessage(event.replyToken, updatedMenu);
        return;
    }

    // (Optional) Handle other events like follow/unfollow, etc., if needed
    return;
}

// (Optional) Daily push feature can be implemented here using setInterval or a scheduling library.
// For example, using node-cron to send daily messages to each group based on their selected languages.

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});