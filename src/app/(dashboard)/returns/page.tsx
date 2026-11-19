"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useDateFnsLocale } from "@/i18n/date-locale";
import type { Return, ReturnReasonCategory, ReturnStatus } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, Loader2, Undo2, X } from "lucide-react";

/**
 * Devoluciones — return requests a customer started themselves by
 * tapping a row on the "¿qué deseas devolver?" list an agent sent from
 * the Inbox (ContactSidebar). This is the review queue Jose asked for:
 * approving one is the ONLY thing that restores stock (via the
 * returns_stock_on_approval trigger, migration
 * add_returns_and_catalog_reservations) — a still-pending or rejected
 * request never touches the Catálogo.
 */
export default function ReturnsPage() {
  const t = useTranslations("Returns");
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canReview = useCan("send-messages"); // agent+, mirrors returns_update RLS
  const dateLocale = useDateFnsLocale();

  const [returns, setReturns] = useState<Return[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from("returns")
      .select("*, contact:contacts(name, phone)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      toast.error(t("toastLoadFailed"));
      return;
    }
    setReturns((data ?? []) as Return[]);
  }, [supabase, accountId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function review(id: string, status: ReturnStatus) {
    setBusyId(id);
    const { error } = await supabase
      .from("returns")
      .update({
        status,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastReviewFailed"));
      return;
    }
    toast.success(status === "approved" ? t("toastApproved") : t("toastRejected"));
    await load();
  }

  /** Badge for the AI's reason_category (migration 047) — null for
   *  returns filed before it existed or via the interactive-list path,
   *  which doesn't ask. */
  function ReasonBadge({ category }: { category: ReturnReasonCategory | null | undefined }) {
    if (!category) return <span className="text-muted-foreground">—</span>;
    if (category === "warranty") {
      return (
        <Badge variant="outline" className="border-amber-600/40 bg-amber-500/10 text-amber-300">
          {t("reasonWarranty")}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t("reasonChangeOfMind")}
      </Badge>
    );
  }

  const pending = returns?.filter((r) => r.status === "pending") ?? [];
  const resolved = returns?.filter((r) => r.status !== "pending") ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {returns === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : returns.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Undo2 className="h-6 w-6 text-primary" />
          </div>
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="max-w-xs text-xs text-muted-foreground">{t("emptyDesc")}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t("pendingSection", { count: pending.length })}
              </h2>
              <div className="overflow-hidden rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colContact")}</TableHead>
                      <TableHead>{t("colProduct")}</TableHead>
                      <TableHead>{t("colQuantity")}</TableHead>
                      <TableHead>{t("colReason")}</TableHead>
                      <TableHead>{t("colRequested")}</TableHead>
                      <TableHead className="w-32" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-foreground">
                          {r.contact?.name?.trim() || r.contact?.phone || t("unknownContact")}
                        </TableCell>
                        <TableCell className="text-foreground">
                          {r.product_name}
                          {r.customer_note && (
                            <div className="max-w-xs truncate text-xs text-muted-foreground">
                              {r.customer_note}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{r.quantity}</TableCell>
                        <TableCell>
                          <ReasonBadge category={r.reason_category} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDistanceToNow(new Date(r.created_at), {
                            addSuffix: true,
                            locale: dateLocale,
                          })}
                        </TableCell>
                        <TableCell>
                          {canReview ? (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon-sm"
                                variant="outline"
                                disabled={busyId === r.id}
                                onClick={() => review(r.id, "approved")}
                                title={t("approve")}
                                className="border-emerald-600/40 text-emerald-400 hover:bg-emerald-500/10"
                              >
                                {busyId === r.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="outline"
                                disabled={busyId === r.id}
                                onClick={() => review(r.id, "rejected")}
                                title={t("reject")}
                                className="border-red-600/40 text-red-400 hover:bg-red-500/10"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {resolved.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t("historySection")}
              </h2>
              <div className="overflow-hidden rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colContact")}</TableHead>
                      <TableHead>{t("colProduct")}</TableHead>
                      <TableHead>{t("colQuantity")}</TableHead>
                      <TableHead>{t("colReason")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colRequested")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {resolved.map((r) => (
                      <TableRow key={r.id} className="opacity-70">
                        <TableCell className="text-foreground">
                          {r.contact?.name?.trim() || r.contact?.phone || t("unknownContact")}
                        </TableCell>
                        <TableCell className="text-foreground">
                          {r.product_name}
                          {r.customer_note && (
                            <div className="max-w-xs truncate text-xs text-muted-foreground">
                              {r.customer_note}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{r.quantity}</TableCell>
                        <TableCell>
                          <ReasonBadge category={r.reason_category} />
                        </TableCell>
                        <TableCell>
                          {r.status === "approved" ? (
                            <Badge variant="outline" className="border-emerald-600/40 bg-emerald-500/10 text-emerald-300">
                              {t("statusApproved")}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">
                              {t("statusRejected")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDistanceToNow(new Date(r.created_at), {
                            addSuffix: true,
                            locale: dateLocale,
                          })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
