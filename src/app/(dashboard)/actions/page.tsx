"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useDateFnsLocale } from "@/i18n/date-locale";
import { formatCurrency } from "@/lib/currency";
import type { Conversation, Deal, Return, ReturnStatus } from "@/types";
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
import {
  Check,
  Loader2,
  MessageCircle,
  PackageSearch,
  Sparkles,
  Truck,
  X,
} from "lucide-react";

type ContactLite = { name: string | null; phone: string | null } | null;

type HandoffRow = Pick<
  Conversation,
  "id" | "last_message_text" | "last_message_at" | "ai_handoff_summary" | "assigned_agent_id"
> & { contact?: ContactLite };

type DispatchDeal = Pick<
  Deal,
  | "id"
  | "title"
  | "value"
  | "currency"
  | "in_process_at"
  | "dispatched_at"
  | "created_at"
  | "conversation_id"
  | "contact_id"
  | "order_code"
> & { contact?: ContactLite };

/**
 * Acciones — a single mobile-friendly page that aggregates everything
 * Jose asked to be able to do "desde el celular, en tiempo real" without
 * waiting on the Android app (Fase 2/3, still pending): give any pending
 * confirmation a chat needs, mark pedidos "en proceso"/"despachado", and
 * approve/reject devoluciones.
 *
 * Deliberately a thin aggregator, not a reimplementation:
 *  - Handoff chats link out to `/inbox?c=<id>`, which already deep-links
 *    into the full MessageThread (realtime view + reply, media,
 *    templates) — see src/app/(dashboard)/inbox/page.tsx.
 *  - Devoluciones review reuses the exact query/mutation shape of
 *    src/app/(dashboard)/returns/page.tsx (that page stays the place for
 *    the full history; this one only surfaces what's pending).
 *  - "Pedidos por despachar" is the one genuinely new piece: two
 *    nullable timestamps on `deals` (migration
 *    044_deal_fulfillment_status), no new RLS needed since deals_update
 *    (migration 017_account_sharing) already covers agent+.
 */
