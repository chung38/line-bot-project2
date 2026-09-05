# line-bot-project2

LINE 多語言翻譯機器人 + 會員中心（付費訂閱、藍新金流）+ 後台管理面板。

支援語言：英文、泰文、越南文、印尼文、繁體中文。翻譯呼叫 OpenAI（模型由 `OPENAI_MODEL` 指定），
資料儲存在 Firebase Firestore。

## 環境需求

- Node.js 18 以上
- 一個 Firebase 專案（Firestore + Service Account 金鑰）
- 一個 LINE Messaging API channel
- 一個藍新金流（NewebPay）特約商店（用於會員訂閱付款）
- 一組 OpenAI API key

## 開始之前

1. 安裝依賴：

   ```bash
   npm install
   ```

2. 複製 `.env.example` 為 `.env`，把裡面的空值都填上實際的值。標「必要」的變數
   少填任何一個，服務啟動時就會直接印錯誤訊息並結束（見 `lib/env.js`）。

3. 啟動：

   ```bash
   npm start        # 一般啟動
   npm run dev       # nodemon，改檔案自動重啟（開發用）
   ```

4. 在 LINE Developers Console 把 webhook URL 設成
   `https://你的網域/webhook`，並開啟 Webhook。

5. 部署 Firestore 安全規則（見下方「Firestore 安全規則」一節），這件事跟部署程式碼
   是分開的，光是 repo 裡有 `firestore.rules` 檔案不會自動生效。

## 專案結構

```
server.js          入口檔：只負責把各模組接起來、啟動 process，不放業務邏輯
lib/                跟外部服務對接的基礎設施
  env.js              環境變數檢查（最先執行，其他模組會依賴這裡的檢查結果）
  firestore.js        Firebase Admin 初始化、db、express-session 用的 Firestore session store
  line.js             LINE Messaging API client
  newebpay.js         藍新金流 AES/SHA 加解密
  i18n.js             語言常數與回覆文案
  utils.js            日期/月份/數字轉換、debugLog
  adminLog.js         後台操作紀錄（adminLogs collection）
  lifecycle.js        追蹤背景工作、SIGTERM 時排乾，見下方「優雅關閉」
  state.js            群組層級的共用狀態（語言/邀請人/行業別/封鎖清單），
                       含 Firestore 即時監聽的多 instance 同步，細節見檔案內註解
services/           跟平台無關的商業邏輯
  subscription.js     訂閱狀態機、用量計算、付款訂單狀態
  group.js            群組操作權限、LINE 訊息回覆輔助
  translateLogic.js   翻譯相關的純函式（語言偵測、mention 遮罩/還原、zh-TW 輸出驗證）
                       —— 不依賴 Firebase，可以直接寫單元測試
  translate.js        呼叫 OpenAI 的翻譯邏輯，組裝 prompt，重用 translateLogic.js 的純函式
  transcribe.js       語音訊息轉逐字稿（OpenAI）與幻覺過濾，見下方「語音訊息翻譯」
  ocr.js              圖片訊息取字（視覺模型）與描述過濾，見下方「圖片翻譯」
  maintenance.js      背景清理（過期 session、逾期未付款訂單），由 server.js 定期呼叫
  reminder.js         訂閱到期提醒（到期前 7 天與到期當下，只推管理者 1:1），由 server.js 每天呼叫
routes/             把 services/ 組裝成實際的路由，各自匯出一個 register*Routes(app) 函式
  webhook.js          LINE webhook：事件處理、指令（!啟動 / !設定 / !文宣）
  admin.js            後台管理 API（/admin/*，session 登入）
  member.js           會員中心 API（/api/member/*，Firebase Auth 登入）
public/             前端靜態檔案（會員中心、後台管理面板）
tests/              單元測試（node:test），用假的 Firestore/LINE/OpenAI 注入，
                       涵蓋 services/ 與 routes/webhook.js，helpers/ 放共用的假實作
```

依賴方向固定是 `routes → services → lib`，反過來不行，避免循環依賴。

### 為什麼要拆成這樣

原本整個專案是一個 3000 多行的 `server.js`，路由、Firebase 邏輯、翻譯邏輯、
金流、LINE webhook、admin API 全部混在一起，除錯（例如追查 `@mention` 或
zh-TW 翻譯異常）要在同一個檔案裡跳來跳去找相關程式碼。拆開之後，例如要查
翻譯相關的問題，直接看 `services/translate.js` 和 `services/translateLogic.js`
就好，不會混到金流或後台管理的程式碼。

## 群組狀態與多 instance 同步

`lib/state.js` 裡的群組語言/邀請人/行業別設定是 process 內的記憶體 Map，
啟動時整批從 Firestore 載入，之後同步讀取、非同步寫回。讀取不用 `await`，
webhook 處理路徑上不會有多餘的網路往返。

多台 instance 之間用 Firestore 的即時監聽（`collection.onSnapshot`）同步：
任何一台寫入後，其他 instance 通常在 1 秒內就會收到 `docChanges` 並更新自己的
記憶體。這條路徑不需要把幾十處同步讀取改成 `await`，呼叫端完全不用動。

三個配套機制（實作在 `lib/state.js`）：

1. **本地寫入保護**：自己剛寫出去、Firestore 還沒回寫完成的文件，會暫時忽略
   對同一份文件的遠端快照，避免「自己的新設定被舊快照蓋回去」。
2. **監聽斷線自動重連**：`onSnapshot` 的 error callback 以指數退避重新掛上監聽。
3. **低頻整批重載當保險**（預設 30 分鐘）：萬一監聽無聲無息地失效，最多一個
   週期會自我修正。

