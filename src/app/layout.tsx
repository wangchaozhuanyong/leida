import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:{default:'模钥重置雷达',template:'%s · 模钥重置雷达'},description:'有依据的重置公告、中文动态和站内提醒'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
