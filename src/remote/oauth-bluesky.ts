import fs from "node:fs/promises";
import type { Request, Response } from "express";
import { JoseKey, NodeOAuthClient, requestLocalLock } from "@atproto/oauth-client-node";
import type { Storage } from "./storage.js";

/**
 * Minimum scope set that covers every tool this server exposes. `atproto` is
 * mandatory. `transition:generic` is the current catch-all that grants
 * read+write on `app.bsky.*` collections (timeline, posts, likes, follows).
 * `transition:chat.bsky` grants access to `chat.bsky.*` DM endpoints.
 *
 * ATProto is moving toward more granular scopes (`app.bsky.feed.post:write`
 * etc.) but the network hasn't fully rolled them out yet. Narrow this when
 * https://github.com/bluesky-social/proposals/tree/main/0004-oauth ships
 * finer-grained scopes.
 */
export const BLUESKY_SCOPES = ["atproto", "transition:generic", "transition:chat.bsky"] as const;

export interface BlueskyOAuthConfig {
  /** Public HTTPS URL where this server is reachable, no trailing slash. */
  publicUrl: string;
  /** Absolute path to the JWK Set created by generate-signing-key. */
  signingKeyPath: string;
  storage: Storage;
}

/**
 * Build the `client-metadata.json` document that the PDS fetches when it
 * sees our client_id. The client_id MUST equal the URL this document is
 * served from, which is why we derive it here from `publicUrl`.
 */
export function buildClientMetadata(publicUrl: string) {
  const base = publicUrl.replace(/\/$/, "");
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: "Bluesky MCP Server",
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`] as [string],
    scope: BLUESKY_SCOPES.join(" "),
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    response_types: ["code"] as ["code"],
    application_type: "web" as const,
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true as const,
    jwks_uri: `${base}/oauth/jwks.json`,
  };
}

export async function createBlueskyOAuthClient(
  config: BlueskyOAuthConfig,
): Promise<NodeOAuthClient> {
  const raw = await fs.readFile(config.signingKeyPath, "utf8");
  const jwks = JSON.parse(raw) as { keys: Record<string, unknown>[] };
  if (!jwks.keys?.length) {
    throw new Error(`Signing key file ${config.signingKeyPath} has no keys. Run 'pnpm run generate-signing-key' first.`);
  }
  const keyset = await Promise.all(jwks.keys.map(jwk => JoseKey.fromJWK(jwk)));

  return new NodeOAuthClient({
    clientMetadata: buildClientMetadata(config.publicUrl),
    keyset,
    stateStore: config.storage.atprotoStateStore(),
    sessionStore: config.storage.atprotoSessionStore(),
    // In-process lock is fine for a single-node deployment. If this ever
    // scales to multiple replicas they'll need a shared lock (e.g. Redis)
    // to prevent refresh-token rotation races.
    requestLock: requestLocalLock,
  });
}

/**
 * Express handler for /oauth/client-metadata.json. Content-type matters —
 * PDSes validate it.
 */
export function clientMetadataHandler(publicUrl: string) {
  const metadata = buildClientMetadata(publicUrl);
  return (_req: Request, res: Response) => {
    res.type("application/json").send(JSON.stringify(metadata, null, 2));
  };
}

/**
 * Express handler for /oauth/jwks.json. Strips private fields from the
 * on-disk JWKS so we only expose the public half.
 */
export function jwksHandler(signingKeyPath: string) {
  return async (_req: Request, res: Response) => {
    try {
      const raw = await fs.readFile(signingKeyPath, "utf8");
      const jwks = JSON.parse(raw) as { keys: Record<string, unknown>[] };
      const pub = {
        keys: jwks.keys.map(k => {
          // Strip private-only JWK members. Keep everything else verbatim so
          // we don't accidentally drop `kid`, `alg`, `use`, etc.
          const { d, p, q, dp, dq, qi, oth, k: sym, ...rest } = k as any;
          return rest;
        }),
      };
      res.type("application/json").send(JSON.stringify(pub, null, 2));
    } catch (err) {
      res.status(500).json({ error: "Failed to load JWKS", message: (err as Error).message });
    }
  };
}
