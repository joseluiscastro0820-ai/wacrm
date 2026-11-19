"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Conversation } from "@/types";

/**
 * Count of items waiting for a human on the Acciones page: conversations
 * the AI handed off (`ai_autoreply_disabled=true`) that are unassigned or
 * assigned to the current user, plus pending devolución requests.
 *
 * Deliberately excludes "pedidos por despachar" (won deals awaiting
 * `in_process_at`/`dispatched_at`) — those are routine fulfillment work,
 * not something that needs the same urgency as a stuck chat or a
 * customer-initiated return. Keeps the sidebar badge meaningful instead
 * of permanently nonzero on any account that sells regularly.
 *
 * Re-fetches the relevant aggregate on every realtime event rather than
 * patching from the payload — `conversations` and `returns` aren't on
 * `REPLICA IDENTITY FULL` (only `notifications` is, see migration
 * 027_notifications), so `payload.old` can't be trusted to carry the
 * columns we'd need to apply a delta safely.
 */
export function useActionsPending(): number {
  const { user } = useAuth();
  const [handoffCount, setHandoffCount] = useState(0);
  const [returnsCount, setReturnsCount] = useState(0);

  useEffect(() => {
    if (!user?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHandoffCount(0);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    const userId = user.id;

    const refresh = async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, assigned_agent_id")
        .eq("ai_autoreply_disabled", true);
      if (cancelled || error || !data) return;
      const count = (
        data as Pick<Conversation, "id" | "assigned_agent_id">[]
      ).filter((c) => !c.assigned_agent_id || c.assigned_agent_id === userId).length;
      setHandoffCount(count);
    };

    refresh();

    const channel = supabase
      .channel("actions-pending-handoff")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        refresh,
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const refresh = async () => {
      const { count, error } = await supabase
        .from("returns")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");
      if (cancelled || error) return;
      setReturnsCount(count ?? 0);
    };

    refresh();

    const channel = supabase
      .channel("actions-pending-returns")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "returns" },
        refresh,
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return handoffCount + returnsCount;
}
