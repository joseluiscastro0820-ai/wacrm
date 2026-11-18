"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Coins, Loader2, MapPin, Percent, Plus, Trash2, Truck } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import type { DeliveryZone, VolumeDiscount } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Deals settings — account-wide default currency.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Writes go straight to `accounts.default_currency`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control.
 */
export function DealsSettings() {
  const supabase = createClient();
  const {
    accountId,
    defaultCurrency,
    defaultDeliveryFee,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCurrency);
  const [saving, setSaving] = useState(false);
  const t = useTranslations("Settings.deals");

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  const dirty = selected !== defaultCurrency;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ default_currency: selected })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the deal form
    // and every total pick it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success(t("saveSuccess"));
  }

  // Default delivery fee — its own input/dirty/save, independent of
  // the currency control above. "" means "no default configured"
  // (writes null), matching deals.delivery_fee's own null = unset.
  const [deliveryFee, setDeliveryFee] = useState(
    defaultDeliveryFee === null ? "" : String(defaultDeliveryFee),
  );
  const [savingDeliveryFee, setSavingDeliveryFee] = useState(false);

  useEffect(() => {
    setDeliveryFee(defaultDeliveryFee === null ? "" : String(defaultDeliveryFee));
  }, [defaultDeliveryFee]);

  const deliveryFeeDirty =
    deliveryFee !== (defaultDeliveryFee === null ? "" : String(defaultDeliveryFee));

  async function handleSaveDeliveryFee() {
    if (!accountId || !deliveryFeeDirty) return;
    setSavingDeliveryFee(true);
    const { error } = await supabase
      .from("accounts")
      .update({
        default_delivery_fee: deliveryFee.trim() === "" ? null : parseFloat(deliveryFee) || 0,
      })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveDeliveryFeeFailed"));
      setSavingDeliveryFee(false);
      return;
    }
    await refreshProfile();
    setSavingDeliveryFee(false);
    toast.success(t("saveDeliveryFeeSuccess"));
  }

  // Delivery zones (migration 043) — per-city overrides on top of the
  // default fee above. Loaded straight from Supabase (RLS already
  // restricts writes to admin+, matching canEditSettings below), not
  // through useAuth: unlike currency/delivery-fee defaults, nothing
  // outside Settings + the deal form needs this list, so it doesn't
  // belong in the global profile fetch.
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [zonesLoading, setZonesLoading] = useState(true);
  const [newZoneLabel, setNewZoneLabel] = useState("");
  const [newZoneFee, setNewZoneFee] = useState("");
  const [savingZone, setSavingZone] = useState(false);
  const [deletingZoneId, setDeletingZoneId] = useState<string | null>(null);

  // Volume discounts (migration 043) — quantity threshold -> % off.
  const [discounts, setDiscounts] = useState<VolumeDiscount[]>([]);
  const [discountsLoading, setDiscountsLoading] = useState(true);
  const [newDiscountQty, setNewDiscountQty] = useState("");
  const [newDiscountPercent, setNewDiscountPercent] = useState("");
  const [savingDiscount, setSavingDiscount] = useState(false);
  const [deletingDiscountId, setDeletingDiscountId] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const [z, d] = await Promise.all([
        supabase
          .from("delivery_zones")
          .select("*")
          .eq("account_id", accountId)
          .order("label"),
        supabase
          .from("volume_discounts")
          .select("*")
          .eq("account_id", accountId)
          .order("min_quantity"),
      ]);
      if (cancelled) return;
      setZones((z.data ?? []) as DeliveryZone[]);
      setZonesLoading(false);
      setDiscounts((d.data ?? []) as VolumeDiscount[]);
      setDiscountsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  async function handleAddZone() {
    if (!accountId || !newZoneLabel.trim() || savingZone) return;
    setSavingZone(true);
    const { data, error } = await supabase
      .from("delivery_zones")
      .insert({
        account_id: accountId,
        label: newZoneLabel.trim(),
        fee: parseFloat(newZoneFee) || 0,
      })
      .select()
      .single();
    setSavingZone(false);
    if (error) {
      // Most likely cause: a zone with this exact name already exists
      // (UNIQUE(account_id, label)) — surfaced generically since the
      // DB error text isn't localized.
      toast.error(t("zoneSaveFailed"));
      return;
    }
    setZones((prev) =>
      [...prev, data as DeliveryZone].sort((a, b) => a.label.localeCompare(b.label)),
    );
    setNewZoneLabel("");
    setNewZoneFee("");
  }

  async function handleDeleteZone(id: string) {
    setDeletingZoneId(id);
    const { error } = await supabase.from("delivery_zones").delete().eq("id", id);
    setDeletingZoneId(null);
    if (error) {
      toast.error(t("zoneDeleteFailed"));
      return;
    }
    setZones((prev) => prev.filter((z) => z.id !== id));
  }

  async function handleAddDiscount() {
    if (!accountId || savingDiscount) return;
    const minQuantity = Math.trunc(Number(newDiscountQty));
    const discountPercent = Number(newDiscountPercent);
    if (!Number.isFinite(minQuantity) || minQuantity < 2) {
      toast.error(t("discountQtyInvalid"));
      return;
    }
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      toast.error(t("discountPercentInvalid"));
      return;
    }
    setSavingDiscount(true);
    const { data, error } = await supabase
      .from("volume_discounts")
      .insert({
        account_id: accountId,
        min_quantity: minQuantity,
        discount_percent: discountPercent,
      })
      .select()
      .single();
    setSavingDiscount(false);
    if (error) {
      // Most likely cause: a rule for this exact threshold already
      // exists (UNIQUE(account_id, min_quantity)).
      toast.error(t("discountSaveFailed"));
      return;
    }
    setDiscounts((prev) =>
      [...prev, data as VolumeDiscount].sort((a, b) => a.min_quantity - b.min_quantity),
    );
    setNewDiscountQty("");
    setNewDiscountPercent("");
  }

  async function handleDeleteDiscount(id: string) {
    setDeletingDiscountId(id);
    const { error } = await supabase.from("volume_discounts").delete().eq("id", id);
    setDeletingDiscountId(null);
    if (error) {
      toast.error(t("discountDeleteFailed"));
      return;
    }
    setDiscounts((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Coins className="size-4 text-primary" />
            {t("defaultCurrency")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("defaultCurrencyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("currencyLabel")}</Label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </select>
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Truck className="size-4 text-primary" />
            {t("defaultDeliveryFee")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("defaultDeliveryFeeDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("deliveryFeeLabel")}</Label>
            <Input
              type="number"
              value={deliveryFee}
              onChange={(e) => setDeliveryFee(e.target.value)}
              placeholder={t("deliveryFeePlaceholder")}
              disabled={!canEditSettings || profileLoading}
              className="border-border bg-muted text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            />
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSaveDeliveryFee}
              disabled={savingDeliveryFee || !deliveryFeeDirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingDeliveryFee ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <MapPin className="size-4 text-primary" />
            {t("zonesTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("zonesDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {zonesLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : zones.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("zonesEmpty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {zones.map((z) => (
                <li
                  key={z.id}
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm"
                >
                  <span className="text-foreground">{z.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{z.fee}</span>
                    {canEditSettings && (
                      <button
                        type="button"
                        onClick={() => handleDeleteZone(z.id)}
                        disabled={deletingZoneId === z.id}
                        aria-label={t("zonesRemove")}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400"
                      >
                        {deletingZoneId === z.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canEditSettings && (
            <div className="flex gap-2">
              <Input
                value={newZoneLabel}
                onChange={(e) => setNewZoneLabel(e.target.value)}
                placeholder={t("zonesLabelPlaceholder")}
                className="min-w-0 flex-1 border-border bg-muted text-foreground"
              />
              <Input
                type="number"
                value={newZoneFee}
                onChange={(e) => setNewZoneFee(e.target.value)}
                placeholder={t("zonesFeePlaceholder")}
                className="w-28 border-border bg-muted text-foreground"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={savingZone || !newZoneLabel.trim()}
                onClick={handleAddZone}
                className="shrink-0 border-border bg-transparent text-foreground hover:bg-muted"
              >
                {savingZone ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Percent className="size-4 text-primary" />
            {t("discountsTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("discountsDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {discountsLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : discounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("discountsEmpty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {discounts.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm"
                >
                  <span className="text-foreground">
                    {t("discountsRuleLabel", { qty: d.min_quantity })}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">-{d.discount_percent}%</span>
                    {canEditSettings && (
                      <button
                        type="button"
                        onClick={() => handleDeleteDiscount(d.id)}
                        disabled={deletingDiscountId === d.id}
                        aria-label={t("discountsRemove")}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400"
                      >
                        {deletingDiscountId === d.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canEditSettings && (
            <div className="flex gap-2">
              <Input
                type="number"
                min="2"
                step="1"
                value={newDiscountQty}
                onChange={(e) => setNewDiscountQty(e.target.value)}
                placeholder={t("discountsQtyPlaceholder")}
                className="min-w-0 flex-1 border-border bg-muted text-foreground"
              />
              <Input
                type="number"
                min="1"
                max="100"
                value={newDiscountPercent}
                onChange={(e) => setNewDiscountPercent(e.target.value)}
                placeholder={t("discountsPercentPlaceholder")}
                className="w-28 border-border bg-muted text-foreground"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={savingDiscount || !newDiscountQty || !newDiscountPercent}
                onClick={handleAddDiscount}
                className="shrink-0 border-border bg-transparent text-foreground hover:bg-muted"
              >
                {savingDiscount ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
