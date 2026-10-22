// Deliberately log only transfer diagnostics, never credentials or signed URLs.
const listeners = new Set<() => void>();
let lines: string[] = [];
export function transferLog(message: string) {
  const safe = message.replace(/https?:\/\/\S+/gi, '[URL omitted]')
    .replace(/(password|token|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  const line = `${new Date().toISOString()} ${safe}`;
  lines = [...lines.slice(-499), line];
  console.info(`[NearNest diagnostic] ${line}`);
  listeners.forEach(listener => listener());
}
export const getTransferLogs = () => lines;
export function subscribeTransferLogs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
