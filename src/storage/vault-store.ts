import type { VaultMeta } from '@/shared/types';

/**
 * 隱私空間的持久化。
 *
 * 主儲存放在 storage.local：搭配 unlimitedStorage 沒有實務上的容量上限，
 * 所以隱私書籤數量不受限。M4 的 storage.sync 只放一份加密副本，
 * 100 KB 的額度只約束「要不要同步」，不約束「能存多少」。
 *
 * 這裡存的 blob 是已加密的 base64；明文只存在解鎖後的背景頁記憶體中。
 */
const META_KEY = 'vaultMeta';
const BLOB_KEY = 'vaultBlob';
const TAG_KEY = 'vaultBlobTag';

export async function readMeta(): Promise<VaultMeta | null> {
  const stored = await browser.storage.local.get(META_KEY);
  return (stored[META_KEY] as VaultMeta | undefined) ?? null;
}

export async function writeMeta(meta: VaultMeta): Promise<void> {
  await browser.storage.local.set({ [META_KEY]: meta });
}

export async function readBlob(): Promise<string | null> {
  const stored = await browser.storage.local.get(BLOB_KEY);
  return (stored[BLOB_KEY] as string | undefined) ?? null;
}

export interface StoredBlob {
  blob: string;
  /** 這份密文的內容指紋。舊版寫入的資料沒有它，那時為 null。 */
  tag: string | null;
}

/**
 * 密文與它的內容指紋一起讀。
 *
 * 指紋**和密文存在一起**而不是另外從記憶體算，因為同步要靠它判斷「雲端那份是不是
 * 已經是這個內容」。從記憶體算的話，只要記憶體與磁碟有一瞬間不一致（例如寫入失敗、
 * 或修改已套用而 persist 還沒完成），就會上傳「舊的密文標上新的指紋」——之後每次
 * 同步都會比對出「相同」而跳過上傳，那筆修改**永遠不會**傳出去，而且兩邊都看不出來。
 * 存在同一次 `storage.local.set` 裡就沒有這個窗口。
 */
export async function readStoredBlob(): Promise<StoredBlob | null> {
  const stored = await browser.storage.local.get([BLOB_KEY, TAG_KEY]);
  const blob = stored[BLOB_KEY] as string | undefined;
  if (blob === undefined) {
    return null;
  }
  const tag = stored[TAG_KEY] as string | undefined;
  return { blob, tag: tag ?? null };
}

export async function writeBlob(blob: string, tag: string): Promise<void> {
  // 一次 set 寫兩個鍵，兩者不會分家
  await browser.storage.local.set({ [BLOB_KEY]: blob, [TAG_KEY]: tag });
}

export async function destroyVault(): Promise<void> {
  await browser.storage.local.remove([META_KEY, BLOB_KEY, TAG_KEY]);
}
