// 藍新金流（NewebPay）相關：MerchantID、AES/SHA 加解密。
import crypto from "node:crypto";
import "./env.js";

const NEWEBPAY_MERCHANT_ID = process.env.NEWEBPAY_MERCHANT_ID;
const NEWEBPAY_HASHKEY = process.env.NEWEBPAY_HASHKEY;
const NEWEBPAY_HASHIV = process.env.NEWEBPAY_HASHIV;
const NEWEBPAY_MPG_URL = process.env.NEWEBPAY_MPG_URL || "https://ccore.newebpay.com/MPG/mpg_gateway";
function aesEncrypt(data) {
  const cipher = crypto.createCipheriv("aes-256-cbc", NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function aesDecrypt(data) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function shaEncrypt(tradeInfo) {
  const str = `HashKey=${NEWEBPAY_HASHKEY}&${tradeInfo}&HashIV=${NEWEBPAY_HASHIV}`;
  return crypto.createHash("sha256").update(str).digest("hex").toUpperCase();
}

export { NEWEBPAY_MERCHANT_ID, NEWEBPAY_HASHKEY, NEWEBPAY_HASHIV, NEWEBPAY_MPG_URL, aesEncrypt, aesDecrypt, shaEncrypt };
