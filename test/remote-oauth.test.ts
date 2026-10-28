import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";

import { Storage } from "../src/remote/storage.js";
import { buildApp } from "../src/remote/server.js";

/**
 * Fake NodeOAuthClient that records calls and doesn't hit the network.
 * The provider only depends on the `authorize`, `callback`, and `restore`
 * methods; we stub each to just enough detail to drive the flow.
 */
function makeFakeBsky(captured: { lastHandle?: string; lastState?: string }) {
  return {
    async authorize(handle: string, options: { state: string }) {
      captured.lastHandle = handle;
      captured.lastState = options.state;
      return new URL(`https://mock-pds.invalid/oauth/authorize?state=${options.state}`);
    },
    async callback(params: URLSearchParams) {
      const state = params.get("state") ?? "";
      const did = params.get("did") ?? "did:plc:fake";
      return { session: { did }, state };
    },
    async restore(_did: string) {
      throw new Error("restore not exercised in these tests");
    },
  } as unknown as NodeOAuthClient;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bsky-mcp-test-"));
}

/**
 * Start the Express app on a random port. Returns the base URL and a
 * teardown function.
 */
async function startApp(): Promise<{ baseUrl: string; storage: Storage; captured: { lastHandle?: string; lastState?: string }; stop: () => Promise<void>; tempDir: string }> {
  const tempDir = mkTempDir();
  const storage = new Storage(path.join(tempDir, "test.db"));
  // Write an empty signing key file so the /jwks handler has something to
  // serve. We don't exercise real signing in these tests.
  fs.writeFileSync(path.join(tempDir, "key.json"), JSON.stringify({ keys: [] }));

  const captured: { lastHandle?: string; lastState?: string } = {};
  const bskyClient = makeFakeBsky(captured);

  const app = buildApp({
    publicUrl: "http://127.0.0.1:0",
    signingKeyPath: path.join(tempDir, "key.json"),
    storage,
    bskyClient,
  });

  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    storage,
    captured,
    tempDir,
    stop: async () => {
      await new Promise<void>(r => server.close(() => r()));
      storage.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function req(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, { redirect: "manual", ...init });
}

// -----------------------------------------------------------------------------

async function testProtectedResourceMetadata() {
  const { baseUrl, stop } = await startApp();
  try {
    const r = await req(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.scopes_supported.sort(), ["atproto", "transition:chat.bsky", "transition:generic"]);
    assert.equal(body.resource_name, "Bluesky MCP");
  } finally {
    await stop();
  }
}

async function testClientMetadataServedAtExpectedPath() {
  const { baseUrl, stop } = await startApp();
  try {
    const r = await req(`${baseUrl}/oauth/client-metadata.json`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.dpop_bound_access_tokens, true);
    assert.equal(body.token_endpoint_auth_method, "private_key_jwt");
    assert.deepEqual(body.redirect_uris, ["http://127.0.0.1:0/oauth/callback"]);
  } finally {
    await stop();
  }
}

async function testUnauthenticatedMcpIs401() {
  const { baseUrl, stop } = await startApp();
  try {
    const r = await req(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(r.status, 401);
  } finally {
    await stop();
  }
}

async function testDcrRegistersAClient() {
  const { baseUrl, stop } = await startApp();
  try {
    const r = await req(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: ["http://localhost:9999/callback"],
      }),
    });
    assert.equal(r.status, 201);
    const body = await r.json() as any;
    assert.ok(body.client_id, "DCR response must include client_id");
    assert.ok(body.client_id_issued_at, "DCR response must include client_id_issued_at");
    assert.deepEqual(body.redirect_uris, ["http://localhost:9999/callback"]);
  } finally {
    await stop();
  }
}

