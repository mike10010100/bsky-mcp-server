import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function testNotificationsReplyFilter() {
  const myDid = "did:plc:me";
  const repliedUri = "at://did:plc:other/app.bsky.feed.post/has-been-responded-to";
  const unrepliedUri = "at://did:plc:other/app.bsky.feed.post/not-yet-responded-to";

  const fakeAgent = {
    did: myDid,
    app: {
      bsky: {
        notification: {
          listNotifications: async ({ reasons }: { reasons?: string[] }) => {
            return {
              success: true,
              data: {
                notifications: [
                  {
                    uri: repliedUri,
                    cid: "c1",
                    author: { handle: "other.test", displayName: "Other" },
                    reason: "reply",
                    indexedAt: new Date().toISOString(),
                    isRead: false
                  },
                  {
                    uri: unrepliedUri,
                    cid: "c2",
                    author: { handle: "other2.test", displayName: "Other 2" },
                    reason: "reply",
                    indexedAt: new Date().toISOString(),
                    isRead: false
                  },
                  {
                    uri: "at://did:plc:other/app.bsky.feed.post/mention",
                    cid: "c3",
                    author: { handle: "other3.test", displayName: "Other 3" },
                    reason: "mention",
                    indexedAt: new Date().toISOString(),
                    isRead: false
                  }
                ],
                cursor: undefined
              }
            };
          }
        },
        feed: {
          getAuthorFeed: async () => {
            return {
              success: true,
              data: {
                feed: [
                  {
                    post: { uri: "at://did:plc:me/app.bsky.feed.post/myreply", author: { did: myDid } },
                    reply: {
                      parent: { $type: "app.bsky.feed.defs#postView", uri: repliedUri },
                      root: { $type: "app.bsky.feed.defs#postView", uri: "at://did:plc:other/app.bsky.feed.post/root" }
                    }
                  }
                ]
              }
            };
          }
        }
      }
    }
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    // Test 'unresponded' filter
    const r1: any = await client.callTool({
      name: "get-notifications",
      arguments: { replyFilter: "unresponded" }
    });
    assert.equal(r1.isError, undefined);
    const text1 = r1.content[0].text as string;
    assert.match(text1, /UNRESPONDED/);
    assert.match(text1, /not-yet-responded-to/);
    assert.ok(!text1.includes("has-been-responded-to"), "Should not contain responded reply");
    assert.ok(!text1.includes("[MENTION]"), "Should filter out mentions when replyFilter is used without explicit reasons");

    // Test 'responded' filter
    const r2: any = await client.callTool({
      name: "get-notifications",
      arguments: { replyFilter: "responded" }
    });
    assert.equal(r2.isError, undefined);
    const text2 = r2.content[0].text as string;
    assert.match(text2, /RESPONDED/);
    assert.match(text2, /has-been-responded-to/);
    assert.ok(!text2.includes("not-yet-responded-to"), "Should not contain unresponded reply");

    // Test 'all' filter (default)
    const r3: any = await client.callTool({
      name: "get-notifications",
      arguments: { replyFilter: "all" }
    });
    assert.equal(r3.isError, undefined);
    const text3 = r3.content[0].text as string;
    assert.match(text3, /\[REPLY\]/);
    assert.match(text3, /\[MENTION\]/);
    assert.match(text3, /has-been-responded-to/);
    assert.match(text3, /not-yet-responded-to/);

    // Test 'authorFilter'
    const r4: any = await client.callTool({
      name: "get-notifications",
      arguments: { authorFilter: "other2.test" }
    });
    assert.equal(r4.isError, undefined);
    const text4 = r4.content[0].text as string;
    assert.match(text4, /other2.test/);
    assert.ok(!text4.includes("other.test"), "Should not contain other authors");
    assert.ok(!text4.includes("other3.test"), "Should not contain other authors");

  } finally {
    await close();
  }
}

testNotificationsReplyFilter().then(() => {
  console.log("ok - get-notifications reply filter tests passed");
}).catch(err => {
  console.error("FAIL - get-notifications reply filter tests failed");
  console.error(err);
  process.exit(1);
});
