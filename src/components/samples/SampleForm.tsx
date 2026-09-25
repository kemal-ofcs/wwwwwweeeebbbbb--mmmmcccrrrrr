"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import type {
  ClientRecord,
  MasterOptionRecord,
  OperatorDirectoryEntry,
} from "@/lib/gateways/clients";
import {
  createSampleRequest,
  type SampleDraftInput,
  type SampleFeeMode,
  updateSampleRequest,
} from "@/lib/gateways/samples";
import {
  SAMPLE_BRAND_MAX,
  SAMPLE_LONG_TEXT_MAX,
  SAMPLE_QTY_MAX,
  SAMPLE_TEXT_MAX,
} from "@/lib/validations/sample";

/**
 * Form tiket sampel (PRD FR-06.1). Semua aturan diputuskan backend; form ini
 * hanya mengumpulkan isian. Setelah tiket dikirim ke RnD (`locked`), hanya
 * deadline, alamat, PIC CRM, dan budget yang bisa diubah (keputusan G).
 */

interface SampleFormProps {
  draft: SampleDraftInput;
  /** Kosong = mengubah tiket yang ada (klien tidak bisa diganti). */
  clients: ClientRecord[];
  options: MasterOptionRecord[];
  operators: OperatorDirectoryEntry[];
  feeMode: SampleFeeMode;
  locked: boolean;
  onSaved: (id: string) => void;
  onClose: () => void;
}

const SPECIAL_FIELDS = [
  ["color", "Color"],
  ["texture", "Texture"],
  ["size", "Size"],
  ["aroma", "Aroma"],
] as const;

