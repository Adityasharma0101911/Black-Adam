import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Toast } from "./store";

/** Look for a signed update on GitHub Releases; offer to install it. Returns true if one was found. */
export async function checkForUpdate(toast: (t: Omit<Toast, "id">) => void, loud = false) {
  try {
    const update = await check();
    if (!update) return false;
    toast({
      kind: "info",
      text: `Black Adam ${update.version} is available.`,
      action: {
        label: "Install & restart",
        run: async () => {
          toast({ kind: "info", text: "Downloading update…" });
          await update.downloadAndInstall();
          await relaunch();
        },
      },
    });
    return true;
  } catch (e) {
    if (loud) throw e;
    return false; // offline or no release yet: stay quiet on launch
  }
}
