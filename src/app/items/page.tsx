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
  deleteItem,
  type ItemDraft,
  type ItemRecord,
  listItems,
  saveItem,
} from "@/lib/gateways/item";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";

const EMPTY_DRAFT: ItemDraft = {
  kode_item: "",
  nama: "",
  kategori: "",
  harga: 0,
  satuan: "",
  catatan: "",
  status_aktif: "Active",
};

export default function ItemsPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const canManage = hasPermission(user, "items.manage");

  const [items, setItems] = useState<ItemRecord[]>([]);
  const [draft, setDraft] = useState<ItemDraft>(EMPTY_DRAFT);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Guard race condition submit ganda: klik cepat dua kali tidak boleh
  // menghasilkan dua event outbox untuk mutasi yang sama.
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listItems());
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

  // Data yang baru masuk dari perangkat lain tiba lewat siklus sinkronisasi,
  // bukan lewat aksi pengguna di layar ini. Tanpa listener ini, hasil scan di
  // perangkat lain baru terlihat setelah halaman dimuat ulang manual.
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
      await saveItem({ ...draft, harga: Number(draft.harga) || 0 });
      setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Item gagal disimpan.");
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const remove = async (kodeItem: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await deleteItem(kodeItem);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Item gagal dihapus.");
    } finally {
      isSubmittingRef.current = false;
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-slate-950" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "items")) redirect("/forbidden");

  return (
    <AppShell>
      <header>
        <h1 className="text-xl font-black text-white">Master Item</h1>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          Domain contoh. Ganti tabel, gateway, dan halaman ini dengan master
          data aplikasi Anda.
        </p>
      </header>

      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/50 p-4 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      {canManage ? (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-3xl border border-white/10 bg-slate-900/60 p-5 sm:grid-cols-2"
        >
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Kode item
            <input
              required
              maxLength={64}
              value={draft.kode_item}
              onChange={(event) =>
                setDraft({ ...draft, kode_item: event.target.value })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Nama
            <input
              required
              minLength={2}
              maxLength={160}
              value={draft.nama}
              onChange={(event) =>
                setDraft({ ...draft, nama: event.target.value })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Kategori
            <input
              maxLength={80}
              value={draft.kategori ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, kategori: event.target.value })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Harga
            <input
              type="number"
              min={0}
              value={draft.harga}
              onChange={(event) =>
                setDraft({ ...draft, harga: Number(event.target.value) })
              }
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-sm text-white"
            />
            <span className="font-normal leading-5 text-slate-500">
              Disimpan sebagai bilangan bulat rupiah. Nilai uang tidak pernah
              disimpan sebagai pecahan desimal.
            </span>
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="min-h-11 rounded-xl bg-sky-400 px-5 text-xs font-black text-slate-950"
            >
              Simpan Item
            </button>
          </div>
        </form>
      ) : null}

      <section className="overflow-x-auto rounded-3xl border border-white/10 bg-slate-900/60">
        <table className="w-full min-w-[40rem] text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-3">Kode</th>
              <th className="px-4 py-3">Nama</th>
              <th className="px-4 py-3">Kategori</th>
              <th className="px-4 py-3 text-right">Harga</th>
              <th className="px-4 py-3">Status</th>
              {canManage ? <th className="px-4 py-3" /> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={6}>
                  Memuat data...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={6}>
                  None yet item.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.kode_item} className="border-b border-white/5">
                  <td className="px-4 py-3 font-mono text-slate-300">
                    {item.kode_item}
                  </td>
                  <td className="px-4 py-3 text-white">{item.nama}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {item.kategori ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-300">
                    {item.harga.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {item.status_aktif}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void remove(item.kode_item)}
                        className="rounded-lg border border-rose-500/30 px-2.5 py-1 text-[11px] font-bold text-rose-300"
                      >
                        Hapus
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
