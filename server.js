// @人名處理輔助函數（改進版）
function extractMentions(text) {
  const mentions = [];
  let idx = 0;
  // 包含中英文名、-、/、．、・等符號
  const newText = text.replace(/@[\w\u4e00-\u9fa5\-\/．・]+/g, match => {
    mentions.push(match);
    return `__MENTION_${idx++}__`;
  });
  return [newText, mentions];
}
function restoreMentions(text, mentions) {
  return text.replace(/__MENTION_(\d+)__/g, (_, n) => mentions[+n] || "");
}