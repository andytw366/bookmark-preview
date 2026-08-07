/**
 * 把非同步工作排成一列，一次只跑一個。
 *
 * 抽出來成獨立模組是為了**能被測試**。這段邏輯的第一版看起來很合理卻完全不互斥：
 * 它用一個「目前在鎖裡」的旗標讓批量操作可以呼叫單筆操作，但那個旗標在持有者的
 * 每一次 await 期間都是 true，而它無法分辨「批量操作的巢狀呼叫」與「剛好在這時
 * 抵達的另一個無關操作」—— 後者直接繞過佇列並行執行。型別檢查與當時的測試全綠，
 * 因為沒有任何測試涵蓋它。
 *
 * 所以這裡刻意**不可重入**。需要在鎖內呼叫別的操作時，呼叫不取鎖的內部函式
 * （專案裡的命名慣例是 `*Locked`），不要試圖讓鎖變聰明。
 */
export function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    // 鏈上接的是吞掉例外的版本：一項失敗不該讓後面排隊的工作全部停下
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
