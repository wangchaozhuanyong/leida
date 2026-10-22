export const statusPosterStyles = [
  { id: 'precision', label: '黑金仪表' },
  { id: 'editorial', label: '水墨刊物' },
] as const;
export type StatusPosterStyle = typeof statusPosterStyles[number]['id'];
export type StatusPosterCodeState = 'included' | 'omitted' | 'unavailable';

/** Missing style retains the existing API contract for older clients. */
export function parseStatusPosterOptions(params: URLSearchParams): { style?: StatusPosterStyle; includeCode: boolean } {
  const style = params.get('style'), code = params.get('code');
  if (style !== null && !statusPosterStyles.some(option => option.id === style)) throw new Error('海报样式无效');
  if (code !== null && code !== 'mini' && code !== 'none') throw new Error('海报码选项无效');
  return { style: style as StatusPosterStyle | null ?? undefined, includeCode: code !== 'none' };
}

export function statusPosterVariant(endpoint: string, filename: string, style: StatusPosterStyle, includeCode: boolean) {
  const [path, query = ''] = endpoint.split('?');
  const params = new URLSearchParams(query);
  params.set('style', style); params.set('code', includeCode ? 'mini' : 'none');
  const label = statusPosterStyles.find(option => option.id === style)!.label;
  return { endpoint: `${path}?${params}`, filename: filename.replace(/\.png$/i, `-${label}${includeCode ? '-圆码版' : ''}.png`) };
}
