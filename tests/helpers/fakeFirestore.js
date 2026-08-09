// 記憶體版的假 Firestore，只實作這個專案實際會用到的 API 子集：
//
//   collection(name).doc(id).get() / set(data, {merge}) / update(data) / delete()
//   collection(name).get() / where(field, "==" | "<" | "<=" | ">" | ">=", value) / limit(n) / add(data)
//   collection(name).onSnapshot(onNext, onError)   ← lib/state.js 的即時同步
//   db.runTransaction(fn)                          ← 額度預扣、綁定碼交易
//   admin.firestore.FieldValue.increment / serverTimestamp
//   admin.firestore.Timestamp.now / fromMillis / fromDate
//
// 兩個刻意做出來的行為，讓測試有意義：
//   1. runTransaction 會「排隊執行」（同一時間只有一個交易在跑），
//      模擬 Firestore 交易的序列化語意 —— 這樣才測得出「併發預扣額度會不會超用」。
//      如果程式把額度檢查寫在交易外面，這個測試就會抓到。
//   2. onSnapshot 會在每次寫入後非同步送出 docChanges，
//      模擬另一台 instance 的變更被推播過來。

class FakeTimestamp {
  constructor(millis) {
    this._millis = millis;
  }
  static now() {
    return new FakeTimestamp(Date.now());
  }
  static fromMillis(ms) {
    return new FakeTimestamp(ms);
  }
  static fromDate(date) {
    return new FakeTimestamp(date.getTime());
  }
  toMillis() {
    return this._millis;
  }
  toDate() {
    return new Date(this._millis);
  }
}

function comparableValue(v) {
  if (v instanceof FakeTimestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  return null;
}

const SENTINEL = Symbol("fake-firestore-sentinel");

function incrementSentinel(value) {
  return { [SENTINEL]: "increment", value };
}

function serverTimestampSentinel() {
  return { [SENTINEL]: "serverTimestamp" };
}

function isSentinel(v) {
  return !!v && typeof v === "object" && SENTINEL in v;
}

function resolveSentinel(sentinel, existingValue) {
  if (sentinel[SENTINEL] === "increment") {
    return Number(existingValue || 0) + Number(sentinel.value || 0);
  }
  if (sentinel[SENTINEL] === "serverTimestamp") {
    return new Date();
  }
  return undefined;
}

function cloneValue(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof FakeTimestamp) return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneValue(val);
    return out;
  }
  return v;
}

