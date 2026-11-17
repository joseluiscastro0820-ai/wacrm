"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Product } from "@/types";
import { CURRENCIES, DEFAULT_CURRENCY, formatCurrency } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Package, Pencil, Plus, Trash2 } from "lucide-react";

/**
 * Catálogo — Agent Free's own product/inventory list (migration
 * add_products_catalog). Lives entirely inside this app: there is no
 * live sync with WhatsApp's native Commerce/Catalog feature yet (that
 * would need a separate Meta Business Manager catalog + the
 * `whatsapp_business_management` permission linked to the WABA — see
 * the note Jose got alongside this). This screen is what a "check
 * stock before confirming" AI tool or a product picker on the deal
 * form would eventually read from.
 */
export default function CatalogPage() {
  const t = useTranslations("Catalog");
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canEdit = useCan("send-messages"); // agent+, mirrors products_insert/update RLS
  const canDelete = useCan("edit-settings"); // admin+, mirrors products_delete RLS

  const [products, setProducts] = useState<Product[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("name");
    if (error) {
      toast.error(t("toastLoadFailed"));
      return;
    }
    setProducts((data ?? []) as Product[]);
  }, [supabase, accountId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setFormOpen(true);
  }

  async function handleDelete() {
    if (!deleting) return;
    setBusy(true);
    const { error } = await supabase.from("products").delete().eq("id", deleting.id);
    setBusy(false);
    if (error) {
      toast.error(t("toastDeleteFailed"));
      return;
    }
    toast.success(t("toastDeleted", { name: deleting.name }));
    setDeleting(null);
    await load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canEdit && (
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="h-4 w-4" />
            {t("addProduct")}
          </Button>
        )}
      </div>

      {products === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : products.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Package className="h-6 w-6 text-primary" />
          </div>
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="max-w-xs text-xs text-muted-foreground">{t("emptyDesc")}</p>
          {canEdit && (
            <Button size="sm" onClick={openCreate} className="mt-2">
              <Plus className="h-4 w-4" />
              {t("addProduct")}
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colSku")}</TableHead>
                <TableHead>{t("colPrice")}</TableHead>
                <TableHead>{t("colStock")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id} className={!p.is_active ? "opacity-60" : undefined}>
                  <TableCell>
                    <div className="font-medium text-foreground">{p.name}</div>
                    {p.description && (
                      <div className="max-w-xs truncate text-xs text-muted-foreground">
                        {p.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.sku || "—"}</TableCell>
                  <TableCell className="font-medium text-foreground">
                    {formatCurrency(p.price, p.currency)}
                  </TableCell>
                  <TableCell>
                    <StockBadge product={p} t={t} />
                  </TableCell>
                  <TableCell>
                    {p.is_active ? (
                      <Badge variant="outline" className="border-emerald-600/40 bg-emerald-500/10 text-emerald-300">
                        {t("statusActive")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        {t("statusInactive")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canEdit && (
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(p)} title={t("edit")}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDeleting(p)}
                          title={t("delete")}
                          className="text-muted-foreground hover:text-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {formOpen && (
        <ProductForm
          product={editing}
          userId={user?.id}
          accountId={accountId}
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false);
            await load();
          }}
        />
      )}

      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {deleting && t("deleteConfirmDesc", { name: deleting.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Stock pill: made-to-order (track_stock off), out, low, or healthy. */
function StockBadge({
  product,
  t,
}: {
  product: Product;
  t: ReturnType<typeof useTranslations>;
}) {
  if (!product.track_stock) {
    return (
      <Badge variant="outline" className="border-sky-600/40 bg-sky-500/10 text-sky-300">
        {t("stockMadeToOrder")}
      </Badge>
    );
  }
  if (product.stock_quantity <= 0) {
    return (
      <Badge variant="outline" className="border-red-600/40 bg-red-500/10 text-red-300">
        {t("stockOut")}
      </Badge>
    );
  }
  if (product.stock_quantity <= 5) {
    return (
      <Badge variant="outline" className="border-amber-600/40 bg-amber-500/10 text-amber-300">
        {t("stockLow", { count: product.stock_quantity })}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-border text-foreground">
      {t("stockAvailable", { count: product.stock_quantity })}
    </Badge>
  );
}

function ProductForm({
  product,
  userId,
  accountId,
  onClose,
  onSaved,
}: {
  product: Product | null;
  userId: string | undefined;
  accountId: string | null | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Catalog");
  const supabase = createClient();
  const isEdit = !!product;

  const [name, setName] = useState(product?.name ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(String(product?.price ?? ""));
  const [currency, setCurrency] = useState(product?.currency ?? DEFAULT_CURRENCY);
  const [stockQuantity, setStockQuantity] = useState(
    String(product?.stock_quantity ?? "0"),
  );
  const [trackStock, setTrackStock] = useState(product?.track_stock ?? true);
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t("toastNameRequired"));
      return;
    }
    if (!userId || !accountId) {
      toast.error(t("toastNoAccount"));
      return;
    }
    setSaving(true);
    const payload = {
      name: trimmedName,
      sku: sku.trim() || null,
      description: description.trim() || null,
      price: Number(price) || 0,
      currency,
      stock_quantity: Math.max(0, Math.trunc(Number(stockQuantity) || 0)),
      track_stock: trackStock,
      is_active: isActive,
    };

    const { error } = isEdit
      ? await supabase.from("products").update(payload).eq("id", product.id)
      : await supabase.from("products").insert({
          ...payload,
          user_id: userId,
          account_id: accountId,
        });
    setSaving(false);

    if (error) {
      toast.error(isEdit ? t("toastUpdateFailed") : t("toastCreateFailed"));
      return;
    }
    toast.success(isEdit ? t("toastUpdated") : t("toastCreated"));
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("editProduct") : t("addProduct")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>{t("fieldName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("fieldNamePlaceholder")} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>{t("fieldSku")}</Label>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t("fieldSkuPlaceholder")} />
            </div>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <div className="grid gap-2">
                <Label>{t("fieldPrice")}</Label>
                <Input
                  type="number"
                  min="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("fieldCurrency")}</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>{t("fieldDescription")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("fieldDescriptionPlaceholder")}
              rows={2}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t("fieldTrackStock")}</p>
              <p className="text-xs text-muted-foreground">{t("fieldTrackStockDesc")}</p>
            </div>
            <Switch checked={trackStock} onCheckedChange={setTrackStock} />
          </div>

          {trackStock && (
            <div className="grid gap-2">
              <Label>{t("fieldStockQuantity")}</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={stockQuantity}
                onChange={(e) => setStockQuantity(e.target.value)}
              />
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t("fieldActive")}</p>
              <p className="text-xs text-muted-foreground">{t("fieldActiveDesc")}</p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isEdit ? t("save") : t("addProduct")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