export default function ActionsPage() {
  const t = useTranslations("Actions");
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canAct = useCan("send-messages"); // agent+, mirrors deals_update/returns_update RLS
  const dateLocale = useDateFnsLocale();

  const [handoffs, setHandoffs] = useState<HandoffRow[] | null>(null);
  const [pendingReturns, setPendingReturns] = useState<Return[] | null>(null);
  const [deals, setDeals] = useState<DispatchDeal[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadHandoffs = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from("conversations")
      .select(
        "id, last_message_text, last_message_at, ai_handoff_summary, assigned_agent_id, contact:contacts(name, phone)",
      )
      .eq("ai_autoreply_disabled", true)
      .order("last_message_at", { ascending: false })
      .limit(50);
    if (error) {
      toast.error(t("toastLoadFailed"));
      return;
    }
    setHandoffs((data ?? []) as unknown as HandoffRow[]);
  }, [supabase, accountId, t]);

  const loadReturns = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from("returns")
      .select("*, contact:contacts(name, phone)")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      toast.error(t("toastLoadFailed"));
      return;
    }
    setPendingReturns((data ?? []) as Return[]);
  }, [supabase, accountId, t]);

  const loadDeals = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from("deals")
      .select(
        "id, title, value, currency, in_process_at, dispatched_at, created_at, conversation_id, contact_id, order_code, contact:contacts(name, phone)",
      )
      .eq("status", "won")
      .is("dispatched_at", null)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) {
      toast.error(t("toastLoadFailed"));
      return;
    }
    setDeals((data ?? []) as unknown as DispatchDeal[]);
  }, [supabase, accountId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHandoffs();
    loadReturns();
    loadDeals();
  }, [loadHandoffs, loadReturns, loadDeals]);

  async function reviewReturn(id: string, status: ReturnStatus) {
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
    await loadReturns();
  }

  // Fire-and-forget WhatsApp notice to the CUSTOMER that their order's
  // fulfillment status changed — a real gap Jose flagged: before this,
  // "en proceso"/"despachado" only updated these two timestamps and the
  // customer never heard about either. Mirrors the existing
  // notify-deal-won / dispatch-terms pattern: reuses the dashboard's own
  // `/api/whatsapp/send` route (role already gated to agent+ by
  // `canAct` above), targets the deal's conversation when there is one
  // (falling back to contact_id so a deal with no thread yet still
  // find-or-creates one), and never blocks or surfaces its own errors —
  // a WhatsApp hiccup must not undo the status change that already
  // succeeded.
  function notifyOrderStatus(deal: DispatchDeal, text: string) {
    if (!deal.conversation_id && !deal.contact_id) return;
    fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(deal.conversation_id
          ? { conversation_id: deal.conversation_id }
          : { contact_id: deal.contact_id }),
        message_type: "text",
        content_text: text,
      }),
    }).catch(() => {});
  }

  async function markInProcess(id: string) {
    setBusyId(id);
    const deal = deals?.find((d) => d.id === id);
    const { error } = await supabase
      .from("deals")
      .update({ in_process_at: new Date().toISOString() })
      .eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastDealUpdateFailed"));
      return;
    }
    if (deal) {
      const code = deal.order_code ? ` ${deal.order_code}` : "";
      notifyOrderStatus(
        deal,
        `🛠️ Tu pedido${code} está en proceso: ya lo estamos preparando.`,
      );
    }
    toast.success(t("toastMarkedInProcess"));
    await loadDeals();
  }

  async function markDispatched(id: string) {
    setBusyId(id);
    const nowIso = new Date().toISOString();
    const deal = deals?.find((d) => d.id === id);
    const { error } = await supabase
      .from("deals")
      .update({
        dispatched_at: nowIso,
        // Dispatching implies it was processed — backfill in_process_at
        // if the agent skipped straight to "despachado".
        ...(deal && !deal.in_process_at ? { in_process_at: nowIso } : {}),
      })
      .eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastDealUpdateFailed"));
      return;
    }
    if (deal) {
      const code = deal.order_code ? ` ${deal.order_code}` : "";
      notifyOrderStatus(
        deal,
        `🚚 Tu pedido${code} fue despachado. ¡Pronto estará contigo!`,
      );
    }
    toast.success(t("toastMarkedDispatched"));
    await loadDeals();
  }

  const loading = handoffs === null || pendingReturns === null || deals === null;
  const totalPending =
    (handoffs?.length ?? 0) + (pendingReturns?.length ?? 0) + (deals?.length ?? 0);

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
      ) : totalPending === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="max-w-xs text-xs text-muted-foreground">{t("emptyDesc")}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* ---------------------------------------------------------- */}
          {/* Chats que requieren un humano                               */}
          {/* ---------------------------------------------------------- */}
          {handoffs && handoffs.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t("handoffSection", { count: handoffs.length })}
              </h2>
              <div className="space-y-2">
                {handoffs.map((c) => (
                  <Link
                    key={c.id}
                    href={`/inbox?c=${c.id}`}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-muted/60"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
                      <MessageCircle className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {c.contact?.name?.trim() || c.contact?.phone || t("unknownContact")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.ai_handoff_summary || c.last_message_text || t("noPreview")}
                      </p>
                    </div>
                    {c.last_message_at && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(c.last_message_at), {
                          addSuffix: true,
                          locale: dateLocale,
                        })}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Devoluciones pendientes                                     */}
          {/* ---------------------------------------------------------- */}
          {pendingReturns && pendingReturns.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("returnsSection", { count: pendingReturns.length })}
                </h2>
                <Link
                  href="/returns"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t("seeAll")}
                </Link>
              </div>
              <div className="overflow-hidden rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colContact")}</TableHead>
                      <TableHead>{t("colProduct")}</TableHead>
                      <TableHead>{t("colQuantity")}</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingReturns.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-foreground">
                          {r.contact?.name?.trim() || r.contact?.phone || t("unknownContact")}
                        </TableCell>
                        <TableCell className="text-foreground">{r.product_name}</TableCell>
                        <TableCell className="text-muted-foreground">{r.quantity}</TableCell>
                        <TableCell>
                          {canAct ? (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon-sm"
                                variant="outline"
                                disabled={busyId === r.id}
                                onClick={() => reviewReturn(r.id, "approved")}
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
                                onClick={() => reviewReturn(r.id, "rejected")}
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
            </section>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Pedidos por despachar                                       */}
          {/* ---------------------------------------------------------- */}
          {deals && deals.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t("dispatchSection", { count: deals.length })}
              </h2>
              <div className="space-y-2">
                {deals.map((d) => (
                  <div
                    key={d.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-lime-500/15 text-lime-400">
                      <PackageSearch className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{d.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {d.contact?.name?.trim() || d.contact?.phone || t("unknownContact")}
                        {" · "}
                        {formatCurrency(d.value, d.currency)}
                      </p>
                    </div>
                    {d.in_process_at ? (
                      <Badge
                        variant="outline"
                        className="border-sky-600/40 bg-sky-500/10 text-sky-300"
                      >
                        {t("statusInProcess")}
                      </Badge>
                    ) : null}
                    {canAct && (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === d.id || !!d.in_process_at}
                          onClick={() => markInProcess(d.id)}
                        >
                          {busyId === d.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <PackageSearch className="h-3.5 w-3.5" />
                          )}
                          {t("markInProcess")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === d.id}
                          onClick={() => markDispatched(d.id)}
                          className="border-emerald-600/40 text-emerald-400 hover:bg-emerald-500/10"
                        >
                          {busyId === d.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Truck className="h-3.5 w-3.5" />
                          )}
                          {t("markDispatched")}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