function createFakeFirestore() {
  // collection -> Map<docId, data>
  const store = new Map();
  // collection -> Map<docId, version>，給 onSnapshot 算 docChanges 用
  const versions = new Map();
  // collection -> Set<listener>
  const listeners = new Map();
  let versionCounter = 0;

  function col(name) {
    if (!store.has(name)) {
      store.set(name, new Map());
      versions.set(name, new Map());
    }
    return store.get(name);
  }

  function notify(collectionName) {
    const set = listeners.get(collectionName);
    if (!set || set.size === 0) return;
    // 非同步送出，模擬真實 Firestore 的推播延遲
    setTimeout(() => {
      for (const listener of set) listener.emit();
    }, 0);
  }

  function touchDoc(collectionName, docId) {
    versionCounter += 1;
    versions.get(collectionName).set(docId, versionCounter);
    notify(collectionName);
  }

  function removeDoc(collectionName, docId) {
    col(collectionName).delete(docId);
    versions.get(collectionName).delete(docId);
    notify(collectionName);
  }

  function makeSnapshot(collectionName, docId) {
    const data = col(collectionName).get(docId);
    return {
      id: docId,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : cloneValue(data)),
      ref: docRef(collectionName, docId),
    };
  }

  function applyWrite(collectionName, docId, data, { merge = false } = {}) {
    const collection = col(collectionName);
    const existing = collection.get(docId);
    const base = merge && existing ? { ...existing } : {};

    for (const [key, value] of Object.entries(data)) {
      base[key] = isSentinel(value)
        ? resolveSentinel(value, existing ? existing[key] : undefined)
        : cloneValue(value);
    }

    collection.set(docId, base);
    touchDoc(collectionName, docId);
  }

  function docRef(collectionName, docId) {
    return {
      id: docId,
      path: `${collectionName}/${docId}`,
      async get() {
        return makeSnapshot(collectionName, docId);
      },
      async set(data, options = {}) {
        applyWrite(collectionName, docId, data, options);
      },
      async update(data) {
        if (!col(collectionName).has(docId)) {
          throw new Error(`No document to update: ${collectionName}/${docId}`);
        }
        applyWrite(collectionName, docId, data, { merge: true });
      },
      async delete() {
        removeDoc(collectionName, docId);
      },
    };
  }

  function buildQuerySnapshot(collectionName, filters = [], limitCount = null) {
    let entries = [...col(collectionName).entries()];

    for (const f of filters) {
      entries = entries.filter(([, data]) => {
        const value = data?.[f.field];
        if (f.op === "==") return value === f.value;

        // 範圍查詢（背景清理過期 session／逾期訂單會用到）。
        // Date 與 FakeTimestamp 都先換算成毫秒再比，跟真的 Firestore 一樣
        // 可以直接拿時間欄位做大小比較。
        const left = comparableValue(value);
        const right = comparableValue(f.value);
        if (left === null || right === null) return false;

        if (f.op === "<") return left < right;
        if (f.op === "<=") return left <= right;
        if (f.op === ">") return left > right;
        if (f.op === ">=") return left >= right;

        throw new Error(`fakeFirestore 尚未支援的查詢運算子: ${f.op}`);
      });
    }

    if (limitCount !== null) entries = entries.slice(0, limitCount);

    const docs = entries.map(([id]) => makeSnapshot(collectionName, id));

    return {
      docs,
      size: docs.length,
      empty: docs.length === 0,
      forEach: cb => docs.forEach(cb),
    };
  }

  function queryRef(collectionName, filters = [], limitCount = null) {
    return {
      where(field, op, value) {
        return queryRef(collectionName, [...filters, { field, op, value }], limitCount);
      },
      limit(n) {
        return queryRef(collectionName, filters, n);
      },
      async get() {
        return buildQuerySnapshot(collectionName, filters, limitCount);
      },
    };
  }

  function collectionRef(name) {
    col(name);
    return {
      doc(id = `auto_${++versionCounter}`) {
        return docRef(name, id);
      },
      where(field, op, value) {
        return queryRef(name, [{ field, op, value }]);
      },
      limit(n) {
        return queryRef(name, [], n);
      },
      async get() {
        return buildQuerySnapshot(name);
      },
      async add(data) {
        const id = `auto_${++versionCounter}`;
        applyWrite(name, id, data, {});
        return docRef(name, id);
      },
      // lib/state.js 的即時同步用的就是這個
      onSnapshot(onNext, onError) {
        if (!listeners.has(name)) listeners.set(name, new Set());

        const listener = {
          lastSeen: new Map(),
          emit() {
            try {
              const current = versions.get(name);
              const changes = [];

              for (const [docId, version] of current) {
                const seen = listener.lastSeen.get(docId);
                if (seen === version) continue;
                changes.push({
                  type: seen === undefined ? "added" : "modified",
                  doc: makeSnapshot(name, docId),
                });
              }

              for (const docId of [...listener.lastSeen.keys()]) {
                if (!current.has(docId)) {
                  changes.push({
                    type: "removed",
                    doc: { id: docId, exists: false, data: () => undefined },
                  });
                }
              }

              listener.lastSeen = new Map(current);

              if (changes.length === 0) return;

              onNext({
                docs: [...current.keys()].map(id => makeSnapshot(name, id)),
                docChanges: () => changes,
              });
            } catch (e) {
              onError?.(e);
            }
          },
        };

        listeners.get(name).add(listener);
        // 第一次快照：把現有文件全部當成 added 推一次
        setTimeout(() => listener.emit(), 0);

        return () => listeners.get(name)?.delete(listener);
      },
    };
  }

  // 交易排隊執行，模擬 Firestore 的序列化語意
  let txChain = Promise.resolve();

  async function runTransaction(fn) {
    const run = async () => {
      const pendingWrites = [];
      const tx = {
        get: ref => ref.get(),
        set: (ref, data, options = {}) => pendingWrites.push(() => ref.set(data, options)),
        update: (ref, data) => pendingWrites.push(() => ref.update(data)),
        delete: ref => pendingWrites.push(() => ref.delete()),
      };

      const result = await fn(tx);
      for (const write of pendingWrites) await write();
      return result;
    };

    const next = txChain.then(run, run);
    txChain = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  const db = {
    collection: collectionRef,
    runTransaction,
  };

  const admin = {
    firestore: {
      FieldValue: {
        increment: incrementSentinel,
        serverTimestamp: serverTimestampSentinel,
      },
      Timestamp: FakeTimestamp,
    },
  };

  // 測試用的輔助方法
  const helpers = {
    // 直接塞資料，不經過寫入路徑
    seed(collectionName, docId, data) {
      col(collectionName).set(docId, cloneValue(data));
      touchDoc(collectionName, docId);
    },
    read(collectionName, docId) {
      const data = col(collectionName).get(docId);
      return data === undefined ? null : cloneValue(data);
    },
    count(collectionName) {
      return col(collectionName).size;
    },
    all(collectionName) {
      return [...col(collectionName).entries()].map(([id, data]) => ({ id, ...cloneValue(data) }));
    },
  };

  return { db, admin, ...helpers, FakeTimestamp };
}

export { createFakeFirestore, FakeTimestamp };
