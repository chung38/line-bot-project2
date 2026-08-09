// Firebase Admin 初始化（db）與 express-session 用的 Firestore session store。
// 全站只有這裡呼叫 admin.initializeApp()，其他模組一律從這裡 import db / admin。
//
// db / firestoreAdmin 刻意宣告成 let 並用「具名 export」導出，
// 這樣 ESM 的 live binding 會讓所有 import 端在測試模式被注入後看到同一份假物件
// （見 setFirestoreForTesting）。正式執行時行為跟原本完全一樣。
import realAdmin from "firebase-admin";
import session from "express-session";
import { isTestEnv } from "./env.js";

let db = null;
let firestoreAdmin = realAdmin;

if (isTestEnv) {
  // 測試模式：完全不碰真的 Firebase，等測試用 setFirestoreForTesting() 注入假的 db。
  console.warn("⚠️ NODE_ENV=test：略過 Firebase 初始化（請用 setFirestoreForTesting 注入假的 db）");
} else {
  try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    if (firebaseConfig.private_key) {
      firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
    }
    realAdmin.initializeApp({
      credential: realAdmin.credential.cert(firebaseConfig)
    });
    db = realAdmin.firestore();
    console.log("✅ Firebase 初始化成功");
  } catch (e) {
    console.error("❌ Firebase 初始化失敗:", e);
    process.exit(1);
  }
}

// 只給測試用：注入假的 Firestore（見 tests/helpers/fakeFirestore.js）。
// 正式環境呼叫會直接丟錯，避免有人不小心在 production 用到。
function setFirestoreForTesting(fakeDb, fakeAdmin = null) {
  if (!isTestEnv) {
    throw new Error("setFirestoreForTesting() 只能在 NODE_ENV=test 下使用");
  }
  db = fakeDb;
  if (fakeAdmin) firestoreAdmin = fakeAdmin;
}

// Firebase Auth 的 ID token 驗證。包一層是為了讓測試能注入替身：
// 會員登入的把關邏輯（例如「信箱沒驗證過就不給登入」）是安全相關的程式碼，
// 應該要能被測到，但測試環境沒有真的 Firebase App 可以呼叫 admin.auth()。
let idTokenVerifier = null;

async function verifyIdToken(idToken) {
  if (idTokenVerifier) return idTokenVerifier(idToken);
  return realAdmin.auth().verifyIdToken(idToken);
}

function setIdTokenVerifierForTesting(fn) {
  if (!isTestEnv) {
    throw new Error("setIdTokenVerifierForTesting() 只能在 NODE_ENV=test 下使用");
  }
  idTokenVerifier = fn;
}

class FirestoreSessionStore extends session.Store {
  constructor(firestoreDb, collectionName = "expressSessions") {
    super();
    this.collection = firestoreDb.collection(collectionName);
  }

  async get(sid, cb) {
    try {
      const doc = await this.collection.doc(sid).get();
      if (!doc.exists) return cb(null, null);

      const { expires, data } = doc.data();
      if (expires && expires.toMillis() <= Date.now()) {
        await this.collection.doc(sid).delete().catch(() => {});
        return cb(null, null);
      }

      cb(null, JSON.parse(data));
    } catch (e) {
      cb(e);
    }
  }

  async set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? 24 * 60 * 60 * 1000;
      const expires = firestoreAdmin.firestore.Timestamp.fromMillis(Date.now() + maxAge);
      await this.collection.doc(sid).set({
        data: JSON.stringify(sessionData),
        expires,
      });
      cb?.(null);
    } catch (e) {
      cb?.(e);
    }
  }

  async destroy(sid, cb) {
    try {
      await this.collection.doc(sid).delete();
      cb?.(null);
    } catch (e) {
      cb?.(e);
    }
  }

  async touch(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? 24 * 60 * 60 * 1000;
      const expires = firestoreAdmin.firestore.Timestamp.fromMillis(Date.now() + maxAge);
      await this.collection.doc(sid).update({ expires });
      cb?.(null);
    } catch (e) {
      // If the doc doesn't exist yet (e.g. race with set), ignore.
      cb?.(null);
    }
  }
}

export {
  firestoreAdmin as admin,
  db,
  FirestoreSessionStore,
  setFirestoreForTesting,
  verifyIdToken,
  setIdTokenVerifierForTesting,
};