async function testFullAuthCodeFlow() {
  // Exercises: DCR → /authorize → /oauth/login → (fake Bluesky) →
  // /oauth/callback → /token.
  //
  // The ATProto OAuth client is the fake above, which resolves callback()
  // to a deterministic DID derived from the state it was handed. That lets
  // us verify the provider issues an MCP auth code + access token bound to
  // the correct DID without any real network traffic.

  const { baseUrl, storage, captured, stop } = await startApp();
  try {
    // 1. DCR — register as a PKCE-only public client (no secret).
    // This is the pattern Claude's MCP connector uses: it can't safely
    // store a client_secret, so authentication is PKCE-only.
    const regRes = await req(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Flow Test",
        redirect_uris: ["http://localhost:9999/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const reg = await regRes.json() as any;
    const clientId = reg.client_id as string;

    // 2. PKCE
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = s256(codeVerifier);
    const clientState = "client-state-xyz";

    // 3. /authorize → login HTML
    const authUrl = new URL(`${baseUrl}/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", clientState);
    authUrl.searchParams.set("scope", "atproto transition:generic");

    const authRes = await req(authUrl.toString());
    assert.equal(authRes.status, 200);
    const html = await authRes.text();
    // Pull the state key out of the hidden form field so we can simulate
    // a POST /oauth/login.
    const match = html.match(/name="state"\s+value="([^"]+)"/);
    assert.ok(match, "login page must carry a hidden state field");
    const stateKey = match![1];

    // 4. POST /oauth/login → redirect to (fake) PDS
    const loginRes = await req(`${baseUrl}/oauth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: stateKey, handle: "alice.test" }).toString(),
    });
    assert.equal(loginRes.status, 302, "login should redirect to PDS");
    const loc = loginRes.headers.get("location")!;
    assert.ok(loc.startsWith("https://mock-pds.invalid/"), `expected redirect to mock PDS, got ${loc}`);
    assert.equal(captured.lastHandle, "alice.test");
    assert.equal(captured.lastState, stateKey);

    // 5. GET /oauth/callback — fake the PDS round-trip by hitting our
    // callback with the state we know about. The fake callback() returns
    // did:plc:fake by default, which is what gets bound to the MCP code.
    const cbRes = await req(`${baseUrl}/oauth/callback?state=${encodeURIComponent(stateKey)}&code=unused`);
    assert.equal(cbRes.status, 302, "callback should redirect to the client");
    const clientRedirect = new URL(cbRes.headers.get("location")!);
    assert.equal(clientRedirect.origin + clientRedirect.pathname, "http://localhost:9999/callback");
    assert.equal(clientRedirect.searchParams.get("state"), clientState);
    const mcpCode = clientRedirect.searchParams.get("code");
    assert.ok(mcpCode, "callback must redirect with an MCP auth code");

    // 6. POST /token — swap code for bearer.
    const tokenRes = await req(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: mcpCode!,
        redirect_uri: "http://localhost:9999/callback",
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
    });
    const tokenBody = await tokenRes.text();
    assert.equal(tokenRes.status, 200, `expected 200 from /token, got ${tokenRes.status}: ${tokenBody}`);
    const tokens = JSON.parse(tokenBody);
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.equal(typeof tokens.expires_in, "number");

    // 7. Verify the stored token is DID-bound.
    const stored = storage.getTokenByAccess(tokens.access_token);
    assert.ok(stored, "token must be persisted");
    assert.equal(stored.did, "did:plc:fake");
    assert.equal(stored.client_id, clientId);

    // 8. Exchange refresh token → should rotate (old access invalidated).
    const refreshRes = await req(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    assert.equal(refreshRes.status, 200);
    const newTokens = await refreshRes.json() as any;
    assert.notEqual(newTokens.access_token, tokens.access_token, "refresh must issue a new access token");
    assert.equal(storage.getTokenByAccess(tokens.access_token), undefined,
      "old access token must be revoked after refresh");
  } finally {
    await stop();
  }
}

async function testCallbackExpiredStateIsRejected() {
  const { baseUrl, stop } = await startApp();
  try {
    const r = await req(`${baseUrl}/oauth/callback?state=does-not-exist&code=whatever`);
    assert.equal(r.status, 400);
  } finally {
    await stop();
  }
}

async function testCallbackPreservesStateBytesForMisEncodingClients() {
  // Regression: a real-world MCP client generated state with base64 `+`
  // chars and URL-encoded them as `%20` instead of `%2B`. That meant the
  // state we received from them contained literal spaces, and when we
  // echoed it back in the redirect using URLSearchParams (which form-
  // encodes spaces as `+`), their client saw the bytes change between
  // what it sent and what we returned, and rejected the callback with
  // "no OAuth flow in progress". Verify our redirect preserves state
  // byte-for-byte via `%20` encoding.
  const { baseUrl, stop } = await startApp();
  try {
    const regRes = await req(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Space Client",
        redirect_uris: ["http://localhost:9999/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const clientId = (await regRes.json() as any).client_id as string;

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = s256(codeVerifier);
    const quirkyState = "abc  def";  // contains two literal spaces

    const authUrl = new URL(`${baseUrl}/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", quirkyState);

    const authRes = await req(authUrl.toString());
    assert.equal(authRes.status, 200);
    const stateKey = (await authRes.text()).match(/name="state"\s+value="([^"]+)"/)![1];

    const loginRes = await req(`${baseUrl}/oauth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: stateKey, handle: "alice.test" }).toString(),
    });
    assert.equal(loginRes.status, 302);

    const cbRes = await req(`${baseUrl}/oauth/callback?state=${encodeURIComponent(stateKey)}&code=unused`);
    assert.equal(cbRes.status, 302);

    const loc = cbRes.headers.get("location")!;
    // The redirect must preserve the client's original state byte-for-byte.
    // encodeURIComponent emits %20 for space; URLSearchParams would have
    // emitted '+'. We want %20 so round-tripping gives the client back
    // exactly "abc  def".
    assert.ok(loc.includes("state=abc%20%20def"),
      `redirect must use %20 for space, not '+'; got: ${loc}`);
    assert.equal(new URL(loc).searchParams.get("state"), quirkyState,
      "decoded state must match original");
  } finally {
    await stop();
  }
}

// -----------------------------------------------------------------------------

async function main() {
  const cases: Array<[string, () => Promise<void>]> = [
    ["/.well-known/oauth-protected-resource advertises scopes", testProtectedResourceMetadata],
    ["/oauth/client-metadata.json matches ATProto confidential-client shape", testClientMetadataServedAtExpectedPath],
    ["POST /mcp without bearer returns 401", testUnauthenticatedMcpIs401],
    ["DCR registers a client and returns its client_id", testDcrRegistersAClient],
    ["full flow: DCR → /authorize → login → callback → /token (+ refresh)", testFullAuthCodeFlow],
    ["callback with unknown state is rejected", testCallbackExpiredStateIsRejected],
    ["callback preserves state bytes for mis-encoding clients", testCallbackPreservesStateBytesForMisEncodingClients],
  ];

  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(err);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} / ${cases.length} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${cases.length} / ${cases.length} test(s) passed`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
