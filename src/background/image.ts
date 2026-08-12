import { t } from '@/shared/i18n';
import { edgeFraction, MIN_COVER_SIDE } from '@/shared/image-structure';

/** 產生縮圖用的影像處理。背景事件頁有 DOM，可直接用 OffscreenCanvas。 */

export interface Thumbnail {
  bytes: ArrayBuffer;
  mime: string;
  width: number;
  height: number;
}

const TARGET_WIDTH = 640;
const ASPECT = 16 / 9;

/**
 * 把任意影像轉成固定 16:9 的縮圖。
 *
 * 從頂端裁切而非整頁縮放：網頁高度差異極大（有的幾千像素），
 * 整頁塞進 16:9 會壓成無法辨識的細長條，而頁面頂端通常最有辨識度。
 * 反過來若來源比 16:9 更矮，則維持比例置頂並留白，避免橫向拉伸變形。
 */
export async function makeThumbnail(source: Blob): Promise<Thumbnail> {
  const bitmap = await createImageBitmap(source);
  try {
    const height = Math.round(TARGET_WIDTH / ASPECT);
    const canvas = new OffscreenCanvas(TARGET_WIDTH, height);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error(t('image_no_2d_context'));
    }

    const scale = TARGET_WIDTH / bitmap.width;
    const drawnHeight = Math.round(bitmap.height * scale);

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, TARGET_WIDTH, height);

    if (drawnHeight >= height) {
      // 來源比 16:9 高 → 從頂端裁掉多餘的部分
      const cropHeight = Math.round(height / scale);
      context.drawImage(bitmap, 0, 0, bitmap.width, cropHeight, 0, 0, TARGET_WIDTH, height);
    } else {
      // 來源比 16:9 矮 → 維持比例置頂，下方留白
      context.drawImage(bitmap, 0, 0, TARGET_WIDTH, drawnHeight);
    }

    const blob = await encode(canvas);
    return { bytes: await blob.arrayBuffer(), mime: blob.type, width: TARGET_WIDTH, height };
  } finally {
    bitmap.close();
  }
}

const COVER_MAX_WIDTH = 480;
const COVER_MAX_HEIGHT = 720;

/** 量邊緣比例用的取樣尺寸。夠小才快，夠大才留得住字的邊緣。 */
const PROBE_SIZE = 48;

export interface CoverThumbnail extends Thumbnail {
  /**
   * 這張圖裡有多少「結構」（見 `shared/image-structure.ts`）。
   *
   * 一起量出來而不是讓呼叫端自己算：位元組在這裡已經解成 bitmap 了，
   * 呼叫端要重算就得再解一次碼。要不要因為它而換下一個候選是呼叫端的政策。
   */
  edges: number;
}

/**
 * 封面圖用的縮圖：**維持原始長寬比，不裁切**。
 *
 * 這跟網頁截圖是相反的處理。截圖要統一成 16:9 才排得整齊，但封面圖
 * 一旦被裁成 16:9 就只剩最上面一條 —— 漫畫與書籍封面幾乎都是直式，
 * 影片封面又是橫式，硬套同一個比例會毀掉整張圖。
 *
 * 只做等比縮小（不放大），長寬各自設上限避免超高的圖佔滿整個側邊欄。
 */
export async function makeCoverThumbnail(source: Blob): Promise<CoverThumbnail> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(
      COVER_MAX_WIDTH / bitmap.width,
      COVER_MAX_HEIGHT / bitmap.height,
      1,
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error(t('image_no_2d_context'));
    }
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await encode(canvas);
    return {
      bytes: await blob.arrayBuffer(),
      mime: blob.type,
      width,
      height,
      // 用原始 bitmap 量，不是用縮好的縮圖：縮放本身會把邊緣抹掉一些
      edges: measureEdges(bitmap),
    };
  } finally {
    bitmap.close();
  }
}

/**
 * 把圖縮到小方塊上量邊緣比例。
 *
 * 原始尺寸太小的一律回 0（＝當成沒有結構）：那種來源只可能是被版面拉開的裝飾，
 * 而它的相鄰像素反而跳得很兇，光看邊緣比例會誤判成「內容豐富」。
 */
function measureEdges(bitmap: ImageBitmap): number {
  if (bitmap.width < MIN_COVER_SIDE || bitmap.height < MIN_COVER_SIDE) {
    return 0;
  }
  const canvas = new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE);
  const context = canvas.getContext('2d');
  if (context === null) {
    // 量不到就不要下結論
    return 1;
  }
  context.drawImage(bitmap, 0, 0, PROBE_SIZE, PROBE_SIZE);
  return edgeFraction(context.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data, PROBE_SIZE, PROBE_SIZE);
}

/**
 * 優先用 WebP（同畫質下比 JPEG 小約三到四成，縮圖累積上千張時差別可觀）。
 * convertToBlob 遇到不支援的型別會靜默改用 PNG，所以要檢查回傳的 type，
 * 不能只看有沒有拋錯。
 */
async function encode(canvas: OffscreenCanvas): Promise<Blob> {
  try {
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    if (webp.type === 'image/webp') {
      return webp;
    }
  } catch {
    // 落到 JPEG
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}
