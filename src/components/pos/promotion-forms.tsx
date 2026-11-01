"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxGroup, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

/** A percentage off items or categories, by channel, weekday, hours and dates (ADR-067). */
export function PromotionForm({
  action,
  categories,
  items,
  channels,
  today,
}: {
  action: Action;
  categories: Option[];
  items: Option[];
  channels: Option[];
  today: string;
}) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm action={action} submitLabel={t("promotions.add")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("promotions.name")} required />
        <TextField
          name="percent"
          label={t("promotions.percent")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="validFrom"
          type="date"
          label={t("promotions.validFrom")}
          defaultValue={today}
          required
        />
        <TextField
          name="validTo"
          type="date"
          label={t("promotions.validTo")}
          optionalLabel={optional}
        />
        <TextField
          name="startTime"
          label={t("promotions.startTime")}
          hint={t("promotions.timeHint")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="endTime"
          label={t("promotions.endTime")}
          dir="ltr"
          optionalLabel={optional}
        />
      </div>
      <CheckboxGroup name="categoryIds" legend={t("promotions.categories")} options={categories} />
      <details>
        <summary className="cursor-pointer text-sm">{t("promotions.items")}</summary>
        <div className="mt-2">
          <CheckboxGroup name="itemIds" legend={t("promotions.items")} options={items} />
        </div>
      </details>
      <CheckboxGroup name="channels" legend={t("promotions.channels")} options={channels} />
      <CheckboxGroup
        name="weekdays"
        legend={t("promotions.weekdays")}
        options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({
          value: String(d),
          label: t(`promotions.weekdayNames.${d}`),
        }))}
      />
      <p className="text-muted text-xs">{t("promotions.emptyMeansAll")}</p>
    </ActionForm>
  );
}

/** A coupon code for a discount on the whole order. */
export function CouponForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={t("promotions.addCoupon")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="code"
          label={t("promotions.code")}
          hint={t("promotions.codeHint")}
          dir="ltr"
          required
        />
        <SelectField
          name="kind"
          label={t("pos.discountKind")}
          options={[
            { value: "PERCENT", label: t("pos.discountKinds.PERCENT") },
            { value: "AMOUNT", label: t("pos.discountKinds.AMOUNT") },
          ]}
          required
        />
        <TextField
          name="value"
          label={t("pos.discountValue")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="maxUses"
          label={t("promotions.maxUses")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="validFrom"
          type="date"
          label={t("promotions.validFrom")}
          defaultValue={today}
          required
        />
        <TextField
          name="validTo"
          type="date"
          label={t("promotions.validTo")}
          optionalLabel={optional}
        />
      </div>
    </ActionForm>
  );
}
