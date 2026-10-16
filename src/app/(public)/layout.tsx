import '@/app/public.css';
import '@/app/public-neural.css';
import PublicApp from '@/components/public/PublicApp';
import { PublicSessionProvider } from '@/components/public/PublicSession';
import { FixedSnapshotProvider } from '@/components/public/useFixedSnapshot';
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="public-surface"><PublicSessionProvider><FixedSnapshotProvider><PublicApp />{children}</FixedSnapshotProvider></PublicSessionProvider></div>;
}
