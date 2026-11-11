import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface BridgeCert {
  key: string;
  cert: string;
  certFile: string;
  /** SHA-256 fingerprint, to tell the user which certificate the browser should be showing. */
  fingerprint: string;
  /** "generated" for the self-signed one, "provided" for CANVA_BRIDGE_CERT/KEY (e.g. from mkcert). */
  source: 'generated' | 'provided';
}

/** Browsers reject server certificates valid for more than 398 days. */
const VALIDITY_DAYS = 397;
const RENEW_WITHIN_MS = 7 * 86_400_000;

// Minimal DER encoding: Node can sign and parse certificates but not build them, and this avoids a
// dependency for the one certificate the bridge needs.
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const seq = (...content: Buffer[]) => tlv(0x30, ...content);
const set = (...content: Buffer[]) => tlv(0x31, ...content);
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);
const octets = (b: Buffer) => tlv(0x04, b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let v = part >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
/** A positive INTEGER: strip redundant leading zeros, add one if the top bit would make it negative. */
function uint(raw: Buffer): Buffer {
  let b = raw;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function time(d: Date): Buffer {
  const digits = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

/** A self-signed ECDSA P-256 server certificate for localhost, 127.0.0.1 and ::1. */
export function selfSignedLocalhost(now = new Date()): { cert: string; key: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('canva-mcp bridge (localhost)', 'utf8')))));
  const algorithm = seq(oid(ECDSA_SHA256));
  const altNames = seq(
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
    tlv(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
  );
  const tbs = seq(
    explicit(0, uint(Buffer.from([2]))), // v3
    uint(crypto.randomBytes(16)),
    algorithm,
    name,
    seq(time(new Date(now.getTime() - 60_000)), time(new Date(now.getTime() + VALIDITY_DAYS * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      seq(
        extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
        extension('2.5.29.15', true, bits(Buffer.from([0x80]), 7)), // keyUsage: digitalSignature
        extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
        extension('2.5.29.17', false, altNames),
      ),
    ),
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, algorithm, bits(signature));
  const body = der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n$/, '');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function fingerprint(pem: string): string {
  return new crypto.X509Certificate(pem).fingerprint256;
}

/**
 * The TLS certificate for the wss:// listener. Uses CANVA_BRIDGE_CERT/CANVA_BRIDGE_KEY when given
 * (a locally trusted mkcert pair), otherwise a self-signed localhost certificate kept in `dir`.
 */
export async function ensureCert(dir: string, provided?: { certFile?: string; keyFile?: string }): Promise<BridgeCert> {
  if (provided?.certFile && provided.keyFile) {
    const [cert, key] = await Promise.all([fs.readFile(provided.certFile, 'utf8'), fs.readFile(provided.keyFile, 'utf8')]);
    return { cert, key, certFile: provided.certFile, fingerprint: fingerprint(cert), source: 'provided' };
  }

  const certFile = path.join(dir, 'localhost.crt');
  const keyFile = path.join(dir, 'localhost.key');
  try {
    const [cert, key] = await Promise.all([fs.readFile(certFile, 'utf8'), fs.readFile(keyFile, 'utf8')]);
    if (Date.parse(new crypto.X509Certificate(cert).validTo) - Date.now() > RENEW_WITHIN_MS) {
      return { cert, key, certFile, fingerprint: fingerprint(cert), source: 'generated' };
    }
  } catch {
    // Missing or unreadable: generate a new pair below.
  }

  const { cert, key } = selfSignedLocalhost();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(keyFile, key, { mode: 0o600 });
  await fs.writeFile(certFile, cert);
  return { cert, key, certFile, fingerprint: fingerprint(cert), source: 'generated' };
}
