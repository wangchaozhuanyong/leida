import { requireAdminPage } from '@/server/auth';
import AdminApp from '@/components/admin/AdminApp';
export const dynamic='force-dynamic';
export default async function AdminPage(){await requireAdminPage();return <AdminApp/>;}
