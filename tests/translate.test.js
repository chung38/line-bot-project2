// services/translate.js 的測試：重點在「輸出品質不合格時的重試路徑」。
//
// 這裡是兩個實際修掉的問題的回歸測試：
//   1. 舊版用 isInvalidZhTwTranslation() 當重試條件，那個判斷只對 zh-TW 有意義，
//      所以泰文/越南文/英文/印尼文的重試路徑永遠不會被觸發（forceStrict 形同虛設）。
//   2. 舊版的極簡 prompt 沒有帶 industryContext，重試之後反而失去產業術語脈絡。
//
// OpenAI 的呼叫用 setChatCompletionForTesting() 換成假的實作，不會發任何網路請求。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { groupIndustry } from "../lib/state.js";
import {
  translateWithChatGPT,
  buildTranslationPrompt,
  buildIndustryContext,
  setChatCompletionForTesting,
  isTranslationFailureOutput,
  isReasoningModel,
  buildRequestPayload,
  extractUnsupportedParam,
} from "../services/translate.js";

// 每個測試用不同的原文，避免模組層級的 LRU 快取跨測試互相影響。
let seq = 0;
function uniqueText(base) {
  seq += 1;
  return `${base}${"　".repeat(seq)}`; // 補全形空白讓字串不同，但不影響語言判斷
}

// 依序回傳預先排好的假譯文，並記錄每次收到的 systemPrompt / temperature。
function fakeCompletions(outputs) {
  const calls = [];
  setChatCompletionForTesting(async ({ systemPrompt, text, temperature }) => {
    calls.push({ systemPrompt, text, temperature });
    const out = outputs[calls.length - 1];
    if (out === undefined) throw new Error(`假的 OpenAI 被呼叫超過預期次數（第 ${calls.length} 次）`);
    return out;
  });
  return calls;
}

function reset() {
  groupIndustry.clear();
  setChatCompletionForTesting(null);
}

test("譯文合格時只呼叫一次 OpenAI，不會重試", async () => {
  reset();
  const src = uniqueText("今天下午三點到二廠開會");
  const calls = fakeCompletions(["ประชุมที่โรงงานสองบ่ายสามโมงวันนี้"]);

  const out = await translateWithChatGPT(src, "th");

  assert.equal(calls.length, 1);
  assert.equal(out, "ประชุมที่โรงงานสองบ่ายสามโมงวันนี้");
});

test("泰文譯文原樣照抄中文時會重試（回歸測試：以前非 zh-TW 的重試永遠不會執行）", async () => {
  reset();
  const src = uniqueText("明天要加班兩小時");
  const calls = fakeCompletions([
    "明天要加班兩小時",            // 模型只做了校對，沒翻譯
    "พรุ่งนี้ต้องทำงานล่วงเวลาสองชั่วโมง",
  ]);

  const out = await translateWithChatGPT(src, "th");

  assert.equal(calls.length, 2, "第一次輸出不合格時應該要重試");
  assert.equal(out, "พรุ่งนี้ต้องทำงานล่วงเวลาสองชั่วโมง");
});

test("越南文譯文原樣照抄中文時會重試", async () => {
  reset();
  const src = uniqueText("記得戴安全帽");
  const calls = fakeCompletions([
    "記得戴安全帽",
    "Nhớ đội mũ bảo hộ",
  ]);

  const out = await translateWithChatGPT(src, "vi");

  assert.equal(calls.length, 2);
  assert.equal(out, "Nhớ đội mũ bảo hộ");
});

test("英文譯文只翻一半（中文比拉丁字母還多）時會重試", async () => {
  reset();
  const src = uniqueText("請到三號機台檢查");
  const calls = fakeCompletions([
    "OK 請到三號機台檢查",          // 非拉丁字數 >= 拉丁字數 → 判定沒翻完
    "Please go to machine No.3 for inspection",
  ]);

  const out = await translateWithChatGPT(src, "en");

  assert.equal(calls.length, 2);
  assert.equal(out, "Please go to machine No.3 for inspection");
});