`server.js` 只需要呼叫 `startGroupStateSync()`。若環境不允許長連線，設定
`STATE_SYNC_MODE=poll` 就會退回舊行為（只做定期整批重載，預設 5 分鐘）。

服務重啟後仍要等 `loadAllGroupState()` 跑完才有資料（通常一兩秒內）。

## 測試

```bash
npm test
```

測試用 `node:test`，不需要 Firebase 憑證、不會發任何網路請求。三個外部相依
都以假的實作注入（見 `tests/helpers/`）：

- `fakeFirestore.js` — 記憶體版 Firestore，只實作專案實際用到的 API 子集。
  兩個刻意做出來的行為讓測試有意義：`runTransaction` 會排隊執行（模擬交易的
  序列化語意，才測得出併發預扣會不會超用）、`onSnapshot` 會在寫入後推送
  `docChanges`（模擬另一台 instance 的變更）。
- `fakeLineClient.js` — 只記錄 reply/push 呼叫，不真的送訊息。
- `setChatCompletionForTesting()`（`services/translate.js`）— 換掉 OpenAI 呼叫。

涵蓋範圍：

| 測試檔 | 對應模組 |
| --- | --- |
| `tests/utils.test.js` | `lib/utils.js` 日期/月份/數字轉換 |
| `tests/translateLogic.test.js` | 語言偵測、mention 遮罩/還原、輸出驗證等純函式 |
| `tests/translate.test.js` | `services/translate.js` 的重試路徑、prompt 組裝、快取 |
| `tests/group.test.js` | `services/group.js` 綁定規則與回覆輔助函式 |
| `tests/subscription.test.js` | `services/subscription.js` 訂閱狀態機、額度預扣/退回、群組數量上限 |
| `tests/webhook.test.js` | `routes/webhook.js` 指令處理與額度結算 |
| `tests/webhook-audio.test.js` | `routes/webhook.js` 語音路徑：轉錄失敗/幻覺時的額度退回 |
| `tests/transcribe.test.js` | `services/transcribe.js` 長度把關與三層幻覺過濾 |
| `tests/transcribe-params.test.js` | 轉錄參數的能力探測與降級重試（跑 gpt-transcribe 路徑）|
| `tests/webhook-image.test.js` | `routes/webhook.js` 圖片路徑：無文字/描述/太大時的額度退回 |
| `tests/ocr.test.js` | `services/ocr.js` OCR prompt 內容與描述過濾 |
| `tests/member.test.js` | `routes/member.js` 登入把關、checkout 金額來源、藍新通知驗證、解除綁定 |
| `tests/admin.test.js` | `routes/admin.js` 登入/權限/群組設定/訂閱設定（真的起一個 express server） |
| `tests/maintenance.test.js` | `services/maintenance.js` 背景清理該刪什麼、不該刪什麼 |
| `tests/reminder.test.js` | `services/reminder.js` 到期提醒該發給誰、發幾次、何時不該發 |

`tests/admin.test.js` 跟其他測試不一樣：它會真的用 express + express-session
起一個伺服器（監聽隨機埠）再用 fetch 打進去。因為後台的權限判斷是靠 middleware
串起來的，直接呼叫 handler 測不到「沒登入會不會被擋」這種真正重要的行為。
這兩個套件本來就是專案的相依，不需要額外裝 supertest。

## 正式上線（藍新金流）

測試環境與正式環境是**完全不同的兩組**商店代號與金鑰，切換時這四個都要改：

| 變數 | 正式環境的值 |
| --- | --- |
| `NEWEBPAY_MPG_URL` | `https://core.newebpay.com/MPG/mpg_gateway`（測試站是 `ccore`，只差開頭一個 c） |
| `NEWEBPAY_MERCHANT_ID` | 正式商店的商店代號 |
| `NEWEBPAY_HASHKEY` | 正式商店的 HashKey（32 字元） |
| `NEWEBPAY_HASHIV` | 正式商店的 HashIV（16 字元） |

正式環境的金鑰要到 `https://www.newebpay.com`（不是 `cwww`）的商店後台另外申請。
另外 `NODE_ENV=production` 要記得設，否則 session cookie 不會加上 `secure` 旗標。

`BASE_URL` 現在是必要環境變數，啟動時會檢查格式（要有 `http(s)://`、結尾不要加
斜線）。它是用來組出藍新的 `ReturnURL` / `NotifyURL` 的，沒設會送出
`undefined/api/member/payment-notify`——付款頁面照樣開得起來、使用者照樣刷得
下去，但通知永遠回不來、訂閱不會開通。這種「錢收了系統沒反應」的錯很難查，
所以直接擋在啟動階段。

### 付款方式：信用卡 + ATM 轉帳

checkout 送出 `CREDIT: 1` 與 `VACC: 1`，其餘（`WEBATM` / `CVS` / `BARCODE`）明確
設成 0。超商代碼是每筆固定手續費（約 28 元），在月繳這種小額訂單上不划算；
WebATM 需要讀卡機。這些旗標只是「允許顯示」，實際能不能用還是看商店後台有沒有開通。

ATM 的流程跟信用卡不一樣，牽涉到三個地方：

| | 信用卡 | ATM 轉帳 |
| --- | --- | --- |
| 何時知道結果 | 幾秒內 | 使用者稍後自己去轉帳，可能隔幾天 |
| 取號 | 無 | 藍新配發虛擬帳號 → POST 到 `CustomerURL` |
| 訂單狀態 | `pending` → `paid` | `pending` → `awaiting_payment` → `paid` |
| 手續費 | 2.8% | 1% |

`POST /api/member/payment-customer` 就是接取號結果的路由。它會驗簽章、比對商店代號
與金額，然後把銀行代碼、虛擬帳號、繳費期限存進訂單。

