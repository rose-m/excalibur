export function applicationOrigin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be an http(s) application origin without a path, query or credentials`); }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be an http(s) application origin without a path, query or credentials`);
  }
  return url.origin;
}
