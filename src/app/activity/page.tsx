"use client";

import { redirect } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppShell } from "@/components/AppShell";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type ActivityDraft,
  type ActivityRecord,
  listActivities,
  recordActivity,
} from "@/lib/gateways/activity";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";

const EMPTY_DRAFT: ActivityDraft = {
  kode_item: "",
  jenis: "masuk",
  jumlah: 1,
  keterangan: "",
};

export default function ActivityPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const canRecord = hasPermission(user, "activity.record");

  const [rows, setRows] = useState<ActivityRecord[]>([]);
  const [draft, setDraft] = useState<ActivityDraft>(EMPTY_DRAFT);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listActivities());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data gagal dimuat.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onSynced = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSynced);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSynced);
  }, [refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await recordActivity({ ...draft, jumlah: Number(draft.jumlah) || 0 });
      setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Aktivitas gagal dicatat.",
      );
    } finally {
      isSubmittingRef.current = false;
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-slate-950" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "activity")) redirect("/forbidden");

  return (
    <AppShell>
      <header>
        <h1 className="text-xl font-black text-white">Log Aktivitas</h1>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          Contoh log transaksional append-only. Setiap baris punya `event_key`
          unik sehingga pengiriman ulang tidak pernah menggandakannya.
        </p>
      </header>

      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/50 p-4 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      {canRecord ? (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-3xl border border-white/10 bg-slate-900/60 p-5 sm:grid-cols-4"
        >
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Kode item
            <input
              required
              value={draft.kode_item}
              onChange={(event) =>
                setDraft({ ...draft, kode_item: event.target.value })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Jenis
            <select
              value={draft.jenis}
              onChange={(event) =>
                setDraft({ ...draft, jenis: event.target.value })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            >
              <option value="masuk">Masuk</option>
              <option value="keluar">Keluar</option>
              <option value="koreksi">Koreksi</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Jumlah
            <input
              type="number"
              value={draft.jumlah}
              onChange={(event) =>
                setDraft({ ...draft, jumlah: Number(event.target.value) })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-sm text-white"
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              className="min-h-11 w-full rounded-xl bg-sky-400 px-4 text-xs font-black text-slate-950"
            >
              Catat
            </button>
          </div>
        </form>
      ) : null}

      <section className="overflow-x-auto rounded-3xl border border-white/10 bg-slate-900/60">
        <table className="w-full min-w-[40rem] text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-3">Waktu</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Jenis</th>
              <th className="px-4 py-3 text-right">Jumlah</th>
              <th className="px-4 py-3">Operator</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={5}>
                  Memuat data...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={5}>
                  None yet aktivitas.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.event_key} className="border-b border-white/5">
                  <td className="px-4 py-3 font-mono text-slate-400">
                    {row.waktu}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-300">
                    {row.kode_item}
                  </td>
                  <td className="px-4 py-3 text-white">{row.jenis}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-300">
                    {row.jumlah}
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {row.kode_operator ?? "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