**這支路由不代表付款成功**，只是把帳號存下來給會員中心顯示。真正代表「錢到了」的
一直都是 `NotifyURL`（`payment-notify`）。

⚠️ `CustomerURL` 是**瀏覽器導轉**，不是 server-to-server 通知。使用者如果在看到
帳號前就關掉分頁，我們就收不到那組號碼。錢還是收得到、付款通知也照樣會進來，
差別只在會員中心查不到帳號（藍新會另外寄一封信給使用者）。這是 `CustomerURL` 的
先天限制，不是靠重試能解決的。

### 訂單付款期限

`ORDER_PENDING_DAYS`（預設 3 天）取代了原本寫死的 30 分鐘。訂單的 `expiresAt` 會算
到那一天的 23:59:59，跟送給藍新的 `ExpireDate`（YYYYMMDD）對齊，避免「虛擬帳號還
有效、訂單已逾期」的矛盾。

⚠️ 這個天數必須 **>=** 你在藍新後台設定的虛擬帳號繳費期限。

### 收真錢之前還沒有的東西

- **電子發票**：在台灣賣訂閱服務要開統一發票，系統目前沒有這塊。
- **自動續約**：目前是一次性付款，到期後使用者要自己回會員中心再刷一次。
- **退款**：只能到藍新後台手動處理，訂閱狀態要另外用後台的「手動停用」調整。
- **對帳**：藍新的交易查詢 API 沒串。如果 Notify 剛好在服務重啟時送達而遺失，
  那筆訂單會一直卡在 pending，目前只能人工從藍新後台核對。

## 訂閱到期提醒

到期前 7 天與到期當下，各推播一則訊息**給群組管理者本人的 1:1**，不推群組
（`services/reminder.js`，每天執行一次）。設 `EXPIRY_REMINDER=off` 可以完全關閉。

### 為什麼推給管理者而不是群組

LINE 的推播訊息**是按「接收者人數」計費的**：對一個 20 人的群組推一則，會被
算成 20 則（翻譯用的 `replyMessage` 完全不計費）。

原本的設計是「4 個里程碑 × 推到群組」：

| | 舊設計 | 現在 |
| --- | --- | --- |
| 里程碑 | 7 / 3 / 1 天 + 到期 | 7 天 + 到期 |
| 收件人 | 群組（N 人 = N 則） | 管理者 1:1（1 則），推不到就不發 |
| 20 人群組一輪 | 80 則 | **2 則** |
| 中用量方案 3,000 則可養 | 37 個群組 | **1,500 個群組** |

而且續約通知本來就該給付錢的人，不是洗整個產線群組的版——外籍移工看到
「訂閱剩 3 天」也不知道要做什麼。

### 推不到管理者的時候

1:1 推播的前提是對方跟官方帳號有過對話。判斷依據是 `lineUsers/{userId}` 存不
存在——那筆只有在使用者私訊「綁定 <碼>」給官方帳號時才會寫入，所以它存在就
代表 1:1 通道是通的。

只用 `!啟動` 綁定、從沒私訊過官方帳號的管理者推不到。**這種情況一律跳過，
任何里程碑都不會退回推群組**，並留一筆 `EXPIRY_REMINDER_OWNER_UNREACHABLE`
後台紀錄。

留這條退路的話，成本上限就等於交給群組人數決定，而且是在最不會被注意到的
地方——所以它被整個拿掉了，`tests/reminder.test.js` 有一個「任何情況下都不會
推播到 gid」的護欄測試盯著。

略過的情況也會寫去重紀錄，否則排程每天跑一次就會每天寫一筆一模一樣的 log。

⚠️ **代價**：沒完成會員綁定的管理者收不到任何到期通知，群組會直接停掉翻譯。
這個缺口要靠「讓管理者一開始就完成綁定」來補，不是靠提醒補救——見下方
「已知待改進項目」。

### 不能重複發

這個排程會在三種情況下被重複觸發：多台
instance 各自執行、free-tier 平台重啟服務、以及同一個里程碑連續好幾天都符合
條件。所以「有沒有發過」寫在 Firestore 的 `subscriptionReminders`，而且是用
交易寫入的，兩台 instance 同時判斷時不會都認為自己是第一個。

去重的鍵是 `${gid}_${到期日}_${里程碑}`——到期日在鍵裡面，所以續約之後會自然
重新開始提醒，不需要清除舊紀錄。推播失敗時會把佔位紀錄刪掉，下一輪再試。

不會發提醒的情況：機器人已不在群組（推了也只會拿到 403）、後台強制停用的訂閱、
以及到期超過 3 天的——最後這條是為了避免功能剛上線或服務停很久才恢復時，
一口氣對一堆早就過期的舊群組發訊息。

## Firestore 安全規則

`firestore.rules` 目前是「全部拒絕」（`allow read, write: if false`），因為
整個專案的 Firestore 存取都是後端用 Firebase Admin SDK 做的（Admin SDK 不受
這份規則限制），前端從來沒有直接呼叫過 Firestore Client SDK。

**這個檔案本身不會自動生效**，需要另外部署：

```bash
npm install -g firebase-tools
firebase login
firebase use --add     # 選這個專案對應的 Firebase project
firebase deploy --only firestore:rules
```

或是直接到 Firebase Console → Firestore Database → 規則，把 `firestore.rules`
的內容貼上去、按發布。建議部署後去 Console 確認一下線上規則不是新專案常見的
「測試模式」（帶到期日、過期前完全公開讀寫）。

## 優雅關閉（SIGTERM）

部署、擴縮、平台回收 instance 都是先送 `SIGTERM`，之後通常給 30 秒才 `SIGKILL`。
這件事對本專案特別重要，因為 webhook 的流程是：

