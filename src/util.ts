export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detect the real format of image bytes from their magic numbers. */
export function sniffImage(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return undefined;
}

/** File extension for an export format, as Canva names the downloaded files. */
export function exportExtension(format: string): string {
  switch (format) {
    case 'html_bundle':
      return 'zip';
    case 'html_standalone':
      return 'html';
    default:
      return format;
  }
}

/** Keep a string usable as a file or folder name on every OS. */
export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  return cleaned || fallback;
}
