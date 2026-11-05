import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

export function isLocalAddress(address: string) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
}

export function localAddresses(interfaces = networkInterfaces()): string[] {
  return [...new Set(Object.values(interfaces).flatMap(entries => (entries ?? [])
    .filter(entry => !entry.internal && isLocalAddress(entry.address)).map(entry => entry.address)))];
}
