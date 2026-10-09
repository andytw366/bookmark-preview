import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetPlaintextTraces } from '@/background/vault-traces';
import { getLastCapture, recordCapture } from '@/storage/diagnostics';
import { isResolved, rememberRedirect } from '@/storage/redirect-map';
import { noteDeclaredImages } from '@/storage/site-image-stats';
import { getPreviewChoice, setPreviewChoice } from '@/storage/preview-choice';

/**
 * 書籤移進隱私空間後，明文快取裡不能再找得到它的網址（2026-10-09 實機發現：
 * Wikipedia 移進去之後頁面網址還在 `siteImageStats`、SO 還在 `redirectTargets`）。
 */
let store: Record<string, unknown>;

function dump(): string {
  return JSON.stringify(store);
}

beforeEach(() => {
  store = {};
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, structuredClone(items));
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
  });
});

describe('forgetPlaintextTraces', () => {
  it('三份快取裡的書籤網址與它轉址到的網址都清掉，別人的留著', async () => {
    await rememberRedirect('http://secret.example/a', 'https://secret.example/a/');
    await rememberRedirect('https://keep.example/', 'https://keep.example/');
    // 學習紀錄記的是分頁停在的網址（轉址後那個）
    await noteDeclaredImages('https://secret.example/a/', ['https://secret.example/logo.png'], { learn: true });
    await noteDeclaredImages('https://secret.example/b', ['https://secret.example/logo.png'], { learn: true });
    await noteDeclaredImages('https://keep.example/', ['https://keep.example/og.png'], { learn: true });
    await recordCapture({ stage: 'ok', url: 'https://secret.example/a/', at: 1 });

    await forgetPlaintextTraces(['http://secret.example/a']);

    expect(dump()).not.toContain('secret.example/a');
    expect(await isResolved('http://secret.example/a')).toBe(false);
    expect(await getLastCapture()).toBeNull();
    // 同網域其他頁面學到的、其他網域的都不動
    expect(dump()).toContain('https://secret.example/b');
    expect(dump()).toContain('https://keep.example');
    expect(await isResolved('https://keep.example/')).toBe(true);
  });

  it('別的書籤轉址到隱私網址的那筆也清掉', async () => {
    await rememberRedirect('https://x.example/', 'https://x.example/zh-TW/');
    await forgetPlaintextTraces(['https://x.example/zh-TW/']);
    expect(dump()).not.toContain('zh-TW');
  });

  it('最後一次診斷是別的網址就不動', async () => {
    await recordCapture({ stage: 'ok', url: 'https://other.example/', at: 1 });
    await forgetPlaintextTraces(['https://secret.example/']);
    expect((await getLastCapture())?.url).toBe('https://other.example/');
  });

  /** 鍵是雜湊，但對得上猜得到的網址；那筆選擇移入時已經搬進加密 payload */
  it('手動選的預覽方式也清掉，別人的留著', async () => {
    await setPreviewChoice('https://secret.example/', 'icon');
    await setPreviewChoice('https://keep.example/', 'page');
    await forgetPlaintextTraces(['https://secret.example']);
    expect(await getPreviewChoice('https://secret.example/')).toBeUndefined();
    expect(await getPreviewChoice('https://keep.example/')).toBe('page');
  });

  it('頁面拿光的圖與空掉的網域整筆刪掉', async () => {
    await noteDeclaredImages('https://secret.example/', ['https://secret.example/x.png'], { learn: true });
    await forgetPlaintextTraces(['https://secret.example/']);
    expect(dump()).not.toContain('secret.example');
  });
});

describe('noteDeclaredImages 的 learn: false', () => {
  it('照已學到的結論判斷全站共用圖，但不把這一頁寫進去', async () => {
    const logo = 'https://site.example/logo.png';
    await noteDeclaredImages('https://site.example/one', [logo], { learn: true });
    const before = dump();

    const siteWide = await noteDeclaredImages('https://site.example/secret', [logo], { learn: false });

    expect(siteWide.has(logo)).toBe(true);
    expect(dump()).toBe(before);
    expect(dump()).not.toContain('secret');
  });
});
