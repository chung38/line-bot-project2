import express from 'express';
import * as line from '@line/bot-sdk';
import admin from 'firebase-admin';
import { v2 as TranslateV2 } from '@google-cloud/translate';
import serviceAccount from './linebot-0511-9a3a5-firebase-adminsdk-fbsvc-4d78e33d6f.json' assert { type: "json" };

// Initialize LINE Bot client and middleware
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const lineClient = new line.Client(lineConfig);

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Initialize Google Cloud Translation API client
const { Translate } = TranslateV2;
const translateClient = new Translate({ 
  projectId: serviceAccount.project_id,
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key
  }
});

// Language options for selection
const languageOptions = [
  { code: 'en', name: '英文' },
  { code: 'th', name: '泰文' },
  { code: 'vi', name: '越南文' },
  { code: 'id', name: '印尼文' }
];

// In-memory store for active language selection sessions
const activeSelections = new Map();

// Helper: Build Flex Message for language selection menu
function buildLanguageMenu(selectedCodes = []) {
  return {
    type: 'flex',
    altText: '語言選擇',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '語言選擇',
            weight: 'bold',
            size: 'lg',
            color: '#1E90FF'
          },
          {
            type: 'text',
            text: '請勾選要接收的語言：',
            size: 'sm',
            color: '#555555',
            wrap: true
          }
        ]
      }
    }
  };
}

// Helper: Add language buttons (with Done/Cancel) to Flex message
function addLanguageButtonsToFlex(flex, selectedCodes = []) {
  const selectedSet = new Set(selectedCodes);
  const buttons = [];
  for (const lang of languageOptions) {
    buttons.push({
      type: 'button',
      style: selectedSet.has(lang.code) ? 'primary' : 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: (selectedSet.has(lang.code) ? '✅ ' : '') + lang.name,
        data: `lang_toggle=${lang.code}`
      }
    });
  }
  // Separator
  buttons.push({ type: 'separator', margin: 'md' });
  // Done and Cancel buttons
  buttons.push({
    type: 'button',
    style: 'primary',
    height: 'sm',
    color: '#1E90FF',
    action: { type: 'postback', label: '完成', data: 'lang_done' }
  });
  buttons.push({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'postback', label: '取消', data: 'lang_cancel' }
  });
  flex.contents.body.contents.push(...buttons);
  return flex;
}

// Start language selection: show Flex menu (reply or push)
async function startLanguageSelection(source, replyToken = null) {
  const sourceId = source.type === 'group' ? source.groupId
                  : source.type === 'room' ? source.roomId
                  : source.userId;
  if (!sourceId) return;
  // Load current preferences from Firestore
  let savedLanguages = [];
  try {
    const doc = await db.collection('groupLanguages').doc(sourceId).get();
    if (doc.exists) {
      const data = doc.data();
      if (data && Array.isArray(data.languages)) {
        savedLanguages = data.languages;
      }
    }
  } catch (err) {
    console.error('Error fetching saved languages:', err);
  }
  // Initialize session
  activeSelections.set(sourceId, { selected: new Set(savedLanguages) });
  // Build and send Flex menu
  let flexMenu = buildLanguageMenu(savedLanguages);
  flexMenu = addLanguageButtonsToFlex(flexMenu, savedLanguages);
  if (replyToken) {
    return lineClient.replyMessage(replyToken, flexMenu)
      .catch(err => console.error('Error sending language menu:', err));
  } else {
    return lineClient.pushMessage(sourceId, flexMenu)
      .catch(err => console.error('Error pushing language menu:', err));
  }
}

// Finalize selection: save to Firestore and return confirmation message
async function finalizeLanguageSelection(sourceId) {
  const session = activeSelections.get(sourceId);
  const finalSelection = session ? Array.from(session.selected) : [];
  try {
    await db.collection('groupLanguages').doc(sourceId).set({ languages: finalSelection });
  } catch (err) {
    console.error('Error saving languages to Firestore:', err);
  }
  let text;
  if (finalSelection.length === 0) {
    text = '✅ 設定完成，目前已選：（未選）';
  } else {
    const names = languageOptions
      .filter(lang => finalSelection.includes(lang.code))
      .map(lang => lang.name);
    text = '✅ 設定完成，目前已選：' + names.join('、');
  }
  activeSelections.delete(sourceId);
  return { type: 'text', text };
}

// Cancel selection: discard changes and return cancellation message
function cancelLanguageSelection(sourceId) {
  activeSelections.delete(sourceId);
  return { type: 'text', text: '已取消設定' };
}

