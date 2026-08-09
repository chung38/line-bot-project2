# line-bot-project2

LINE 多語言翻譯機器人 + 會員中心（付費訂閱、藍新金流）+ 後台管理面板。

支援語言：英文、泰文、越南文、印尼文、繁體中文。翻譯呼叫 OpenAI（gpt-4.1-mini），
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
  state.js            群組層級的共用狀態（語言/邀請人/行業別/封鎖清單），
                       含定期重新整理機制，細節見檔案內註解
services/           跟平台無關的商業邏輯
  subscription.js     訂閱狀態機、用量計算、付款訂單狀態
  group.js            群組操作權限、LINE 訊息回覆輔助
  translateLogic.js   翻譯相關的純函式（語言偵測、mention 遮罩/還原、zh-TW 輸出驗證）
                       —— 不依賴 Firebase，可以直接寫單元測試
  translate.js        呼叫 OpenAI 的翻譯邏輯，組裝 prompt，重用 translateLogic.js 的純函式
routes/             把 services/ 組裝成實際的路由，各自匯出一個 register*Routes(app) 函式
  webhook.js          LINE webhook：事件處理、指令（!啟動 / !設定 / !文宣）
  admin.js            後台管理 API（/admin/*，session 登入）
  member.js           會員中心 API（/api/member/*，Firebase Auth 登入）
public/             前端靜態檔案（會員中心、後台管理面板）
tests/              單元測試（node:test），只測 services/translateLogic.js 和 lib/utils.js
                       這種不依賴 Firebase/LINE 的純函式
```

依賴方向固定是 `routes → services → lib`，反過來不行，避免循環依賴。

### 為什麼要拆成這樣

原本整個專案是一個 3000 多行的 `server.js`，路由、Firebase 邏輯、翻譯邏輯、
金流、LINE webhook、admin API 全部混在一起，除錯（例如追查 `@mention` 或
zh-TW 翻譯異常）要在同一個檔案裡跳來跳去找相關程式碼。拆開之後，例如要查
翻譯相關的問題，直接看 `services/translate.js` 和 `services/translateLogic.js`
就好，不會混到金流或後台管理的程式碼。

## 群組狀態與多 instance 的限制

`lib/state.js` 裡的群組語言/邀請人/行業別設定是 process 內的記憶體 Map，
啟動時整批從 Firestore 載入，之後同步讀取、非同步寫回。這代表：

- 服務重啟後，要等 `loadAllGroupState()` 跑完才有資料（通常一兩秒內）。
- 如果之後要開多台 instance，各 instance 的記憶體彼此不會即時同步。目前用
  `startPeriodicStateRefresh()`（預設每 5 分鐘）做緩解，最多等一個週期就會跟
  資料庫同步，但不是即時的。

如果之後真的要上多台 instance 且需要即時同步，正確做法是把這些 Map 換成
「每次讀都查 Firestore、外面包一層短 TTL 快取」，但那需要把所有同步讀取
（例如 `groupLang.get(gid)`）幾十處呼叫全部改成 `await`，影響範圍大，
建議另外排一輪、而且要在有真實環境可以實際測試的情況下再做。詳細取捨說明
寫在 `lib/state.js` 檔案開頭。

## 測試

```bash
npm test
```

目前的測試只涵蓋 `services/translateLogic.js`（語言偵測、mention 遮罩/還原、
zh-TW 輸出驗證這幾個之前實際除錯過的地方）和 `lib/utils.js`（日期/月份/數字
轉換）。這兩個檔案刻意不 import 任何需要 Firebase 憑證的模組，所以測試可以
直接跑，不需要 mock 或假的 `.env`。

其他大部分邏輯（`services/subscription.js`、`services/group.js`、
`routes/*.js`）都會牽動 Firestore/LINE API，需要更完整的 mock 或一個測試用的
Firebase 專案才能好好測試，目前還沒有涵蓋——如果要繼續補測試，這是下一個
可以做的地方。

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

## 已知待改進項目

- 群組狀態的多 instance 同步（見上方「群組狀態與多 instance 的限制」）。
- 測試覆蓋率：目前只覆蓋不依賴外部服務的純函式，`services/subscription.js`、
  `services/group.js`、`routes/*.js` 這些牽動 Firestore/LINE 的部分還沒有測試。
- **`maxGroups` 設定目前沒有作用**：後台訂閱設定頁可以填 `trialMaxGroups` /
  `paidMaxGroups` / `manualMaxGroups`，也會存進 Firestore，但後端沒有任何一處
  讀取它們來限制綁定數量，使用者可以無限綁定群組。要嘛在
  `ensureInviterIfMissing()` 裡加上檢查（用 `getBoundGroupsByInviter()` 算數量），
  要嘛把後台那三個欄位拿掉——現況是管理員以為設定生效、實際上沒有，容易誤判。
- **額度是「事後扣」，可能小幅超用**：`canUseGroup()` 先檢查額度、翻譯完才
  `incrementGroupUsage()`。因為 webhook 是先回 200 再背景處理，短時間湧入多則
  訊息時它們會全部通過檢查（當下計數都還沒加），之後才一起累加，所以額度
  3000 的群組有可能衝到 3010 左右。如果需要精準計費，要改成「先扣再翻、
  失敗時退回」。
- `services/translate.js` 的 retry 機制：`forceStrict` 對所有語言都會套用極簡
  prompt，但觸發它的 `isInvalidZhTwTranslation()` 只對 zh-TW 有效，所以其他語言
  的 retry 路徑實際上永遠不會執行。另外極簡 prompt 沒有帶入 `industryContext`，
  重試時會失去產業術語脈絡。
