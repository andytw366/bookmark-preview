import { makeCoverThumbnail, type Thumbnail } from './image';

/**
 * 把候選封面網址取下來並做成縮圖，第一個成功的就採用。
 *
 * 帶 referrer 是為了對付防盜連：不少圖片 CDN 會檢查 Referer，
 * 沒有的話回 403。擴充套件的 fetch 不受 CORS 限制，但仍會照規則送 Referer。
 *
 * credentials: 'omit' —— 不帶使用者的 cookie。圖片幾乎不需要，
 * 而且對一個主打隱私的擴充套件來說，能不送就不送。
 */
const TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 12_000_000;

export async function fetchCoverThumbnail(
  candidates: readonly string[],
  pageUrl: string,
): Promise<Thumbnail | null> {
  for (const candidate of candidates) {
    const blob = await fetchImage(candidate, pageUrl);
    if (blob === null) {
      continue;
    }
    try {
      return await makeCoverThumbnail(blob);
    } catch {
      // 這張解碼失敗（可能是 SVG 或壞檔），換下一張
      continue;
    }
  }
  return null;
}

async function fetchImage(url: string, pageUrl: string): Promise<Blob | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      referrer: pageUrl,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    if (!(response.headers.get('content-type') ?? '').startsWith('image/')) {
      return null;
    }
    const blob = await response.blob();
    return blob.size > MAX_IMAGE_BYTES ? null : blob;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
