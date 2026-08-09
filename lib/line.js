// LINE Messaging API client 與 webhook 簽章驗證 middleware。
import { Client, middleware } from "@line/bot-sdk";
import { isTestEnv } from "./env.js";

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 測試模式下不建立真的 client，避免測試漏注入假的實作時「真的把訊息推到 LINE」。
function createUninjectedTestClient() {
  const fail = name => async () => {
    throw new Error(`測試模式尚未注入 LINE client，卻呼叫了 client.${name}()`);
  };
  return {
    replyMessage: fail("replyMessage"),
    pushMessage: fail("pushMessage"),
    getGroupMemberProfile: fail("getGroupMemberProfile"),
    getGroupSummary: fail("getGroupSummary"),
  };
}

let client = isTestEnv ? createUninjectedTestClient() : new Client(lineConfig);

// 只給測試用：注入一個會記錄呼叫紀錄的假 client。
function setLineClientForTesting(fakeClient) {
  if (!isTestEnv) {
    throw new Error("setLineClientForTesting() 只能在 NODE_ENV=test 下使用");
  }
  client = fakeClient;
}

export { client, lineConfig, middleware, setLineClientForTesting };
