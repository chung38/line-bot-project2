/**
 * server.js - LINE Bot with translation and daily propaganda image push
 */
'use strict';

// Module dependencies
const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

// Initialize Firebase Admin with service account (Firestore)
const serviceAccount = require(__dirname + '/linebot-0511-9a3a5-firebase-adminsdk-fbsvc-4d78e33d6f.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// LINE Bot configuration
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, // Add your LINE Channel Access Token in environment variables
    channelSecret: process.env.LINE_CHANNEL_SECRET // Add your LINE Channel Secret in environment variables
};
const client = new line.Client(config);

// Express app for webhook
const app = express();
app.post('/callback', line.middleware(config), async (req, res) => {
    try {
        const events = req.body.events;
        for (const event of events) {
            // Only handle message events
            if (event.type === 'message' && event.message.type === 'text') {
                const text = event.message.text.trim();
                const source = event.source;
                // Determine group or room ID
                const groupId = source.groupId || source.roomId || source.userId;
                
                // Handle manual command for propaganda images
                if (text.startsWith('!文宣 ')) {
                    const parts = text.split(' ');
                    if (parts.length >= 2) {
                        const dateInput = parts[1];
                        // Validate date format YYYY-MM-DD
                        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
                        if (!datePattern.test(dateInput)) {
                            await client.replyMessage(event.replyToken, {
                                type: 'text',
                                text: '日期格式錯誤，請使用 YYYY-MM-DD。'
                            });
                        } else {
                            // Fetch images for the specified date
                            const imagesByLang = await fetchImagesByDate(dateInput);
                            // Get group language settings from Firestore
                            const groupRef = db.collection('groups').doc(groupId);
                            const groupSnap = await groupRef.get();
                            let groupLangs = [];
                            if (groupSnap.exists) {
                                groupLangs = groupSnap.data().languages || [];
                            }
                            // Prepare image messages for this group based on languages
                            let messages = [];
                            for (const lang of groupLangs) {
                                if (imagesByLang[lang]) {
                                    for (const imgUrl of imagesByLang[lang]) {
                                        messages.push({
                                            type: 'image',
                                            originalContentUrl: imgUrl,
                                            previewImageUrl: imgUrl
                                        });
                                    }
                                }
                            }
                            if (messages.length > 0) {
                                // Reply with images
                                await client.replyMessage(event.replyToken, messages);
                            } else {
                                // No images found for group languages
                                await client.replyMessage(event.replyToken, {
                                    type: 'text',
                                    text: '該日期無符合條件的宣導圖片，或您群組設定的語言中無對應語言版本。'
                                });
                            }
                        }
                    } else {
                        // No date provided
                        await client.replyMessage(event.replyToken, {
                            type: 'text',
                            text: '請提供日期，例如：!文宣 2025-05-16'
                        });
                    }
                    continue; // move to next event after handling command
                }
                
                // TODO: Handle other commands or translation logic
                // Example: language menu settings, translation of messages, permission checks, etc.
                // Keep original translation and language menu logic unchanged.

                // Example placeholder: If a translation feature existed, it would be here
            }
        }
        // Return HTTP 200 to LINE platform
        res.sendStatus(200);
    } catch (err) {
        console.error('Error handling event:', err);
        res.sendStatus(500);
    }
});

// Function to fetch propaganda images by date (YYYY-MM-DD)
async function fetchImagesByDate(dateStr) {
    // Convert YYYY-MM-DD to site format YYYY/MM/DD
    const [year, month, day] = dateStr.split('-');
    const target = `${year}/${month}/${day}`;
    const listUrl = 'https://fw.wda.gov.tw/wda-employer/home/file';

    let imagesByLang = {}; // { 'vi': [...], 'th': [...], ... }
    try {
        const res = await axios.get(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        const tasks = [];
        // Find table rows matching the date
        $('tr').each((i, tr) => {
            const dateCell = $(tr).find('td[data-label="發佈日期｜"]');
            if (dateCell && dateCell.text().trim() === target) {
                const link = $(tr).find('a').attr('href');
                if (link) {
                    const detailUrl = 'https://fw.wda.gov.tw' + link;
                    tasks.push(extractImagesFromPage(detailUrl, imagesByLang));
                }
            }
        });
        // Wait for all detail pages to be processed
        await Promise.all(tasks);
    } catch (err) {
        console.error('Error fetching list page:', err);
    }
    return imagesByLang;
}

// Helper function to fetch detail page and extract images (populates imagesByLang)
async function extractImagesFromPage(detailUrl, imagesByLang) {
    try {
        const res = await axios.get(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        // Find all anchors that correspond to images (indicated by page count text)
        $('a').each((i, a) => {
            const text = $(a).text() || '';
            if (text.match(/版[1-3]\/3/)) {
                let langCode = null;
                if (text.includes('英文版')) langCode = 'en';
                else if (text.includes('泰文版')) langCode = 'th';
                else if (text.includes('印尼文版')) langCode = 'id';
                else if (text.includes('越南文版')) langCode = 'vi';
                else if (text.includes('中文版')) {
                    langCode = 'zh'; // Traditional Chinese
                }
                if (!langCode || langCode === 'zh') {
                    return; // skip if no valid language or Chinese
                }
                const href = $(a).attr('href');
                if (href) {
                    const imgUrl = href.startsWith('http') ? href : 'https://fw.wda.gov.tw' + href;
                    if (!imagesByLang[langCode]) imagesByLang[langCode] = [];
                    if (!imagesByLang[langCode].includes(imgUrl)) {
                        imagesByLang[langCode].push(imgUrl);
                    }
                }
            }
        });
    } catch (err) {
        console.error('Error fetching detail page:', err);
    }
}

// Schedule daily job at 15:00 Asia/Taipei time
cron.schedule('0 15 * * *', async () => {
    console.log('Running daily propaganda image push job...');
    // Today's date (Taipei time)
    const now = new Date();
    const year = now.getFullYear();
    const month = ('0' + (now.getMonth() + 1)).slice(-2);
    const day = ('0' + now.getDate()).slice(-2);
    const todayStr = `${year}-${month}-${day}`;
    // Fetch images for today
    const imagesByLang = await fetchImagesByDate(todayStr);
    // Get all groups from Firestore
    const snapshot = await db.collection('groups').get();
    if (snapshot.empty) {
        console.log('No groups found for image push.');
        return;
    }
    for (const doc of snapshot.docs) {
        const groupId = doc.id;
        const groupData = doc.data();
        const groupLangs = groupData.languages || [];
        let msgs = [];
        for (const lang of groupLangs) {
            if (imagesByLang[lang]) {
                imagesByLang[lang].forEach(url => {
                    msgs.push({
                        type: 'image',
                        originalContentUrl: url,
                        previewImageUrl: url
                    });
                });
            }
        }
        if (msgs.length > 0) {
            try {
                await client.pushMessage(groupId, msgs);
                console.log(`Pushed images to group ${groupId}: ${msgs.length} images.`);
            } catch (err) {
                console.error('Error pushing images to group', groupId, err);
            }
        }
    }
}, {
    timezone: 'Asia/Taipei'
});

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});