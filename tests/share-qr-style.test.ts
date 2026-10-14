import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import { qrSvg } from '../src/server/share-qr';

interface RasterResult { data: Buffer; info: { width: number; height: number; channels: number }; }
interface RasterPipeline {
  resize(width: number): RasterPipeline;
  flatten(options: { background: string }): RasterPipeline;
  png(): RasterPipeline;
  ensureAlpha(): RasterPipeline;
  raw(): RasterPipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<RasterResult>;
}
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
const rasterize = nextRequire('sharp') as (input: Buffer) => RasterPipeline;

async function decoded(svg: string, width: number) {
  // Decode the generated artwork after a PNG round-trip, including real
  // downsampling. A recreated matrix would not verify the circular styling.
  const png = await rasterize(Buffer.from(svg)).resize(width).flatten({ background: '#fff' }).png().toBuffer();
  const { data, info } = await rasterize(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' });
  assert.ok(code, `点阵网页二维码在 ${width}px 的实际 PNG 中必须可解码`);
  return code.data;
}

test('圆点和圆形定位眼保留网页 QR 的扫码信息，短链接及固定版本长链接可实际解码', async () => {
  const urls = [
    'https://radar.example.org/',
    'http://127.0.0.1:5190/events/event_942bd49b-250e-45cd-9bf7-083b811f3a09?publication=pub_942bd49b-250e-45cd-9bf7-083b811f3a09',
    'https://radar.example.org/events/event_942bd49b-250e-45cd-9bf7-083b811f3a09?publication=pub_942bd49b-250e-45cd-9bf7-083b811f3a09',
  ];
  for (const url of urls) {
    const svg = qrSvg(url);
    assert.match(svg, /width="320" height="320" viewBox="0 0 320 320"/);
    assert.equal((svg.match(/r="3\.5"/g) ?? []).length, 3);
    assert.match(svg, /<circle [^>]*r="\.49"/);
    assert.match(svg, /<rect [^>]*width="1" height="1"/);
    assert.doesNotMatch(svg, /<path|stroke=|clipPath/);
    for (const width of [320, 192, 160]) assert.equal(await decoded(svg, width), url);
  }
});

test('高密度长链接的完整点阵和白色安静区仍可解码', async () => {
  const url = `https://radar.example.org/events/archive?publication=${'published-version-'.repeat(14)}`;
  assert.equal(await decoded(qrSvg(url), 320), url);
});
