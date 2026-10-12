import QRCode from 'qrcode';

/** A dotted website QR; only WeChat can supply a genuine mini-program code. */
export function qrSvg(url: string): string {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('无效的扫码地址');
  const modules = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
  const quiet = 4, side = modules.size + quiet * 2, scale = 224 / side, offset = 48;
  const cells: string[] = [];
  const finders = [[0, 0], [modules.size - 7, 0], [0, modules.size - 7]] as const;
  for (let row = 0; row < modules.size; row++) for (let column = 0; column < modules.size; column++) {
    if (finders.some(([left, top]) => column >= left && column < left + 7 && row >= top && row < top + 7)) continue;
    if (!modules.get(row, column)) continue;
    // Timing, alignment, format and version modules must keep their standard
    // geometry, especially when a multi-version URL creates a dense matrix.
    cells.push(modules.isReserved(row, column)
      ? `<rect x="${column + quiet}" y="${row + quiet}" width="1" height="1"/>`
      : `<circle cx="${column + quiet + .5}" cy="${row + quiet + .5}" r=".49"/>`);
  }
  const eyes = finders.map(([left, top]) => `<circle cx="${left + quiet + 3.5}" cy="${top + quiet + 3.5}" r="3.5"/><circle cx="${left + quiet + 3.5}" cy="${top + quiet + 3.5}" r="2.5" fill="#fff"/><circle cx="${left + quiet + 3.5}" cy="${top + quiet + 3.5}" r="1.5"/>`).join('');
  // Keep the matrix, timing/alignment patterns and the full four-module quiet
  // zone inside the white disc. No radial decoration or clipping invents a code.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><circle cx="160" cy="160" r="159" fill="#fff"/><g transform="translate(${offset} ${offset}) scale(${scale})" fill="#101d2d">${cells.join('')}${eyes}</g></svg>`;
}
