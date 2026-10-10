/**
 * 搜尋結果裡把符合的字加上底色（`<mark>`）。比對規則與 `searchTree` 一樣：整段搜尋字、
 * 不分大小寫。只標第一個符合的位置 —— 這裡是幫眼睛找到在哪裡，不必每個都標。
 */
export function Highlight({ text, query }: { text: string; query: string | undefined }) {
  const needle = query?.trim().toLowerCase() ?? '';
  // `#名稱` 是找群組，不是找標題裡的字
  const at = needle === '' || needle.startsWith('#') ? -1 : text.toLowerCase().indexOf(needle);
  if (at === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
