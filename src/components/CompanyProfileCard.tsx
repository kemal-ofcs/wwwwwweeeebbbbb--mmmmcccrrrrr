"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import {
  type CompanyProfile,
  getCompanyProfile,
  MAX_IMAGE_BASE64_LENGTH,
  saveCompanyProfile,
} from "@/lib/gateways/company-profile";

/**
 * Identitas perusahaan pemakai aplikasi.
 *
 * Bagian PLATFORM, bukan domain contoh — jangan hapus bersama halaman Item dan
 * Aktivitas. Nilai-nilai di sini muncul di kop dokumen, cetakan, dan ekspor
 * yang dihasilkan aplikasi turunan.
 *
 * Logo dan tanda tangan disimpan sebagai data URI di dalam baris yang IKUT
 * sinkronisasi, bukan sebagai path berkas. Path yang sah di satu perangkat
 * tidak berarti apa-apa di perangkat lain, sedangkan aplikasi ini berjalan di
 * Web, Desktop, dan Android dengan sistem berkas yang berbeda-beda.
 */

/** Kolom teks bebas, dirender dari satu daftar supaya tidak ada yang terlewat. */
const TEXT_FIELDS = [
  { key: "branch_name", label: "Branch / unit", placeholder: "Head office" },
  { key: "address", label: "Address", placeholder: "Jl. Contoh No. 1" },
  { key: "phone", label: "Phone", placeholder: "021-0000000" },
  { key: "email", label: "Email", placeholder: "info@company.co.id" },
  { key: "website", label: "Website", placeholder: "https://company.co.id" },
  { key: "leader_name", label: "Signatory name", placeholder: "Full name" },
  { key: "leader_title", label: "Signatory title", placeholder: "Director" },
] as const;

type TextFieldKey = (typeof TEXT_FIELDS)[number]["key"];

type ImageFieldKey = "logo_url" | "signature_url";

const IMAGE_FIELDS: { key: ImageFieldKey; label: string; hint: string }[] = [
  { key: "logo_url", label: "Logo", hint: "Shown in document letterheads." },
  {
    key: "signature_url",
    label: "Signature",
    hint: "Shown in document footers.",
  },
];

const EMPTY: CompanyProfile = {
  id: "default_company",
  company_name: "",
  branch_name: null,
  logo_url: null,
  signature_url: null,
  address: null,
  phone: null,
  email: null,
  website: null,
  leader_name: null,
  leader_title: null,
  timezone: "Asia/Jakarta",
  updated_at: "",
};

export function CompanyProfileCard() {
  const [profile, setProfile] = useState<CompanyProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const signatureInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getCompanyProfile()
      .then((value) => {
        if (!cancelled) setProfile(value);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFeedback({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "The company profile could not be loaded.",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setField = (key: TextFieldKey | "company_name" | "timezone") => {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setProfile((current) => ({ ...current, [key]: value }));
    };
  };

  /**
   * Baca berkas gambar menjadi data URI.
   *
   * Batas ukurannya ditegakkan SETELAH pengodean base64, karena itulah yang
   * benar-benar disimpan dan disinkronkan — bukan ukuran berkas aslinya.
   */
  const pickImage = (key: ImageFieldKey) => {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result ?? "");
        if (value.length > MAX_IMAGE_BASE64_LENGTH) {
          setFeedback({
            tone: "error",
            text: "The image is too large. Make it smaller first: this file is synced to every device.",
          });
          return;
        }
        setProfile((current) => ({ ...current, [key]: value }));
        setFeedback(null);
      };
      reader.onerror = () => {
        setFeedback({ tone: "error", text: "The image could not be read." });
      };
      reader.readAsDataURL(file);
    };
  };

  const clearImage = (key: ImageFieldKey) => {
    setProfile((current) => ({ ...current, [key]: null }));
    if (key === "logo_url" && logoInput.current) logoInput.current.value = "";
    if (key === "signature_url" && signatureInput.current) {
      signatureInput.current.value = "";
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const { id: _id, updated_at: _updatedAt, ...draft } = profile;
      setProfile(await saveCompanyProfile(draft));
      setFeedback({ tone: "success", text: "Company profile saved." });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The company profile could not be saved.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
          <Icon name="tools" className="size-5" />
        </span>
        <div>
          <h2 className="text-headline-md text-on-surface">Company identity</h2>
          <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
            Used as the letterhead on documents, printouts, and exports. This is
            a single synced record, so every device uses the same identity.
          </p>
        </div>
      </div>

      {feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-4 rounded-md border p-3 text-body-md ${
            feedback.tone === "success"
              ? "border-success/30 bg-success-container text-on-success-container"
              : "border-error/30 bg-error-container text-on-error-container"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-4 text-body-md text-on-surface-variant">Loading…</p>
      ) : (
        <form className="mt-4 space-y-4" onSubmit={submit}>
          <label className="app-label grid gap-1.5">
            Company name
            <input
              required
              minLength={2}
              maxLength={120}
              value={profile.company_name}
              onChange={setField("company_name")}
              placeholder="Company name"
              className="app-input font-normal"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            {TEXT_FIELDS.map((field) => (
              <label key={field.key} className="app-label grid gap-1.5">
                {field.label}
                <input
                  maxLength={200}
                  value={profile[field.key] ?? ""}
                  onChange={setField(field.key)}
                  placeholder={field.placeholder}
                  className="app-input font-normal"
                />
              </label>
            ))}
            <label className="app-label grid gap-1.5">
              Time zone
              <input
                maxLength={64}
                value={profile.timezone}
                onChange={setField("timezone")}
                placeholder="Asia/Jakarta"
                className="app-input font-normal"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {IMAGE_FIELDS.map((field) => (
              <div
                key={field.key}
                className="space-y-2 rounded-md border border-surface-container bg-surface-container-low p-3"
              >
                <p className="app-label">{field.label}</p>
                <p className="text-body-sm text-on-surface-variant">
                  {field.hint}
                </p>
                {profile[field.key] ? (
                  <div className="flex items-center gap-3">
                    {/* Data URI, bukan URL jarak jauh — `next/image` tidak
                        memberi keuntungan apa pun di sini dan build
                        `output: "export"` tidak mengoptimalkannya. */}
                    {/** biome-ignore lint/performance/noImgElement: data URI lokal */}
                    <img
                      src={profile[field.key] as string}
                      alt={field.label}
                      className="h-12 w-auto rounded-md border border-surface-container bg-surface-container-lowest object-contain p-1"
                    />
                    <button
                      type="button"
                      onClick={() => clearImage(field.key)}
                      className="app-btn app-btn-secondary"
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
                <input
                  ref={field.key === "logo_url" ? logoInput : signatureInput}
                  type="file"
                  aria-label={`Choose ${field.label.toLowerCase()} image`}
                  accept="image/png,image/jpeg,image/webp"
                  onChange={pickImage(field.key)}
                  className="block w-full text-body-sm text-on-surface-variant file:mr-3 file:min-h-9 file:rounded-md file:border file:border-outline-variant file:bg-surface-container-lowest file:px-3 file:text-body-sm file:font-semibold file:text-on-surface"
                />
              </div>
            ))}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-primary w-full sm:w-auto"
          >
            {busy ? "Saving…" : "Save company identity"}
          </button>
        </form>
      )}
    </section>
  );
}
