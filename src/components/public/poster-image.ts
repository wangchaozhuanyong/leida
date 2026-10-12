import type { StatusPosterCodeState } from '@/lib/status-poster-style';
export type PosterImage = { blob: Blob; url: string; filename: string; codeState?: StatusPosterCodeState };

/** Rasterize the very SVG served by the publication API, so preview and download agree. */
export async function createPosterImage(publicationId: string, filename: string, signal: AbortSignal): Promise<PosterImage> {
  return createPosterFromEndpoint(`/api/v1/posters/${encodeURIComponent(publicationId)}`, filename, signal);
}

/** Both single-publication and activity-day posters use the server's fixed-version rendering. */
export async function createPosterFromEndpoint(endpoint: string, filename: string, signal: AbortSignal): Promise<PosterImage> {
  if (!/^\/api\/v1\/(?:posters|activity-posters|forecast-posters)\//.test(endpoint) || /[\r\n]/.test(endpoint)) throw new Error('海报地址无效。');
  const response = await fetch(endpoint, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(response.status === 410 ? '此内容已撤回，已停止生成海报。' : '海报生成失败，请稍后重试。');
  const svg = await response.blob();
  const source = URL.createObjectURL(svg);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        image.onload = null; image.onerror = null;
        if (error) reject(error); else resolve();
      };
      const abort = () => { image.src = ''; finish(new DOMException('已取消', 'AbortError')); };
      const timer = setTimeout(() => finish(new Error('图片生成超时，请重新生成。')), 15_000);
      image.onload = () => finish();
      image.onerror = () => finish(new Error('浏览器未能生成海报图片，请重试。'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      image.src = source;
    });
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (image.naturalHeight > 16_384 || image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error('内容较长，暂时无法生成图片海报，请分享此版本链接。');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持图片海报，请分享此版本链接。');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('海报图片生成失败，请重试。')), 'image/png'));
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const codeHeader = response.headers.get('X-Poster-Code');
    const codeState = codeHeader === 'included' || codeHeader === 'omitted' || codeHeader === 'unavailable' ? codeHeader : undefined;
    return { blob, url: URL.createObjectURL(blob), filename, codeState };
  } finally { URL.revokeObjectURL(source); }
}

export function savePosterImage(image: PosterImage): void {
  const anchor = document.createElement('a');
  anchor.href = image.url; anchor.download = image.filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}
