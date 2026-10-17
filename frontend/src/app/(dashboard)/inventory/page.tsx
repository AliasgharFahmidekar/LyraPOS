'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import toast from 'react-hot-toast';
import { ArrowDownCircle, ArrowUpCircle, AlertTriangle, ClipboardList, Edit, PackageMinus, Search, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';
import type { Product } from '@/lib/types';

type InventoryTab = 'products' | 'movements';
type StockAction = 'increase' | 'decrease' | 'set';

interface ProductMovement {
  id: number;
  product_id: string;
  product_name: string | null;
  quantity_delta: number;
  movement_type: 'sale' | 'cancel_restore' | 'adjustment' | string;
  reference_type: string | null;
  reference_id: string | null;
  reason: string | null;
  actor_user_id: string;
  actor_name: string | null;
  stock_after: number;
  created_at: string;
}

interface MovementPage {
  movements: ProductMovement[];
  nextCursor: number | null;
}

function getApiErrorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = (error as { response?: { data?: { error?: unknown } } }).response;
  return typeof response?.data?.error === 'string' ? response.data.error : undefined;
}

function isRequestCancelled(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'name' in error
    && ['CanceledError', 'AbortError'].includes(String((error as { name?: unknown }).name));
}

function isProductStockManaged(product: Product, inventoryTargets: Set<string>): boolean {
  return product.track_inventory || inventoryTargets.has(product.id);
}

function saleUnitTranslationKey(unit: Product['sale_unit']): 'saleUnitEach' | 'saleUnitKg' | 'saleUnitG' | 'saleUnitLb' | 'saleUnitMl' | 'saleUnitCl' | 'saleUnitL' | 'saleUnitFlOz' | 'saleUnitOz' {
  switch (unit) {
    case 'kg': return 'saleUnitKg';
    case 'g': return 'saleUnitG';
    case 'lb': return 'saleUnitLb';
    case 'ml': return 'saleUnitMl';
    case 'cl': return 'saleUnitCl';
    case 'l': return 'saleUnitL';
    case 'fl oz': return 'saleUnitFlOz';
    case 'oz': return 'saleUnitOz';
    default: return 'saleUnitEach';
  }
}

const movementTypeIcons = {
  sale: PackageMinus,
  cancel_restore: ArrowUpCircle,
  adjustment: Edit,
} as const;

