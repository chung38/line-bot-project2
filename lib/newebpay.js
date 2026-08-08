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
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    if (e.message?.includes("bad decrypt")) {
      console.error("❌ 藍新 TradeInfo 解密失敗（bad decrypt）。若簽章驗證（shaEncrypt）有先通過，代表金鑰內容應該是對的，這裡多做一次關閉 auto-padding 的解密，幫助判斷問題出在金鑰內容還是 padding 判斷本身。");
      try {
        const rawDecipher = crypto.createDecipheriv("aes-256-cbc", NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV);
        rawDecipher.setAutoPadding(false);
        const rawBuf = Buffer.concat([
          rawDecipher.update(Buffer.from(data, "hex")),
          rawDecipher.final(),
        ]);
        const padByte = rawBuf[rawBuf.length - 1];
        // 只印前 100 個字元當預覽，且用 JSON.stringify 讓不可見字元以跳脫字元顯示，
        // 不會印出完整交易明細；藍新 TradeInfo 解密後正常內容只有訂單編號、金額、
        // 交易編號這類中繼資料，本來就不含卡號等敏感資訊。
        console.error("🔍 關閉 auto-padding 後的原始解密內容（前 100 字元預覽）：", JSON.stringify(rawBuf.toString("utf8").slice(0, 100)));
        console.error("🔍 最後一個 byte（PKCS7 padding 長度宣告值，合法範圍應為 1-16）：", padByte);
      } catch (rawErr) {
        console.error("🔍 連關閉 auto-padding 的解密都失敗：", rawErr.message);
      }
    }
    throw e;
  }
}

function shaEncrypt(tradeInfo) {
  const str = `HashKey=${NEWEBPAY_HASHKEY}&${tradeInfo}&HashIV=${NEWEBPAY_HASHIV}`;
  return crypto.createHash("sha256").update(str).digest("hex").toUpperCase();
}

export { NEWEBPAY_MERCHANT_ID, NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV, NEWEBPAY_MPG_URL, aesEncrypt, aesDecrypt, shaEncrypt };
