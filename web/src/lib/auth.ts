import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-change-me";

export async function verifyPin(pin: string): Promise<boolean> {
  const hash = process.env.PIN_HASH;
  if (!hash) return false;
  return bcrypt.compare(pin, hash);
}

export function createToken(): string {
  return jwt.sign({ authorized: true }, JWT_SECRET, { expiresIn: "24h" });
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}
