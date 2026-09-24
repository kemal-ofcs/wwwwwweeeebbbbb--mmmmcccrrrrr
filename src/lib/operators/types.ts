export interface OperatorRecord {
  id: number;
  kodeOperator: string;
  name: string;
  username: string;
  /**
   * Kontak akun. NULL-able di DDL supaya baris operator lama tidak rusak,
   * tetapi diwajibkan validasi aplikasi pada setiap penyimpanan. Email adalah
   * satu-satunya jalur pengiriman link "Lupa Password".
   */
  email: string;
  noHp: string;
  /** Verifikasi dua langkah aktif pada akun ini. */
  totpEnabled: boolean;
  roleId: number;
  roleKey: string;
  roleName: string;
  isSuperadmin: boolean;
  status: "Active" | "Inactive";
}

export interface OperatorDraft {
  kodeOperator: string;
  name: string;
  username: string;
  email: string;
  noHp: string;
  password?: string;
  roleId: number;
  status: "Active" | "Inactive";
}
