// 假的 LINE client：只把呼叫記錄下來，不真的送任何訊息。
// 用 setLineClientForTesting() 注入（見 lib/line.js）。
function createFakeLineClient({
  displayName = "測試使用者",
  failReply = false,
  // 機器人已經被移出群組時，getGroupSummary 會失敗。設成 true 可以模擬這個情況。
  failGroupSummary = false,
  groupName = null,
} = {}) {
  const calls = {
    replies: [],
    pushes: [],
    profileLookups: [],
    groupSummaryLookups: [],
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
      calls.groupSummaryLookups.push({ gid });
      if (failGroupSummary) {
        const err = new Error("not a member of the group");
        err.response = { status: 404 };
        throw err;
      }
      return { groupName: groupName || `群組 ${gid}` };
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
