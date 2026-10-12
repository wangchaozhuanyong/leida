import { Suspense } from 'react';
import PublicApp from '@/components/public/PublicApp';
export default async function PublicPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return <Suspense fallback={<div className="pub-loading">正在读取公开资料…</div>}><PublicApp path={path} /></Suspense>;
}
