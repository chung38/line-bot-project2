// LINE Messaging API client 與 webhook 簽章驗證 middleware。
import { Client, middleware } from "@line/bot-sdk";
import "./env.js";

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

export { client, lineConfig, middleware };
