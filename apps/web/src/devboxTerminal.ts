import { readLocalApi } from "./localApi";

/**
 * Devbox: open a Pi thread's session in Windows Terminal on the viewer's PC.
 * That PC registers the t3pi:// scheme (t3pi-open.ps1), which runs
 * `ssh -t devbox .local/bin/pi-t3 <threadId>`; pi-t3 on the devbox maps the
 * thread to its Pi session file and opens it in tmux.
 */
export function isPiThread(thread: {
  readonly runtime?: { readonly providerInstanceId?: string | null } | null;
  readonly modelSelection?: { readonly instanceId: string } | null;
}): boolean {
  return (thread.runtime?.providerInstanceId ?? thread.modelSelection?.instanceId) === "pi";
}

export function threadTerminalUrl(threadId: string): string {
  return `t3pi://open/${encodeURIComponent(threadId)}`;
}

export async function openThreadInTerminal(threadId: string): Promise<void> {
  const url = threadTerminalUrl(threadId);
  if (window.desktopBridge) {
    await readLocalApi()?.shell.openExternal(url);
    return;
  }
  // A custom scheme hands off to the OS handler; the page stays where it is.
  window.location.assign(url);
}
