import type { NextConfig } from "next";

const isDesktopBuild = process.env.APP_BUILD_TARGET === "desktop";

/**
 * Header keamanan jalur Web. Build Tauri (`output: "export"`) tidak punya
 * server dan dijaga CSP di `tauri.conf.json`. CSP skrip penuh sengaja belum
 * dipasang: Next.js butuh nonce untuk skrip inline-nya.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Kamera dipakai verifikasi wajah di "Lupa Password" dan pemindai.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  ...(isDesktopBuild
    ? { output: "export" as const }
    : {
        async headers() {
          return [{ source: "/:path*", headers: SECURITY_HEADERS }];
        },
      }),
  devIndicators: false,
  turbopack: {
    root: process.cwd(),
  },
  images: {
    unoptimized: true,
  },
  reactCompiler: true,
};

export default nextConfig;
