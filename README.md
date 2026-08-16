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
                       含 Firestore 即時監聽的多 instance 同步，細節見檔案內註解
services/           跟平台無關的商業邏輯
  subscription.js     訂閱狀態機、用量計算、付款訂單狀態
  group.js            群組操作權限、LINE 訊息回覆輔助
  translateLogic.js   翻譯相關的純函式（語言偵測、mention 遮罩/還原、zh-TW 輸出驗證）
                       —— 不依賴 Firebase，可以直接寫單元測試
  translate.js        呼叫 OpenAI 的翻譯邏輯，組裝 prompt，重用 translateLogic.js 的純函式
  maintenance.js      背景清理（過期 session、逾期未付款訂單），由 server.js 定期呼叫
  reminder.js         訂閱到期提醒（到期前 7/3/1 天與到期當下），由 server.js 每天呼叫
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

到期前 7/3/1 天與到期當下，各推播一則訊息到該群組（`services/reminder.js`，
每天執行一次）。設 `EXPIRY_REMINDER=off` 可以完全關閉。

⚠️ 用的是 LINE 的 **推播** 訊息，會計入官方帳號的訊息額度（翻譯用的回覆訊息
不計費）。每個群組每個訂閱週期最多 4 則，群組多的時候請先確認方案額度。

設計上最重要的是「不能重複發」。這個排程會在三種情況下被重複觸發：多台
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

## 已知待改進項目

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
