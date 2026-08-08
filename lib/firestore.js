// Firebase Admin 初始化（db）與 express-session 用的 Firestore session store。
// 全站只有這裡呼叫 admin.initializeApp()，其他模組一律從這裡 import db / admin。
import admin from "firebase-admin";
import session from "express-session";
import "./env.js";

let db;
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  if (firebaseConfig.private_key) {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
  db = admin.firestore();
  console.log("✅ Firebase 初始化成功");
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
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
      const expires = admin.firestore.Timestamp.fromMillis(Date.now() + maxAge);
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
      const expires = admin.firestore.Timestamp.fromMillis(Date.now() + maxAge);
      await this.collection.doc(sid).update({ expires });
      cb?.(null);
    } catch (e) {
      // If the doc doesn't exist yet (e.g. race with set), ignore.
      cb?.(null);
    }
  }
}

export { admin, db, FirestoreSessionStore };
