"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, PackageX, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import type { Product } from "@/types";

interface CatalogPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (product: Product) => void;
}

/**
 * Lists the account's active catalog products for a quick send from the
 * composer — the "catálogo" button Jose asked for, which had no home
 * anywhere in the Inbox before this. Mirrors QuickReplyPicker's shape
 * (dialog + list + onPick) but reads straight from `products` (RLS
 * already scopes it to the account) instead of an API route, since the
 * Catálogo page already queries the table the same way client-side.
 */
export function CatalogPicker({ open, onOpenChange, onPick }: CatalogPickerProps) {
  const t = useTranslations("Inbox.composer");
  const supabase = createClient();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("is_active", true)
        .order("name");
      if (!cancelled && !error) {
        setItems((data ?? []) as Product[]);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // supabase client is stable across renders — omitting it from deps
    // avoids re-fetching on every keystroke in the search box below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the search box each time the dialog is reopened.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.category ?? "").toLowerCase().includes(q) ||
        (p.sku ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("catalog")}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("catalogSearchPlaceholder")}
            className="w-full rounded-md border border-border bg-muted px-8 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
          />
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <PackageX className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {items.length === 0 ? t("catalogEmpty") : t("catalogNoMatches")}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((p) => {
                const outOfStock = p.track_stock && p.stock_quantity <= 0;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onPick(p)}
                      className="flex w-full items-center gap-3 rounded-md border border-border bg-muted/40 p-2.5 text-left hover:border-primary/50 hover:bg-muted"
                    >
                      {p.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.image_url}
                          alt={p.name}
                          className="h-10 w-10 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
                          {p.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {p.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatCurrency(p.price, p.currency)}
                          {outOfStock ? ` · ${t("catalogOutOfStock")}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
