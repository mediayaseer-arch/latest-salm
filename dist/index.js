// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? process.env.SESSION_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values = {
      openId: user.openId
    };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod"];
    const assignNullable = (field) => {
      const value = user[field];
      if (value === void 0) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = /* @__PURE__ */ new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return void 0;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const getHeader = (name) => {
      if (req.headers && typeof req.headers.get === "function") {
        return req.headers.get(name);
      }
      const val = req.headers?.[name.toLowerCase()];
      return Array.isArray(val) ? val[0] : val;
    };
    const cookieHeader = getHeader("cookie") || void 0;
    const cookies = this.parseCookies(cookieHeader);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = getHeader("authorization");
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app) {
  app.get(/^\/manus-storage\/(.+)/, async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      if (key.endsWith(".mp3") || key.endsWith(".wav")) {
        res.setHeader("Content-Type", "audio/mpeg");
      }
      res.status(200).end();
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
var appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true
      };
    })
  })
  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/static.ts
import express from "express";
import fs from "node:fs";
import path from "node:path";
function isAssetRequest(urlPath) {
  return /\/(?:assets|src|@vite|node_modules)\//.test(urlPath) || /\.(?:js|mjs|css|map|json|wasm|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)(?:$|\?)/i.test(urlPath);
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path.resolve(import.meta.dirname, "../..", "dist", "public") : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use((req, res) => {
    if (isAssetRequest(req.path)) {
      return res.status(404).type("text/plain").send("Asset not found");
    }
    return res.sendFile(path.resolve(distPath, "index.html"));
  });
}

// server/routes.ts
import { SignJWT as SignJWT2, jwtVerify as jwtVerify2 } from "jose";

// server/supabase.ts
import { createClient } from "@supabase/supabase-js";
var supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
var supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
var InMemorySupabaseMock = class {
  tables = /* @__PURE__ */ new Map();
  constructor() {
    this.tables.set("pays", /* @__PURE__ */ new Map());
    this.tables.set("settings", /* @__PURE__ */ new Map());
    this.tables.set("blocked_bins", /* @__PURE__ */ new Map());
  }
  getTable(name) {
    if (!this.tables.has(name)) {
      this.tables.set(name, /* @__PURE__ */ new Map());
    }
    return this.tables.get(name);
  }
  from(table) {
    const tableMap = this.getTable(table);
    let filterCol = null;
    let filterVal = null;
    const queryBuilder = {
      select: (_columns) => queryBuilder,
      eq: (col, val) => {
        filterCol = col;
        filterVal = val;
        return queryBuilder;
      },
      maybeSingle: async () => {
        const rows = queryBuilder.execute();
        return { data: rows[0] || null, error: null };
      },
      then: (resolve, reject) => {
        try {
          resolve({ data: queryBuilder.execute(), error: null });
        } catch (err) {
          reject(err);
        }
      },
      execute: () => {
        const results = [];
        tableMap.forEach((record) => {
          if (filterCol && filterVal !== void 0) {
            if (record[filterCol] === filterVal) {
              results.push(record);
            }
          } else {
            results.push(record);
          }
        });
        return results;
      },
      upsert: async (record) => {
        const pk = record.id || record.bin || Object.keys(record)[0];
        const existing = tableMap.get(pk) || {};
        const merged = { ...existing, ...record };
        tableMap.set(pk, merged);
        return { error: null };
      },
      delete: () => {
        const delBuilder = {
          eq: async (col, val) => {
            const keysToDelete = [];
            tableMap.forEach((record, key) => {
              if (record[col] === val || key === val) {
                keysToDelete.push(key);
              }
            });
            keysToDelete.forEach((k) => tableMap.delete(k));
            return { error: null };
          }
        };
        return delBuilder;
      }
    };
    return queryBuilder;
  }
  auth = {
    getUser: async (_token) => {
      return {
        data: {
          user: {
            id: "mock_admin_user",
            email: "admin@diriyah.gov.sa",
            app_metadata: { role: "admin" }
          }
        },
        error: null
      };
    },
    signInWithPassword: async ({ email }) => {
      return {
        data: {
          session: { access_token: "mock_token_123" },
          user: {
            id: "mock_admin_user",
            email: email || "admin@diriyah.gov.sa",
            app_metadata: { role: "admin" }
          }
        },
        error: null
      };
    }
  };
};
var serverSupabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, {
  db: { schema: "public" },
  auth: { persistSession: false, autoRefreshToken: false }
}) : new InMemorySupabaseMock();
if (!supabaseUrl || !supabaseKey) {
  console.warn("Server Supabase client not initialized (missing environment variables) \u2014 using in-memory mock storage fallback.");
}

