// ─── AES-256-GCM 暗号化/復号 ───────────────────────────────
// CREDENTIAL_ENCRYPTION_KEY (hex, 32 bytes = 64 hex chars)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getKey(): Promise<CryptoKey> {
  const hexKey = Deno.env.get("CREDENTIAL_ENCRYPTION_KEY");
  if (!hexKey || hexKey.length !== 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptTokens(
  plainObj: Record<string, unknown>
): Promise<{ encrypted: Uint8Array; iv: Uint8Array }> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(plainObj));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  return { encrypted: new Uint8Array(ciphertext), iv };
}

export async function decryptTokens(
  encrypted: Uint8Array,
  iv: Uint8Array
): Promise<Record<string, unknown>> {
  const key = await getKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );
  return JSON.parse(decoder.decode(plaintext));
}

// bytea from Postgres comes as hex string "\\x..."
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return "\\x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
