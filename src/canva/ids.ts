/**
 * Accept a bare design ID or any canva.com design link (edit, view, present, share-with-token).
 * https://www.canva.com/design/DAGxyz123/abcToken/edit -> DAGxyz123
 */
export function designId(input: string): string {
  return idFromUrl(input, 'design');
}

/** Accept a bare folder ID or a canva.com/folder/... link. */
export function folderId(input: string): string {
  return idFromUrl(input, 'folder');
}

function idFromUrl(input: string, kind: 'design' | 'folder'): string {
  const s = input.trim();
  const match = s.match(new RegExp(`canva\\.com/${kind}/([A-Za-z0-9_-]+)`, 'i'));
  if (match) return match[1];
  if (/^https?:\/\//i.test(s) || s.includes('/')) {
    const shortlink = /canva\.link\//i.test(s) ? ' This is a short link: resolve it with resolve-shortlink first.' : '';
    throw new Error(`"${s}" is not a canva.com/${kind}/... link or a ${kind} ID.${shortlink}`);
  }
  if (!s) throw new Error(`A ${kind} ID is required.`);
  return s;
}

const SHORTLINK_HOSTS = /(^|\.)canva\.(link|com)$/i;

/** Follow a canva.link short link's redirects to the canva.com URL it points at. */
export async function resolveShortlink(input: string): Promise<{ url: string; designId?: string; hops: string[] }> {
  let current = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  if (!SHORTLINK_HOSTS.test(current.hostname)) throw new Error(`Only canva.link and canva.com links can be resolved (got ${current.hostname}).`);
  const hops: string[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(current, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    current = new URL(location, current);
    hops.push(current.toString());
    if (/canva\.com\/design\//i.test(current.toString())) break;
  }
  const url = current.toString();
  const match = url.match(/canva\.com\/design\/([A-Za-z0-9_-]+)/i);
  return { url, designId: match?.[1], hops };
}
