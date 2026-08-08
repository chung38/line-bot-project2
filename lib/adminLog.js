// 後台操作紀錄（adminLogs collection）。被 routes/admin.js、routes/member.js、
// services/group.js（REBIND_BLOCKED）共用，獨立成檔避免互相 import 造成循環依賴。
import { admin, db } from "./firestore.js";

async function addAdminLog(action, detail, actor = "admin", extra = {}) {
  try {
    await db.collection("adminLogs").add({
      action,
      detail,
      actor,
      extra,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("admin log 寫入失敗:", e.message);
  }
}

export { addAdminLog };
