"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useDateFnsLocale } from "@/i18n/date-locale";
import { formatCurrency } from "@/lib/currency";
import { isWithinDateRange } from "@/lib/billing/date-filter";
import type { Deal } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, Clock, Loader2, X, XCircle } from "lucide-react";

type ContactLite = { name: string | null; phone: string | null } | null;
type ItemLite = { product_name: string; quantity: number };

type BillingDeal = Pick<
  Deal,
  | "id"
  | "title"
  | "value"
  | "currency"
  | "delivery_fee"
  | "order_code"
  | "dispatched_at"
  | "in_process_at"
  | "cancelled_by"
  | "cancellation_reason"
  | "created_at"
> & { contact?: ContactLite; deal_items?: ItemLite[] };

type Variant = "sales" | "scheduled" | "cancelled";

// Same embed on all three statuses — one shape, three filters. Kept as
// a constant (not a function) since it never varies.
const SELECT =
  "id, title, value, currency, delivery_fee, order_code, dispatched_at, in_process_at, cancelled_by, cancellation_reason, created_at, contact:contacts(name, phone), deal_items(product_name, quantity)";

/**
 * Facturación — the plain ledger view Jose asked for: ventas, pedidos
 * agendados, and cancelados, each as a flat list with totals. This is
 * deliberately NOT a reimplementation of Pipelines (that page is a
 * sales-funnel kanban by stage) or Acciones (a queue of pending
 * work) — it reads the exact same `deals`/`deal_items` rows those
 * pages already write, split by `status` instead of `stage_id`, so
 * there is nothing new here that can drift out of sync with them.
 * Pure read-only report: no mutations, so no role gate beyond normal
 * dashboard access.
 */
