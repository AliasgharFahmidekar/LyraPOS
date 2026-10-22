'use client';

import { useState } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { hasRole, ROLE_ACCESS } from '@shared/role-permissions';
import { AccountingSettings } from '@/components/settings/AccountingSettings';
import { AccountingReports } from '@/components/settings/AccountingReports';
import { AccountingFutureItems } from '@/components/settings/AccountingFutureItems';
import { AccountingRecurringObligations } from '@/components/settings/AccountingRecurringObligations';

export default function AccountingPage() {
  const locale = useLocale();
  const [view, setView] = useState<'operations' | 'reports' | 'futureItems' | 'recurring'>('operations');
  const isPersian = locale.toLowerCase().startsWith('fa');
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
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label={isPersian ? 'بخش‌های حسابداری' : 'Accounting sections'} dir={isPersian ? 'rtl' : 'ltr'}>
        <button type="button" role="tab" aria-selected={view === 'operations'} onClick={() => setView('operations')} className={view === 'operations' ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>
          {isPersian ? 'عملیات حسابداری' : 'Accounting operations'}
        </button>
        <button type="button" role="tab" aria-selected={view === 'reports'} onClick={() => setView('reports')} className={view === 'reports' ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>
          {isPersian ? 'گزارش‌های مالی' : 'Financial reports'}
        </button>
        <button type="button" role="tab" aria-selected={view === 'futureItems'} onClick={() => setView('futureItems')} className={view === 'futureItems' ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>
          {isPersian ? 'دریافت‌ها و چک‌های آتی' : 'Future receipts & cheques'}
        </button>
        <button type="button" role="tab" aria-selected={view === 'recurring'} onClick={() => setView('recurring')} className={view === 'recurring' ? 'rounded-lg border border-brand bg-brand/10 px-4 py-2 text-sm text-brand' : 'rounded-lg border border-border px-4 py-2 text-sm'}>
          {isPersian ? 'تعهدات تکرارشونده' : 'Recurring obligations'}
        </button>
      </div>
      {view === 'reports' ? <AccountingReports /> : view === 'futureItems' ? <AccountingFutureItems /> : view === 'recurring' ? <AccountingRecurringObligations /> : <AccountingSettings isAdmin={isAdmin} mode="operations" />}
    </div>
  );
}
