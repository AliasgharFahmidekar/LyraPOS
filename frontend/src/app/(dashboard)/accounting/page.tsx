'use client';

import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { hasRole, ROLE_ACCESS } from '@shared/role-permissions';
import { AccountingSettings } from '@/components/settings/AccountingSettings';

export default function AccountingPage() {
  const locale = useLocale();
  const role = useAuthStore((state) => state.currentTenant?.role);
  const isAdmin = hasRole(role, ROLE_ACCESS.ownerManager);

  if (!isAdmin) {
    return (
      <section dir={locale.toLowerCase().startsWith('fa') ? 'rtl' : 'ltr'} className="rounded-xl border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{locale.toLowerCase().startsWith('fa') ? 'دسترسی غیرمجاز' : 'Access denied'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {locale.toLowerCase().startsWith('fa') ? 'برای دسترسی به حسابداری باید مدیر یا مالک مجموعه باشید.' : 'Accounting is available to owners and managers only.'}
        </p>
      </section>
    );
  }

  return (
    <div className="min-h-0 w-full overflow-y-auto">
      <AccountingSettings isAdmin={isAdmin} mode="operations" />
    </div>
  );
}
