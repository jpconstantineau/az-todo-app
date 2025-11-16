// Ensure globalThis.crypto exists and has randomUUID in Node environments
import { webcrypto, randomUUID } from "node:crypto";

if (!globalThis.crypto) {
  // Node 18+ exposes webcrypto; bind it to the browser-like global name
  globalThis.crypto = webcrypto;
}

// Some environments may have webcrypto but not randomUUID on crypto
if (!globalThis.crypto.randomUUID) {
  // Provide randomUUID from node:crypto
  globalThis.crypto.randomUUID = randomUUID;
}