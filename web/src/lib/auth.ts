import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const hash = process.env.PIN_HASH;
  if (!hash) return false;
  return bcrypt.compare(pin, hash);
}

export function createToken(): string {
  return jwt.sign({ authorized: true }, getJwtSecret(), { expiresIn: "24h" });
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, getJwtSecret());
    return true;
  } catch {
    return false;
  }
}
