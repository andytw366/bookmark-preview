import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '@/shared/serial-queue';

/**
 * 這些測試存在的理由：佇列的第一版看起來很合理，型別檢查與當時的 80 項測試全綠，
 * 但它完全不互斥 —— 隱私空間最嚴重的資料遺失路徑因此原封不動地留著。
 * 「一次只跑一個」必須是被驗證過的性質，不是讀程式碼推論出來的。
 */

/** 記錄進入與離開的順序，用來偵測交錯。 */
function tracker() {
  const log: string[] = [];
  const gate = async (name: string, steps: number): Promise<void> => {
    log.push(`${name}:enter`);
    for (let i = 0; i < steps; i += 1) {
      // 每一次 await 都是一個可能被插隊的縫隙
      await Promise.resolve();
    }
    log.push(`${name}:exit`);
  };
  return { log, gate };
}

describe('createSerialQueue', () => {
  it('同時送進來的工作不會交錯', async () => {
    const exclusive = createSerialQueue();
    const { log, gate } = tracker();

    await Promise.all([
      exclusive(async () => gate('a', 5)),
      exclusive(async () => gate('b', 1)),
      exclusive(async () => gate('c', 3)),
    ]);

    expect(log).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit', 'c:enter', 'c:exit']);
  });

  it('後來才送進來的工作也要等前一個做完', async () => {
    const exclusive = createSerialQueue();
    const { log, gate } = tracker();

    const first = exclusive(async () => gate('first', 8));
    // 前一個已經在跑（而且正卡在 await 上）時才送出第二個 —— 這正是同步合併插進
    // 「移入隱私空間」中間的情境
    await Promise.resolve();
    const second = exclusive(async () => gate('second', 1));

    await Promise.all([first, second]);
    expect(log).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit']);
  });

  it('一項失敗不會卡住後面排隊的工作', async () => {
    const exclusive = createSerialQueue();

    const failing = exclusive(async () => {
      throw new Error('boom');
    });
    const following = exclusive(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  it('例外會傳回原本的呼叫端，不會被吞掉', async () => {
    const exclusive = createSerialQueue();
    await expect(
      exclusive(async () => {
        throw new Error('對呼叫端要看得見');
      }),
    ).rejects.toThrow('對呼叫端要看得見');
  });

  it('回傳值原樣傳回', async () => {
    const exclusive = createSerialQueue();
    await expect(exclusive(async () => ({ moved: true }))).resolves.toEqual({ moved: true });
  });

  it('共用狀態不會因為交錯而遺失更新', async () => {
    /*
     * 直接模擬那個真實的失敗：持有者在 await 之間改一份共用狀態，而另一條路徑
     * （同步的合併）把那份狀態整個換成新物件。
     *
     * 第二個工作必須在第一個**已經開始跑之後**才送出 —— 兩個同時送出的話，
     * 連壞掉的那版實作也會乖乖排隊，測試就白寫了。等待進入是關鍵。
     */
    const exclusive = createSerialQueue();
    let shared = { items: ['existing'] };
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });

    const mutate = exclusive(async () => {
      const mine = shared;
      started();
      await Promise.resolve();
      await Promise.resolve();
      mine.items.push('added-by-mutator');
      // persist 讀的是模組層的那份，不是自己手上那份
      return shared.items.includes('added-by-mutator');
    });

    await running;
    const replace = exclusive(async () => {
      await Promise.resolve();
      shared = { items: [...shared.items, 'added-by-merge'] };
    });

    const persistedTheMutation = await mutate;
    await replace;

    expect(persistedTheMutation).toBe(true);
    expect(shared.items).toEqual(['existing', 'added-by-mutator', 'added-by-merge']);
  });

  /*
   * 這一項釘住的是「不可重入」的代價，不是它的好處。
   *
   * 2026-08-05 實機驗證踩到：`moveManyToFolder` 在鎖裡呼叫了會自己取鎖的
   * `moveBookmarkToFolder`，於是內層等外層、外層等內層，整個 vault 佇列從此
   * 卡死 —— 而且是無聲的，之後每一個寫入操作都跟著失效，UI 什麼都不會說。
   *
   * 所以：**在鎖裡要呼叫別的操作，一律走不取鎖的 `*Locked` 版本。**
   */
  it('在鎖裡再取一次鎖會死結（所以批量操作必須走 *Locked）', async () => {
    const exclusive = createSerialQueue();
    let innerRan = false;

    await exclusive(async () => {
      const nested = exclusive(async () => {
        innerRan = true;
      });
      // 內層永遠等不到，只能靠計時器把測試救回來
      await Promise.race([nested, new Promise((resolve) => setTimeout(resolve, 30))]);
    });

    expect(innerRan).toBe(false);
  });
});