export default function BillingPage() {
  const t = useTranslations("Billing");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();
  const dateLocale = useDateFnsLocale();

  const [sales, setSales] = useState<BillingDeal[] | null>(null);
  const [scheduled, setScheduled] = useState<BillingDeal[] | null>(null);
  const [cancelled, setCancelled] = useState<BillingDeal[] | null>(null);

  // "YYYY-MM-DD" from a date <input>, or "" for unbounded. Filters the
  // "Fecha" column (created_at) client-side — the three lists are
  // already fully loaded (capped at 200 each), so there's no reason to
  // round-trip to Supabase just to narrow a range already in memory.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const dateFilterActive = !!(dateFrom || dateTo);

  const load = useCallback(async () => {
    if (!accountId) return;
    const [salesRes, scheduledRes, cancelledRes] = await Promise.all([
      supabase
        .from("deals")
        .select(SELECT)
        .eq("status", "won")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("deals")
        .select(SELECT)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("deals")
        .select(SELECT)
        .eq("status", "lost")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (salesRes.error || scheduledRes.error || cancelledRes.error) {
      toast.error(t("toastLoadFailed"));
      return;
    }
    setSales((salesRes.data ?? []) as unknown as BillingDeal[]);
    setScheduled((scheduledRes.data ?? []) as unknown as BillingDeal[]);
    setCancelled((cancelledRes.data ?? []) as unknown as BillingDeal[]);
  }, [supabase, accountId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loading = sales === null || scheduled === null || cancelled === null;

  function filterByDate(deals: BillingDeal[] | null): BillingDeal[] {
    if (!deals) return [];
    if (!dateFilterActive) return deals;
    return deals.filter((d) => isWithinDateRange(d.created_at, dateFrom, dateTo));
  }

  const filteredSales = filterByDate(sales);
  const filteredScheduled = filterByDate(scheduled);
  const filteredCancelled = filterByDate(cancelled);

  function sumTotal(deals: BillingDeal[]) {
    return deals.reduce(
      (sum, d) => sum + Number(d.value || 0) + Number(d.delivery_fee || 0),
      0,
    );
  }

  function itemsLabel(items?: ItemLite[]) {
    if (!items || items.length === 0) return t("noItems");
    return items.map((i) => `${i.quantity}x ${i.product_name}`).join(", ");
  }

  function DispatchBadge({ deal }: { deal: BillingDeal }) {
    if (deal.dispatched_at) {
      return (
        <Badge variant="outline" className="border-emerald-600/40 bg-emerald-500/10 text-emerald-300">
          {t("dispatchDone")}
        </Badge>
      );
    }
    if (deal.in_process_at) {
      return (
        <Badge variant="outline" className="border-sky-600/40 bg-sky-500/10 text-sky-300">
          {t("dispatchInProcess")}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t("dispatchPending")}
      </Badge>
    );
  }

  function renderTable(deals: BillingDeal[], variant: Variant) {
    if (deals.length === 0) {
      return (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {dateFilterActive
            ? t("emptyFiltered")
            : t(
                variant === "sales"
                  ? "emptySales"
                  : variant === "scheduled"
                    ? "emptyScheduled"
                    : "emptyCancelled",
              )}
        </p>
      );
    }
    return (
      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colCode")}</TableHead>
              <TableHead>{t("colContact")}</TableHead>
              <TableHead>{t("colProducts")}</TableHead>
              <TableHead>{t("colTotal")}</TableHead>
              {variant === "sales" && <TableHead>{t("colDispatch")}</TableHead>}
              {variant === "cancelled" && <TableHead>{t("colReason")}</TableHead>}
              <TableHead>{t("colDate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deals.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="text-muted-foreground">{d.order_code || "—"}</TableCell>
                <TableCell className="text-foreground">
                  {d.contact?.name?.trim() || d.contact?.phone || t("unknownContact")}
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {itemsLabel(d.deal_items)}
                </TableCell>
                <TableCell className="font-medium text-foreground">
                  {formatCurrency(
                    Number(d.value || 0) + Number(d.delivery_fee || 0),
                    d.currency || defaultCurrency,
                  )}
                  {d.delivery_fee ? (
                    <div className="text-xs font-normal text-muted-foreground">
                      {t("deliveryFeeNote", {
                        amount: formatCurrency(d.delivery_fee, d.currency || defaultCurrency),
                      })}
                    </div>
                  ) : null}
                </TableCell>
                {variant === "sales" && (
                  <TableCell>
                    <DispatchBadge deal={d} />
                  </TableCell>
                )}
                {variant === "cancelled" && (
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {d.cancellation_reason || "—"}
                    {d.cancelled_by === "ai" && (
                      <div className="text-xs text-muted-foreground">{t("cancelledByAi")}</div>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDistanceToNow(new Date(d.created_at), {
                    addSuffix: true,
                    locale: dateLocale,
                  })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="billing-date-from" className="text-xs text-muted-foreground">
                {t("filterFrom")}
              </Label>
              <Input
                id="billing-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                max={dateTo || undefined}
                className="bg-muted border-border text-foreground h-9 w-auto"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billing-date-to" className="text-xs text-muted-foreground">
                {t("filterTo")}
              </Label>
              <Input
                id="billing-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                min={dateFrom || undefined}
                className="bg-muted border-border text-foreground h-9 w-auto"
              />
            </div>
            {dateFilterActive && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" />
                {t("filterClear")}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SummaryCard
              icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />}
              label={t("summarySales")}
              total={formatCurrency(sumTotal(filteredSales), defaultCurrency)}
              count={t("summarySalesCount", { count: filteredSales.length })}
            />
            <SummaryCard
              icon={<Clock className="h-4 w-4 text-sky-400" />}
              label={t("summaryScheduled")}
              total={formatCurrency(sumTotal(filteredScheduled), defaultCurrency)}
              count={t("summaryScheduledCount", { count: filteredScheduled.length })}
            />
            <SummaryCard
              icon={<XCircle className="h-4 w-4 text-red-400" />}
              label={t("summaryCancelled")}
              total={formatCurrency(sumTotal(filteredCancelled), defaultCurrency)}
              count={t("summaryCancelledCount", { count: filteredCancelled.length })}
            />
          </div>

          <Tabs defaultValue="sales">
            <TabsList className="bg-muted/50">
              <TabsTrigger value="sales">{t("tabSales")}</TabsTrigger>
              <TabsTrigger value="scheduled">{t("tabScheduled")}</TabsTrigger>
              <TabsTrigger value="cancelled">{t("tabCancelled")}</TabsTrigger>
            </TabsList>
            <TabsContent value="sales" className="mt-4">
              {renderTable(filteredSales, "sales")}
            </TabsContent>
            <TabsContent value="scheduled" className="mt-4">
              {renderTable(filteredScheduled, "scheduled")}
            </TabsContent>
            <TabsContent value="cancelled" className="mt-4">
              {renderTable(filteredCancelled, "cancelled")}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  total,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  total: string;
  count: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-2 text-xl font-bold text-foreground">{total}</p>
      <p className="text-xs text-muted-foreground">{count}</p>
    </div>
  );
}
