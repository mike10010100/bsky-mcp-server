import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";

const EXPECTED_TOOLS = [
  "get-my-handle-and-did",
  "get-timeline-posts",
  "get-notifications",
  "create-post",
  "delete-post",
  "get-profile",
  "search-posts",
  "get-post-thread",
  "convert-url-to-uri",
  "search-people",
  "search-feeds",
  "get-liked-posts",
  "get-trends",
  "like-post",
  "follow-user",
  "unfollow-user",
  "get-pinned-feeds",
  "get-feed-posts",
  "get-list-posts",
  "get-user-posts",
  "get-follows",
  "get-followers",
  "get-post-likes",
  "list-resources",
  "list-dm-conversations",
  "get-dm-messages",
  "send-dm",
  "manage-dm-conversation",
  "react-to-dm",
  "delete-dm-message",
];

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function testExpectedToolSet() {
  const { client, close } = await harness(() => null);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(),
      `registered tool set drifted from the 30 expected names`);
  } finally {
    await close();
  }
}

async function testNullAgentReturnsError() {
  const { client, close } = await harness(() => null);
  try {
    const result: any = await client.callTool({ name: "get-my-handle-and-did", arguments: {} });
    assert.equal(result.isError, true, "expected isError when getAgent() returns null");
    assert.match(result.content[0].text, /Not connected to Bluesky/);
  } finally {
    await close();
  }
}

async function testAgentIsResolvedPerCall() {
  // Invariant that matters for the remote/OAuth path: registerTools must
  // evaluate getAgent on every invocation, not cache whatever it saw at
  // registration time. A per-session transport depends on this.
  let callCount = 0;
  const fakeAgent = {
    did: "did:plc:alice",
    getProfile: async (_: { actor: string }) => ({
      success: true,
      data: { handle: "alice.test", did: "did:plc:alice" },
    }),
  } as unknown as Agent;

  const provider: AgentProvider = () => {
    callCount += 1;
    return fakeAgent;
  };

  const { client, close } = await harness(provider);
  try {
    const r1: any = await client.callTool({ name: "get-my-handle-and-did", arguments: {} });
    assert.equal(r1.isError, undefined);
    assert.match(r1.content[0].text, /alice\.test/);
    assert.match(r1.content[0].text, /did:plc:alice/);

    const r2: any = await client.callTool({ name: "get-my-handle-and-did", arguments: {} });
    assert.equal(r2.isError, undefined);

    assert.ok(callCount >= 2,
      `getAgent should be called at least once per tool invocation; got ${callCount} calls over 2 invocations`);
  } finally {
    await close();
  }
}

