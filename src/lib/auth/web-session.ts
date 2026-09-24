import { WEB_SESSION_COOKIE as IDENTITY_COOKIE } from "@/lib/constants/app-identity";

/**
 * Nama cookie sesi Web.
 *
 * Diturunkan dari identitas produk supaya dua aplikasi turunan yang dipasang
 * pada host yang sama tidak saling menimpa sesi penggunanya.
 */
export const WEB_SESSION_COOKIE = IDENTITY_COOKIE;
export const WEB_SESSION_TTL_SECONDS = 8 * 60 * 60;

export function getWebSessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  };
}
