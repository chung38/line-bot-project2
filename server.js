// 🔧 LINE Bot with Firestore + 多選語系設定 + 宣導品推播 + DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

// === Firebase Init ===
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// === LINE Init ===
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;

// 語系對照
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([code,name])=>{
  NAME_TO_CODE[name] = code;
  NAME_TO_CODE[name+"版"] = code;
});

// 快取
const translationCache = new LRUCache({ max:500, ttl:24*60*60*1000 });

// Load group settings (languages + owner)
const groupLang = new Map();     // gid → Set<code>
const groupOwner = new Map();    // gid → ownerUid
async function loadLangAndOwner() {
  const snap = await db.collection("groupSettings").get();
  snap.forEach(doc=>{
    const d = doc.data();
    groupLang.set(doc.id, new Set(d.langs||[]));
    if (d.owner) groupOwner.set(doc.id, d.owner);
  });
}
// Toggle a language in Firestore
async function toggleLang(gid, code, uid) {
  const ref = db.collection("groupSettings").doc(gid);
  const data = (await ref.get()).data() || {};
  const langs = new Set(data.langs||[]);
  if (langs.has(code)) langs.delete(code);
  else langs.add(code);
  await ref.set({ langs: [...langs], owner: data.owner||uid }, { merge:true });
  groupLang.set(gid, langs);
  if (!groupOwner.has(gid)) {
    // first-time setting sets owner
    await ref.set({ owner: uid }, { merge:true });
    groupOwner.set(gid, uid);
  }
}

// DeepSeek 翻譯
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[{role:"system",content:sys},{role:"user",content:text}] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key,out);
    return out;
  } catch(e) {
    console.error("❌ 翻譯失敗:",e.message);
    return "（翻譯暫不可用）";
  }
}

// 使用者名稱
async function getUserName(gid,uid){
  try{ return (await client.getGroupMemberProfile(gid,uid)).displayName; }
  catch{ return uid; }
}

// 抓圖（同方案 C）
async function fetchImageUrlsByDate(gid,dateStr){
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const detailUrls=[];
  $("table.sub-table tbody.tbody tr").each((_,tr)=>{
    const tds=$(tr).find("td");
    if(tds.eq(1).text().trim()===dateStr.replace(/-/g,"/")){
      const href=tds.eq(0).find("a").attr("href");
      if(href) detailUrls.push("https://fw.wda.gov.tw"+href);
    }
  });
  const wanted=groupLang.get(gid)||new Set();
  const images=[];
  for(const url of detailUrls){
    const d=await axios.get(url);
    const $$=load(d.data);
    $$(" .text-photo a").each((_,el)=>{
      const raw= $$(el).find("p").text().trim().replace(/\d.*$/,"");
      const code=NAME_TO_CODE[raw];
      if(code && wanted.has(code)){
        const src=$$(el).find("img").attr("src");
        if(src) images.push("https://fw.wda.gov.tw"+src);
      }
    });
  }
  return images;
}

// 傳圖
async function sendImagesToGroup(gid,dateStr){
  const imgs=await fetchImageUrlsByDate(gid,dateStr);
  for(const u of imgs){
    await client.pushMessage(gid,{type:"image",originalContentUrl:u,previewImageUrl:u});
  }
}

// 排程
cron.schedule("0 15 * * *",async()=>{
  const today=new Date().toISOString().slice(0,10);
  for(const [gid] of groupLang) await sendImagesToGroup(gid,today);
});

// Webhook
app.post(
  "/webhook",
  bodyParser.raw({type:"application/json"}),
  middleware(client.config),
  express.json(),
  async(req,res)=>{
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev=>{
      const gid=ev.source?.groupId, uid=ev.source?.userId;
      const txt=ev.message?.text?.trim();
      // !設定
      if(ev.type==="message" && txt==="!設定" && gid){
        const owner=groupOwner.get(gid);
        if(owner && owner!==uid){
          return client.replyMessage(ev.replyToken,{type:"text",text:"只有管理者可以設定語系"});
        }
        // 列出多選 Quick Reply
        const langs=groupLang.get(gid)||new Set();
        const items=Object.entries(LANGS).map(([code,name])=>({
          type:"action",
          action:{
            type:"message",
            label: `${langs.has(code)?"✓":""}${name}`,
            text: `!設定 ${code}`
          }
        }));
        return client.replyMessage(ev.replyToken,{type:"text",text:"請點選要開/關的語系：",quickReply:{items}});
      }
      // !設定 <code>
      if(ev.type==="message" && txt?.startsWith("!設定 ") && gid){
        const owner=groupOwner.get(gid);
        if(owner && owner!==uid){
          return client.replyMessage(ev.replyToken,{type:"text",text:"只有管理者可以設定語系"});
        }
        const code=txt.split(" ")[1];
        if(!LANGS[code]){
          return client.replyMessage(ev.replyToken,{type:"text",text:"未知語系代碼"});
        }
        await toggleLang(gid,code,uid);
        return client.replyMessage(ev.replyToken,{type:"text",text:`已設定：${[...groupLang.get(gid)].map(c=>LANGS[c]).join(",")}`});
      }
      // !文宣
      if(ev.type==="message" && txt?.startsWith("!文宣") && gid){
        const d=txt.split(" ")[1];
        if(!/^\d{4}-\d{2}-\d{2}$/.test(d)){
          return client.replyMessage(ev.replyToken,{type:"text",text:"請輸入：!文宣 YYYY-MM-DD"});
        }
        await sendImagesToGroup(gid,d);
        return;
      }
      // 翻譯
      if(ev.type==="message"&&ev.message?.type==="text"&&gid&&!txt?.startsWith("!文宣")&&!txt?.startsWith("!設定")){
        const langs=groupLang.get(gid);
        if(!langs) return;
        const name=await getUserName(gid,uid);
        const isZh=/[\u4e00-\u9fff]/.test(txt);
        const out=isZh
          ?await Promise.all([...langs].map(l=>translateWithDeepSeek(txt,l))).then(a=>a.join("\n"))
          :await translateWithDeepSeek(txt,"zh-TW");
        return client.replyMessage(ev.replyToken,{type:"text",text:`【${name}】說：\n${out}`});
      }
    }));
  }
);

app.get("/",(_,res)=>res.send("OK"));
app.listen(PORT,async()=>{
  await loadLangAndOwner();
  console.log("🚀 Bot 已啟動 on",PORT);
});
