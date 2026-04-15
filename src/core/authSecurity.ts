import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

function parseSaltedHash(hash: string): { salt: string; storedHex: string } | null {
  const [salt, storedHex] = hash.split(":");
  if (!salt || !storedHex) return null;
  return { salt, storedHex };
}

async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scryptAsync(secret, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifySecret(secret: string, hash: string): Promise<boolean> {
  const parsed = parseSaltedHash(hash);
  if (!parsed) return false;
  const derived = (await scryptAsync(secret, parsed.salt, 64)) as Buffer;
  const stored = Buffer.from(parsed.storedHex, "hex");
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

export function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return hashSecret(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return verifySecret(password, hash);
}

export async function hashPin(pin: string): Promise<string> {
  return hashSecret(pin);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return verifySecret(pin, hash);
}
