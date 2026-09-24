"use client";

import { DEFAULT_SERVER_ORIGIN } from "@/lib/constants/app-identity";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export async function getServerUrl(): Promise<string> {
  if (!isDesktopRuntime()) return DEFAULT_SERVER_ORIGIN;
  try {
    return await invokeDesktop<string>("desktop_get_server_url");
  } catch {
    return DEFAULT_SERVER_ORIGIN;
  }
}

export async function setServerUrl(url: string): Promise<string> {
  if (!isDesktopRuntime()) return url;
  return invokeDesktop<string>("desktop_set_server_url", { url });
}
