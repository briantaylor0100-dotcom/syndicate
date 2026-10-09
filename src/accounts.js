import { randomUUID, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const TOKEN_AGE_SECONDS = 12 * 60 * 60;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export class AccountService {
  constructor({ secret = process.env.JWT_SECRET } = {}) {
    if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
      throw new Error("Set JWT_SECRET to a random value of at least 32 characters in production");
    }
    this.secret = secret || randomBytes(48).toString("base64url");
    this.accountsById = new Map();
    this.accountIdByUsername = new Map();
    this.accountIdByEmail = new Map();
  }

  async register({ username, email, password }) {
    username = String(username ?? "").trim();
    email = String(email ?? "").trim().toLowerCase();
    password = String(password ?? "");
    if (!USERNAME_PATTERN.test(username)) throw new Error("Username must be 3–20 letters, numbers, or underscores");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
    if (Buffer.byteLength(password, "utf8") < 10 || Buffer.byteLength(password, "utf8") > 72) throw new Error("Password must be 10–72 bytes long");
    if (this.accountIdByUsername.has(username.toLowerCase())) throw new Error("That username is already in use");
    if (this.accountIdByEmail.has(email)) throw new Error("That email is already registered");

    const passwordHash = await bcrypt.hash(password, 12);
    if (this.accountIdByUsername.has(username.toLowerCase())) throw new Error("That username is already in use");
    if (this.accountIdByEmail.has(email)) throw new Error("That email is already registered");
    const user = {
      id: randomUUID(), username, email,
      passwordHash,
      sessionVersion: 0,
      createdAt: Date.now(),
    };
    this.accountsById.set(user.id, user);
    this.accountIdByUsername.set(username.toLowerCase(), user.id);
    this.accountIdByEmail.set(email, user.id);
    return { user: this.publicUser(user), token: this.#issue(user) };
  }

  async login({ identity, password }) {
    identity = String(identity ?? "").trim().toLowerCase();
    const id = identity.includes("@") ? this.accountIdByEmail.get(identity) : this.accountIdByUsername.get(identity);
    const user = id ? this.accountsById.get(id) : null;
    const matches = user ? await bcrypt.compare(String(password ?? ""), user.passwordHash) : false;
    if (!matches) throw new Error("Invalid username/email or password");
    return { user: this.publicUser(user), token: this.#issue(user) };
  }

  authenticate(token) {
    if (!token) return null;
    try {
      const claims = jwt.verify(token, this.secret, { algorithms: ["HS256"], issuer: "syndicate", audience: "syndicate-game" });
      const user = this.accountsById.get(claims.sub);
      if (!user || claims.sv !== user.sessionVersion) return null;
      return this.publicUser(user);
    } catch {
      return null;
    }
  }

  revoke(userId) {
    const user = this.accountsById.get(userId);
    if (user) user.sessionVersion += 1;
  }

  publicUser(user) {
    return { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt };
  }

  #issue(user) {
    return jwt.sign({ sv: user.sessionVersion }, this.secret, {
      algorithm: "HS256", subject: user.id, issuer: "syndicate", audience: "syndicate-game", expiresIn: TOKEN_AGE_SECONDS,
    });
  }
}

export const AUTH_COOKIE = "syndicate_session";
export const AUTH_COOKIE_MAX_AGE = TOKEN_AGE_SECONDS;
