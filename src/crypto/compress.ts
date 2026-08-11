import { t } from '@/shared/i18n';

import type { Bytes } from './bytes';

/**
 * gzip 壓縮，用來把隱私書籤塞進 storage.sync 的 100 KB 額度內。
 *
 * 網址與標題的重複性很高（同網域前綴、共同字詞），壓縮率通常約 3:1，
 * 直接把可容納的書籤數從數百筆推到上千筆。
 *
 * CompressionStream 需要 Firefox 113+；本擴充套件的下限是 140，所以一定有。
 * 仍保留可用性檢查，讓在其他環境（例如測試）跑時能明確失敗而不是靜默出錯。
 */
export const COMPRESSION_AVAILABLE = typeof CompressionStream !== 'undefined';

async function pipe(data: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  const piped = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function gzip(data: Bytes): Promise<Bytes> {
  if (!COMPRESSION_AVAILABLE) {
    throw new Error(t('crypto_no_compression_stream'));
  }
  return pipe(data, new CompressionStream('gzip'));
}

export async function gunzip(data: Bytes): Promise<Bytes> {
  if (!COMPRESSION_AVAILABLE) {
    throw new Error(t('crypto_no_decompression_stream'));
  }
  return pipe(data, new DecompressionStream('gzip'));
}