test("重試用的極簡 prompt 仍帶著產業脈絡（回歸測試：以前重試會失去產業術語）", async () => {
  reset();
  groupIndustry.set("Gfactory", "電子廠");

  const src = uniqueText("這批板子要重工");
  const calls = fakeCompletions([
    "這批板子要重工",
    "ล็อตนี้ต้องทำใหม่",
  ]);

  await translateWithChatGPT(src, "th", "Gfactory");

  assert.equal(calls.length, 2);
  assert.match(calls[0].systemPrompt, /電子廠/, "一般 prompt 本來就要帶產業");
  assert.match(calls[1].systemPrompt, /電子廠/, "重試的極簡 prompt 也必須帶產業");
  // 極簡 prompt 確實換過了，不是把同一份 prompt 再送一次
  assert.notEqual(calls[0].systemPrompt, calls[1].systemPrompt);
});

test("重試時會提高 temperature，避免再吐出同一個錯誤答案", async () => {
  reset();
  const src = uniqueText("下班前記得打卡");
  const calls = fakeCompletions([
    "下班前記得打卡",
    "Jangan lupa absen sebelum pulang",
  ]);

  await translateWithChatGPT(src, "id");

  assert.equal(calls[0].temperature, 0.1);
  assert.equal(calls[1].temperature, 0.3);
});

test("重試次數用完仍不合格時回傳翻譯異常訊息，不會把原文當譯文回傳", async () => {
  reset();
  const src = uniqueText("倉庫的料明天到");
  const calls = fakeCompletions([
    "倉庫的料明天到",
    "倉庫的料明天到",
    "倉庫的料明天到",
  ]);

  const out = await translateWithChatGPT(src, "th");

  assert.equal(calls.length, 3, "原始 1 次 + 最多重試 2 次");
  assert.notEqual(out.trim(), src.trim(), "絕對不能把原文偽裝成譯文");
  assert.equal(isTranslationFailureOutput(out), true, "要能被 webhook 認出是失敗，才不會計費");
});

test("zh-TW 的判斷維持原本行為：譯文有中文就算通過", async () => {
  reset();
  const src = uniqueText("Please clean the machine before leaving");
  const calls = fakeCompletions(["離開前請先清理機台"]);

  const out = await translateWithChatGPT(src, "zh-TW");

  assert.equal(calls.length, 1);
  assert.equal(out, "離開前請先清理機台");
});

test("zh-TW 譯文完全沒有中文時會重試", async () => {
  reset();
  const src = uniqueText("Check the water level");
  const calls = fakeCompletions([
    "Check the water level",  // 沒翻
    "請檢查水位",
  ]);

  const out = await translateWithChatGPT(src, "zh-TW");

  assert.equal(calls.length, 2);
  assert.equal(out, "請檢查水位");
});

test("空字串或純表情符號不會呼叫 OpenAI", async () => {
  reset();
  const calls = fakeCompletions([]);

  assert.equal(await translateWithChatGPT("   ", "th"), "   ");
  assert.equal(await translateWithChatGPT("😀😀", "th"), "😀😀");
  assert.equal(calls.length, 0);
});

test("OpenAI 逾時會退避重試，重試成功就回傳正常譯文", async () => {
  reset();
  const src = uniqueText("零件明天補齊");
  const calls = [];
  setChatCompletionForTesting(async args => {
    calls.push(args);
    if (calls.length === 1) {
      const err = new Error("timeout of 25000ms exceeded");
      err.code = "ECONNABORTED";
      throw err;
    }
    return "พรุ่งนี้จะเติมอะไหล่ให้ครบ";
  });

  const out = await translateWithChatGPT(src, "th");

  assert.equal(calls.length, 2);
  assert.equal(out, "พรุ่งนี้จะเติมอะไหล่ให้ครบ");
});

test("OpenAI 一直失敗時回傳可被辨識的失敗字串", async () => {
  reset();
  const src = uniqueText("設備異常請通知組長");
  setChatCompletionForTesting(async () => {
    const err = new Error("service unavailable");
    err.response = { status: 503 };
    throw err;
  });

  const out = await translateWithChatGPT(src, "th");

  assert.equal(isTranslationFailureOutput(out), true);
});

test("合格的譯文會被快取，相同輸入不會再打一次 OpenAI", async () => {
  reset();
  const src = uniqueText("安全門不可堆放物品");
  const calls = fakeCompletions(["ห้ามวางของขวางประตูหนีไฟ"]);

  const first = await translateWithChatGPT(src, "th");
  const second = await translateWithChatGPT(src, "th");

  assert.equal(calls.length, 1);
  assert.equal(second, first);
});

