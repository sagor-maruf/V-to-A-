// ---------------------------------------------------------------------------
// audioStorage.ts — ডিভাইসেই অডিও স্থায়ীভাবে সংরক্ষণ (IndexedDB)
//
// কেন? আগে অডিও ফাইল শুধু সার্ভারে থাকত (২ ঘণ্টা পর ডিলিট) — তাই কিছুক্ষণ
// পরে ইতিহাসের গানগুলো আর চলত না। এখন অডিও ডাউনলোড হওয়ার সাথে সাথেই ডিভাইসের
// IndexedDB-তে কপি রাখা হয়, তাই:
//   ✅ অ্যাপ বন্ধ করলেও, ফোন রিস্টার্ট করলেও গান থাকে ও চলে
//   ✅ সার্ভার ফাইল মুছে গেলেও সমস্যা নেই (লোকাল কপি থেকে চলে)
//   ✅ ইন্টারনেট ছাড়াও বাজানো যায়
// ---------------------------------------------------------------------------

const DB_NAME = 'vtoa-audio-store';
const DB_VERSION = 1;
const STORE = 'audios';

interface StoredAudioRecord {
  id: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    openDb().then((db) => {
      if (!db) return resolve(null);
      try {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const req = run(store);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** অডিও ব্লব ডিভাইসে সেভ করে (একই id থাকলে আগেরটা বদলে যায়) */
export async function saveAudio(
  id: string,
  fileName: string,
  mimeType: string,
  blob: Blob
): Promise<boolean> {
  try {
    const record: StoredAudioRecord = {
      id,
      fileName,
      mimeType: mimeType || 'audio/mpeg',
      blob,
      savedAt: Date.now(),
    };
    const res = await tx('readwrite', (store) => store.put(record) as IDBRequest<IDBValidKey>);
    return res !== null;
  } catch {
    return false;
  }
}

/** id দিয়ে ডিভাইসে রাখা অডিও ফেরত দেয় (না থাকলে null) */
export async function getAudio(id: string): Promise<StoredAudioRecord | null> {
  try {
    const rec = await tx('readonly', (store) => store.get(id) as IDBRequest<StoredAudioRecord>);
    return rec && rec.blob ? rec : null;
  } catch {
    return null;
  }
}

/** এই id-র অডিও ডিভাইসে আছে কি না */
export async function hasAudio(id: string): Promise<boolean> {
  const rec = await getAudio(id);
  return !!rec;
}

/** ডিভাইসের স্টোর থেকে অডিও মুছে ফেলে (দরকার হলে) */
export async function removeAudio(id: string): Promise<void> {
  try {
    await tx('readwrite', (store) => store.delete(id) as unknown as IDBRequest<undefined>);
  } catch {}
}