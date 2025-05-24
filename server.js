// 🔧 LINE Bot with Firestore + 宣導圖推播 + DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:     process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;

const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
const NAME_TO_CODE = Object.entries(LANGS).reduce((m,[code,label])=>{
  m[label+"版"]=code; m[label]=code; return m;
},{});

const groupLang  = new Map(); // gid→Set<lang>
const groupOwner = new Map(); // gid→uid

// 載／存／清 Firestore
async function loadLang(){
  const snap=await db.collection("groupLanguages").get();
  snap.forEach(d=>{
    const data=d.data();
    groupLang.set(d.id,new Set(data.langs||[]));
    if(data.owner) groupOwner.set(d.id,data.owner);
  });
}
async function saveLang(gid,langs){
  const owner=groupOwner.get(gid);
  await db.collection("groupLanguages").doc(gid)
    .set({ langs, ...(owner?{owner}:{}) });
  groupLang.set(gid,new Set(langs));
}
async function clearLang(gid){
  await db.collection("groupLanguages").doc(gid).delete();
  groupLang.delete(gid);
  groupOwner.delete(gid);
}

// Quick Reply 語言選單
function makeLangQR(gid){
  const sel = groupLang.get(gid)||new Set();
  const items = Object.entries(LANGS).map(([code,label])=>({
    type: "action", action:{
      type: "postback",
      label: (sel.has(code)?"✅ ":"")+label,
      data: `lang_toggle=${code}`
    }
  }));
  // 加一個完成
  items.push({
    type:"action", action:{
      type:"message",
      label:"完成",
      text:"完成"
    }
  });
  return { quickReply:{ items } };
}

// DeepSeek etc. (同前略過，請照原本程式貼上)

app.post(
  "/webhook",
  bodyParser.raw({type:"application/json"}),
  middleware(client.config),
  express.json(),
  async (req,res)=>{
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev=>{
      const gid=ev.source?.groupId, uid=ev.source?.userId;
      // Bot 加入
      if(ev.type==="join"&&gid){
        groupOwner.set(gid,uid);
        await saveLang(gid,[]);
        return client.replyMessage(ev.replyToken,{
          type:"text", text:"請選語言：", ...makeLangQR(gid)
        });
      }
      // Bot 離開
      if(ev.type==="leave"&&gid){
        return clearLang(gid);
      }
      // postback 切語言
      if(ev.type==="postback"&&gid&&ev.postback.data.startsWith("lang_toggle=")){
        if(groupOwner.get(gid)!==uid) return;
        const code=ev.postback.data.split("=")[1];
        const set=groupLang.get(gid)||new Set();
        set.has(code)?set.delete(code):set.add(code);
        await saveLang(gid,[...set]);
        return client.replyMessage(ev.replyToken,{
          type:"text", text:"請繼續選語言或按「完成」", ...makeLangQR(gid)
        });
      }
      // 手動 !設定
      if(ev.type==="message"&&ev.message?.text==="!設定"&&gid){
        if(groupOwner.get(gid)!==uid) return;
        return client.replyMessage(ev.replyToken,{
          type:"text", text:"請選語言：", ...makeLangQR(gid)
        });
      }
      // 完成
      if(ev.type==="message"&&ev.message?.text==="完成"&&gid){
        const names=[...(groupLang.get(gid)||[])].map(c=>LANGS[c]).join("、")||"（未選）";
        return client.replyMessage(ev.replyToken,{
          type:"text", text:`設定完成，目前：${names}`
        });
      }
      // 其餘如 !文宣 / 翻譯... 同原程式
      // ...
    }));
  }
);

app.get("/",(_,res)=>res.send("OK"));
app.listen(PORT,async()=>{
  await loadLang();
  console.log("🚀 Bot 已啟動，Listening on",PORT);
});