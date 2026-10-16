import { apiError, body, json } from '@/server/http';
import { confirmWechatSubscription, revokeWechatSubscription, saveWechatReminderPreferences, wechatLogin, wechatSubscriptionChallenge, wechatSubscriptionState } from '@/server/wechat';

export const dynamic = 'force-dynamic';
function readerToken(request: Request): string {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/i)?.[1];
  if (!token) throw Object.assign(new Error('请先在小程序内连接微信提醒。'), { status: 401 });
  return token;
}
const missing = () => { throw Object.assign(new Error('未找到微信操作。'), { status: 404 }); };
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    if (path.join('/') !== 'subscription') return missing();
    return json(await wechatSubscriptionState(readerToken(request)));
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    switch (path.join('/')) {
      case 'login': {
        const input = await body(request);
        return json(await wechatLogin(input?.code));
      }
      case 'subscription/challenge': return json(await wechatSubscriptionChallenge(readerToken(request)));
      case 'subscription/confirm': return json(await confirmWechatSubscription(readerToken(request), await body(request)));
      case 'subscription/preferences': return json(await saveWechatReminderPreferences(readerToken(request), await body(request)));
      default: return missing();
    }
  } catch (error) { return apiError(error); }
}
export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    if (path.join('/') !== 'subscription') return missing();
    return json(await revokeWechatSubscription(readerToken(request)));
  } catch (error) { return apiError(error); }
}