```
reserveGroupTranslation()        ← 額度在 Firestore 交易裡「先扣掉」
  → res.sendStatus(200)
  → processTranslationInBackground()   ← 背景，可能跑 20 秒以上
      → commitGroupTranslation() / releaseGroupTranslation()
```

中間那段被砍掉的話，額度已經扣了、譯文沒送出、退回也不會執行——使用者付了錢
卻什麼都沒拿到，而且不會留下任何錯誤紀錄。`processTranslationInBackground()`
內部的 `finally` 擋得住例外，擋不住 process 直接消失。

`lib/lifecycle.js` 追蹤所有「已回 200、還在背景跑」的工作，`server.js` 收到
`SIGTERM` / `SIGINT` 時：

1. `beginShutdown()` — webhook 不再受理新翻譯（已預扣的不受影響）
2. `server.close()` — 停止接受新連線，處理中的請求不會被切斷
3. `waitForDrain()` — 等背景翻譯結清額度，預設最多 25 秒

25 秒的來源：翻譯本身逾時是 28 秒，平台寬限期通常 30 秒。寧可讓最後幾則逾時
走正常的退回流程，也不要被 `SIGKILL` 砍在半路。平台寬限期不同時用
`SHUTDOWN_DRAIN_MS` 調整。

排乾逾時會印一則 `⚠️ 排乾逾時` 的 error log——那代表可能有人的額度被扣了卻
沒收到譯文，客訴時要查得到是哪一次部署。

## Token 用量與 log 分級

每次翻譯呼叫都會**無條件**印一行摘要：

```
💰 tokens gpt-5.6-luna → th | prompt=1388 cached=0 write=1385 out=6
```

累計數字在 `/admin/token-usage`，重點欄位是 `relativeInputCost`——以「完全不
快取 = 1」換算的相對 input 成本。`< 1` 代表快取有省到，`> 1` 代表寫入太多、
反而比不快取貴（GPT-5.6 之後快取寫入收 1.25 倍、讀取 0.1 倍，可快取前綴至少
1024 tokens，所以快取從「開了就賺」變成「要算才賺」）。

### ⚠️ log 的隱私分級

這一行刻意用 `console.log`，其他診斷訊息（例如 `🔎 mention restore check`）
用 `debugLog`，兩者**不共用開關**：

| 訊息 | 開關 | 內容 |
| --- | --- | --- |
| `💰 tokens` | 永遠輸出 | 只有數字：token 數、模型、目標語言 |
| `🔎 mention restore check` 等 | `DEBUG=1` 才輸出 | **含使用者訊息原文** |

若兩者共用同一個開關，就變成「想看成本數據 = 必須同時開啟對話內容記錄」——
等於為了對帳把工廠群組的對話持續寫進 log 服務。成本監控是商業化的日常需求，
對話內容外流不是。

`tests/translate.test.js` 有兩個案例釘住這件事：token 摘要在 `DEBUG` 關閉時
仍會輸出，而且格式裡不含任何使用者內容。

## 語音訊息翻譯

群組裡的語音訊息會先轉成逐字稿，再走**跟文字訊息完全一樣**的翻譯流程
（`detectLang` → `resolveTargetLangs` → `translateLineSegments`）。回覆會同時
附上逐字稿與譯文，聽錯或講錯的時候當場就能更正：

```
【張三】語音：
明天早上八點到現場集合

🇹🇭 (泰文譯文)
🇻🇳 (越南文譯文)
```

額度跟文字一樣「一則算 1 次」，跟長度、翻幾種語言都無關。

### 過濾 Whisper 幻覺（`services/transcribe.js`）

這是這個功能最重要的部分。Whisper 這類模型在**沒有語音內容**的音檔上不會回空
字串，它會生出完全不存在的句子——中文最典型的是「謝謝觀看」「字幕由 XXX 提供」
這種從大量影片字幕訓練資料殘留下來的內容。

工廠群組正是高頻情境：背景機台噪音、誤觸錄音鍵、收音失敗。而失敗的樣子很糟——
群組裡冒出一句沒人講過的話，還被翻成四種語言推給所有人，使用者完全無從判斷。

所以有三層防護：

| 層 | 做什麼 | 擋不掉什麼 |
| --- | --- | --- |
| 長度 | `MIN_AUDIO_MS`（預設 1 秒）以下不送轉錄 | 有長度但全是噪音的 |
| 信心度 | 模型自己都沒把握的輸出不拿去翻譯。訊號依模型而異，見下表 | 真的有人講話但模型聽錯的 |
| 片語清單 + 重複迴圈 | `HALLUCINATION_PATTERNS` 用「整句完全等於」比對，避免誤殺「謝謝」這種正常對話 | 清單以外的新幻覺 |

#### 換轉錄模型時要注意的事

`OPENAI_TRANSCRIBE_MODEL` 兩個系列程式都支援，但**信心度那一層的訊號不同**，
程式會依模型自動切換：

| 模型 | `response_format` | 信心度訊號 | 門檻變數 |
| --- | --- | --- | --- |
| `whisper-1` | `verbose_json` | `segments[].no_speech_prob` | `AUDIO_NO_SPEECH_THRESHOLD`（0.6） |
| `gpt-transcribe`<br>`gpt-4o-transcribe`<br>`gpt-4o-mini-transcribe` | `json` + `include[]=logprobs` | `logprobs[].logprob` 平均 | `AUDIO_MIN_AVG_LOGPROB`（-1.0） |

只有 whisper 系列拿得到 `no_speech_prob`。其他模型如果沒換信心度來源，那一層
防護會**安靜地變成空的**，`evaluateTranscript()` 只剩片語清單擋著。

`AUDIO_MIN_AVG_LOGPROB` 的門檻沒有標準答案，要靠實際觀察調整。預設 -1.0 刻意
保守：寧可漏放幾句雜訊，也不要吃掉真的有人講的話。