export function SampleForm({
  draft: initial,
  clients,
  options,
  operators,
  feeMode,
  locked,
  onSaved,
  onClose,
}: SampleFormProps) {
  const [draft, setDraft] = useState<SampleDraftInput>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);
  const creating = draft.id === "";

  const choices = (kind: string, current: string) =>
    options.filter(
      (option) =>
        option.kind === kind && (option.is_active || option.id === current),
    );
  const crm = operators.filter(
    (operator) =>
      operator.role_key === "crm" || operator.id === initial.pic_crm_id,
  );

  const pickClient = (id: string) => {
    const client = clients.find((row) => row.id === id);
    setDraft({
      ...draft,
      client_id: id,
      // Bawaan dari alamat klien, boleh diubah (FR-06.1).
      ship_to_address:
        draft.ship_to_address ||
        [client?.address, client?.city, client?.province]
          .filter(Boolean)
          .join(", "),
      product_category_option_id:
        draft.product_category_option_id ||
        client?.product_category_option_id ||
        "",
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = creating
        ? await createSampleRequest(draft)
        : await updateSampleRequest(draft);
      onSaved(saved.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The request was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const optionSelect = (
    label: string,
    kind: string,
    key:
      | "product_category_option_id"
      | "sample_kind_option_id"
      | "formulation_type_option_id"
      | "registration_category_option_id",
    required: boolean,
  ) => {
    const list = choices(kind, initial[key]);
    return (
      <label className="app-label grid gap-1.5">
        {label}
        {required ? "" : " (optional)"}
        <select
          required={required}
          disabled={locked}
          value={draft[key]}
          onChange={(event) =>
            setDraft({ ...draft, [key]: event.target.value })
          }
          className="app-input font-normal"
        >
          <option value="">
            {list.length === 0 ? "None in Master Data yet" : "Choose"}
          </option>
          {list.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.is_active ? "" : " (turned off)"}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <Modal
      title={creating ? "New sample request" : "Edit sample request"}
      titleId="sample-form-title"
      onClose={onClose}
    >
      <form onSubmit={submit} className="grid gap-4">
        {error ? (
          <FeedbackBanner tone="error" onDismiss={() => setError("")}>
            {error}
          </FeedbackBanner>
        ) : null}
        {locked ? (
          <FeedbackBanner tone="info">
            This request is already with RnD, so the product details are locked.
            You can still change the deadline, address, PIC CRM, and budget.
          </FeedbackBanner>
        ) : null}

        {creating ? (
          <label className="app-label grid gap-1.5">
            Client
            <select
              required
              value={draft.client_id}
              onChange={(event) => pickClient(event.target.value)}
              className="app-input font-normal"
            >
              <option value="">Choose a client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.client_code} · {client.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {optionSelect(
            "Product type",
            "PRODUCT_CATEGORY",
            "product_category_option_id",
            true,
          )}
          {optionSelect(
            "Sample kind",
            "SAMPLE_KIND",
            "sample_kind_option_id",
            false,
          )}
          {optionSelect(
            "Formulation type",
            "FORMULATION_TYPE",
            "formulation_type_option_id",
            false,
          )}
          {optionSelect(
            "Registration category",
            "REGISTRATION_CATEGORY",
            "registration_category_option_id",
            false,
          )}
          <label className="app-label grid gap-1.5">
            Brand
            <input
              required
              disabled={locked}
              maxLength={SAMPLE_BRAND_MAX}
              value={draft.brand_name}
              onChange={(event) =>
                setDraft({ ...draft, brand_name: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Number of samples
            <input
              required
              disabled={locked}
              type="number"
              min={1}
              max={SAMPLE_QTY_MAX}
              step={1}
              value={draft.sample_qty}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  sample_qty: Math.trunc(Number(event.target.value)),
                })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Packaging
            <input
              required
              disabled={locked}
              maxLength={SAMPLE_TEXT_MAX}
              value={draft.packaging}
              onChange={(event) =>
                setDraft({ ...draft, packaging: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            BPOM product name (optional)
            <input
              disabled={locked}
              maxLength={SAMPLE_BRAND_MAX}
              value={draft.bpom_product_name}
              onChange={(event) =>
                setDraft({ ...draft, bpom_product_name: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
        </div>

        <label className="app-label grid gap-1.5">
          Product claims (optional)
          <textarea
            rows={2}
            disabled={locked}
            maxLength={SAMPLE_LONG_TEXT_MAX}
            value={draft.claims}
            onChange={(event) =>
              setDraft({ ...draft, claims: event.target.value })
            }
            className="app-input min-h-16 py-2 font-normal"
          />
        </label>
        <label className="app-label grid gap-1.5">
          Reference product (optional)
          <textarea
            rows={2}
            disabled={locked}
            maxLength={SAMPLE_LONG_TEXT_MAX}
            value={draft.reference_notes}
            onChange={(event) =>
              setDraft({ ...draft, reference_notes: event.target.value })
            }
            className="app-input min-h-16 py-2 font-normal"
          />
        </label>

        <fieldset className="grid gap-3 sm:grid-cols-4">
          <legend className="app-label mb-1.5">
            Special requests (optional)
          </legend>
          {SPECIAL_FIELDS.map(([key, label]) => (
            <label key={key} className="app-label grid gap-1.5">
              {label}
              <input
                disabled={locked}
                maxLength={SAMPLE_TEXT_MAX}
                value={draft.special_requests[key]}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    special_requests: {
                      ...draft.special_requests,
                      [key]: event.target.value,
                    },
                  })
                }
                className="app-input font-normal"
              />
            </label>
          ))}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="app-label grid gap-1.5">
            Sample must reach the client by
            <input
              required
              type="date"
              value={draft.deadline_at}
              onChange={(event) =>
                setDraft({ ...draft, deadline_at: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Client budget in rupiah (optional)
            <input
              type="number"
              min={0}
              step={1}
              value={draft.client_budget_idr ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  client_budget_idr:
                    event.target.value === ""
                      ? null
                      : Math.trunc(Number(event.target.value)),
                })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5 sm:col-span-2">
            Ship the sample to
            <input
              required
              maxLength={SAMPLE_TEXT_MAX}
              value={draft.ship_to_address}
              onChange={(event) =>
                setDraft({ ...draft, ship_to_address: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            PIC CRM (for information)
            <select
              value={draft.pic_crm_id ?? 0}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  pic_crm_id: Number(event.target.value) || null,
                })
              }
              className="app-input font-normal"
            >
              <option value={0}>
                {crm.length === 0 ? "No CRM operators yet" : "None"}
              </option>
              {crm.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.nama_operator}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className="flex min-h-11 items-center gap-2 text-body-md text-on-surface">
            <input
              type="checkbox"
              disabled={locked}
              checked={draft.is_dummy_required}
              onChange={(event) =>
                setDraft({ ...draft, is_dummy_required: event.target.checked })
              }
              className="size-4"
            />
            Needs a packaging dummy
          </label>
          {feeMode === "PER_REQUEST" ? (
            <fieldset className="flex flex-wrap items-center gap-4">
              <legend className="sr-only">Sample fee</legend>
              {(
                [
                  [true, "Paid sample"],
                  [false, "Free sample"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={label}
                  className="flex min-h-11 items-center gap-2 text-body-md text-on-surface"
                >
                  <input
                    type="radio"
                    name="sample-fee"
                    disabled={locked}
                    checked={draft.is_paid_sample === value}
                    onChange={() =>
                      setDraft({ ...draft, is_paid_sample: value })
                    }
                    className="size-4"
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="self-center text-body-sm text-on-surface-variant">
              {feeMode === "PAID"
                ? "Every sample is paid (Business settings)."
                : "Every sample is free (Business settings)."}
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="app-btn app-btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-primary"
          >
            {busy ? "Saving…" : creating ? "Create request" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