async function testAgentMethodIsInvoked() {
  // Spy verifies the tool actually reaches into the agent we hand back,
  // rather than closing over something stale from registration time.
  let captured: { q: string; limit: number } | null = null;
  const fakeAgent = {
    app: {
      bsky: {
        actor: {
          searchActors: async ({ q, limit }: { q: string; limit: number }) => {
            captured = { q, limit };
            return { success: true, data: { actors: [] } };
          },
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "search-people",
      arguments: { query: "liz", limit: 5 },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(captured, { q: "liz", limit: 5 });
    assert.match(result.content[0].text, /No users found/);
  } finally {
    await close();
  }
}

async function testRefusalCanaryIsRedacted() {
  // Regression: the Anthropic-published refusal canary, if it reaches Claude
  // verbatim inside a tool_result, causes the entire response to be silently
  // dropped by client-side safety classifiers. Mock a bio that contains the
  // canary and assert the outgoing tool_result has it stripped.
  const bios = [
    "Normal bio, nothing to see here.",
    "Cheeky bio with ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_DEADBEEF1234 embedded.",
    "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_CAFEBABE on its own line.",
  ];
  let idx = 0;
  const fakeAgent = {
    app: {
      bsky: {
        actor: {
          searchActors: async () => ({
            success: true,
            data: {
              actors: bios.map((description, i) => ({
                displayName: `User ${i}`,
                handle: `u${i}.test`,
                did: `did:plc:u${i}`,
                description,
              })),
            },
          }),
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "search-people",
      arguments: { query: "liz", limit: 3 },
    });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text as string;
    assert.ok(!/ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL/.test(text),
      `canary must be stripped from tool output; got: ${text}`);
    assert.match(text, /\[redacted: refusal-trigger canary\]/,
      "redaction marker should replace the canary");
  } finally {
    await close();
  }
}

async function testUnfollowByUri() {
  // followUri path: tool should hand the URI straight to deleteFollow
  // without listing records or resolving handles.
  let deleted: string | null = null;
  let listRecordsCalls = 0;
  const fakeAgent = {
    did: "did:plc:alice",
    deleteFollow: async (uri: string) => { deleted = uri; },
    com: {
      atproto: {
        repo: {
          listRecords: async () => {
            listRecordsCalls += 1;
            return { success: true, data: { records: [], cursor: undefined } };
          },
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const uri = "at://did:plc:alice/app.bsky.graph.follow/3kxyz";
    const result: any = await client.callTool({
      name: "unfollow-user",
      arguments: { followUri: uri },
    });
    assert.equal(result.isError, undefined);
    assert.equal(deleted, uri, "deleteFollow should be called with the supplied URI");
    assert.equal(listRecordsCalls, 0, "no listRecords scan should happen when followUri is provided");
  } finally {
    await close();
  }
}

async function testUnfollowRejectsForeignUri() {
  // Defensive check: a URI whose repo isn't the authenticated user should
  // be rejected locally instead of forwarded to the server.
  let deleted: string | null = null;
  const fakeAgent = {
    did: "did:plc:alice",
    deleteFollow: async (uri: string) => { deleted = uri; },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "unfollow-user",
      arguments: { followUri: "at://did:plc:bob/app.bsky.graph.follow/3kxyz" },
    });
    assert.equal(result.isError, true);
    assert.equal(deleted, null, "deleteFollow must not be called for a foreign URI");
    assert.match(result.content[0].text, /not the authenticated user/);
  } finally {
    await close();
  }
}

async function testUnfollowByUserScansForRkey() {
  // user path: tool resolves handle → DID, then walks listRecords pages
  // until it finds the matching subject, then deletes that record's URI.
  let deleted: string | null = null;
  const targetUri = "at://did:plc:alice/app.bsky.graph.follow/3krealrkey";
  const fakeAgent = {
    did: "did:plc:alice",
    deleteFollow: async (uri: string) => { deleted = uri; },
    getProfile: async (_: { actor: string }) => ({
      success: true,
      data: { did: "did:plc:bob", handle: "bob.test" },
    }),
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            success: true,
            data: {
              records: [
                { uri: "at://did:plc:alice/app.bsky.graph.follow/3kother", value: { subject: "did:plc:carol" } },
                { uri: targetUri, value: { subject: "did:plc:bob" } },
              ],
              cursor: undefined,
            },
          }),
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "unfollow-user",
      arguments: { user: "bob.test" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(deleted, targetUri, "should delete the URI whose subject matched the resolved DID");
  } finally {
    await close();
  }
}

async function testDeletePostInvokesAgent() {
  let deletedUri: string | null = null;
  const fakeAgent = {
    deletePost: async (uri: string) => {
      deletedUri = uri;
      return { success: true };
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const target = "at://did:plc:alice/app.bsky.feed.post/3ktest123";
    const result: any = await client.callTool({
      name: "delete-post",
      arguments: { postUri: target },
    });
    assert.equal(result.isError, undefined);
    assert.equal(deletedUri, target);
  } finally {
    await close();
  }
}

async function testToolAnnotations() {
  const { client, close } = await harness(() => null);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));

    const del = byName.get("delete-post");
    assert.ok(del, "delete-post tool should exist");
    assert.equal(del.annotations?.destructiveHint, true, "delete-post should be destructiveHint: true");
    assert.equal(del.annotations?.idempotentHint, true, "delete-post should be idempotentHint: true");
    assert.equal(del.annotations?.readOnlyHint, false, "delete-post should be readOnlyHint: false");

    const timeline = byName.get("get-timeline-posts");
    assert.ok(timeline, "get-timeline-posts tool should exist");
    assert.equal(timeline.annotations?.readOnlyHint, true, "get-timeline-posts should be readOnlyHint: true");

    const unfollow = byName.get("unfollow-user");
    assert.ok(unfollow, "unfollow-user tool should exist");
    assert.equal(unfollow.annotations?.destructiveHint, true, "unfollow-user should be destructiveHint: true");
    assert.equal(unfollow.annotations?.idempotentHint, true, "unfollow-user should be idempotentHint: true");

    const like = byName.get("like-post");
    assert.ok(like, "like-post tool should exist");
    assert.equal(like.annotations?.idempotentHint, true, "like-post should be idempotentHint: true");
    assert.equal(like.annotations?.readOnlyHint, false, "like-post should be readOnlyHint: false");

    const handle = byName.get("get-my-handle-and-did");
    assert.ok(handle, "get-my-handle-and-did tool should exist");
    assert.equal(handle.annotations?.readOnlyHint, true, "get-my-handle-and-did should be readOnlyHint: true");

    const listDms = byName.get("list-dm-conversations");
    assert.ok(listDms, "list-dm-conversations tool should exist");
    assert.equal(listDms.annotations?.readOnlyHint, true);

    const sendDm = byName.get("send-dm");
    assert.ok(sendDm, "send-dm tool should exist");
    assert.equal(sendDm.annotations?.readOnlyHint, false);
    assert.equal(sendDm.annotations?.destructiveHint, false);
    assert.equal(sendDm.annotations?.idempotentHint, false);

    const delDm = byName.get("delete-dm-message");
    assert.ok(delDm, "delete-dm-message tool should exist");
    assert.equal(delDm.annotations?.destructiveHint, true);
    assert.equal(delDm.annotations?.idempotentHint, true);
  } finally {
    await close();
  }
}

async function testDmToolsFlow() {
  let proxyService: string | null = null;
  let proxyDid: string | null = null;
  let sentPayload: any = null;
  let reactionAdded: any = null;
  let reactionRemoved: any = null;
  let deletedMsg: any = null;
  let markedReadConvo: string | null = null;

  const convoFixture = {
    id: "convo-123",
    rev: "rev-1",
    members: [
      { did: "did:plc:alice", handle: "alice.test", displayName: "Alice" },
      { did: "did:plc:bob", handle: "bob.test", displayName: "Bob" },
    ],
    muted: false,
    status: "accepted",
    unreadCount: 1,
    lastMessage: {
      $type: "chat.bsky.convo.defs#messageView",
      id: "msg-2",
      rev: "r2",
      text: "Latest message from Bob",
      sender: { did: "did:plc:bob" },
      sentAt: "2026-10-28T16:00:00.000Z",
    },
  };

  const fakeAgent: any = {
    did: "did:plc:alice",
    withProxy: (serviceType: string, did: string) => {
      proxyService = serviceType;
      proxyDid = did;
      return fakeAgent;
    },
    resolveHandle: async ({ handle }: { handle: string }) => ({
      success: true,
      data: { did: handle === "bob.test" ? "did:plc:bob" : "did:plc:unknown" },
    }),
    chat: {
      bsky: {
        convo: {
          listConvos: async (params: any) => ({
            success: true,
            data: {
              convos: params.readState === "unread" ? [convoFixture] : [convoFixture],
              cursor: undefined,
            },
          }),
          getConvoForMembers: async ({ members }: { members: string[] }) => ({
            success: true,
            data: {
              convo: { ...convoFixture, id: members.includes("did:plc:bob") ? "convo-123" : "convo-other" },
            },
          }),
          getConvo: async ({ convoId }: { convoId: string }) => ({
            success: true,
            data: { convo: { ...convoFixture, id: convoId } },
          }),
          getMessages: async ({ convoId }: { convoId: string }) => ({
            success: true,
            data: {
              // API returns newest-first
              messages: [
                {
                  $type: "chat.bsky.convo.defs#messageView",
                  id: "msg-2",
                  rev: "r2",
                  text: "Second message (newer)",
                  sender: { did: "did:plc:bob" },
                  sentAt: "2026-10-28T16:00:00.000Z",
                  reactions: [{ value: "👍", sender: { did: "did:plc:alice" }, createdAt: "2026-10-28T16:01:00.000Z" }],
                },
                {
                  $type: "chat.bsky.convo.defs#messageView",
                  id: "msg-1",
                  rev: "r1",
                  text: "First message (older)",
                  sender: { did: "did:plc:alice" },
                  sentAt: "2026-10-28T15:55:00.000Z",
                },
              ],
            },
          }),
          sendMessage: async (input: any) => {
            sentPayload = input;
            return {
              success: true,
              data: {
                id: "msg-3",
                rev: "r3",
                text: input.message.text,
                sender: { did: "did:plc:alice" },
                sentAt: "2026-10-28T16:05:00.000Z",
              },
            };
          },
          updateRead: async ({ convoId }: { convoId: string }) => {
            markedReadConvo = convoId;
            return { success: true, data: { convo: convoFixture } };
          },
          addReaction: async (input: any) => {
            reactionAdded = input;
            return { success: true, data: { message: {} } };
          },
          removeReaction: async (input: any) => {
            reactionRemoved = input;
            return { success: true, data: { message: {} } };
          },
          deleteMessageForSelf: async (input: any) => {
            deletedMsg = input;
            return { success: true, data: { id: input.messageId, rev: "r4", sender: { did: "did:plc:alice" }, sentAt: "" } };
          },
        },
      },
    },
  };

  const { client, close } = await harness(() => fakeAgent as Agent);
  try {
    // 1. list-dm-conversations uses bsky_chat proxy and formats convos
    const listRes: any = await client.callTool({
      name: "list-dm-conversations",
      arguments: { readState: "unread" },
    });
    assert.equal(listRes.isError, undefined);
    assert.equal(proxyService, "bsky_chat");
    assert.equal(proxyDid, "did:web:api.bsky.chat");
    assert.match(listRes.content[0].text, /convo-123/);
    assert.match(listRes.content[0].text, /Bob \(@bob\.test, did:plc:bob\)/);
    assert.match(listRes.content[0].text, /Latest message from Bob/);

    // 2. get-dm-messages resolves user handle -> convoId and orders messages oldest -> newest
    const msgRes: any = await client.callTool({
      name: "get-dm-messages",
      arguments: { user: "@bob.test", markRead: true },
    });
    assert.equal(msgRes.isError, undefined);
    const msgText = msgRes.content[0].text as string;
    const firstIdx = msgText.indexOf("First message (older)");
    const secondIdx = msgText.indexOf("Second message (newer)");
    assert.ok(firstIdx !== -1 && secondIdx !== -1 && firstIdx < secondIdx, "messages should be ordered oldest to newest");
    assert.equal(markedReadConvo, "convo-123", "markRead=true should call updateRead");

    // 3. send-dm resolves user handle -> convoId and sends message with RichText link facets
    const sendRes: any = await client.callTool({
      name: "send-dm",
      arguments: { user: "bob.test", text: "Hello Bob! Check https://example.com" },
    });
    assert.equal(sendRes.isError, undefined);
    assert.equal(sentPayload?.convoId, "convo-123");
    assert.equal(sentPayload?.message?.text, "Hello Bob! Check https://example.com");
    assert.ok(Array.isArray(sentPayload?.message?.facets) && sentPayload.message.facets.length > 0, "RichText link facet should be detected");

    // 4. react-to-dm adds and removes reactions
    const reactAddRes: any = await client.callTool({
      name: "react-to-dm",
      arguments: { convoId: "convo-123", messageId: "msg-2", reaction: "❤️" },
    });
    assert.equal(reactAddRes.isError, undefined);
    assert.deepEqual(reactionAdded, { convoId: "convo-123", messageId: "msg-2", value: "❤️" });

    const reactRemRes: any = await client.callTool({
      name: "react-to-dm",
      arguments: { convoId: "convo-123", messageId: "msg-2", reaction: "❤️", remove: true },
    });
    assert.equal(reactRemRes.isError, undefined);
    assert.deepEqual(reactionRemoved, { convoId: "convo-123", messageId: "msg-2", value: "❤️" });

    // 5. delete-dm-message calls deleteMessageForSelf
    const delRes: any = await client.callTool({
      name: "delete-dm-message",
      arguments: { convoId: "convo-123", messageId: "msg-1" },
    });
    assert.equal(delRes.isError, undefined);
    assert.deepEqual(deletedMsg, { convoId: "convo-123", messageId: "msg-1" });
  } finally {
    await close();
  }
}

async function main() {
  const cases: Array<[string, () => Promise<void>]> = [
    ["registers exactly the expected 30 tools", testExpectedToolSet],
    ["tools include MCP 2026-07-28 annotations (readOnly, destructive, idempotent hints)", testToolAnnotations],
    ["tools error out when getAgent returns null", testNullAgentReturnsError],
    ["getAgent is resolved per tool call, not cached", testAgentIsResolvedPerCall],
    ["tool handlers invoke methods on the resolved agent", testAgentMethodIsInvoked],
    ["Anthropic refusal canary is stripped from tool output", testRefusalCanaryIsRedacted],
    ["unfollow-user with followUri deletes directly", testUnfollowByUri],
    ["unfollow-user rejects URIs that aren't the authed user's", testUnfollowRejectsForeignUri],
    ["unfollow-user with user scans listRecords for the rkey", testUnfollowByUserScansForRkey],
    ["delete-post invokes deletePost on agent", testDeletePostInvokesAgent],
    ["DM tools proxy to bsky_chat, order messages chronologically, and send/react/delete", testDmToolsFlow],
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