#### 能力探測：為什麼不寫死模型能力表

OpenAI 的轉錄模型推出速度比文件更新快（`gpt-transcribe` 是 2026-07-28 才有的），
各模型支援的可選參數也不一樣而且會變。任何寫死在程式裡的能力表遲早會過期，
而過期的症狀是「語音翻譯整個沒反應」——非常難查。

所以 `requestTranscriptionViaOpenAI()` 的策略是**先送再說**：

```
送出可選參數（logprobs / keywords / prompt）
  → 400 且錯誤訊息認得出是哪個參數
      → 記進 unsupportedParams，拿掉重試，並在 log 印出停用了什麼
  → 400 但認不出參數
      → 多半是模型名稱打錯，印明顯提示後直接失敗（不重試）
```

同一個參數只會探測一次，不會每則語音都白白失敗一次。`getConfidenceSource()`
會回報目前實際生效的信心度來源（`no_speech_prob` / `logprobs` / `none`），
部署後看一眼就知道那一層是不是空的。

#### 逐字提示（`TRANSCRIBE_KEYWORDS`）

`gpt-transcribe` 支援 `keywords`（逐字提示）與 `prompt`（情境描述）。對工廠場景
特別有用——機台型號、料號、人名地名正是最容易聽錯的東西，而人名地名恰好也是
翻譯 prompt 裡特別規定要保留的（見「翻譯規則」）。

```
TRANSCRIBE_KEYWORDS=大甲廠,射出機,SMT,料號,林班長
TRANSCRIBE_PROMPT=這是工廠產線群組的對話，會夾雜台語與越南語。
```

模型不支援這些參數的話會自動停用並在 log 提示，不會讓功能壞掉。

#### gpt 系列多一種失敗模式

`gpt-*-transcribe` 是 LLM 架構，不是純 ASR。它可能「回應」音檔內容而不是照抄，
或吐出「抱歉，我無法轉錄這段音檔」這類助理式回覆——whisper 不會有這種行為。
`ASSISTANT_REPLY_PATTERNS` 專門擋這個。

比對刻意抓得很緊，要「拒絕的句型」整組出現才算：工廠群組裡「抱歉我遲到了」
「抱歉剛剛沒聽到」是正常對話，誤殺的代價比漏放高。測試裡有一組專門確認這些
不會被誤殺。

還有一個擋不掉的殘留風險：有人對著麥克風唸「請說：某某某」，LLM 系列可能真的
照做。緩解方式是逐字稿會跟譯文一起顯示，群組看得到實際產出了什麼，而且長度
與額度都有上限。

第一層的片語清單一定會有遺漏，發現新的就往 `HALLUCINATION_PATTERNS` 加。比對刻意用
「整句等於」而不是「包含」——`tests/transcribe.test.js` 有專門的案例確認
「謝謝你幫忙」「謝謝觀看這台機器的操作示範」不會被誤殺。

被過濾掉的語音**不回覆、不扣額度**（預扣會退回）。群組裡冒出「你剛剛那則語音
我聽不懂」比安靜跳過更擾人。

### 防濫用：三道護欄

「有人刻意錄很長的音檔」是這個功能最直接的攻擊面。三道護欄，重要性由高到低：

| 護欄 | 預設 | 為什麼需要 |
| --- | --- | --- |
| `MAX_AUDIO_BYTES` | 8MB | **真正擋得住的那道。** 邊讀邊數，超過就當場中止下載並丟棄 |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | 3 | 額度管的是每月總量，擋不住同一秒湧進來一堆 |
| `MAX_AUDIO_SECONDS` | 60 | 便宜的提前擋掉，能省一次下載——但**不能當成唯一護欄**，見下 |

#### ⚠️ `duration` 靠不住

LINE 的 audio 訊息規格裡，`duration` 標註為 **Not always included**——webhook
事件不會帶上沒有值的屬性。所以「拿不到 duration」是正常情況，不是異常。

這代表只看 `duration` 的長度檢查會被沒有這個欄位的長音檔整個穿過去。真正擋得住
的是位元組上限：位元組是我們自己一塊一塊數出來的，造不了假。

`streamToBufferWithLimit()` 是**邊讀邊數**，不是讀完再檢查——後者的話一個
200MB 的檔案還是會被整份讀進記憶體，檢查只是在事後告訴你剛剛差點死掉。

#### 為什麼要限制並行數

額度限制的是「每月總量」，擋不住「同一秒湧進來」。連續丟 20 則語音 = 20 個並行
下載 + 20 份音檔同時佔記憶體 + 20 個 Whisper 請求，在小規格的機器上足以把
process 打掛。

超過上限的語音**直接跳過，不排隊**——排隊只會讓 `replyToken` 過期，使用者一樣
拿不到東西，卻多付了成本。名額在**扣額度之前**取得，所以被擋掉的語音不會浪費
使用者的額度。

#### 下載逾時

`getMessageContent()` 沒有內建逾時，而 LINE 對還在轉檔的大檔案會回 `202` 而不是
音檔內容。沒有逾時的話，背景任務會永遠掛著：額度停在「已預扣、未結算」，關機時
`waitForDrain()` 也會被它拖滿整個排乾時間。`AUDIO_FETCH_TIMEOUT_MS` 預設 15 秒。

### 為什麼有長度上限

`MAX_AUDIO_SECONDS`（預設 60）同時是成本與延遲的護欄。轉錄是**按秒計費**的額外
成本，而額度只算 1 次；同時轉錄要花幾秒，疊在翻譯的 28 秒逾時上，太長的語音容易
撞到 LINE `replyToken` 過期——過期就整則靜靜消失（回覆免費、推播要錢，所以
`safeReply` 刻意不退回 push）。

