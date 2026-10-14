import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import type { BenefitAction, Publication } from '../src/lib/types';
import { publicationUrl } from '../src/lib/share';
import { statusPosterSvg, type StatusPosterInput } from '../src/server/status-poster';
import { parseStatusPosterOptions, statusPosterVariant, statusPosterStyles } from '../src/lib/status-poster-style';

interface RasterResult { data: Buffer; info: { width: number; height: number; channels: number }; }
interface RasterPipeline {
  flatten(options: { background: string }): RasterPipeline;
  png(): RasterPipeline;
  ensureAlpha(): RasterPipeline;
  raw(): RasterPipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<RasterResult>;
}
interface PixelInput { create: { width: number; height: number; channels: 4; background: { r: number; g: number; b: number; alpha: number } }; }
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
// QA only: Next already supplies sharp. Production does not need another dependency.
const rasterize = nextRequire('sharp') as (input: Buffer | PixelInput) => RasterPipeline;
const generatedAt = '2026-10-10T14:46:00Z';
const statementAt = '2026-10-08T03:44:00Z';

function publication(): Publication {
  const id = 'pub-fixed-completion', eventId = 'event-public-card', articleId = 'article-public-card';
  return {
    id, eventId, articleId, publishedAt: '2026-10-09T00:00:00Z', cutoffAt: '2026-10-09T01:00:00Z', reason: '固定公开原文版本', mode: 'state_change',
    event: {
      id: eventId, title: '发放记录', version: 2, status: 'published', publicationId: id, updatedAt: statementAt, evidenceIds: ['source-1'],
      actions: [{ id: 'completed-card', kind: 'banked_reset', stage: 'claimed_complete', scope: 'public', eligibility: '付费账户', statementAt, evidenceIds: ['source-1'] }],
    },
    article: {
      id: articleId, eventId, publicationId: id, title: '公告称重置卡已发放', summary: '公开完成声明，个人到账情况尚未观测。', translation: '', category: 'reset', version: 3,
      status: 'published', evidenceIds: ['source-1'], publishedAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', publicationMode: 'state_change',
    },
  };
}
function input(patch: Partial<StatusPosterInput> = {}): StatusPosterInput {
  const selected = patch.publication ?? publication();
  return { publication: selected, actionId: 'completed-card', name: '模钥重置雷达', generatedAt, shareUrl: publicationUrl('https://radar.example.org', selected), ...patch };
}
function announcement(patch: Partial<BenefitAction> = {}): BenefitAction {
  return { id: 'next-announcement', kind: 'automatic_reset', stage: 'promised', scope: 'public', eligibility: '公开用户', statementAt: '2026-10-10T02:00:00Z', evidenceIds: ['source-2'], ...patch };
}
async function decodedPoster(svg: string): Promise<{ url: string; width: number; height: number }> {
  // Decode the complete served SVG after a PNG round-trip; do not reconstruct its QR matrix.
  const png = await rasterize(Buffer.from(svg)).flatten({ background: '#101f33' }).png().toBuffer();
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const { data, info } = await rasterize(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' });
  assert.ok(code, '完整状态海报转为 PNG 后，网页二维码必须可以独立解码');
  return { url: code.data, width: info.width, height: info.height };
}

test('首页状态海报使用明确选择的公开完成动作，不取其他动作或文章措辞', () => {
  const selected = publication();
  selected.event.actions.unshift({ ...selected.event.actions[0], id: 'other-completion', kind: 'automatic_reset', statementAt: '2026-10-10T02:00:00Z' });
  selected.article.title = '这段中文文章标题不应覆盖完成状态';
  const before = structuredClone(selected);
  const svg = statusPosterSvg(input({ publication: selected }));
  assert.match(svg, /公告称已发放重置卡/);
  assert.match(svg, />2 天<\/text>/);
  assert.doesNotMatch(svg, /公告称已重置用量|这段中文文章标题/);
  assert.match(statusPosterSvg(input({ publication: selected, actionId: 'other-completion' })), /公告称已重置用量/);
  assert.throws(() => statusPosterSvg(input({ actionId: 'missing-action' })), /公开完成声明/);
  assert.deepEqual(selected, before, '生成海报不得修改发布快照');
});

test('间隔按生成时间计算，声明和生成时间均明确标为北京时间', () => {
  const svg = statusPosterSvg(input());
  assert.match(svg, />2 天<\/text>/);
  assert.match(svg, /10月8日 11:44 · 北京时间/);
  assert.match(svg, /生成于 10月10日 22:46 · 北京时间/);
  assert.doesNotMatch(svg, /生成于 10月9日/);
  assert.match(svg, /公开完成声明/);
  assert.match(svg, /海报为生成时的记录，扫码查看发放依据/);
  for (const [offset, label] of [[0, '刚刚'], [5 * 60000, '5 分钟'], [3 * 3600000, '3 小时'], [24 * 3600000, '1 天']] as const) {
    assert.ok(statusPosterSvg(input({ generatedAt: new Date(Date.parse(statementAt) + offset).toISOString() })).includes(`>${label}</text>`));
  }
});

test('下一次时间只来自未过期公开预告，过期或未知日期不当作未来重置日期', () => {
  const future = statusPosterSvg(input({ nextAction: announcement({ expectedAt: '2026-10-11T03:30:00Z' }) }));
  assert.match(future, /下次重置预告：10月11日 11:30前 · 北京时间/);
  assert.match(future, /公开预告，实际重置待确认/);
  for (const expectedAt of [undefined, 'invalid-date']) {
    const svg = statusPosterSvg(input({ nextAction: announcement({ expectedAt }) }));
    assert.match(svg, /已有发放预告，具体时间等待公开确认/);
    assert.doesNotMatch(svg, /下次重置预告：|下次发卡预告：/);
  }
  for (const expectedAt of ['2026-10-08T03:30:00Z', generatedAt]) {
    const svg = statusPosterSvg(input({ nextAction: announcement({ expectedAt }) }));
    assert.match(svg, /已过预计时间，等待公开确认/);
    assert.doesNotMatch(svg, /下次重置预告：|下次发卡预告：/);
  }
  for (const nextAction of [undefined, announcement({ scope: 'private', expectedAt: '2026-10-11T03:30:00Z' }), announcement({ stage: 'claimed_complete' }), announcement({ stage: 'cancelled' })]) {
    const svg = statusPosterSvg(input({ nextAction }));
    assert.match(svg, /暂无可靠的下次重置日期/);
    assert.doesNotMatch(svg, /下次重置预告：|下次发卡预告：/);
  }
});

test('网页回退码在完整品牌海报 PNG 内可扫，仍绑定固定发布 URL', async () => {
  const selected = publication();
  const shareUrl = publicationUrl('https://radar.example.org', selected);
  const svg = statusPosterSvg(input({ publication: selected, shareUrl }));
  assert.deepEqual(await decodedPoster(svg), { url: shareUrl, width: 900, height: 1200 });
  assert.match(svg, /查看最新状态与原文依据/);
  assert.doesNotMatch(svg, /微信通知你|已开启微信提醒/);
});

test('本机状态海报明确说明手机扫码限制，图像仍可解码固定版本', async () => {
  const selected = publication();
  const shareUrl = publicationUrl('http://127.0.0.1:5190', selected);
  const svg = statusPosterSvg(input({ publication: selected, shareUrl }));
  assert.match(svg, /本机预览码，手机扫码需正式网站地址/);
  assert.equal((await decodedPoster(svg)).url, shareUrl);
});

test('仅新闻、私有和定向动作、预告或非公开发布不能生成完成状态海报', () => {
  const cases: Publication[] = [];
  const byMode = publication(); byMode.mode = 'news_only'; cases.push(byMode);
  const byArticle = publication(); byArticle.article.publicationMode = 'news_only'; cases.push(byArticle);
  for (const scope of ['private', 'targeted'] as const) { const selected = publication(); selected.event.actions[0].scope = scope; cases.push(selected); }
  for (const stage of ['promised', 'in_progress', 'cancelled'] as const) { const selected = publication(); selected.event.actions[0].stage = stage; cases.push(selected); }
  for (const status of ['withdrawn', 'merged'] as const) { const selected = publication(); selected.event.status = status; cases.push(selected); }
  const withdrawnArticle = publication(); withdrawnArticle.article.status = 'withdrawn'; cases.push(withdrawnArticle);
  for (const selected of cases) assert.throws(() => statusPosterSvg(input({ publication: selected })), /公开完成声明/);
});

test('非法声明时间、生成时间和发生在生成之后的声明拒绝生成', () => {
  for (const invalid of ['invalid-date', '', '2026-99-99T25:00:00Z']) {
    assert.throws(() => statusPosterSvg(input({ generatedAt: invalid })), /公开完成声明/);
    const selected = publication(); selected.event.actions[0].statementAt = invalid;
    assert.throws(() => statusPosterSvg(input({ publication: selected })), /公开完成声明/);
  }
  assert.throws(() => statusPosterSvg(input({ generatedAt: '2026-10-08T03:43:59Z' })), /公开完成声明/);
});

test('图像合同夹具原字节完整嵌入，错版本、格式不符和截断图像拒绝', async () => {
  // This is a one-pixel image for transport/layout validation only. It is not a
  // WeChat-generated or scannable mini-program code and never proves real scanning.
  const image = await rasterize({ create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const selected = publication();
  const code = { publicationId: selected.id, image, contentType: 'image/png' };
  const svg = statusPosterSvg(input({ publication: selected, code }));
  assert.ok(svg.includes(`href="data:image/png;base64,${image.toString('base64')}"`));
  assert.match(svg, /width="168" height="168" preserveAspectRatio="xMidYMid meet"/);
  assert.match(svg, /微信扫码，查看重置记录/);
  assert.match(svg, /进入小程序，查看依据并订阅提醒/);
  assert.doesNotMatch(svg, /查看最新状态与原文依据/);
  assert.throws(() => statusPosterSvg(input({ code: { ...code, publicationId: 'other-publication' } })), /版本不匹配/);
  assert.throws(() => statusPosterSvg(input({ code: { ...code, contentType: 'image/jpeg' } })), /版本不匹配/);
  for (const broken of [image.subarray(0, 8), image.subarray(0, image.length - 1), Buffer.from('<svg/>')]) {
    assert.throws(() => statusPosterSvg(input({ code: { ...code, image: broken } })), /不完整|格式无效/);
  }
  assert.throws(() => statusPosterSvg(input({ code, shareUrl: 'javascript:alert(1)' })), /扫码地址/);
});

test('名称在 SVG 属性与文字中正确转义，不添加注入的图像或脚本', () => {
  const svg = statusPosterSvg(input({ name: '模钥 <品牌> & "记录"' }));
  assert.match(svg, /模钥 &lt;品牌&gt; &amp; &quot;记录&quot;/);
  assert.doesNotMatch(svg, /<品牌>/);
});

test('模板切换保留发布目标和动作，无圆码版不请求微信，非法选项拒绝', () => {
  const old = '/api/v1/posters/fixed?layout=status&action=completed-card';
  const variant = statusPosterVariant(old, 'record.png', 'editorial', false);
  const url = new URL(variant.endpoint, 'https://radar.example.org');
  assert.equal(url.pathname, '/api/v1/posters/fixed');
  assert.equal(url.searchParams.get('action'), 'completed-card');
  assert.equal(url.searchParams.get('layout'), 'status');
  assert.deepEqual(parseStatusPosterOptions(url.searchParams), { style: 'editorial', includeCode: false });
  assert.equal(variant.filename, 'record-水墨刊物.png');
  assert.deepEqual(parseStatusPosterOptions(new URLSearchParams('style=precision&code=mini')), { style: 'precision', includeCode: true });
  assert.deepEqual(parseStatusPosterOptions(new URLSearchParams()), { style: undefined, includeCode: true });
  assert.deepEqual(parseStatusPosterOptions(new URLSearchParams('style=editorial')), { style: 'editorial', includeCode: false });
  for (const value of ['style=unknown', 'style=../../outside', 'style=', 'style=editorial&code=fake']) assert.throws(() => parseStatusPosterOptions(new URLSearchParams(value)), /无效/);
});

for (const { id: style } of statusPosterStyles) {
  test(`${style} 动态模板使用真实状态和北京时间，无码时不绘制假码`, async () => {
    const selected = publication();
    const svg = statusPosterSvg(input({ style, publication: selected }));
    assert.match(svg, new RegExp(`data-poster-style="${style}"`));
    assert.match(svg, /公告称已发放重置卡/);
    assert.match(svg, /距该公告 2 天/);
    assert.match(svg, /2026\.10\.08/); assert.match(svg, /11:44/);
    assert.match(svg, /生成于 2026\.10\.10 22:46 · 北京时间/);
    assert.match(svg, /下一次时间待公开确认/);
    assert.match(svg, /个人状态以账户显示为准/);
    assert.match(svg, /依据：所选公开公告/);
    assert.doesNotMatch(svg, /圆码示意|扫码|二维码|设计样张|data-poster-code/);
    const png = await rasterize(Buffer.from(svg)).png().toBuffer();
    assert.equal(png.readUInt32BE(16), 1080); assert.equal(png.readUInt32BE(20), 1920);
    const future = statusPosterSvg(input({ style, nextAction: announcement({ expectedAt: '2026-10-11T03:30:00Z' }) }));
    assert.match(future, /下次重置预告/); assert.match(future, /实际完成待确认/);
    const expired = statusPosterSvg(input({ style, nextAction: announcement({ expectedAt: generatedAt }) }));
    assert.match(expired, /已过预计时间/); assert.doesNotMatch(expired, /下次重置预告/);
    assert.throws(() => statusPosterSvg(input({ style, actionId: 'missing' })), /公开完成声明/);
  });

  test(`${style} 圆码保持原始字节、正确版本和完整图像，验证失败不输出`, async () => {
    const image = await rasterize({ create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const code = { publicationId: publication().id, image, contentType: 'image/png' };
    const svg = statusPosterSvg(input({ style, code }));
    assert.match(svg, /data-poster-code="mini"/);
    assert.ok(svg.includes(`href="data:image/png;base64,${image.toString('base64')}"`));
    assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
    assert.doesNotMatch(svg, /clip-path|圆码示意|微信通知你/);
    assert.throws(() => statusPosterSvg(input({ style, code: { ...code, publicationId: 'wrong' } })), /版本不匹配/);
    assert.throws(() => statusPosterSvg(input({ style, code: { ...code, image: image.subarray(0, 9) } })), /不完整|格式无效/);
  });
}
