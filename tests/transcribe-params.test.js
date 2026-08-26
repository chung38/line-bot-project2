// services/transcribe.js 的「能力探測 + 降級重試」。
//
// 為什麼需要這一層：OpenAI 各個轉錄模型支援的可選參數不一樣，而且會變動。
// gpt-transcribe 是 2026-07 才推出的，文件更新的速度跟不上模型推出的速度，
// 任何寫死在程式裡的能力表遲早會過期——而過期的症狀是「語音翻譯整個沒反應」，
// 非常難查。
//
// 所以策略是：可選參數一律先送，被 API 以 400 退回就記下來、拿掉重試，並在
// log 印出來。功能永遠不會整個死掉，最多安靜降級成少一層防護。
//
// 這支測試直接把 global.fetch 換掉，不需要真的打 OpenAI。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";

// 這支測試專門跑 gpt 系列的路徑（whisper 走 verbose_json，不送 logprobs）。
// TRANSCRIBE_MODEL 是在模組載入時算好的常數，所以要先設好環境變數再動態
// import——靜態 import 會被提升到檔案最上面，來不及。
// node --test 每個檔案跑在自己的行程裡，不會影響其他測試檔。
process.env.OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";

const {
  detectUnsupportedParam,
  requestTranscriptionViaOpenAI,
  getConfidenceSource,
  TRANSCRIBE_MODEL,
  SUPPORTS_VERBOSE_JSON,
} = await import("../services/transcribe.js");

test("gpt-transcribe 走 json + logprobs 這條路徑，不是 verbose_json", () => {
  assert.equal(TRANSCRIBE_MODEL, "gpt-transcribe");
  assert.equal(SUPPORTS_VERBOSE_JSON, false);
  assert.equal(getConfidenceSource(), "logprobs", "一開始應該打算用 logprobs");
});

const realFetch = global.fetch;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// 記錄每次呼叫實際送出的表單欄位，讓測試能斷言「那個參數有沒有被拿掉」
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const fields = {};
    for (const [k, v] of opts.body.entries()) {
      if (fields[k] === undefined) fields[k] = [];
      fields[k].push(typeof v === "string" ? v : "<blob>");
    }
    calls.push(fields);
    return handler(fields, calls.length);
  };
  return calls;
}

test.afterEach(() => {
  global.fetch = realFetch;
});

// ── 錯誤訊息的判讀 ─────────────────────────────────────────

test("detectUnsupportedParam：認得出 OpenAI 各種說法裡的參數名", () => {
  assert.equal(
    detectUnsupportedParam("response_format 'verbose_json' is not compatible with model 'gpt-transcribe'. Use 'json' or 'text' instead."),
    "response_format"
  );
  assert.equal(
    detectUnsupportedParam('{"error":{"message":"Unsupported parameter: logprobs","type":"invalid_request_error"}}'),
    "logprobs"
  );
  assert.equal(
    detectUnsupportedParam('{"error":{"message":"Unknown parameter: keywords"}}'),
    "keywords"
  );
});

test("detectUnsupportedParam：認不出來時回 null（避免把真正的錯誤當成參數問題無限重試）", () => {
  assert.equal(detectUnsupportedParam("The model `gpt-transcribi` does not exist"), null);
  assert.equal(detectUnsupportedParam("Rate limit reached"), null);
  assert.equal(detectUnsupportedParam(""), null);
});

// ── 降級重試 ───────────────────────────────────────────────

test("logprobs 不被支援時自動拿掉重試，功能不會整個死掉", async () => {
  const calls = stubFetch((fields, n) => {
    if (n === 1) {
      assert.ok(fields["include[]"], "第一次應該要送 logprobs");
      return jsonResponse({ error: { message: "Unsupported parameter: logprobs" } }, 400);
    }
    assert.equal(fields["include[]"], undefined, "重試時應該把 logprobs 拿掉");
    return jsonResponse({ text: "明天早上八點集合" });
  });

  const res = await requestTranscriptionViaOpenAI(Buffer.from("fake"), {});

  assert.equal(res.text, "明天早上八點集合");
  assert.equal(calls.length, 2, "應該只重試一次");
  assert.equal(res.avgLogprob, null, "拿不到 logprobs，信心度那一層就是空的");
});

test("同一個不支援的參數只會探測一次，之後的請求直接不送", async () => {
  // 承接上一個測試留下的狀態：logprobs 已經被記為不支援
  const calls = stubFetch(fields => {
    assert.equal(fields["include[]"], undefined, "已知不支援就不該再送");
    return jsonResponse({ text: "第二則語音" });
  });

  const res = await requestTranscriptionViaOpenAI(Buffer.from("fake"), {});

  assert.equal(res.text, "第二則語音");
  assert.equal(calls.length, 1, "不該每則語音都白白失敗一次再重試");
  assert.equal(getConfidenceSource(), "none", "信心度來源要如實反映目前的狀態");
});

test("模型名稱打錯時不會無限重試，會丟出錯誤", async () => {
  const calls = stubFetch(() =>
    jsonResponse({ error: { message: "The model `gpt-transcribi` does not exist" } }, 400)
  );

  await assert.rejects(
    () => requestTranscriptionViaOpenAI(Buffer.from("fake"), {}),
    /轉錄失敗 HTTP 400/
  );
  assert.equal(calls.length, 1, "認不出參數就直接失敗，不要重試");
});

test("非 400 的錯誤直接往上拋，不進降級流程", async () => {
  const calls = stubFetch(() => jsonResponse({ error: { message: "server error" } }, 500));

  await assert.rejects(
    () => requestTranscriptionViaOpenAI(Buffer.from("fake"), {}),
    /轉錄失敗 HTTP 500/
  );
  assert.equal(calls.length, 1);
});

test("成功時會把 logprobs 換算成平均信心度", async () => {
  stubFetch(() =>
    jsonResponse({
      text: "測試",
      logprobs: [{ logprob: -0.1 }, { logprob: -0.3 }],
    })
  );

  const res = await requestTranscriptionViaOpenAI(Buffer.from("fake"), {});

  assert.equal(Math.abs(res.avgLogprob - -0.2) < 1e-9, true);
});