// Translate a message to the group's selected languages (if configured)
async function translateMessage(source, userId, text) {
  const sourceId = source.type === 'group' ? source.groupId
                  : source.type === 'room' ? source.roomId
                  : source.userId;
  if (!sourceId || source.type === 'user') return null;
  // Get target languages from Firestore
  let targetLangs = [];
  try {
    const doc = await db.collection('groupLanguages').doc(sourceId).get();
    if (doc.exists && doc.data().languages) {
      targetLangs = doc.data().languages;
    }
  } catch (err) {
    console.error('Error fetching target languages:', err);
    return null;
  }
  if (!targetLangs.length) return null;
  // Get user name for attribution
  let displayName = '';
  try {
    if (source.type === 'group' && userId) {
      const profile = await lineClient.getGroupMemberProfile(source.groupId, userId);
      displayName = profile.displayName;
    } else if (source.type === 'room' && userId) {
      const profile = await lineClient.getRoomMemberProfile(source.roomId, userId);
      displayName = profile.displayName;
    } else if (source.type === 'user' && userId) {
      const profile = await lineClient.getProfile(userId);
      displayName = profile.displayName;
    }
  } catch (err) {
    console.error('Error getting user profile:', err);
  }
  // Perform translations
  const translatedParts = [];
  for (const code of targetLangs) {
    try {
      const [translated] = await translateClient.translate(text, code);
      translatedParts.push(translated);
    } catch (err) {
      console.error(`Error translating to ${code}:`, err);
    }
  }
  if (!translatedParts.length) return null;
  const namePrefix = displayName ? `【${displayName}】說:\n` : '';
  const translationText = translatedParts.join('\n');
  return { type: 'text', text: namePrefix + translationText };
}

// Event handler
async function handleEvent(event) {
  const source = event.source;
  const sourceId = source.type === 'group' ? source.groupId
                  : source.type === 'room' ? source.roomId
                  : source.userId;
  if (!sourceId) {
    return Promise.resolve(null);
  }
  // Message events
  if (event.type === 'message' && event.message.type === 'text') {
    const userMsg = event.message.text.trim();
    // Language menu command
    if (userMsg === '!設定' || userMsg === '！設定') {
      if (source.type === 'user') {
        const reply = { type: 'text', text: '此功能僅適用於群組聊天。' };
        return lineClient.replyMessage(event.replyToken, reply)
          .catch(err => console.error('Error replying to user:', err));
      }
      return startLanguageSelection(source, event.replyToken);
    }
    // (Other commands can be handled here)
    // Automatic translation for regular messages
    if (!userMsg.startsWith('!') && !userMsg.startsWith('lang_')) {
      const translationMsg = await translateMessage(source, source.userId, userMsg);
      if (translationMsg) {
        return lineClient.pushMessage(sourceId, translationMsg)
          .catch(err => console.error('Error pushing translation:', err));
      }
    }
    return Promise.resolve(null);
  }
  // Postback events (from language menu buttons)
  if (event.type === 'postback') {
    const data = event.postback.data;
    if (!data) return Promise.resolve(null);
    if (data.startsWith('lang_toggle=')) {
      const code = data.split('=')[1];
      if (!code) return Promise.resolve(null);
      const session = activeSelections.get(sourceId);
      if (!session) {
        const expired = { type: 'text', text: '設定已過期，請重新輸入「!設定」進行設定。' };
        return lineClient.replyMessage(event.replyToken, expired)
          .catch(err => console.error('Error sending expired message:', err));
      }
      // Toggle selection
      if (session.selected.has(code)) {
        session.selected.delete(code);
      } else {
        session.selected.add(code);
      }
      // Reply with updated menu
      const updatedList = Array.from(session.selected);
      let flexMenu = buildLanguageMenu(updatedList);
      flexMenu = addLanguageButtonsToFlex(flexMenu, updatedList);
      return lineClient.replyMessage(event.replyToken, flexMenu)
        .catch(err => console.error('Error updating menu:', err));
    }
    if (data === 'lang_done') {
      const confirmation = await finalizeLanguageSelection(sourceId);
      return lineClient.replyMessage(event.replyToken, confirmation)
        .catch(err => console.error('Error replying done:', err));
    }
    if (data === 'lang_cancel') {
      const cancelMsg = cancelLanguageSelection(sourceId);
      return lineClient.replyMessage(event.replyToken, cancelMsg)
        .catch(err => console.error('Error replying cancel:', err));
    }
    return Promise.resolve(null);
  }
  // Bot added to group/room
  if (event.type === 'join') {
    return startLanguageSelection(source, event.replyToken);
  }
  // Other events (memberJoined, memberLeft, follow, etc.) - no action
  return Promise.resolve(null);
}

// Express app and webhook route
const app = express();
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(event => handleEvent(event)))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error('Error handling event:', err);
      res.status(500).end();
    });
});

// (Preserve existing translation, broadcast, scheduled push functionality above)

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on port ' + PORT);
});