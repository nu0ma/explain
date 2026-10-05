// Shared policy for generated pages and video players. This is a resource-loading
// boundary, not a sandbox for hostile JavaScript (notably, CSP cannot stop top-level navigation).
export interface NetworkOptions {
  // Trusted caller only: never read this permission from manuscript frontmatter or saved config.
  allowNetwork?: boolean;
}

export function contentSecurityPolicy({ allowNetwork = false, isStatic = false }: NetworkOptions & { isStatic?: boolean } = {}): string {
  const script = isStatic ? "script-src 'none'" : "script-src 'unsafe-inline'";
  const restrictions = "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  if (allowNetwork) return isStatic ? `${script}; ${restrictions}` : '';
  return `default-src 'none'; ${script}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; ${restrictions}`;
}

export function networkMeta(options: NetworkOptions & { isStatic?: boolean } = {}): string {
  const csp = contentSecurityPolicy(options);
  return `${csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` : ''}<meta http-equiv="x-dns-prefetch-control" content="off">\n`;
}
