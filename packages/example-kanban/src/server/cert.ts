// Generate (or load) a self-signed ECDSA P-256 certificate suitable
// for WebTransport. Chrome accepts cert-hash-pinned WebTransport
// connections only for:
//   * leaf certificates (single self-signed cert)
//   * ECDSA, curve P-256 (secp256r1)
//   * validity ≤ 14 days
// We shell out to `openssl` rather than pull in a dedicated x509
// library — this is a demo, the cert generation is one-off at
// startup, and openssl is universally available in dev environments.

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CERT_DIR = join(HERE, '..', '..', 'cert')

export interface CertBundle {
  /** PEM-encoded leaf cert. */
  cert: string
  /** PEM-encoded ECDSA P-256 private key. */
  privKey: string
  /** Base64 SHA-256 hash of the DER cert. Browser pins this
   *  via `serverCertificateHashes`. */
  hashBase64: string
  /** Same hash, formatted hex with `:` separators (matches
   *  `openssl x509 -fingerprint` output). For logging only. */
  hashHex: string
}

/** Load a cached cert from `cert/` if one is still fresh, otherwise
 *  generate a new ECDSA P-256 leaf valid for 13 days. */
export function loadOrGenerateCert(): CertBundle {
  if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true })
  const certPath = join(CERT_DIR, 'cert.pem')
  const keyPath = join(CERT_DIR, 'key.pem')
  const metaPath = join(CERT_DIR, 'meta.json')

  if (existsSync(certPath) && existsSync(keyPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        notAfter: string
      }
      if (Date.parse(meta.notAfter) > Date.now() + 60_000) {
        const cert = readFileSync(certPath, 'utf8')
        const privKey = readFileSync(keyPath, 'utf8')
        return { ...computeHash(cert), cert, privKey }
      }
    } catch {
      // fall through to regenerate
    }
  }

  // Generate ECDSA P-256 keypair + self-signed cert.
  // -newkey ec:- with curve in the dgst flow; simplest is two
  // steps: gen the key, then a req+x509.
  execSync(`openssl ecparam -name prime256v1 -genkey -noout -out ${keyPath}`)
  execSync(
    `openssl req -x509 -key ${keyPath} -out ${certPath} -days 13 ` +
      `-subj "/CN=localhost" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
  )

  const cert = readFileSync(certPath, 'utf8')
  const privKey = readFileSync(keyPath, 'utf8')
  const notAfter = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toISOString()
  writeFileSync(metaPath, JSON.stringify({ notAfter }))
  return { ...computeHash(cert), cert, privKey }
}

function computeHash(certPem: string): { hashBase64: string; hashHex: string } {
  // Extract DER bytes from the PEM body, hash with SHA-256.
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
  const der = Buffer.from(body, 'base64')
  const digest = createHash('sha256').update(der).digest()
  const hashBase64 = digest.toString('base64')
  const hashHex = [...digest]
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':')
  return { hashBase64, hashHex }
}
