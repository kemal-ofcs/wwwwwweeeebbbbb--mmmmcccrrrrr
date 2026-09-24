import { type NextRequest, NextResponse } from "next/server";
import {
  clearLoginFailures,
  consumeLoginAttempt,
} from "@/lib/auth/login-rate-limit";
import {
  getWebSessionCookieOptions,
  WEB_SESSION_COOKIE,
} from "@/lib/auth/web-session";
import { authenticateWebOperator } from "@/lib/server/auth/authenticate";
import { createWebSession } from "@/lib/server/auth/session";
import { evaluateTwoFactorGate } from "@/lib/server/auth/two-factor";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import { toApiErrorResponse } from "@/lib/server/http/api-response";
import {
  JsonBodyError,
  readBoundedJsonBody,
} from "@/lib/server/http/json-body";
import {
  getClientAddress,
  isSameOriginMutation,
} from "@/lib/server/http/request-security";

export const runtime = "nodejs";

interface LoginBody {
  username?: unknown;
  password?: unknown;
  /** Kode 6 digit autentikator, atau kode cadangan. */
  totpCode?: unknown;
}

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { sukses: false, pesan: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return errorResponse("The request origin is not allowed.", 403);
  }
  let body: LoginBody;
  try {
    body = await readBoundedJsonBody<LoginBody>(request, 4_096);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      const message =
        error.status === 413
          ? "The sign-in payload is too large."
          : error.status === 415
            ? "Content-Type must be application/json."
            : "Invalid sign-in payload.";
      return errorResponse(message, error.status);
    }
    return errorResponse("Invalid sign-in payload.", 400);
  }

  const username =
    typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length < 3 || username.length > 64 || password.length > 256) {
    return errorResponse("Wrong username or password.", 401);
  }

  // Tanpa penangkap ini, error database (URL/token salah, skema pra-rilis,
  // Turso tidak terjangkau) menjadi halaman 500 non-JSON dan layar login hanya
  // bisa berkata "Invalid authentication response." tanpa penyebab.
  try {
    await ensureServerDatabaseInitialized();
    const database = getServerDatabase();
    const clientAddress = getClientAddress(request);
    const rateLimit = await consumeLoginAttempt(
      database,
      clientAddress,
      username,
    );
    if (!rateLimit.allowed) {
      const minutes = Math.floor(rateLimit.retryAfterSeconds / 60);
      const seconds = rateLimit.retryAfterSeconds % 60;
      const timeStr =
        minutes > 0
          ? `${minutes} minutes${seconds > 0 ? ` ${seconds} seconds` : ""}`
          : `${seconds} seconds`;
      const response = errorResponse(
        `Too many sign-in attempts. The account is temporarily locked for security. Wait ${timeStr} before trying again.`,
        429,
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }

    const operator = await authenticateWebOperator(username, password);
    if (!operator) {
      return errorResponse("Wrong username or password.", 401);
    }

    // Gerbang 2FA dijalankan SETELAH password terbukti benar, supaya layar login
    // tidak bisa dipakai memetakan akun mana yang memakai verifikasi dua langkah.
    const gate = await evaluateTwoFactorGate(
      database,
      operator.id,
      typeof body.totpCode === "string" ? body.totpCode : undefined,
    );
    if (gate.outcome === "code_required" || gate.outcome === "code_invalid") {
      const pesan =
        gate.outcome === "code_required"
          ? "Enter the 6-digit code from your authenticator app."
          : "The verification code does not match. Check the latest code in your authenticator app.";
      // Penanda `requiresTotp` yang membuat form login menampilkan kolom kode;
      // password sudah benar, jadi memberitahukannya di sini tidak membocorkan
      // apa pun yang belum diketahui pemanggil.
      return NextResponse.json(
        { sukses: false, pesan, requiresTotp: true },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (gate.outcome === "enrollment_required") {
      return errorResponse(
        "This account's role requires two-step verification, but your account has not enrolled yet. Ask an Admin to open 2FA enrollment.",
        403,
      );
    }

    await clearLoginFailures(database, clientAddress, username);

    const session = await createWebSession(
      operator,
      request.headers.get("user-agent"),
    );
    const response = NextResponse.json(
      { sukses: true, pesan: "Signed in.", operator },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(
      WEB_SESSION_COOKIE,
      session.token,
      getWebSessionCookieOptions(process.env.NODE_ENV === "production"),
    );
    return response;
  } catch (error) {
    console.error("[auth/login]", error);
    return toApiErrorResponse(error);
  }
}