test("buildIndustryContext：沒有指定行業時退回通用說明", () => {
  reset();
  assert.match(buildIndustryContext(""), /未指定工作類型/);
  assert.match(buildIndustryContext("食品廠"), /食品廠/);
});

test("buildTranslationPrompt：極簡版本仍包含目標語言與產業脈絡", () => {
  reset();
  const normal = buildTranslationPrompt("th", "紡織廠", false);
  const strict = buildTranslationPrompt("th", "紡織廠", true);

  assert.match(normal, /紡織廠/);
  assert.match(strict, /紡織廠/);
  assert.match(strict, /泰文|ไทย|Thai|泰/);
  assert.ok(strict.length < normal.length, "極簡 prompt 應該比一般 prompt 短");
});

test("setChatCompletionForTesting 傳 null 時會還原成真正的實作", async () => {
  reset();
  // 只驗證不會丟錯；還原後不再呼叫任何翻譯，避免真的打到 OpenAI。
  assert.doesNotThrow(() => setChatCompletionForTesting(null));
});


// ── prompt 結構 ─────────────────────────────────────────────
//
// 這幾個測試不驗「翻得好不好」（那要靠人看），而是驗 prompt 本身的結構有沒有壞。
// 加這一組的直接原因：先前手動編輯 prompt 時，${industryContext} 被貼了兩次而沒人
// 發現——重複的指令會被模型當成特別強調，可能讓日常對話也被硬套產業術語。
// 這種錯誤在翻譯結果上不會立刻看出來，只能從 prompt 本身檢查。

test("prompt：industryContext 只會出現一次（回歸測試：曾經重複貼了兩次）", () => {
  reset();
  const industry = "電子廠";
  const context = buildIndustryContext(industry);

  for (const strict of [false, true]) {
    const prompt = buildTranslationPrompt("th", industry, strict);
    const occurrences = prompt.split(context).length - 1;
    assert.equal(occurrences, 1, `${strict ? "極簡" : "一般"} prompt 的產業脈絡出現 ${occurrences} 次`);
  }
});

test("prompt：規則編號連續且不重複", () => {
  reset();
  const prompt = buildTranslationPrompt("th", "電子廠");
  const numbers = [...prompt.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));

  assert.ok(numbers.length >= 4, "規則數量看起來不對");
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "編號要遞增");
  assert.equal(new Set(numbers).size, numbers.length, "編號不能重複");
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1), "編號要從 1 開始連續");
});

test("prompt：保留人名地名的規則沒有掉（工廠群組高頻情境）", () => {
  reset();
  const prompt = buildTranslationPrompt("th", "電子廠");
  // 中文姓氏與地名的字本身有意義，沒有這條規則的話
  // 「林先生」「大甲廠」會被照字面翻成「森林」「大盔甲」
  assert.match(prompt, /人名/);
  assert.match(prompt, /地名/);
});

test("prompt：代碼類保留規則沒有掉", () => {
  reset();
  const prompt = buildTranslationPrompt("th", "");
  for (const keyword of ["機台代號", "料號", "工單號", "URL", "Email"]) {
    assert.match(prompt, new RegExp(keyword), `少了「${keyword}」的保留規則`);
  }
});

test("prompt：不會出現整段重複的規則行", () => {
  reset();
  const prompt = buildTranslationPrompt("vi", "食品廠");
  const lines = prompt
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 10);

  const seen = new Set();
  for (const line of lines) {
    assert.equal(seen.has(line), false, `這一行重複了：${line.slice(0, 40)}`);
    seen.add(line);
  }
});

test("prompt：目標語言名稱有正確帶入，不是語言代碼", () => {
  reset();
  const prompt = buildTranslationPrompt("th", "");
  assert.match(prompt, /泰/, "應該用語言名稱而不是 th");
});

test("prompt：沒有指定行業時不會出現空白的產業段落", () => {
  reset();
  const prompt = buildTranslationPrompt("th", "");
  assert.doesNotMatch(prompt, /工作類型：\s*。/, "行業是空的時候不該產生「工作類型：。」");
  assert.match(prompt, /未指定工作類型/);
});

