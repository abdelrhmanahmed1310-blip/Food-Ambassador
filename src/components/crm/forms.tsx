"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A segment's name and conditions; empty conditions are not applied (ADR-118). */
export function SegmentForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  const optional = t("common.optional");
  const num = (name: string, label: string, hint?: string) => (
    <TextField
      name={name}
      label={label}
      hint={hint}
      inputMode="numeric"
      dir="ltr"
      optionalLabel={optional}
    />
  );
  return (
    <ActionForm
      action={action}
      submitLabel={t("crm.saveSegment")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("crm.name")} required />
        <TextField name="description" label={t("crm.description")} optionalLabel={optional} />
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField
          name="windowDays"
          label={t("crm.windowDays")}
          hint={t("crm.windowDaysHint")}
          defaultValue="365"
          inputMode="numeric"
          dir="ltr"
        />
        {num("visitedWithinDays", t("crm.visitedWithinDays"))}
        {num("notVisitedForDays", t("crm.notVisitedForDays"))}
        {num("minOrders", t("crm.minOrders"))}
        {num("maxOrders", t("crm.maxOrders"))}
        <TextField
          name="minSpend"
          label={t("crm.minSpend")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={optional}
        />
        {num("minPoints", t("crm.minPoints"))}
      </div>
      {branches.length > 1 ? (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">{t("crm.branches")}</legend>
          <div className="flex flex-wrap gap-4">
            {branches.map((b) => (
              <label key={b.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="branchIds" value={b.value} />
                {b.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <CheckboxField name="consentOnly" label={t("crm.consentOnly")} />
    </ActionForm>
  );
}

export function ReviewForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("crm.markReviewed")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <TextField name="note" label={t("crm.reviewNote")} optionalLabel={t("common.optional")} />
    </ActionForm>
  );
}

export function EscalateForm({ action, categories }: { action: Action; categories: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("crm.escalate")}
      pendingLabel={t("common.saving")}
      submitVariant="danger"
    >
      <SelectField
        name="category"
        label={t("crm.complaintCategory")}
        options={categories}
        defaultValue="QUALITY"
      />
    </ActionForm>
  );
}

/** The guest's rating: five buttons and an optional comment. */
export function GuestRatingForm({
  submit,
}: {
  submit: (input: { rating: number; comment: string }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useTranslations("feedback");
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  if (state === "done")
    return (
      <p className="text-lg font-medium" role="status">
        {t("thanks")}
      </p>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rating) return;
        setState("sending");
        const r = await submit({ rating, comment });
        if (r.ok) setState("done");
        else {
          setError(r.error ?? "");
          setState("error");
        }
      }}
    >
      <fieldset>
        <legend className="mb-2 font-medium">{t("question")}</legend>
        <div className="flex gap-2" role="radiogroup">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={t("stars", { count: n })}
              onClick={() => setRating(n)}
              className={`h-12 w-12 rounded-full border text-2xl ${n <= rating ? "bg-primary text-primary-foreground" : "bg-surface"}`}
            >
              ★
            </button>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">{t("comment")}</span>
        <textarea
          name="comment"
          maxLength={1000}
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className="border-border bg-surface w-full rounded-lg border p-2"
        />
      </label>
      {state === "error" ? (
        <p role="alert" className="text-sm text-red-700">
          {error || t("failed")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!rating || state === "sending"}
        className="bg-primary text-primary-foreground rounded-lg px-4 py-2 disabled:opacity-50"
      >
        {t("send")}
      </button>
    </form>
  );
}