超過上限會回覆說明並請使用者分段，不扣額度。

### ⚠️ 背景任務不要用 `console.log`

`processVoiceTranslationInBackground()` 裡的診斷訊息走 `debugLog()`（stderr／
只在 `DEBUG` 開啟時輸出），不是 `console.log()`。

原因是 `node --test` 用子行程的 **stdout** 傳測試協定。語音的背景任務會在
「測試已經結束之後」才寫 stdout，那會打亂協定串流，整個測試檔以
`Unable to deserialize cloned data due to invalid or unsupported version.` 失敗，
而且錯誤訊息完全看不出跟那行 log 有關。`console.error`（stderr）不受影響。

## 圖片翻譯

群組裡的圖片會先用視覺模型把圖中的文字抽出來（OCR），再走**跟文字訊息完全一樣**
的翻譯流程。回覆的形狀跟語音一致，原文與譯文並陳：

```
【張三】圖片文字：
禁止進入
施工中

🇹🇭 (泰文譯文)
🇻🇳 (越南文譯文)
```

額度跟文字、語音一樣「一張圖算 1 次」。

⚠️ 一次傳多張圖片時，LINE 會送出**多個各自獨立的事件**（帶 `imageSet`），
所以是「一張圖 = 一次額度 = 一則回覆」。傳 5 張就是 5 次、5 則回覆。

### 預設是關閉的

沒有設定 `OPENAI_VISION_MODEL` 就完全不啟用，圖片訊息會像以前一樣被忽略。

刻意不給預設值：視覺模型的可用名稱會隨時間變動，寫死一個預設值在程式裡，等它
某天下架，錯誤會以「圖片翻譯莫名其妙全部失敗」的形式出現，很難查。要用就明確
指定一個你確認過、支援圖片輸入的模型。

### 過濾「描述」而不是「文字」（`services/ocr.js`）

這是這個功能最重要的部分，性質跟語音的幻覺過濾一樣。

工廠群組裡的圖片**大多數根本沒有文字**：壞掉的機台零件、現場照片、午餐。而視覺
模型天生傾向「描述」而不是「照抄」——你問它圖裡有什麼字，它很容易回「這是一張
顯示機台故障的照片」。那句描述會被當成原文翻成四種語言推給整個群組，使用者完全
無從判斷那是誰寫的。

兩道防線：

1. **prompt**：明確要求原樣照抄、禁止描述，並約定「沒有文字就只輸出 `NO_TEXT`」。
   `tests/ocr.test.js` 直接對 prompt 本身斷言——prompt 壞掉不會有任何錯誤訊息，
   只會安靜地開始翻譯圖片描述，所以那幾條規則有沒有掉必須用測試盯著。
2. **`looksLikeDescription()`**：擋掉「這是一張…」「圖片中…」「抱歉，我無法…」
   `This image shows…` 這類典型開頭。用**開頭比對**而不是包含比對，避免誤殺真的
   印在看板上的字（有測試確認「這區域請配戴安全帽」「圖書室 二樓」不會被誤殺）。

被過濾掉的圖片**不回覆、不扣額度**。這一點對圖片比對語音更重要：沒有文字的圖片
是常態，每張機台照片都回一句「沒有偵測到文字」會把群組洗爆。

### 兩道成本護欄

| 護欄 | 預設 | 擋什麼 |
| --- | --- | --- |
| `MAX_IMAGE_BYTES` | 4MB | 視覺模型按解析度計費，超大圖成本可能是文字翻譯的好幾倍，額度卻只算 1 次 |
| `MAX_TRANSLATE_CHARS` | 1500 | OCR 完的文字沿用文字訊息的上限。一整頁公告或規格書 OCR 出來可能好幾千字 |

OCR 用 `detail: "high"`，這是必要的——`low` 會把圖縮到很小，看板上的小字會整片
消失，等於功能失效。

## 單則訊息長度上限

額度是「一則訊息 = 1 次」，跟訊息長度、翻成幾種語言都無關。LINE 單則文字訊息
可以到 5000 字，勾 4 種語言就是一次 20000+ 字的 API 呼叫，帳單上卻只算一次額度。

`MAX_TRANSLATE_CHARS`（預設 1500）超過就直接回覆提示，**不扣額度、不呼叫
OpenAI**。長度檢查刻意放在 `reserveGroupTranslation()` 之前——使用者不該為一則
被我們拒絕處理的訊息付錢。

## 已知待改進項目

- **管理者沒完成會員綁定就收不到到期通知**。提醒只走管理者 1:1（成本考量，
  見上方「訂閱到期提醒」），所以只用 `!啟動` 綁定、從沒私訊過官方帳號的管理者
  等於完全沒有通知，服務會安靜停掉。正解是在 `!啟動` 成功的回覆裡就把管理者
  導去私訊官方帳號完成綁定（`routes/webhook.js`），而不是在提醒端補救。
  後台的 `EXPIRY_REMINDER_OWNER_UNREACHABLE` 紀錄可以先當作人工追蹤的清單。

- **管理者沒綁定就收不到到期通知**。到期提醒只走 1:1，推不到就跳過（見上方
  「訂閱到期提醒」）。目前 `!啟動` 成功的回覆沒有請管理者去完成會員綁定，
  所以這個缺口的大小完全取決於有多少人自己走進會員中心。兩個可以補的地方：
  (1) `!啟動` 成功時就引導綁定；(2) 訂閱到期後群組還有人講話時，用
  **`replyMessage`**（不計費）回一句「訂閱已到期」——那是唯一一條能到達群組
  又不花訊息額度的路徑，但要自己做節流，否則會對每一則訊息都回。