test("prompt：極簡版本比一般版本短，但仍保留核心約束", () => {
  reset();
  const normal = buildTranslationPrompt("th", "紡織廠");
  const strict = buildTranslationPrompt("th", "紡織廠");
  const strictPrompt = buildTranslationPrompt("th", "紡織廠", true);

  assert.ok(strictPrompt.length < normal.length);
  assert.match(strictPrompt, /紡織廠/, "重試時不能失去產業脈絡");
  assert.match(strictPrompt, /校對/, "要明確禁止「只改錯字」這種行為");
});


// ── 模型參數相容性 ──────────────────────────────────────────
//
// GPT-5 系列是推理模型，Chat Completions 的參數規格跟 GPT-4.x 不同。
// 換模型時如果沒跟著改參數，OpenAI 會直接回 400，整個翻譯功能會停擺——
// 而使用者只會看到「翻譯失敗」，很難聯想到是參數問題。

test("isReasoningModel：認得 GPT-5 與 o 系列", () => {
  reset();
  for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.4-mini", "gpt-5.6-terra", "o3-mini", "o4-mini"]) {
    assert.equal(isReasoningModel(model), true, `${model} 應該被當成推理模型`);
  }
  for (const model of ["gpt-4.1-mini", "gpt-4o", "gpt-4-turbo"]) {
    assert.equal(isReasoningModel(model), false, `${model} 不是推理模型`);
  }
});

test("payload：GPT-5 用 max_completion_tokens，不能送 max_tokens", () => {
  reset();
  const payload = buildRequestPayload({
    model: "gpt-5.4-mini",
    systemPrompt: "翻譯",
    text: "測試",
    temperature: 0.1,
  });

  // 送 max_tokens 會被打回 400：
  // "Unsupported parameter: 'max_tokens' is not supported with this model."
  assert.equal("max_tokens" in payload, false);
  assert.equal(payload.max_completion_tokens, 1000);
});

test("payload：GPT-5 會明確關掉推理", () => {
  reset();
  const payload = buildRequestPayload({
    model: "gpt-5.4-mini",
    systemPrompt: "翻譯",
    text: "測試",
    temperature: 0.1,
  });

  // 翻譯不需要推理，而且推理會吃掉 token 額度，用完的話譯文會是空字串
  assert.equal(payload.reasoning_effort, "none");
});

test("payload：GPT-4.x 維持原本的 max_tokens", () => {
  reset();
  const payload = buildRequestPayload({
    model: "gpt-4.1-mini",
    systemPrompt: "翻譯",
    text: "測試",
    temperature: 0.1,
  });

  assert.equal(payload.max_tokens, 1000);
  assert.equal("max_completion_tokens" in payload, false);
  assert.equal("reasoning_effort" in payload, false);
});

test("payload：兩種模型都會帶上 system 與 user 訊息", () => {
  reset();
  for (const model of ["gpt-4.1-mini", "gpt-5.4-mini"]) {
    const payload = buildRequestPayload({ model, systemPrompt: "SYS", text: "USER", temperature: 0.1 });
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[0].content, "SYS");
    assert.equal(payload.messages[1].content, "USER");
  }
});

test("extractUnsupportedParam：從 OpenAI 的錯誤裡認出被拒絕的參數", () => {
  reset();

  // OpenAI 實際回傳的格式
  const err = {
    response: {
      data: {
        error: {
          message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: "invalid_request_error",
          param: "max_tokens",
          code: "unsupported_parameter",
        },
      },
    },
  };
  assert.equal(extractUnsupportedParam(err), "max_tokens");

  // 沒有 param 欄位時從訊息裡撈
  const err2 = {
    response: {
      data: {
        error: {
          message: "Unsupported parameter: 'temperature' is not supported with this model.",
          code: "unsupported_parameter",
        },
      },
    },
  };
  assert.equal(extractUnsupportedParam(err2), "temperature");
});

test("extractUnsupportedParam：一般錯誤不會被誤判成參數問題", () => {
  reset();
  assert.equal(extractUnsupportedParam(new Error("timeout")), null);
  assert.equal(
    extractUnsupportedParam({ response: { data: { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } } } }),
    null
  );
  assert.equal(extractUnsupportedParam({ response: { status: 503 } }), null);
});
