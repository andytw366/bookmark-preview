import { fromBase64, toBase64 } from '@/crypto/bytes';
import type { PrivateBookmark, PrivateFolder, VaultPayload } from './types';
import { emptyLayout, type LayoutEntry, type VaultLayout } from './vault-layout';

/**
 * 隱私空間在 `storage.sync` 上的精簡編碼：書籤與版面合成**一份**，再交給 `encodePayload`
 * 壓縮加密。本機儲存、備份檔、合併規則都不碰這個格式 —— 它只活在「推上去 / 拉下來」那一瞬間。
 *
 * 舊做法（書籤一份、版面一份，各自是原樣的 JSON）400 筆約 70 KB，錢幾乎都花在壓不動的東西上：
 *
 * - **UUID**：一筆書籤的 id 在書籤、`order`、`groupOf` 各出現一次，又分在兩份各自壓縮的資料裡，
 *   gzip 只能各壓各的。這裡改成一張 id 表，其他地方只放表裡的位置。
 * - **毫秒時間戳**：13 位數，在 gzip 眼裡是亂數。書籤先按 `createdAt` 排好再存相鄰的差
 *   （一次匯入的幾百筆差距只有幾毫秒），`updatedAt` 存與 `createdAt` 的差（沒改過就是 0）。
 *   **精度不能降**：解回來差一毫秒，內容指紋就對不上，兩台裝置會輪流互相覆蓋。
 * - **JSON 鍵名**：改成按欄位存的陣列。
 *
 * 第 2 版再擠一點（400 筆約再少 6%，加上信封改 base91 共約 13%）：
 *
 * - UUID 存成 16 bytes 的 base64url（22 字元）而不是 32 個 hex —— 兩者的資訊量一樣，hex 的
 *   每個字元只帶 4 bits，gzip 也補不回來。
 * - `order` 的成員存相鄰差：大多數資料夾的排列接近書籤的打包順序，差值幾乎都是 1。
 * - `groupOf` 按鍵排序後存鍵的相鄰差。
 * - 網址的「scheme + 主機」另建一張表（`w`），網址只存表裡的位置與剩下的部分。
 *
 * 第 1 版只出現在沒有上架的建置裡，解碼仍然支援，讓那些裝置推上來的副本讀得進來。
 *
 * 版面的格式是可擴充的（不認得的區段、項目上多出來的欄位都要原封不動保留，見 `vault-layout`
 * 檔頭）。這裡只精簡**形狀完全認得**的項目，其餘原樣放進 `r` —— 不會因為這一層而剝掉任何東西。
 * 呼叫端在上傳前仍要解回來比對指紋（`vault.ts` 的 `packedSnapshot`），不一致就改用原樣的格式。
 */

export const PACK_VERSION = 2;

