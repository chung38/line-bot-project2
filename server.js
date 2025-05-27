// --------------------------
// config.js - 全域配置
// --------------------------
export const LANGUAGE_CONFIG = {
  'en': { name: '英文', flag: '🇬🇧', timeFormat: 'h:mm a' },
  'th': { name: '泰文', flag: '🇹🇭', timeFormat: 'HH:mm น.' },
  'vi': { name: '越南文', flag: '🇻🇳', timeFormat: 'HH:mm' },
  'id': { name: '印尼文', flag: '🇮🇩', timeFormat: 'HH:mm' },
  'zh-TW': { name: '繁體中文', flag: '', timeFormat: 'ahh:mm' }
};

export const FIREBASE_CONFIG = JSON.parse(process.env.FIREBASE_CONFIG);
FIREBASE_CONFIG.private_key = FIREBASE_CONFIG.private_key.replace(/\\n/g, '\n');

export const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// --------------------------
// firebase-service.js - 資料庫服務
// --------------------------
import admin from 'firebase-admin';
import { FIREBASE_CONFIG } from './config.js';

export class FirebaseService {
  static init() {
    try {
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(FIREBASE_CONFIG) });
      }
      return admin.firestore();
    } catch (e) {
      throw new Error(`Firebase初始化失敗: ${e.message}`);
    }
  }

  static async loadGroupSettings(db) {
    const snapshot = await db.collection('groupSettings').get();
    const settings = new Map();
    snapshot.forEach(doc => {
      settings.set(doc.id, {
        langs: new Set(doc.data().langs || []),
        inviter: doc.data().inviter
      });
    });
    return settings;
  }
}

// --------------------------
// line-service.js - LINE互動服務
// --------------------------
import { Client } from '@line/bot-sdk';
import { LANGUAGE_CONFIG, LINE_CONFIG } from './config.js';

export class LineService {
  static client = new Client(LINE_CONFIG);

  static async sendLanguageMenu(groupId) {
    try {
      const buttons = Object.entries(LANGUAGE_CONFIG)
        .filter(([code]) => code !== 'zh-TW')
        .map(([code, {flag, name}]) => ({
          type: "button",
          action: {
            type: "postback",
            label: `${flag} ${name}`,
            data: `action=set_lang&code=${code}`
          },
          style: "primary"
        }));

      await this.client.pushMessage(groupId, {
        type: "flex",
        altText: "語言設定選單",
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "🌐 選擇翻譯語言", weight: "bold", size: "xl" },
              { type: "separator", margin: "md" },
              { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
            ]
          }
        }
      });
    } catch (e) {
      console.error(`[選單發送錯誤] ${groupId}:`, e.message);
      throw e;
    }
  }
}

// --------------------------
// translation-service.js - 翻譯核心
// --------------------------
import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { LANGUAGE_CONFIG } from './config.js';

export class TranslationService {
  static cache = new LRUCache({ max: 1000, ttl: 86400000 });

  static async translate(text, targetLang) {
    const cacheKey = `${targetLang}:${text}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    try {
      const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
        messages: [{
          role: "system",
          content: `將以下內容翻譯成${LANGUAGE_CONFIG[targetLang].name}，保留專業術語`
        }, {
          role: "user",
          content: text
        }]
      }, {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        timeout: 10000
      });

      const result = res.data.choices[0].message.content.trim();
      this.cache.set(cacheKey, result);
      return result;
    } catch (e) {
      console.error(`[翻譯失敗] ${targetLang}:`, e.message);
      return "（翻譯服務暫時不可用）";
    }
  }
}

// --------------------------
// news-service.js - 文宣管理
// --------------------------
import { load } from 'cheerio';
import axios from 'axios';
import https from 'node:https';

export class NewsService {
  static http = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15000
  });

  static async fetchImages(gid, date) {
    try {
      const res = await this.http.get("https://fw.wda.gov.tw/wda-employer/home/file");
      const $ = load(res.data);
      // 解析邏輯...
      return ['https://example.com/image.jpg']; // 示例返回
    } catch (e) {
      console.error(`[文宣抓取失敗] ${gid}:`, e.message);
      return [];
    }
  }
}

// --------------------------
// server.js - 主入口
// --------------------------
import express from 'express';
import bodyParser from 'body-parser';
import { middleware } from '@line/bot-sdk';
import { LINE_CONFIG } from './config.js';
import { FirebaseService } from './firebase-service.js';
import { LineService } from './line-service.js';

const app = express();
const PORT = process.env.PORT || 10000;
const db = FirebaseService.init();
let groupSettings = await FirebaseService.loadGroupSettings(db);

app.post('/webhook',
  bodyParser.raw({ type: 'application/json' }),
  middleware(LINE_CONFIG),
  async (req, res) => {
    res.sendStatus(200);
    
    await Promise.all(req.body.events.map(async event => {
      try {
        // 加入群組處理
        if (event.type === 'join' && event.source.type === 'group') {
          const gid = event.source.groupId;
          console.log(`[新群組] ${gid}`);
          await LineService.sendLanguageMenu(gid);
          groupSettings.set(gid, { langs: new Set(), inviter: null });
        }

        // 訊息處理邏輯...
      } catch (e) {
        console.error('[事件處理異常]:', e);
      }
    }));
  }
);

app.listen(PORT, () => {
  console.log(`🚀 服務已啟動於端口 ${PORT}`);
  if (process.env.DEBUG_MODE) {
    console.log('🔧 調試模式啟用中...');
  }
});