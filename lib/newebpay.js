// 藍新金流（NewebPay）相關：MerchantID、AES/SHA 加解密。
import crypto from "node:crypto";
import "./env.js";

const NEWEBPAY_MERCHANT_ID = process.env.NEWEBPAY_MERCHANT_ID;
const NEWEBPAY_HASHKEY = process.env.NEWEBPAY_HASHKEY;
const NEWEBPAY_HASHIV = process.env.NEWEBPAY_HASHIV;
const NEWEBPAY_MPG_URL = process.env.NEWEBPAY_MPG_URL || "https://ccore.newebpay.com/MPG/mpg_gateway";

// AES-256-CBC 要求 HashKey 剛好 32 bytes、HashIV 剛好 16 bytes（藍新的 HashKey/HashIV
// 本身就是設計成這個長度的英數字串）。長度不對，createDecipheriv 會直接丟
// "Invalid key/IV length"；長度對但內容不對（跟藍新商店後台登記的不一致），
// 才會是 decrypt 階段的 "bad decrypt" 錯誤。這裡只檢查長度、印出結果，
// 完全不會印金鑰本身，用來快速排除「環境變數設定錯誤／貼錯／少貼」這類問題。
if (NEWEBPAY_HASHKEY && NEWEBPAY_HASHKEY.length !== 32) {
  console.error(`⚠️ NEWEBPAY_HASHKEY 長度是 ${NEWEBPAY_HASHKEY.length}，藍新的 HashKey 應該剛好 32 個字元，請檢查是否貼錯或有多餘的空白/換行。`);
}
if (NEWEBPAY_HASHIV && NEWEBPAY_HASHIV.length !== 16) {
  console.error(`⚠️ NEWEBPAY_HASHIV 長度是 ${NEWEBPAY_HASHIV.length}，藍新的 HashIV 應該剛好 16 個字元，請檢查是否貼錯或有多餘的空白/換行。`);
}

function aesEncrypt(data) {
  const cipher = crypto.createCipheriv("aes-256-cbc", NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function aesDecrypt(data) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV);

  // 藍新實際送出的 TradeInfo，padding 長度有時會超過 AES 單一區塊 16 bytes 的理論上限
  // （已用實際資料驗證過：padding 的長度值、byte 數量、byte 內容三者完全吻合，
  // 只是長度超過標準 PKCS7 規定的 1–16 範圍——這是藍新那邊加密實作本身的行為，
  // 不是我們這邊的錯誤）。Node 內建的 setAutoPadding(true) 對 padding 長度做嚴格驗證，
  // 只要超過 16 就會直接丟出 "bad decrypt"，即使解密出來的內容完全正確也一樣。
  // 因此這裡關閉自動 padding，改成自己讀最後一個 byte 當作 padding 長度直接砍掉，
  // 不去驗證它是否 ≤ 16。
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]);

  const padLen = raw[raw.length - 1];
  // 基本合理性檢查：padLen 至少要是 1，且不能大於整段內容長度，
  // 不然代表資料/金鑰真的有問題（不是藍新那個「超過 16」的已知情況），
  // 這種才需要真的擋下來、丟出錯誤讓上層 catch 到。
  if (!padLen || padLen > raw.length) {
    throw new Error(`aesDecrypt: 無法辨識的 padding 長度 (${padLen})，可能是金鑰不符或密文毀損`);
  }

  return raw.slice(0, raw.length - padLen).toString("utf8");
}

function shaEncrypt(tradeInfo) {
  const str = `HashKey=${NEWEBPAY_HASHKEY}&${tradeInfo}&HashIV=${NEWEBPAY_HASHIV}`;
  return crypto.createHash("sha256").update(str).digest("hex").toUpperCase();
}

export { NEWEBPAY_MERCHANT_ID, NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV, NEWEBPAY_MPG_URL, aesEncrypt, aesDecrypt, shaEncrypt };