/** id 表裡「這不是 UUID」的前綴。UUID 去掉連字號存 32 個 hex，其他 id（例如 `~root`）原樣加這個前綴 */
const PLAIN_ID = '!';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const B64URL22 = /^[A-Za-z0-9_-]{22}$/;
/** 網址拆成「scheme + 主機」與其餘。拆不了的（沒有主機、不是 http/https）整串存著，表位置記 -1 */
const ORIGIN = /^(https?:\/\/[^/?#]+)([\s\S]*)$/;

const FLAG_ICON = 1;
const FLAG_PAGE = 2;
const FLAG_DELETED = 4;
const FLAG_PINNED = 8;

export interface PackedSync {
  v: 1 | typeof PACK_VERSION;
  /** id 表。前 `b.u.length` 個是書籤（依打包順序），接著是資料夾，其餘是被引用到的 id */
  ids: string[];
  /** 時間的基準點 */
  t: number;
  /** 網址開頭（scheme + 主機）的表（第 2 版起） */
  w?: string[];
  /**
   * 書籤，按 createdAt 排序：網址（第 2 版起是去掉開頭的部分）、開頭在 `w` 的位置（第 2 版起，-1 = 整串在 u）、
   * 標題、資料夾（id 表位置，-1 = 最上層）、createdAt 相鄰差、updatedAt − createdAt、旗標
   */
  b: { u: string[]; h?: number[]; n: string[]; f: number[]; c: number[]; m: number[]; p: number[] };
  /** 資料夾，按 updatedAt 排序：名稱、上層、updatedAt 相鄰差、旗標 */
  d: { n: string[]; p: number[]; m: number[]; x: number[] };
  /** 版面裡出現過的區段名稱（空的區段也算，指紋看得到它） */
  s: string[];
  /** order：[鍵, updatedAt − t, 成員]（第 2 版起成員存相鄰差） */
  o: [number, number, number[]][];
  /** groups：[鍵, 資料夾, 名稱, 顏色, 旗標, updatedAt − t] */
  g: [number, number, string, number, number, number][];
  /** groupOf：[鍵, 群組, updatedAt − t]（第 2 版起按鍵排序、鍵存相鄰差） */
  a: [number, number, number][];
  /** grid：[鍵, 欄數, updatedAt − t] */
  c: [number, number, number][];
  /** 形狀不認得的項目，原樣 */
  r: Record<string, Record<string, LayoutEntry>>;
}

/** 精簡失敗時的退路：原樣放著，一樣進同一個信封 */
export interface RawSync {
  v: 0;
  payload: VaultPayload;
  layout: VaultLayout;
}

export interface Unpacked {
  payload: VaultPayload;
  layout: VaultLayout;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(entry: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(entry).every((name) => allowed.includes(name));
}

class IdTable {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();

  ref(id: string | null): number {
    if (id === null) {
      return -1;
    }
    const known = this.index.get(id);
    if (known !== undefined) {
      return known;
    }
    this.index.set(id, this.list.length);
    this.list.push(id);
    return this.list.length - 1;
  }
}

function encodeId(id: string): string {
  if (!UUID.test(id)) {
    return `${PLAIN_ID}${id}`;
  }
  const hex = id.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function uuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeId(text: string, version: number): string {
  if (text.startsWith(PLAIN_ID)) {
    return text.slice(PLAIN_ID.length);
  }
  if (version === 1 && HEX32.test(text)) {
    return uuidFromHex(text);
  }
  if (version >= 2 && B64URL22.test(text)) {
    const bytes = fromBase64(`${text.replace(/-/g, '+').replace(/_/g, '/')}==`);
    return uuidFromHex(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  throw new Error(`bad id ${text}`);
}

/** 相鄰差。第一個是它自己 */
function deltas(values: readonly number[]): number[] {
  return values.map((value, index) => value - (index === 0 ? 0 : (values[index - 1] as number)));
}

function undeltas(values: readonly number[]): number[] {
  let running = 0;
  return values.map((value) => (running += value));
}

function byNumber<T>(pick: (item: T) => number, id: (item: T) => string) {
  return (a: T, b: T): number => pick(a) - pick(b) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
}

export function packSync(payload: VaultPayload, layout: VaultLayout): PackedSync {
  const table = new IdTable();
  const bookmarks = [...payload.bookmarks].sort(
    byNumber<PrivateBookmark>((r) => r.createdAt, (r) => r.id),
  );
  const folders = [...payload.folders].sort(byNumber<PrivateFolder>((r) => r.updatedAt, (r) => r.id));
  // 書籤與資料夾的 id 先進表，位置就等於它們在陣列裡的位置，不必另外存
  for (const record of bookmarks) {
    table.ref(record.id);
  }
  for (const folder of folders) {
    table.ref(folder.id);
  }

  const times = [
    ...bookmarks.map((r) => r.createdAt),
    ...folders.map((r) => r.updatedAt),
    ...Object.values(layout.sections).flatMap((section) => Object.values(section).map((e) => e.updatedAt)),
  ];
  const t = times.length === 0 ? 0 : Math.min(...times);

  const origins: string[] = [];
  const originIndex = new Map<string, number>();
  const b: PackedSync['b'] = { u: [], h: [], n: [], f: [], c: [], m: [], p: [] };
  let previous = t;
  for (const record of bookmarks) {
    const split = ORIGIN.exec(record.url);
    if (split === null) {
      b.h?.push(-1);
      b.u.push(record.url);
    } else {
      const origin = split[1] as string;
      let at = originIndex.get(origin);
      if (at === undefined) {
        at = origins.length;
        originIndex.set(origin, at);
        origins.push(origin);
      }
      b.h?.push(at);
      b.u.push(split[2] as string);
    }
    b.n.push(record.title);
    b.f.push(table.ref(record.folderId));
    b.c.push(record.createdAt - previous);
    b.m.push(record.updatedAt - record.createdAt);
    b.p.push(
      (record.preview === 'icon' ? FLAG_ICON : 0) |
        (record.preview === 'page' ? FLAG_PAGE : 0) |
        (record.deleted === true ? FLAG_DELETED : 0),
    );
    previous = record.createdAt;
  }

  const d: PackedSync['d'] = { n: [], p: [], m: [], x: [] };
  previous = t;
  for (const folder of folders) {
    d.n.push(folder.name);
    d.p.push(table.ref(folder.parentId));
    d.m.push(folder.updatedAt - previous);
    d.x.push(folder.deleted === true ? FLAG_DELETED : 0);
    previous = folder.updatedAt;
  }

  const packed: PackedSync = {
    v: PACK_VERSION,
    ids: [],
    t,
    w: origins,
    b,
    d,
    s: Object.keys(layout.sections),
    o: [],
    g: [],
    a: [],
    c: [],
    r: {},
  };
  const raw = (section: string, id: string, entry: LayoutEntry): void => {
    (packed.r[section] ??= {})[id] = entry;
  };

  for (const [section, entries] of Object.entries(layout.sections)) {
    for (const [id, entry] of Object.entries(entries)) {
      const at = entry.updatedAt - t;
      if (
        section === 'order' &&
        hasOnly(entry, ['updatedAt', 'ids']) &&
        Array.isArray(entry.ids) &&
        entry.ids.every((member) => typeof member === 'string')
      ) {
        packed.o.push([table.ref(id), at, deltas((entry.ids as string[]).map((member) => table.ref(member)))]);
      } else if (
        section === 'groups' &&
        hasOnly(entry, ['updatedAt', 'folderId', 'name', 'color', 'pinned', 'deleted']) &&
        (entry.folderId === null || typeof entry.folderId === 'string') &&
        typeof entry.name === 'string' &&
        typeof entry.color === 'number' &&
        (entry.pinned === undefined || entry.pinned === true) &&
        (entry.deleted === undefined || entry.deleted === true)
      ) {
        const flags = (entry.pinned === true ? FLAG_PINNED : 0) | (entry.deleted === true ? FLAG_DELETED : 0);
        packed.g.push([table.ref(id), table.ref(entry.folderId), entry.name, entry.color, flags, at]);
      } else if (
        section === 'groupOf' &&
        hasOnly(entry, ['updatedAt', 'groupId']) &&
        (entry.groupId === null || typeof entry.groupId === 'string')
      ) {
        packed.a.push([table.ref(id), table.ref(entry.groupId), at]);
      } else if (section === 'grid' && hasOnly(entry, ['updatedAt', 'columns']) && typeof entry.columns === 'number') {
        packed.c.push([table.ref(id), entry.columns, at]);
      } else {
        raw(section, id, entry);
      }
    }
  }

  // groupOf 按鍵排序後存鍵的相鄰差：鍵多半是書籤自己，排好後差值很小
  packed.a.sort((x, y) => x[0] - y[0]);
  const keys = deltas(packed.a.map(([key]) => key));
  packed.a = packed.a.map(([, group, at], index) => [keys[index] as number, group, at]);

  packed.ids = table.list.map(encodeId);
  return packed;
}

/**
 * 解回 payload 與版面。形狀不對就丟錯 —— 呼叫端把它當成「遠端那份解不開」。
 * 解出來的東西呼叫端還會再過一次 `sanitizeVaultPayload` / `sanitizeLayout`。
 */
export function unpackSync(value: unknown): Unpacked {
  if (!isObject(value)) {
    throw new Error('not a sync pack');
  }
  if (value.v === 0) {
    return { payload: value.payload as VaultPayload, layout: value.layout as VaultLayout };
  }
  if (value.v !== 1 && value.v !== PACK_VERSION) {
    throw new Error(`unsupported sync pack ${String(value.v)}`);
  }
  const packed = value as unknown as PackedSync;
  const version = packed.v;
  const ids = packed.ids.map((text) => decodeId(text, version));
  const id = (ref: number): string => {
    const found = ids[ref];
    if (found === undefined) {
      throw new Error(`bad id ref ${String(ref)}`);
    }
    return found;
  };
  const optional = (ref: number): string | null => (ref === -1 ? null : id(ref));

  const bookmarks: PrivateBookmark[] = [];
  let previous = packed.t;
  packed.b.u.forEach((rest, index) => {
    const createdAt = previous + (packed.b.c[index] ?? 0);
    const flags = packed.b.p[index] ?? 0;
    const origin = version >= 2 ? (packed.b.h?.[index] ?? -1) : -1;
    if (origin !== -1 && packed.w?.[origin] === undefined) {
      throw new Error(`bad origin ref ${String(origin)}`);
    }
    const record: PrivateBookmark = {
      id: id(index),
      url: origin === -1 ? rest : `${packed.w?.[origin] ?? ''}${rest}`,
      title: packed.b.n[index] ?? '',
      folderId: optional(packed.b.f[index] ?? -1),
      createdAt,
      updatedAt: createdAt + (packed.b.m[index] ?? 0),
    };
    if ((flags & FLAG_ICON) !== 0) {
      record.preview = 'icon';
    } else if ((flags & FLAG_PAGE) !== 0) {
      record.preview = 'page';
    }
    if ((flags & FLAG_DELETED) !== 0) {
      record.deleted = true;
    }
    bookmarks.push(record);
    previous = createdAt;
  });

  const folders: PrivateFolder[] = [];
  const offset = packed.b.u.length;
  previous = packed.t;
  packed.d.n.forEach((name, index) => {
    const updatedAt = previous + (packed.d.m[index] ?? 0);
    const folder: PrivateFolder = {
      id: id(offset + index),
      name,
      parentId: optional(packed.d.p[index] ?? -1),
      updatedAt,
    };
    if (((packed.d.x[index] ?? 0) & FLAG_DELETED) !== 0) {
      folder.deleted = true;
    }
    folders.push(folder);
    previous = updatedAt;
  });

  const layout = emptyLayout();
  for (const name of packed.s) {
    layout.sections[name] = {};
  }
  const put = (section: string, key: string, entry: LayoutEntry): void => {
    (layout.sections[section] ??= {})[key] = entry;
  };
  for (const [key, at, members] of packed.o) {
    put('order', id(key), { updatedAt: packed.t + at, ids: (version >= 2 ? undeltas(members) : members).map(id) });
  }
  for (const [key, folder, name, color, flags, at] of packed.g) {
    const entry: LayoutEntry = { updatedAt: packed.t + at, folderId: optional(folder), name, color };
    if ((flags & FLAG_PINNED) !== 0) {
      entry.pinned = true;
    }
    if ((flags & FLAG_DELETED) !== 0) {
      entry.deleted = true;
    }
    put('groups', id(key), entry);
  }
  const groupKeys = version >= 2 ? undeltas(packed.a.map(([key]) => key)) : packed.a.map(([key]) => key);
  packed.a.forEach(([, group, at], index) => {
    put('groupOf', id(groupKeys[index] as number), { updatedAt: packed.t + at, groupId: optional(group) });
  });
  for (const [key, columns, at] of packed.c) {
    put('grid', id(key), { updatedAt: packed.t + at, columns });
  }
  for (const [section, entries] of Object.entries(packed.r)) {
    for (const [key, entry] of Object.entries(entries)) {
      put(section, key, entry);
    }
  }

  return { payload: { version: 1, bookmarks, folders }, layout };
}