export default function InventoryPage() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('inventory');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const tProducts = useTranslations('products');
  const { formatDate } = useFormatDate();
  const fmtNum = useFormatNumber();
  const canManage = hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager);

  const [tab, setTab] = useState<InventoryTab>('products');
  const [products, setProducts] = useState<Product[]>([]);
  const [movements, setMovements] = useState<ProductMovement[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [movementProductFilter, setMovementProductFilter] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [stockAction, setStockAction] = useState<StockAction>('increase');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const inventoryTargets = useMemo(
    () => new Set(products.map((product) => product.inventory_product_id).filter((id): id is string => Boolean(id))),
    [products],
  );

  const catalogProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return products.filter((product) => {
      if (!includeInactive && (!product.is_active || (product.category && !product.category.is_active))) return false;
      if (!query) return true;
      return [product.name, product.sku, product.barcode]
        .some((value) => typeof value === 'string' && value.toLocaleLowerCase().includes(query));
    });
  }, [products, includeInactive, search]);

  const visibleProducts = useMemo(() => {
    if (!lowStockOnly) return catalogProducts;
    return catalogProducts.filter((product) =>
      isProductStockManaged(product, inventoryTargets)
      && Number(product.stock_quantity ?? 0) <= Number(product.low_stock_threshold ?? 0),
    );
  }, [catalogProducts, lowStockOnly, inventoryTargets]);

  const refreshProducts = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    // Load the full catalog so inventory-product links remain resolvable even
    // when a linked source product is hidden by the current search/active filter.
    api.get('/products', { signal: controller.signal })
      .then(({ data }) => setProducts(Array.isArray(data.products) ? data.products : []))
      .catch((error: unknown) => {
        if (!isRequestCancelled(error)) toast.error(t('loadFailed'));
      });

    return () => controller.abort();
  }, [canManage, refreshKey, t]);

  const loadMovements = useCallback(async (cursor?: number | null, signal?: AbortSignal) => {
    try {
      const params: Record<string, string | number> = { per_page: 50 };
      if (cursor) params.before_id = cursor;
      if (movementProductFilter) params.product_id = movementProductFilter;
      const { data } = await api.get<MovementPage>('/inventory/movements', { params, signal });
      setMovements((current) => (cursor ? [...current, ...(data.movements || [])] : data.movements || []));
      setNextCursor(data.nextCursor ?? null);
    } catch (error: unknown) {
      if (!isRequestCancelled(error)) toast.error(t('loadFailed'));
    }
  }, [movementProductFilter, t]);

  useEffect(() => {
    if (!canManage || tab !== 'movements') return;
    const controller = new AbortController();
    void loadMovements(null, controller.signal);
    return () => controller.abort();
  }, [canManage, loadMovements, refreshKey, tab]);

  const openStockAdjustment = (product: Product) => {
    setSelectedProduct(product);
    setStockAction('increase');
    setQuantity('');
    setReason('');
  };

  const handleStockAdjustment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProduct || saving) return;

    const amount = Number(quantity);
    if (!Number.isFinite(amount) || amount < 0 || (stockAction !== 'set' && amount <= 0)) {
      toast.error(t('saveFailed'));
      return;
    }
    if (!reason.trim()) {
      toast.error(t('saveFailed'));
      return;
    }

    setSaving(true);
    try {
      await api.post('/products/' + encodeURIComponent(selectedProduct.id) + '/stock', {
        action: stockAction,
        quantity: amount,
        reason: reason.trim(),
      });
      toast.success(tCommon('save'));
      setSelectedProduct(null);
      refreshProducts();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error) || t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const movementLabel = (movementType: string): string => {
    if (movementType === 'sale') return t('saleMovement');
    if (movementType === 'cancel_restore') return t('cancelRestoreMovement');
    if (movementType === 'adjustment') return t('adjustment');
    return movementType;
  };

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="mb-2 text-xl font-bold text-foreground">{tNav('inventory')}</h1>
        <p className="text-muted-foreground">{t('noAccess')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{tNav('inventory')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tProducts('fieldStock')}</p>
        </div>
        {tab === 'products' && (
          <span className="text-sm text-muted-foreground">
            {fmtNum(visibleProducts.length)} / {fmtNum(catalogProducts.length)}
          </span>
        )}
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as InventoryTab)}>
        <TabsList>
          <TabsTrigger value="products">{tProducts('tabProducts')}</TabsTrigger>
          <TabsTrigger value="movements">{t('tabMovements')}</TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-48 flex-1">
              <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tCommon('search')}
                className="w-full rounded-lg border border-border bg-card py-2.5 pe-4 ps-10 outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
              <input type="checkbox" checked={lowStockOnly} onChange={(event) => setLowStockOnly(event.target.checked)} />
              {t('lowStockOnly')}
            </label>
            <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
              <input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} />
              {t('includeInactive')}
            </label>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px]">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{tProducts('columnProduct')}</th>
                    <th className="p-4 text-end text-xs font-medium uppercase text-muted-foreground">{tProducts('fieldStock')}</th>
                    <th className="p-4 text-end text-xs font-medium uppercase text-muted-foreground">{tProducts('fieldLowStockThreshold')}</th>
                    <th className="p-4 text-center text-xs font-medium uppercase text-muted-foreground">{tProducts('fieldTrackInventory')}</th>
                    <th className="p-4 text-center text-xs font-medium uppercase text-muted-foreground">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleProducts.map((product) => {
                    const stock = Number(product.stock_quantity ?? 0);
                    const threshold = product.low_stock_threshold === null ? null : Number(product.low_stock_threshold);
                    const stockManaged = isProductStockManaged(product, inventoryTargets);
                    const isOutOfStock = stockManaged && stock <= 0;
                    const isLowStock = stockManaged && !isOutOfStock && threshold !== null && stock <= threshold;

                    return (
                      <tr key={product.id} className="hover:bg-muted/60">
                        <td className="p-4">
                          <div className="font-medium text-foreground">{product.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            {product.sku && <span>SKU: {product.sku}</span>}
                            {product.barcode && <span>{product.barcode}</span>}
                          </div>
                        </td>
                        <td className={'whitespace-nowrap p-4 text-end text-sm font-semibold ' + (stock < 0 ? 'text-red-600' : 'text-foreground')}>
                          {fmtNum(stock)} {tProducts(saleUnitTranslationKey(product.sale_unit || 'each'))}
                          {isOutOfStock && (
                            <Badge variant="destructive" className="ms-2">
                              {t('outOfStock')}
                            </Badge>
                          )}
                          {isLowStock && (
                            <Badge variant="destructive" className="ms-2">
                              {t('lowStock')}
                            </Badge>
                          )}
                        </td>
                        <td className="p-4 text-end text-sm text-muted-foreground">
                          {threshold === null ? '—' : fmtNum(threshold) + ' ' + tProducts(saleUnitTranslationKey(product.sale_unit || 'each'))}
                        </td>
                        <td className="p-4 text-center text-sm">
                          <Badge variant={stockManaged ? 'secondary' : 'outline'}>
                            {stockManaged ? tCommon('active') : tCommon('inactive')}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Button variant="outline" size="sm" disabled={!stockManaged} onClick={() => openStockAdjustment(product)} title={!stockManaged ? tProducts('fieldTrackInventory') : t('recordMovement')}>
                            <Edit size={14} className="me-1" />
                            {t('recordMovement')}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {visibleProducts.length === 0 && (
              <p className="py-12 text-center text-muted-foreground">{t('emptyProducts')}</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="movements" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted-foreground" htmlFor="inventory-movement-product">{tProducts('columnProduct')}</label>
            <select
              id="inventory-movement-product"
              value={movementProductFilter}
              onChange={(event) => setMovementProductFilter(event.target.value)}
              className="min-w-56 rounded-lg border border-border bg-card px-3 py-2.5 outline-none focus:ring-2 focus:ring-brand"
            >
              <option value="">{t('allProducts')}</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px]">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('date')}</th>
                    <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{tProducts('columnProduct')}</th>
                    <th className="p-4 text-center text-xs font-medium uppercase text-muted-foreground">{t('movementType')}</th>
                    <th className="p-4 text-end text-xs font-medium uppercase text-muted-foreground">{t('quantity')}</th>
                    <th className="p-4 text-end text-xs font-medium uppercase text-muted-foreground">{t('stockAfter')}</th>
                    <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('reason')}</th>
                    <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('actor')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {movements.map((movement) => {
                    const Icon = movementTypeIcons[movement.movement_type as keyof typeof movementTypeIcons] || ClipboardList;
                    const movementProduct = products.find((product) => product.id === movement.product_id);
                    const unitLabel = movementProduct ? tProducts(saleUnitTranslationKey(movementProduct.sale_unit || 'each')) : '';
                    const delta = Number(movement.quantity_delta);
                    return (
                      <tr key={movement.id} className="hover:bg-muted/60">
                        <td className="whitespace-nowrap p-4 text-sm text-muted-foreground">{formatDate(movement.created_at)}</td>
                        <td className="p-4 text-sm font-medium text-foreground">{movement.product_name || movement.product_id}</td>
                        <td className="p-4 text-center text-sm">
                          <span className="inline-flex items-center gap-1.5">
                            <Icon size={14} className="text-muted-foreground" />
                            {movementLabel(movement.movement_type)}
                          </span>
                        </td>
                        <td className={'whitespace-nowrap p-4 text-end text-sm font-medium ' + (delta < 0 ? 'text-red-600' : 'text-emerald-600')}>
                          {delta > 0 ? '+' : ''}{fmtNum(delta)}{unitLabel ? ' ' + unitLabel : ''}
                        </td>
                        <td className={'whitespace-nowrap p-4 text-end text-sm ' + (Number(movement.stock_after) < 0 ? 'text-red-600' : 'text-muted-foreground')}>
                          {fmtNum(Number(movement.stock_after))}{unitLabel ? ' ' + unitLabel : ''}
                        </td>
                        <td className="p-4 text-sm text-muted-foreground">{movement.reason || '—'}</td>
                        <td className="p-4 text-sm text-muted-foreground">{movement.actor_name || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {movements.length === 0 && <p className="py-12 text-center text-muted-foreground">{t('emptyMovements')}</p>}
            {nextCursor !== null && (
              <div className="border-t border-border p-3 text-center">
                <Button variant="ghost" onClick={() => void loadMovements(nextCursor)}>
                  {t('loadMore')}
                </Button>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="inventory-adjustment-title"
            className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="inventory-adjustment-title" className="text-lg font-semibold text-foreground">{t('recordMovement')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{selectedProduct.name}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setSelectedProduct(null)} aria-label={tCommon('close')}>
                <X size={18} />
              </Button>
            </div>

            <div className="mb-4 rounded-lg bg-muted p-3">
              <div className="text-sm text-muted-foreground">{tProducts('fieldStock')}</div>
              <div className={'mt-1 text-xl font-semibold ' + (Number(selectedProduct.stock_quantity) < 0 ? 'text-red-600' : 'text-foreground')}>
                {fmtNum(Number(selectedProduct.stock_quantity ?? 0))} {tProducts(saleUnitTranslationKey(selectedProduct.sale_unit || 'each'))}
              </div>
              {Number(selectedProduct.stock_quantity ?? 0) <= 0 && (
                <p className="mt-2 flex items-center gap-2 text-sm text-red-600">
                  <AlertTriangle size={15} /> {t('outOfStock')}
                </p>
              )}
            </div>

            <form onSubmit={handleStockAdjustment} className="space-y-4">
              <div>
                <p className="mb-2 text-sm font-medium text-foreground">{t('movementType')}</p>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['increase', t('increaseStock'), ArrowUpCircle],
                    ['decrease', t('decreaseStock'), ArrowDownCircle],
                    ['set', t('setStock'), ClipboardList],
                  ] as const).map(([action, label, Icon]) => (
                    <Button
                      key={action}
                      type="button"
                      size="sm"
                      variant={stockAction === action ? 'default' : 'outline'}
                      disabled={saving}
                      onClick={() => setStockAction(action)}
                      className="min-w-0"
                    >
                      <Icon size={14} className="me-1 shrink-0" />
                      <span className="truncate">{label}</span>
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="inventory-stock-quantity" className="mb-1.5 block text-sm font-medium text-foreground">
                  {stockAction === 'set' ? tProducts('fieldStock') : t('quantity')}
                </label>
                <input
                  id="inventory-stock-quantity"
                  type="number"
                  min="0"
                  step={selectedProduct.sale_unit === 'each' ? '1' : 'any'}
                  required
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              <div>
                <label htmlFor="inventory-stock-reason" className="mb-1.5 block text-sm font-medium text-foreground">{t('reason')}</label>
                <textarea
                  id="inventory-stock-reason"
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" disabled={saving} onClick={() => setSelectedProduct(null)}>
                  {tCommon('cancel')}
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? tCommon('saving') : tCommon('save')}
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
