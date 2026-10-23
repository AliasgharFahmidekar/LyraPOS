'use client';

import { useState } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { hasRole, ROLE_ACCESS } from '@shared/role-permissions';
import {
  ArrowLeftRight, CalendarClock, BarChart3, FileBarChart2,
  LayoutDashboard, Landmark, ReceiptText, Settings2, Wallet, WalletCards,
} from 'lucide-react';
import { AccountingSettings } from '@/components/settings/AccountingSettings';
import { AccountingReports } from '@/components/settings/AccountingReports';
import { AccountingFutureItems } from '@/components/settings/AccountingFutureItems';
import { AccountingRecurringObligations } from '@/components/settings/AccountingRecurringObligations';
import { AccountingLoans } from '@/components/settings/AccountingLoans';
import { AccountingForecast } from '@/components/settings/AccountingForecast';
import { AccountingOverview } from '@/components/settings/AccountingOverview';
import { AccountingAccounts } from '@/components/settings/AccountingAccounts';

type AccountingView = 'overview' | 'accounts' | 'operations' | 'reports' | 'futureItems' | 'recurring' | 'loans' | 'forecast' | 'settings';

export default function AccountingPage() {
  const locale = useLocale();
  const [view, setView] = useState<AccountingView>('overview');
  const isPersian = locale.toLowerCase().startsWith('fa');
  const role = useAuthStore((state) => state.currentTenant?.role);
  const isAdmin = hasRole(role, ROLE_ACCESS.ownerManager);

  const sections: Array<{ id: AccountingView; title: string; icon: typeof LayoutDashboard }> = [
    { id: 'overview', title: isPersian ? 'نمای کلی' : 'Overview', icon: LayoutDashboard },
    { id: 'accounts', title: isPersian ? 'حساب‌ها' : 'Accounts', icon: Wallet },
    { id: 'operations', title: isPersian ? 'عملیات حسابداری' : 'Operations', icon: ArrowLeftRight },
    { id: 'reports', title: isPersian ? 'گزارش‌ها' : 'Reports', icon: FileBarChart2 },
    { id: 'futureItems', title: isPersian ? 'دریافت‌ها و چک‌های آتی' : 'Future receipts & cheques', icon: ReceiptText },
    { id: 'recurring', title: isPersian ? 'تعهدات تکرارشونده' : 'Recurring obligations', icon: CalendarClock },
    { id: 'loans', title: isPersian ? 'وام‌ها و اقساط' : 'Loans & instalments', icon: WalletCards },
    { id: 'forecast', title: isPersian ? 'پیش‌بینی مالی' : 'Financial forecast', icon: BarChart3 },
    { id: 'settings', title: isPersian ? 'تنظیمات حسابداری' : 'Accounting settings', icon: Settings2 },
  ];

  if (!isAdmin) {
    return (
      <section dir={isPersian ? 'rtl' : 'ltr'} className="accounting-theme rounded-xl border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{isPersian ? 'دسترسی غیرمجاز' : 'Access denied'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {isPersian ? 'برای دسترسی به حسابداری باید مدیر یا مالک مجموعه باشید.' : 'Accounting is available to owners and managers only.'}
        </p>
      </section>
    );
  }

  return (
    <main className="accounting-theme acct-page min-h-0 w-full space-y-5" dir={isPersian ? 'rtl' : 'ltr'}>
      <nav className="acct-navigation" role="tablist" aria-label={isPersian ? 'بخش‌های حسابداری' : 'Accounting sections'}>
        {sections.map(({ id, title, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={view === id}
            onClick={() => setView(id)} className={view === id ? 'acct-nav-item is-active' : 'acct-nav-item'}>
            <Icon size={17} strokeWidth={1.8} /><span>{title}</span>
          </button>
        ))}
      </nav>

      <div className="acct-view-content" key={view}>
        {view === 'overview' && <AccountingOverview onOpen={(next) => setView(next as AccountingView)} />}
        {view === 'accounts' && <AccountingAccounts />}
        {view === 'operations' && <AccountingSettings isAdmin={isAdmin} mode="operations" />}
        {view === 'reports' && <AccountingReports />}
        {view === 'futureItems' && <AccountingFutureItems />}
        {view === 'recurring' && <AccountingRecurringObligations />}
        {view === 'loans' && <AccountingLoans />}
        {view === 'forecast' && <AccountingForecast />}
        {view === 'settings' && <AccountingSettings isAdmin={isAdmin} mode="settings" />}
      </div>
    </main>
  );
}
