import type { ThumbRecord } from '@/shared/types';
import { t } from '@/shared/i18n';

/**
 * 縮圖的 IndexedDB 存取層。
 *
 * 背景頁與側邊欄同屬一個擴充套件 origin，因此共用同一個 IndexedDB。
 * 側邊欄直接讀取而不透過訊息傳圖，可以省掉每張縮圖的序列化來回 ——
 * 這在一次渲染數十張縮圖時差別很明顯。
 *
 * 例外是隱私書籤的縮圖：那些是密文，解密金鑰只存在背景頁記憶體，
 * 必須向背景頁索取明文（見 M3）。
 */
const DB_NAME = 'bookmark-preview';
const DB_VERSION = 1;
const STORE = 'thumbs';

let cached: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  cached ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('capturedAt', 'capturedAt');
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      cached = null;
      reject(request.error ?? new Error(t('thumbdb_open_failed')));
    };
  });
  return cached;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error(t('thumbdb_request_failed')));
        };
      }),
  );
}

export async function getThumb(key: string): Promise<ThumbRecord | undefined> {
  return run<ThumbRecord | undefined>('readonly', (store) => store.get(key) as IDBRequest<ThumbRecord | undefined>);
}

export async function putThumb(record: ThumbRecord): Promise<void> {
  await run('readwrite', (store) => store.put(record));
}

export async function deleteThumb(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key));
}

export async function listKeys(): Promise<string[]> {
  const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  return keys.map(String);
}

export interface ThumbUsage {
  count: number;
  bytes: number;
}

/** `include` 決定哪些鍵算進來（預設全部） */
export async function usage(include: (key: string) => boolean = () => true): Promise<ThumbUsage> {
  const all = await run<ThumbRecord[]>('readonly', (store) => store.getAll() as IDBRequest<ThumbRecord[]>);
  const records = all.filter((record) => include(record.key));
  return {
    count: records.length,
    bytes: records.reduce((total, record) => total + record.bytes.byteLength, 0),
  };
}

/** 刪除早於 cutoff 的縮圖（只動 `include` 認可的鍵，預設全部），回傳刪除筆數。 */
export async function pruneOlderThan(cutoff: number, include: (key: string) => boolean = () => true): Promise<number> {
  const records = await run<ThumbRecord[]>('readonly', (store) => store.getAll() as IDBRequest<ThumbRecord[]>);
  const stale = records.filter((record) => record.capturedAt < cutoff && include(record.key));
  await Promise.all(stale.map((record) => deleteThumb(record.key)));
  return stale.length;
}

/** 只保留 keep 集合中的縮圖，用於清掉已刪除書籤留下的孤兒。 */
export async function pruneMissing(keep: ReadonlySet<string>): Promise<number> {
  const keys = await listKeys();
  const orphans = keys.filter((key) => !keep.has(key));
  await Promise.all(orphans.map((key) => deleteThumb(key)));
  return orphans.length;
}
