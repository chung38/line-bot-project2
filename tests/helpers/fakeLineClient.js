// 假的 LINE client：只把呼叫記錄下來，不真的送任何訊息。
// 用 setLineClientForTesting() 注入（見 lib/line.js）。
function createFakeLineClient({ displayName = "測試使用者", failReply = false } = {}) {
  const calls = {
    replies: [],
    pushes: [],
    profileLookups: [],
  };

  return {
    calls,
    async replyMessage(replyToken, message) {
      calls.replies.push({ replyToken, message });
      if (failReply) {
        const err = new Error("reply failed");
        err.response = { data: { message: "Invalid reply token" } };
        throw err;
      }
      return {};
    },
    async pushMessage(to, message) {
      calls.pushes.push({ to, message });
      return {};
    },
    async getGroupMemberProfile(gid, uid) {
      calls.profileLookups.push({ gid, uid });
      return { displayName };
    },
    async getGroupSummary(gid) {
      return { groupName: `群組 ${gid}` };
    },
    // 方便斷言：最後一則回覆的文字
    lastReplyText() {
      return calls.replies.at(-1)?.message?.text ?? null;
    },
    lastPushText() {
      return calls.pushes.at(-1)?.message?.text ?? null;
    },
  };
}

export { createFakeLineClient };