- **電子發票、自動續約、退款、對帳**（見上方「收真錢之前還沒有的東西」）。
- **額度預扣是以「一則訊息 = 1 次」計算**，跟實際翻成幾種語言無關。要改成按語言
  數計費的話，`reserveGroupTranslation()` 已經支援傳入 `translationCount`，但目標
  語言是在背景處理才算出來的，呼叫順序要一起調整。這是計價方式的商業決定，
  沒有動它。
- **`subscriptionReminders` 沒有清理機制**。一個群組一個訂閱週期最多 4 筆，
  量很小，暫時沒放進 `services/maintenance.js`；如果之後群組數量大幅成長，
  可以照那邊的模式加一個刪除一年前紀錄的工作。
- **`npm audit` 剩一項 moderate**：`uuid` 在 `google-gax` 的依賴鏈裡。已實測過
  升級到 `firebase-admin@13` 也不會解掉（google-gax 自己鎖著舊版 uuid），
  所以沒有做這個 major 升級。該漏洞只在呼叫 uuid 時傳入 `buf` 參數才會觸發，
  本專案沒有這種用法。
- **PDF 翻譯（版面保留）** 仍在另一條線上處理，尚未併進這個 repo。

## 修正紀錄

以下是先前列在「已知待改進項目」、目前已經修掉的項目：

- **多 instance 同步**：改用 Firestore `onSnapshot` 即時監聽，見上方章節。
- **測試覆蓋率**：補上 `services/subscription.js`、`services/group.js`、
  `services/translate.js`、`routes/webhook.js` 的測試，共 93 個案例。
- **`maxGroups` 設定沒有作用**：`ensureInviterIfMissing()` 現在會呼叫
  `canBindMoreGroups()` 檢查上限（0 代表不限制），超過時拒絕綁定並寫一筆
  `BIND_LIMIT_REACHED` 的後台紀錄。後台那三個欄位現在是真的生效的。
- **額度事後扣可能超用**：改成「先扣再翻、失敗時退回」。預扣
  （`reserveGroupTranslation()`）在 Firestore 交易裡完成，同一瞬間湧入的訊息
  會被序列化，不可能超用；翻譯成功只補記字元數（`commitGroupTranslation()`），
  失敗／逾時／沒有目標語言則退回（`releaseGroupTranslation()`）。
  `monthKey` 由預扣時決定並一路帶著，跨月不會退到下個月的計數上。
### 第八批（模型切換相容性）

換成 `gpt-5.4-mini` 之後翻譯全部失敗，原因不是模型名稱打錯，而是 GPT-5 系列是
**推理模型**，Chat Completions 的參數規格跟 GPT-4.x 不同：

| | GPT-4.x | GPT-5 系列 |
| --- | --- | --- |
| 輸出長度上限 | `max_tokens` | `max_completion_tokens`（送 `max_tokens` 會回 400） |
| `temperature` | 支援 | 部分版本不支援 |
| 推理 | 無 | 會消耗 token 額度，需要 `reasoning_effort` |

改動：

- **模型改用 `OPENAI_MODEL` 環境變數**（預設 `gpt-4.1-mini`），換模型不用動程式碼。
- **依模型自動切換參數**：`isReasoningModel()` 判斷後由 `buildRequestPayload()` 組出
  對的欄位名稱。
- **明確設 `reasoning_effort: "none"`**：翻譯不需要推理，而且推理會吃掉
  `max_completion_tokens` 的額度——用完的話回來的 `content` 是空字串，
  只會看到「翻譯失敗」卻查不出原因。這種情況現在會印出明確的 log。
- **被拒絕的參數會自動移除後重試**：OpenAI 每隔幾個月就會改一次參數規格，
  寫死「哪個模型支援哪個參數」遲早會過期。現在收到
  `unsupported_parameter` 就把那個參數拿掉再送一次，並留一筆 warning。

### 第七批（翻譯 prompt 整理）

- **移除重複的 `${industryContext}`**：一般版 prompt 裡產業脈絡被貼了兩次。
  重複的指令會被模型當成特別強調，可能讓日常對話也被硬套產業術語。
- **合併重疊的規則**：原本的規則 4 與規則 5 有一半內容相同（型號、批號、料號、
  工單號、ERP 代碼、URL、Email、數字、日期、時間），合併成一條並改用清單排版。
- **加回人名/地名的保留規則**：中文姓氏與地名的字本身有意義，沒有這條規則
  「林先生」「大甲廠」會被照字面翻成「森林」「大盔甲」，這在工廠群組是高頻情境。
- **縮短過長的規則**：原本一句話塞了 7 個名詞類別加 6 個禁止目標，模型對這種
  超長規則的遵循率不好，改成一句短的（「只翻譯原文寫出來的內容」）。
- **新增 prompt 結構測試**（`tests/translate.test.js`）：驗證產業脈絡只出現一次、
  規則編號連續不重複、沒有整行重複、關鍵保留規則沒有掉。這類錯誤在翻譯結果上
  不會立刻看出來，只能從 prompt 本身檢查——重複貼上那次就是這樣溜過去的。

### 第六批（ATM 轉帳）

- **開放 ATM 轉帳**（`VACC: 1`），新增 `POST /api/member/payment-customer` 接取號
  結果，新增訂單狀態 `awaiting_payment`。細節見上方「付款方式」。
- **訂單付款期限改成以天計算**（`ORDER_PENDING_DAYS`，預設 3 天），跟藍新的
  `ExpireDate` 對齊。背景清理的逾期掃描同步涵蓋 `awaiting_payment`。
- **會員中心顯示轉帳資訊**：銀行代碼、虛擬帳號、金額、繳費期限。新增
  `GET /api/member/orders` 讓使用者不需要記得訂單編號也查得到——虛擬帳號是稍後
  才會用的東西，使用者一定會關掉分頁再回來。

