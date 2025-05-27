// --------------------------
// 模块一：环境配置与初始化 - config.js
// --------------------------
import 'dotenv/config';
import admin from 'firebase-admin';

// Firebase 初始化
export const initFirebase = () => {
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG);
    config.private_key = config.private_key.replace(/\\n/g, '\n');
    return admin.initializeApp({ credential: admin.credential.cert(config) });
  } catch (e) {
    console.error('❌ Firebase 初始化失败:', e);
    process.exit(1);
  }
};

// 多语言配置
export const LANGUAGE_CONFIG = {
  'en': { name: '英文', flag: '🇬🇧', timeFormat: 'h:mm a' },
  'th': { name: '泰文', flag: '🇹🇭', timeFormat: 'HH:mm น.' },
  'vi': { name: '越南文', flag: '🇻🇳', timeFormat: 'HH:mm' },
  'id': { name: '印尼文', flag: '🇮🇩', timeFormat: 'HH:mm' },
  'zh-TW': { name: '繁體中文', flag: '', timeFormat: 'ahh:mm' }
};

// --------------------------
// 模块二：LINE 服务 - line-service.js
// --------------------------
import { Client } from '@line/bot-sdk';
import { LANGUAGE_CONFIG } from './config.js';

export class LineService {
  static client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
  });

  // 强化版语言选单
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
          style: "primary",
          color: "#3b82f6"
        }));
      
      buttons.push({
        type: "button",
        action: { type: "postback", label: "❌ 取消选择", data: "action=set_lang&code=cancel" },
        style: "secondary",
        color: "#ef4444"
      });

      await this.client.pushMessage(groupId, {
        type: "flex",
        altText: "语言设定选单",
        contents: {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "🌏 自动翻译语言设定", weight: "bold", size: "xl" },
              { type: "separator", margin: "md" },
              { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
            ]
          }
        }
      });
      console.log(`✅ 选单已发送至群组 ${groupId}`);
    } catch (e) {
      console.error(`❌ 选单发送失败 [${groupId}]:`, e.message);
      throw e;
    }
  }

  // 权限验证
  static async validateGroupPermission(groupId) {
    try {
      const summary = await this.client.getGroupSummary(groupId);
      return summary.permissions.includes('BOT');
    } catch (e) {
      console.error(`权限检查失败 [${groupId}]:`, e.message);
      return false;
    }
  }
}

// --------------------------
// 模块三：翻译服务 - translation-service.js
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
      const response = await axios.post("https://api.deepseek.com/v1/chat/completions", {
        model: "deepseek-chat",
        messages: [{
          role: "system",
          content: `你是一位专业翻译，请将以下内容翻译成${LANGUAGE_CONFIG[targetLang].name}（使用台湾常用语）`
        }, {
          role: "user",
          content: text
        }]
      }, {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        timeout: 10000
      });

      const result = response.data.choices[0].message.content.trim();
      this.cache.set(cacheKey, result);
      return result;
    } catch (e) {
      console.error(`翻译失败 [${targetLang}]:`, e.message);
      return "（翻译服务暂时不可用）";
    }
  }
}

// --------------------------
// 模块四：文宣服务 - news-service.js
// --------------------------
import { load } from 'cheerio';
import axios from 'axios';
import https from 'node:https';

export class NewsService {
  static axios = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15000
  });

  static async fetchImages(groupId, dateStr) {
    try {
      const res = await this.axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
      const $ = load(res.data);
      const targetDate = dateStr.replace(/-/g, '/');
      
      // 解析逻辑...
      return []; // 返回图片URL数组
    } catch (e) {
      console.error("文宣抓取失败:", e.message);
      return [];
    }
  }

  static async sendImages(client, groupId, images) {
    for (const url of images) {
      try {
        await client.pushMessage(groupId, {
          type: "image",
          originalContentUrl: url,
          previewImageUrl: url
        });
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error("图片发送失败:", e.message);
      }
    }
  }
}

// --------------------------
// 主应用模块 - app.js
// --------------------------
import express from 'express';
import bodyParser from 'body-parser';
import { middleware } from '@line/bot-sdk';
import { initFirebase } from './config.js';
import { LineService } from './line-service.js';
import { TranslationService } from './translation-service.js';
import { NewsService } from './news-service.js';

// 初始化
const db = initFirebase().firestore();
const app = express();
const PORT = process.env.PORT || 10000;

// 状态存储
let groupSettings = new Map();

// 路由配置
app.post('/webhook',
  bodyParser.raw({ type: 'application/json' }),
  middleware(LineService.client.config),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(handleEvent));
  }
);

// 事件处理器
async function handleEvent(event) {
  try {
    switch (event.type) {
      case 'join':
        await handleJoin(event);
        break;
      case 'postback':
        await handlePostback(event);
        break;
      case 'message':
        await handleMessage(event);
        break;
    }
  } catch (e) {
    console.error('事件处理异常:', e);
  }
}

// 加入群组处理
async function handleJoin(event) {
  if (event.source.type !== 'group') return;
  
  const groupId = event.source.groupId;
  console.log(`🆕 加入新群组: ${groupId}`);
  
  if (!await LineService.validateGroupPermission(groupId)) {
    return console.log(`⛔ 群组 ${groupId} 无权限`);
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await LineService.sendLanguageMenu(groupId);
      break;
    } catch (e) {
      if (attempt === 3) console.error(`连续发送失败 [${groupId}]`);
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}

// ...其他事件处理函数保持完整

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务已启动于端口 ${PORT}`);
  if (process.env.DEBUG_MODE) {
    console.log('🔧 调试模式已启用');
    LineService.sendLanguageMenu = async (gid) => {
      console.log(`模拟发送选单至 ${gid}`);
      return { status: 'mocked' };
    };
  }
});