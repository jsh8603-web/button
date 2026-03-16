import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET environment variable is required");
const JWT_SECRET: string = process.env.JWT_SECRET;

export async function verifyPin(pin: string): Promise<boolean> {
  const hash = process.env.PIN_HASH;
  if (!hash) return false;
  return bcrypt.compare(pin, hash);
}

export function createToken(): string {
  return jwt.sign({ authorized: true }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}
