// 🔧 LINE Bot with Firestore + 勞動部宣導圖轉圖推播（使用 puppeteer 轉圖）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio"; // ✅ 修正這行
import https from "node:https";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import puppeteer from "puppeteer";
import cron from "node-cron";
import path from "path";

// 🔥 Firebase Init
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// 📡 LINE Init
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

const app = express();
const PORT = process.env.PORT || 10000;
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const groupLang = new Map();
const groupInviter = new Map();
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// 🧠 快取轉圖：Map<langCode, Map<pdfUrl, imageBuffer>>
const imageCache = new Map();

// 📁 Firestore load/save
const loadLang = async () => {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};
const loadInviter = async () => {
  const snap = await db.collection("groupInviters").get();
  snap.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
};

const hasSent = async (gid, url) => {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
};
const markSent = async (gid, url) => {
  const ref = db.collection("sentPosters").doc(gid);
  await ref.set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
};

// 🧲 爬勞動部宣導文宣
const fetchPostersByLangAndDate = async (langName, dateStr) => {
  const listRes = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(listRes.data); // ✅ 修正
  const links = [];

  $(".table-responsive tbody tr").each((_, tr) => {
    const title = $(tr).find("a").text();
    const href = $(tr).find("a").attr("href");
    const date = $(tr).find("td").eq(2).text().trim();
    if (title.includes(langName) || title.includes("多國語言版")) {
      if (dateStr === date) {
        links.push({ title, url: `https://fw.wda.gov.tw${href}` });
      }
    }
  });

  const posters = [];
  for (const item of links) {
    const detail = await axios.get(item.url);
    const $$ = load(detail.data); // ✅ 修正
    $$('a').each((_, a) => {
      const label = $$(a).text();
      const href = $$(a).attr('href');
      if (label.includes(langName) && href.includes("download-file")) {
        posters.push({
          title: item.title,
          pdfUrl: `https://fw.wda.gov.tw${href}`
        });
      }
    });
  }
  return posters;
};

// 其餘程式碼不變...