### 第五批（上線前）

- **`BASE_URL` 改為必要環境變數**，並在啟動時檢查格式。
- **修正 `.env.example` 的錯誤註解**：原本寫「`NEWEBPAY_MPG_URL` 預設是正式環境
  網址」，但程式的預設值其實是測試站 `ccore`。照原註解操作會一直在打測試環境。
- **checkout 限定信用卡**（見上方「正式上線」）。
- **新增訂閱到期提醒**（見上方「訂閱到期提醒」）。

### 第四批（後台可用性）

- **封鎖清單顯示群組名稱**：以前只顯示一串 gid，看不出是哪個群組。名稱在「封鎖
  當下」就抓下來存進 `deletedGroups`——因為封鎖之後機器人通常已被移出群組，
  那時再呼叫 `getGroupSummary()` 就查不到了。這個功能上線前的舊紀錄會在開啟
  封鎖清單時補查一次並回寫，機器人已經離開的群組則顯示「名稱無法取得」。
  刪除與恢復的確認視窗也一併改成顯示名稱。

### 第三批（清理待改進項目）

- **綁定上限改成交易保護**：`reserveGroupBinding()` 把「數目前綁了幾個 + 寫入
  這一筆」包在同一個 Firestore 交易裡，多個群組同時輸入 `!啟動` 不會再雙雙通過
  檢查而超出上限。外面包一層 `withInviterWriteGuard()`，多 instance 的即時監聽
  也不會用舊快照蓋掉剛寫進去的綁定。
- **新增背景清理**（`services/maintenance.js`，每 6 小時一次）：刪除過期的
  `expressSessions`、把逾期未付款的 `paymentOrders` 標成 `expired`、刪除 180 天前
  的未成交訂單。已付款的訂單一律保留；逾期訂單只標記不刪除，銀行端延遲送達的
  成功通知仍然對得到單。每輪只處理一批（預設 200 筆），清理失敗只印 log，
  不影響正常服務。
  > 如果你的 Firebase 專案可以設 TTL 政策，對 `expressSessions` 的 `expires`
  > 欄位設一個 TTL 會比這裡的清理更省錢，那時可以用
  > `startMaintenanceJobs({ sessions: false })` 關掉那一項。
- **會員端 API 掛上 rate limiter**：登入與產生綁定碼 30 次／15 分鐘、一般 API
  120 次／分鐘、建立訂單 20 次／10 分鐘。`payment-notify` 刻意不掛——它是藍新
  主動送來的，被擋掉會導致已付款卻沒開通，而且它本身有簽章驗證把關。
- **`session-login` 加上 `email_verified` 檢查**：目前只開放 Email Link 登入
  （一定是 verified），這個檢查是為了之後有人加開密碼登入的情況。
- **補上 `routes/admin.js` 與 `services/maintenance.js` 的測試**，並為
  Firebase Auth 的 token 驗證加了測試注入點（`setIdTokenVerifierForTesting`），
  讓登入把關的邏輯測得到。測試總數從 112 增加到 147。

### 第二批（安全性與計費）

- **付費方案的價格／月數／額度不再寫死**：原本 `routes/member.js` 的 checkout 與
  付款通知各自寫死 300／3000，後台的 `paidMonthlyQuota` 完全沒被讀取，導致月繳
  客戶拿到的額度跟試用一樣是 300。現在統一由 `resolvePaidPlanConfig()` 從後台
  設定算出來，後台也新增了「月繳售價／年繳售價／年繳月數」三個欄位。
  訂單成立時會把當下的方案內容一起存進 `paymentOrders`，之後改設定不會影響
  已成立的訂單。
- **藍新付款通知加上商店代號與金額驗證**：`MerchantID` 不是本商店、或入帳金額
  跟訂單金額不符時一律不開通，並各留一筆 `PAYMENT_MERCHANT_MISMATCH` /
  `PAYMENT_AMOUNT_MISMATCH` 的後台紀錄。
- **登入改為換發 session id（session fixation 防護）**：後台與會員端登入都先
  `regenerate()` 再寫入登入狀態；後台登出也從「把旗標設 false」改成真的
  `destroy()`。
- **會員中心新增「解除綁定」**：`DELETE /api/member/groups/:gid`。原本上限提示
  叫使用者去解除綁定，但根本沒有這個功能。解除時會連語言設定一起清掉（否則
  群組會繼續翻譯吃額度卻不算進上限），訂閱期限保留，之後重新 `!啟動` 可接回。
- **群組上限判定改看 `groupSubscriptions.ownerUserId`**：原本從 `groupInviters`
  判斷方案等級，但機器人被踢出群組時那筆會被清掉，導致付費用戶的上限掉回試用
  等級。數量計算仍以實際綁定中的群組為準。
- **相依套件更新**：`npm audit fix` 修掉 4 個 high、6 個 moderate
  （含 `jws` 的 JWT 簽章問題，在 `verifyIdToken` 的依賴鏈上）。
- **移除 `incrementGroupUsage()`**：改成先扣再翻之後已無呼叫端，留著會跟預扣機制
  打架造成重複計數。
- **`RAW official mention` 的 log 改走 `debugLog()`**：那行會印出 LINE userId。
- **`PING_URL` 未設定時不再每 10 分鐘打 localhost 洗 log。**

### 第一批（功能與測試）

- **retry 對非 zh-TW 無效、且失去產業脈絡**：改用
  `isInvalidTranslation(src, out, targetLang)`，每個目標語言都有對應的判斷規則
  （漢字/泰文/拉丁）；重試用的極簡 prompt 現在也會帶入 `industryContext`。