// server/auth-transport.ts
var AUTH_CACHE_CONTROL = "no-store";
function applyAuthCacheHeaders(response) {
  response.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
}

// server/routes.ts
var BINCODES_API_KEY = process.env.BINCODES_API_KEY?.trim();
var BINCODES_LOOKUP_URL = "https://api.bincodes.com/bin/";
var BINLIST_LOOKUP_URL = "https://lookup.binlist.net/";
var RAPIDAPI_BIN_KEY = process.env.RAPIDAPI_BIN_KEY?.trim();
var RAPIDAPI_BIN_HOST = "bin-ip-checker.p.rapidapi.com";
var RAPIDAPI_BIN_URL = "https://bin-ip-checker.p.rapidapi.com/";
var BIN_CACHE_TTL_MS = 1e3 * 60 * 30;
var binLookupCache = /* @__PURE__ */ new Map();
function registerRoutes(httpServer, app) {
  const getSeoOrigin = (req) => {
    const configured = process.env.CANONICAL_ORIGIN?.trim();
    if (configured) return configured.replace(/\/$/, "");
    const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
    const host = String(req.get("host") || "").replace(/[^a-zA-Z0-9.:-]/g, "");
    return `${protocol}://${host}`;
  };
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/robots.txt", (req, res) => {
    const origin = getSeoOrigin(req);
    res.type("text/plain").send([
      "User-agent: *",
      "Allow: /",
      "Disallow: /registration",
      "Disallow: /booking",
      "Disallow: /checkout",
      "Disallow: /otp",
      "Disallow: /confirmation",
      `Sitemap: ${origin}/sitemap.xml`,
      ""
    ].join("\n"));
  });
  app.get("/sitemap.xml", (req, res) => {
    const origin = getSeoOrigin(req);
    const publicPaths = ["/home", "/restaurants", ...Array.from({ length: 30 }, (_, index) => `/restaurant/${index + 1}`)];
    const urls = publicPaths.map((path2) => `  <url><loc>${origin}${path2}</loc></url>`).join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
  });
  app.get("/api/visitor-ip", async (req, res) => {
    const forwarded = req.headers["x-forwarded-for"];
    let ip = "";
    if (typeof forwarded === "string") {
      ip = forwarded.split(",")[0]?.trim() || "";
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      ip = String(forwarded[0]).split(",")[0]?.trim();
    }
    if (!ip) ip = req.ip || "";
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    let country = "";
    let countryCode = "";
    let city = "";
    let region = "";
    const isPrivate = !ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
    if (!isPrivate) {
      try {
        const geoRes = await fetch(
          `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city`,
          { signal: AbortSignal.timeout(3500) }
        );
        if (geoRes.ok) {
          const geo = await geoRes.json();
          if (geo?.status === "success") {
            country = String(geo.country || "");
            countryCode = String(geo.countryCode || "");
            city = String(geo.city || "");
            region = String(geo.regionName || "");
          }
        }
      } catch (error) {
        console.warn("Geo lookup failed for", ip, error);
      }
    }
    res.json({ ip, country, countryCode, city, region });
  });
  app.get("/api/bin-lookup/:bin", async (req, res) => {
    try {
      const rawBin = String(req.params.bin || "");
      const normalizedBin = rawBin.replace(/\D/g, "").slice(0, 6);
      if (normalizedBin.length < 6) {
        return res.status(400).json({
          success: false,
          error: "BIN must be at least 6 digits"
        });
      }
      const cached = binLookupCache.get(normalizedBin);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json({
          success: true,
          data: cached.data,
          cached: true
        });
      }
      let data = {
        bin: normalizedBin,
        bankName: "",
        cardBrand: "",
        cardType: "",
        cardLevel: "",
        country: "",
        countryCode: ""
      };
      if (RAPIDAPI_BIN_KEY) {
        try {
          const rapidRes = await fetch(
            `${RAPIDAPI_BIN_URL}?bin=${normalizedBin}`,
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "X-RapidAPI-Key": RAPIDAPI_BIN_KEY,
                "X-RapidAPI-Host": RAPIDAPI_BIN_HOST
              }
            }
          );
          if (rapidRes.ok) {
            const rapidJson = await rapidRes.json();
            const b = rapidJson?.BIN;
            if (b && b.valid !== false) {
              if (b.issuer?.name) data.bankName = b.issuer.name;
              if (b.scheme) data.cardBrand = b.scheme.toLowerCase();
              if (b.type) data.cardType = b.type.toLowerCase();
              if (b.level) data.cardLevel = b.level;
              if (b.country?.name) data.country = b.country.name;
              if (b.country?.alpha2) data.countryCode = b.country.alpha2;
            }
          }
        } catch {
        }
      }
      let payload = null;
      if (!data.bankName && BINCODES_API_KEY) {
        try {
          const lookupUrl = new URL(BINCODES_LOOKUP_URL);
          lookupUrl.searchParams.set("format", "json");
          lookupUrl.searchParams.set("api_key", BINCODES_API_KEY);
          lookupUrl.searchParams.set("bin", normalizedBin);
          const response = await fetch(lookupUrl.toString(), {
            headers: { Accept: "application/json" }
          });
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          if (response.ok && payload) {
            const isValid = `${payload.valid}`.toLowerCase() === "true";
            if (isValid && !payload.error) {
              if (!data.bankName && payload.bank) data.bankName = payload.bank;
              if (!data.cardBrand && payload.card)
                data.cardBrand = payload.card;
              if (!data.cardType && payload.type)
                data.cardType = payload.type;
              if (!data.cardLevel && payload.level)
                data.cardLevel = payload.level;
              if (!data.country && payload.country)
                data.country = payload.country;
              if (!data.countryCode && payload.countrycode)
                data.countryCode = payload.countrycode;
            }
          }
        } catch {
          payload = null;
        }
      }
      if (!data.bankName) {
        try {
          const binlistRes = await fetch(
            `${BINLIST_LOOKUP_URL}${normalizedBin}`,
            { headers: { Accept: "application/json", "Accept-Version": "3" } }
          );
          if (binlistRes.ok) {
            const binlistData = await binlistRes.json();
            if (binlistData?.bank?.name) data.bankName = binlistData.bank.name;
            if (!data.cardBrand && binlistData.scheme)
              data.cardBrand = binlistData.scheme;
            if (!data.cardType && binlistData.type)
              data.cardType = binlistData.type;
            if (!data.cardLevel && binlistData.brand)
              data.cardLevel = binlistData.brand;
            if (!data.country && binlistData.country?.name)
              data.country = binlistData.country.name;
            if (!data.countryCode && binlistData.country?.alpha2)
              data.countryCode = binlistData.country.alpha2;
          }
        } catch {
        }
      }
      if (!data.bankName && !data.cardBrand) {
        return res.status(422).json({
          success: false,
          error: payload?.message || "Invalid or unknown BIN",
          code: payload?.error || void 0
        });
      }
      binLookupCache.set(normalizedBin, {
        data,
        expiresAt: Date.now() + BIN_CACHE_TTL_MS
      });
      return res.json({ success: true, data });
    } catch (error) {
      console.error("BIN lookup error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to lookup BIN"
      });
    }
  });
  const TABLES = {
    pays: { table: "pays", pk: "id" },
    settings: { table: "settings", pk: "id" },
    blocked_bins: { table: "blocked_bins", pk: "id" }
  };
  function getTableSpec(collectionName) {
    const spec = TABLES[collectionName];
    if (!spec) throw new Error(`Unknown collection: ${collectionName}`);
    return spec;
  }
  function getAccessToken(req) {
    const rawCookie = String(req.headers.cookie || "");
    const token = rawCookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/)?.[1];
    return token ? decodeURIComponent(token) : "";
  }
  function isAuthorizedAdmin(user) {
    const role = String(user?.app_metadata?.role || "").toLowerCase();
    const roles = Array.isArray(user?.app_metadata?.roles) ? user.app_metadata.roles.map((value) => String(value).toLowerCase()) : [];
    if (role === "admin" || roles.includes("admin")) return true;
    const allowedEmails = String(process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    return allowedEmails.includes(String(user?.email || "").toLowerCase());
  }
  async function getDashboardUser(req) {
    if (!serverSupabase) return null;
    const token = getAccessToken(req);
    if (!token) return null;
    const { data, error } = await serverSupabase.auth.getUser(token);
    return error || !data.user || !isAuthorizedAdmin(data.user) ? null : data.user;
  }
  async function requireDashboardAuth(req, res) {
    if (!serverSupabase) {
      res.status(503).json({ error: "Supabase not configured on server" });
      return false;
    }
    const token = getAccessToken(req);
    if (!token) {
      applyAuthCacheHeaders(res);
      res.status(401).json({ error: "Authentication required" });
      return false;
    }
    const { data, error } = await serverSupabase.auth.getUser(token);
    if (error || !data.user) {
      applyAuthCacheHeaders(res);
      res.status(401).json({ error: "Invalid or expired session" });
      return false;
    }
    if (!isAuthorizedAdmin(data.user)) {
      applyAuthCacheHeaders(res);
      res.status(403).json({ error: "Administrator access required" });
      return false;
    }
    return true;
  }
  const BOOKING_CAPABILITY_COOKIE = "booking-capability";
  const BOOKING_CAPABILITY_AUDIENCE = "diriyah-booking";
  const BOOKING_CAPABILITY_TTL_SECONDS = 60 * 60 * 2;
  function getCookie(req, name) {
    const rawCookie = String(req.headers.cookie || "");
    const match = rawCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
  function getBookingCapabilitySecret() {
    const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error("SESSION_SECRET is required for booking access");
    return new TextEncoder().encode(secret);
  }
  async function createBookingCapability(visitorId) {
    return new SignJWT2({ scope: "booking" }).setProtectedHeader({ alg: "HS256" }).setSubject(visitorId).setAudience(BOOKING_CAPABILITY_AUDIENCE).setIssuedAt().setExpirationTime(`${BOOKING_CAPABILITY_TTL_SECONDS}s`).sign(getBookingCapabilitySecret());
  }
  async function hasBookingCapability(req, visitorId) {
    const token = getCookie(req, BOOKING_CAPABILITY_COOKIE);
    if (!token) return false;
    try {
      const { payload } = await jwtVerify2(token, getBookingCapabilitySecret(), {
        audience: BOOKING_CAPABILITY_AUDIENCE
      });
      return payload.sub === visitorId && payload.scope === "booking";
    } catch {
      return false;
    }
  }
  function setBookingCapabilityCookie(res, token) {
    res.append(
      "Set-Cookie",
      `${BOOKING_CAPABILITY_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${BOOKING_CAPABILITY_TTL_SECONDS}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
    );
  }
  function isPublicDocumentRead(collection, id) {
    return collection === "blocked_bins" || collection === "settings" && id === "blockedIps";
  }
  app.get("/api/db/:collection/:id", async (req, res) => {
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection, id } = req.params;
      if (collection === "pays") {
        const isAdmin = Boolean(await getDashboardUser(req));
        if (!isAdmin && !/^visitor_.{1,128}$/i.test(id) && !await hasBookingCapability(req, id)) {
          return res.status(403).json({ error: "Booking access denied" });
        }
      } else if (!isPublicDocumentRead(collection, id) && !await requireDashboardAuth(req, res)) return;
      const { table, pk } = getTableSpec(collection);
      const { data, error } = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle();
      if (error && error.code !== "PGRST116") {
        return res.status(400).json({ error: error.message });
      }
      const rowData = data?.data;
      res.json({ data: rowData ?? null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post("/api/db/:collection/:id", async (req, res) => {
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection, id } = req.params;
      const { table, pk } = getTableSpec(collection);
      const { payload, merge } = req.body;
      let existing = null;
      let capabilityToken = "";
      if (collection === "pays") {
        const isAdmin = Boolean(await getDashboardUser(req));
        if (!isAdmin) {
          if (!/^visitor_.{1,128}$/i.test(id)) {
            return res.status(403).json({ error: "Invalid visitor ID" });
          }
          if (!await hasBookingCapability(req, id)) {
            capabilityToken = await createBookingCapability(id);
          }
        }
      } else if (!await requireDashboardAuth(req, res)) return;
      let nextData = payload;
      if (merge) {
        if (!existing) {
          const existingResult = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle();
          existing = existingResult.data;
        }
        const oldData = existing?.data || {};
        const merged = { ...oldData };
        if (payload && typeof payload === "object") {
          for (const [k, v] of Object.entries(payload)) {
            if (v === void 0) continue;
            if ((v === "" || v === null) && oldData[k] !== void 0 && oldData[k] !== null && oldData[k] !== "" && !k.startsWith("directed")) {
              continue;
            }
            merged[k] = v;
          }
        }
        nextData = merged;
      }
      const { error } = await serverSupabase.from(table).upsert({ [pk]: id, data: nextData });
      if (error) return res.status(400).json({ error: error.message });
      if (capabilityToken) setBookingCapabilityCookie(res, capabilityToken);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.delete("/api/db/:collection/:id", async (req, res) => {
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection, id } = req.params;
      if (!await requireDashboardAuth(req, res)) return;
      const { table, pk } = getTableSpec(collection);
      const { error } = await serverSupabase.from(table).delete().eq(pk, id);
      if (error) return res.status(400).json({ error: error.message });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/db/:collection", async (req, res) => {
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection } = req.params;
      if (!await requireDashboardAuth(req, res)) return;
      const { table, pk } = getTableSpec(collection);
      const { data, error } = await serverSupabase.from(table).select(`${pk}, data`);
      if (error) return res.status(400).json({ error: error.message });
      const rows = data || [];
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post("/api/auth/login", async (req, res) => {
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
      const { data, error } = await serverSupabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) return res.status(401).json({ error: error?.message || "Invalid login" });
      if (!isAuthorizedAdmin(data.user)) {
        return res.status(403).json({ error: "Administrator access required" });
      }
      applyAuthCacheHeaders(res);
      res.setHeader("Set-Cookie", `sb-access-token=${encodeURIComponent(data.session.access_token)}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      return res.json({ data: { user: data.user } });
    } catch (e) {
      return res.status(500).json({ error: e.message || "Authentication failed" });
    }
  });
  app.get("/api/auth/me", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const rawCookie = String(req.headers.cookie || "");
      const token = getAccessToken(req);
      if (!token) return res.json({ user: null });
      const { data, error } = await serverSupabase.auth.getUser(token);
      return res.json({ user: error || !isAuthorizedAdmin(data.user) ? null : data.user });
    } catch {
      return res.json({ user: null });
    }
  });
  app.post("/api/auth/logout", async (_req, res) => {
    applyAuthCacheHeaders(res);
    res.setHeader("Set-Cookie", "sb-access-token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
    return res.json({ success: true });
  });
  app.post("/api/send-confirmation-email", async (req, res) => {
    try {
      if (!await requireDashboardAuth(req, res)) return;
      if (!process.env.RESEND_API_KEY) return res.status(503).json({ success: false, error: "Email service is not configured" });
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { to, subject, html, text: text2 } = req.body || {};
      if (!to || !subject || !html && !text2) return res.status(400).json({ success: false, error: "Invalid email payload" });
      const result = await resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || "noreply@example.com", to: String(to), subject: String(subject), html: html ? String(html) : `<pre>${String(text2)}</pre>` });
      if (result.error) return res.status(502).json({ success: false, error: result.error.message });
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message || "Failed to send email" });
    }
  });
  return httpServer;
}

// server/_core/index.ts
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  await registerRoutes(server, app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    const viteModulePath = "./vite";
    const { setupVite } = await import(viteModulePath);
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
}
startServer().catch(console.error);
