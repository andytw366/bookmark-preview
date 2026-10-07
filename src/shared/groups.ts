/**
 * 群組（＝ tag）的基本形狀：書籤與隱私空間共用。
 *
 * 群組是「某個資料夾裡一塊上下左右相連的書籤」加上名稱與顏色（第 3 期改版：框線群組，
 * 位置由固定格子決定，見 `grid.ts` / `board.ts`）。有名字的群組就是 tag；沒名字的是不用
 * tag 建的 group（兩張卡片疊在一起選「建立群組」）。一個書籤最多屬於一個群組
 * （使用者拍板的決定）。資料存在哪裡兩邊不同（書籤：`grid:<資料夾>`；隱私空間：
 * 加密的版面文件），但畫面與操作只看這裡的形狀。
 */

export interface GroupInfo {
  id: string;
  /** 空字串 = 沒名字的群組（畫面顯示「未命名群組」） */
  name: string;
  /** `GROUP_COLORS` 的索引 */
  color: number;
  /**
   * 顏色是使用者自己在選單裡挑的。沒挑過的群組在畫面上會自動換色，避免和相鄰的群組同色
   * （`displayColors`）；挑過的照使用者的意思，不自動換。
   */
  pinned?: boolean;
}

/** 群組框線的顏色。只存索引：顏色本身由樣式決定，深色主題可以換一組 */
export const GROUP_COLORS = 6;

/** 名稱比對：去頭尾空白、不分大小寫。同一個資料夾裡不能有兩個同名群組 */
export function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

/** 新群組的顏色：挑這個資料夾裡用得最少的那個，相鄰的群組才分得出來 */
export function nextColor(existing: readonly GroupInfo[]): number {
  const used = new Array<number>(GROUP_COLORS).fill(0);
  for (const group of existing) {
    const color = ((group.color % GROUP_COLORS) + GROUP_COLORS) % GROUP_COLORS;
    used[color] = (used[color] ?? 0) + 1;
  }
  let best = 0;
  for (let color = 1; color < GROUP_COLORS; color += 1) {
    if ((used[color] ?? 0) < (used[best] ?? 0)) {
      best = color;
    }
  }
  return best;
}

/**
 * `#名稱` 搜尋找到的一個群組：在哪個資料夾、群組本身、成員（照那個資料夾的順序，只含真的還在那裡的）。
 * 搜尋結果裡群組照樣畫出來（色條／框線＋標籤），點標籤是跳到那個資料夾。
 */
export interface TagHit {
  folderId: string | null;
  group: GroupInfo;
  members: string[];
}

/**
 * 搜尋框裡的 `#名稱`：找出所有名為這個 tag 的群組成員（跨資料夾）。回傳要比對的名稱，
 * 不是 tag 搜尋就回 null。只打一個 `#` 還不算（那時當成普通的字去找）。
 */
export function tagQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed.startsWith('#')) {
    return null;
  }
  const name = trimmed.slice(1).trim();
  return name === '' ? null : name;
}

/**
 * 群組名稱合不合 `#` 後面打的字：去頭尾空白、不分大小寫的**開頭相符**，打到一半就看得到結果。
 * 沒名字的群組不是 tag，永遠不合。不同資料夾裡同名的群組視為同一個 tag。
 */
export function tagMatches(groupName: string, needle: string): boolean {
  const name = normalizeName(groupName);
  return name !== '' && name.startsWith(normalizeName(needle));
}
