import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";
import { preprocessPosts, formatPostThread } from "../src/llm-preprocessor.js";
import { convertBskyUrlToAtUri, isValidPostAtUri, normalizePostUri } from "../src/utils.js";

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "regression-test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "regression-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Independent XML oracle using Python's stdlib ElementTree parser over a batch of XML documents.
 */
function verifyXmlDocumentsWithPython(docs: Array<{ label: string; xml: string }>): void {
  const payload = JSON.stringify(docs);
  const pyScript = `
import json, sys, xml.etree.ElementTree as ET
docs = json.loads(sys.stdin.read())
for d in docs:
    try:
        ET.fromstring(d["xml"])
    except Exception as e:
        sys.stderr.write(f"XML PARSE FAILURE in {d['label']}: {e}\\n{d['xml'][:600]}\\n")
        sys.exit(1)
print(f"verified {len(docs)} xml documents")
`;
  const res = spawnSync("python3", ["-c", pyScript], {
    input: payload,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `Independent XML parser failed:\n${res.stderr}`);
}

function makePostView(opts: {
  uri: string;
  cid?: string;
  handle?: string;
  displayName?: string;
  text: string;
  createdAt?: string;
  indexedAt?: string;
  replyParentUri?: string;
  replyRootUri?: string;
  embed?: any;
  recordEmbed?: any;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
}): any {
  const did = opts.uri.split("/")[2] || "did:plc:test";
  const record: any = {
    $type: "app.bsky.feed.post",
    text: opts.text,
    createdAt: opts.createdAt || "2026-11-10T18:00:00.000Z",
  };
  if (opts.replyParentUri) {
    record.reply = {
      parent: { uri: opts.replyParentUri, cid: "cid-parent" },
      root: { uri: opts.replyRootUri || opts.replyParentUri, cid: "cid-root" },
    };
  }
  if (opts.recordEmbed) {
    record.embed = opts.recordEmbed;
  }
  return {
    uri: opts.uri,
    cid: opts.cid || `cid-${opts.uri.split("/").pop()}`,
    author: {
      did,
      handle: opts.handle || "user.test",
      displayName: opts.displayName ?? "Test User",
    },
    record,
    embed: opts.embed,
    indexedAt: opts.indexedAt || opts.createdAt || "2026-11-10T18:00:05.000Z",
    likeCount: opts.likeCount ?? 2,
    repostCount: opts.repostCount ?? 0,
    replyCount: opts.replyCount ?? 1,
    quoteCount: opts.quoteCount ?? 0,
  };
}

// -----------------------------------------------------------------------------
// Saved Regression Replays (R1 - R8)
// -----------------------------------------------------------------------------

async function testRegressionR1DeepOrphanedRepliesAndMultiSiblingXml() {
  // Reproduces:
  // 1) Stancil thread bug where author wrote root R, other users wrote intermediate replies
  //    (absent from author's getAuthorFeed), and author wrote deep replies S1 -> S2 and S3.
  // 2) Foreign-root deep reply F1 where neither root nor parent is in feedItems.
  // 3) Multi-sibling nested reply XML slice corruption (old formatReplies sliced `result`
  //    using `indentedReply.lastIndexOf('</post>')`).
  const rootUri = "at://did:plc:stancil/app.bsky.feed.post/root1";
  const mikeMidUri = "at://did:plc:mike/app.bsky.feed.post/mid-absent";
  const s1Uri = "at://did:plc:stancil/app.bsky.feed.post/deep1";
  const s2Uri = "at://did:plc:stancil/app.bsky.feed.post/deep2";
  const s3Uri = "at://did:plc:stancil/app.bsky.feed.post/deep3";
  const d1aUri = "at://did:plc:stancil/app.bsky.feed.post/direct1a";
  const d1bUri = "at://did:plc:stancil/app.bsky.feed.post/direct1b";
  const d1bChildUri = "at://did:plc:stancil/app.bsky.feed.post/direct1b-child";
  const foreignDeepUri = "at://did:plc:stancil/app.bsky.feed.post/foreign-deep";

  const items: any[] = [
    { post: makePostView({ uri: rootUri, text: "Root post" }) },
    {
      post: makePostView({
        uri: d1aUri,
        text: "First direct child of root with <angle> & \"quotes\"",
        displayName: "Name <with> \"quotes\" & \x0Bcontrol",
        replyParentUri: rootUri,
        replyRootUri: rootUri,
        createdAt: "2026-11-10T18:01:00.000Z",
      }),
    },
    {
      post: makePostView({
        uri: d1bUri,
        text: "Second direct child of root (triggered substring corruption when it had nested child)",
        replyParentUri: rootUri,
        replyRootUri: rootUri,
        createdAt: "2026-11-10T18:02:00.000Z",
      }),
    },
    {
      post: makePostView({
        uri: d1bChildUri,
        text: "Nested child under second sibling",
        replyParentUri: d1bUri,
        replyRootUri: rootUri,
        createdAt: "2026-11-10T18:03:00.000Z",
      }),
    },
    {
      post: makePostView({
        uri: s1Uri,
        text: "Deep reply 1 to Mike (parent absent from feedItems)",
        replyParentUri: mikeMidUri,
        replyRootUri: rootUri,
        createdAt: "2026-11-10T18:10:00.000Z",
      }),
    },
    {
      post: makePostView({
        uri: s2Uri,
        text: "Self-continuation under Deep reply 1",
        replyParentUri: s1Uri,
        replyRootUri: rootUri,
        createdAt: "2026-11-10T18:11:00.000Z",
      }),
    },
    {
      post: makePostView({
        uri: s3Uri,
        text: "Second deep reply to Mike",
        replyParentUri: mikeMidUri,
        replyRootUri: rootUri,
        createdAt: "2026-11-10T18:12:00.000Z",
      }),
    },
    {
      post: makePostView({
        uri: foreignDeepUri,
        text: "Depth-3 reply in someone else's thread",
        replyParentUri: "at://did:plc:someone/app.bsky.feed.post/p99",
        replyRootUri: "at://did:plc:other/app.bsky.feed.post/r00",
        createdAt: "2026-11-10T18:15:00.000Z",
      }),
    },
  ];

  const xml = preprocessPosts(items, { detail: "full" });
  verifyXmlDocumentsWithPython([{ label: "R1-full", xml }]);

  const expectedUris = [rootUri, d1aUri, d1bUri, d1bChildUri, s1Uri, s2Uri, s3Uri, foreignDeepUri];
  const emittedUris = [...xml.matchAll(/<post\b[^>]*\buri="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...emittedUris].sort(),
    [...expectedUris].sort(),
    "Every input post must be emitted exactly once (0 dropped, 0 duplicated)"
  );

  const compact = preprocessPosts(items, { detail: "compact" });
  for (const u of expectedUris) {
    assert.ok(compact.includes(u), `Compact output must preserve ${u}`);
  }
}

async function testRegressionR2RecordWithMediaAndDeletedQuoteStubs() {
  // Reproduces `3mzxxztyin22k` (quote + screenshot) losing BOTH quote and image,
  // plus `3mzxx5cl5rc2z` (deleted quoted post) losing its URI.
  const liveQuotedUri = "at://did:plc:quoted/app.bsky.feed.post/q1";
  const deletedQuotedUri = "at://did:plc:stancil/app.bsky.feed.post/3mzxx5cl5rc2z";

  const receiptPost = makePostView({
    uri: "at://did:plc:mike/app.bsky.feed.post/receipt1",
    text: "Receipt with quote AND screenshot",
    embed: {
      $type: "app.bsky.embed.recordWithMedia#view",
      record: {
        $type: "app.bsky.embed.record#view",
        record: {
          $type: "app.bsky.embed.record#viewRecord",
          uri: liveQuotedUri,
          cid: "cid-q1",
          author: { did: "did:plc:quoted", handle: "quoted.test", displayName: "Quoted Author" },
          value: { text: "Original claim text", createdAt: "2026-11-10T17:00:00.000Z" },
          indexedAt: "2026-11-10T17:00:01.000Z",
          likeCount: 10,
          repostCount: 2,
          replyCount: 3,
        },
      },
      media: {
        $type: "app.bsky.embed.images#view",
        images: [
          {
            thumb: "https://cdn.bsky.app/img/thumb1.jpg",
            fullsize: "https://cdn.bsky.app/img/full1.jpg",
            alt: 'Screenshot showing "deleted" post & timestamp',
          },
        ],
      },
    },
  });

  const deletedQuotePost = makePostView({
    uri: "at://did:plc:mike/app.bsky.feed.post/receipt2",
    text: "Quoting a post that was later deleted",
    embed: {
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewNotFound",
        uri: deletedQuotedUri,
        notFound: true,
      },
    },
  });

  const xml = preprocessPosts([{ post: receiptPost }, { post: deletedQuotePost }], { detail: "full" });
  verifyXmlDocumentsWithPython([{ label: "R2-recordWithMedia", xml }]);

  assert.match(xml, /type="standalone,quote"/);
  assert.match(xml, new RegExp(`<quoted_post uri="${liveQuotedUri}"`));
  assert.match(xml, /https:\/\/cdn\.bsky\.app\/img\/full1\.jpg/);
  assert.match(xml, new RegExp(`<quoted_post uri="${deletedQuotedUri}"[^>]*status="not_found"`));

  const compact = preprocessPosts([{ post: receiptPost }, { post: deletedQuotePost }], { detail: "compact" });
  assert.match(compact, new RegExp(`quote: @quoted\\.test \\(${liveQuotedUri}`));
  assert.match(compact, /media: \[image\] https:\/\/cdn\.bsky\.app\/img\/full1\.jpg/);
  assert.match(compact, new RegExp(`quote: \\[not_found\\] ${deletedQuotedUri}`));
}

async function testRegressionR3DeletedAncestorInThreadPreservesRequestedPost() {
  // Previously, if any parent in `threadView.parent` was `#notFoundPost` or `#blockedPost`,
  // `processThreadViewPostChain` hit `if (!post) return ''` and blanked the ENTIRE thread!
  const threadView = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: makePostView({
      uri: "at://did:plc:mike/app.bsky.feed.post/target-live",
      text: "Target post below deleted root",
      replyParentUri: "at://did:plc:other/app.bsky.feed.post/blocked-mid",
      replyRootUri: "at://did:plc:other/app.bsky.feed.post/deleted-root",
    }),
    parent: {
      $type: "app.bsky.feed.defs#blockedPost",
      uri: "at://did:plc:other/app.bsky.feed.post/blocked-mid",
      blocked: true,
      parent: {
        $type: "app.bsky.feed.defs#notFoundPost",
        uri: "at://did:plc:other/app.bsky.feed.post/deleted-root",
        notFound: true,
      },
    },
    replies: [
      {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: makePostView({ uri: "at://did:plc:r/app.bsky.feed.post/r1", text: "Reply 1" }),
      },
      {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: makePostView({ uri: "at://did:plc:r/app.bsky.feed.post/r2", text: "Reply 2" }),
      },
      {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: makePostView({ uri: "at://did:plc:r/app.bsky.feed.post/r3", text: "Reply 3" }),
      },
    ],
  };

  const xml = formatPostThread(threadView, { detail: "full", maxRepliesPerNode: 2 });
  verifyXmlDocumentsWithPython([{ label: "R3-deleted-ancestor", xml }]);
  assert.match(xml, /uri="at:\/\/did:plc:other\/app\.bsky\.feed\.post\/deleted-root" status="not_found"/);
  assert.match(xml, /uri="at:\/\/did:plc:other\/app\.bsky\.feed\.post\/blocked-mid" status="blocked"/);
  assert.match(xml, /uri="at:\/\/did:plc:mike\/app\.bsky\.feed\.post\/target-live"[^>]*requested="true"/);
  assert.match(xml, /<omitted_replies count="1" \/>/);

  const compact = formatPostThread(threadView, { detail: "compact", maxRepliesPerNode: 2 });
  assert.match(compact, /\[not_found\] at:\/\/did:plc:other\/app\.bsky\.feed\.post\/deleted-root/);
  assert.match(compact, /target-live \[REQUESTED\]/);
  assert.match(compact, /\[\+1 more direct replies omitted\]/);
}

async function testRegressionR4OldRepostDoesNotAbortHoursPagination() {
  // Previously, if the last item of page 1 in `hours` mode was a recent repost of a 2024 post,
  // `oldestPost.post.record.createdAt < targetDate` aborted pagination and missed page 2!
  const now = Date.now();
  const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const twentyMinAgo = new Date(now - 20 * 60 * 1000).toISOString();
  const twoYearsAgo = "2024-01-15T12:00:00.000Z";

  let pagesRequested = 0;
  const fakeAgent: any = {
    getProfile: async () => ({
      success: true,
      data: { did: "did:plc:alice", handle: "alice.test", displayName: "Alice" },
    }),
    app: {
      bsky: {
        feed: {
          getAuthorFeed: async ({ cursor }: { cursor?: string }) => {
            pagesRequested += 1;
            if (!cursor) {
              return {
                success: true,
                data: {
                  cursor: "page2",
                  feed: [
                    {
                      post: makePostView({
                        uri: "at://did:plc:old/app.bsky.feed.post/vintage2024",
                        text: "2024 post reposted 10 minutes ago",
                        createdAt: twoYearsAgo,
                      }),
                      reason: {
                        $type: "app.bsky.feed.defs#reasonRepost",
                        by: { did: "did:plc:alice", handle: "alice.test", displayName: "Alice" },
                        indexedAt: tenMinAgo,
                      },
                    },
                  ],
                },
              };
            }
            return {
              success: true,
              data: {
                cursor: undefined,
                feed: [
                  {
                    post: makePostView({
                      uri: "at://did:plc:alice/app.bsky.feed.post/fresh-page2",
                      text: "Authored post 20 minutes ago on page 2",
                      createdAt: twentyMinAgo,
                    }),
                  },
                ],
              },
            };
          },
        },
      },
    },
  };

  const { client, close } = await harness(() => fakeAgent as Agent);
  try {
    const res: any = await client.callTool({
      name: "get-user-posts",
      arguments: { user: "alice.test", count: 2, type: "hours" },
    });
    assert.equal(res.isError, undefined);
    assert.equal(pagesRequested, 2, "Must continue past old-createdAt repost to page 2");
    assert.match(res.content[0].text, /vintage2024/);
    assert.match(res.content[0].text, /fresh-page2/);
  } finally {
    await close();
  }
}

async function testRegressionR5CreatePostAndCreateThreadContracts() {
  const postedRecords: any[] = [];
  const tempImg = path.join(os.tmpdir(), `bsky-test-${Date.now()}.png`);
  // Minimal 1x1 PNG header bytes
  fs.writeFileSync(tempImg, Buffer.from("89504e470d0a1a0a", "hex"));

  const fakeAgent: any = {
    did: "did:plc:author",
    resolveHandle: async ({ handle }: { handle: string }) => ({
      success: handle === "valid.test",
      data: { did: "did:plc:valid" },
    }),
    uploadBlob: async () => ({
      success: true,
      data: { blob: { $type: "blob", ref: { $link: "bafkreitestblob" }, mimeType: "image/png", size: 8 } },
    }),
    post: async (record: any) => {
      postedRecords.push(record);
      const idx = postedRecords.length;
      return {
        uri: `at://did:plc:author/app.bsky.feed.post/rkey${idx}`,
        cid: `cid-${idx}`,
      };
    },
    app: {
      bsky: {
        feed: {
          getPosts: async ({ uris }: { uris: string[] }) => ({
            success: true,
            data: {
              posts: uris
                .filter((u) => !u.endsWith("/deleted"))
                .map((u) => ({
                  uri: u,
                  cid: `cid-for-${u.split("/").pop()}`,
                  record: { text: "quoted", createdAt: "2026-11-10T00:00:00.000Z" },
                })),
            },
          }),
        },
      },
    },
  };

  const { client, close } = await harness(() => fakeAgent as Agent);
  try {
    // 1. Fail-closed on deleted quoteUri (0 posts published!)
    const deadQuote: any = await client.callTool({
      name: "create-post",
      arguments: {
        text: "Trying to quote a deleted post",
        quoteUri: "at://did:plc:valid/app.bsky.feed.post/deleted",
        embedPreview: false,
      },
    });
    assert.equal(deadQuote.isError, true);
    assert.equal(postedRecords.length, 0, "Must NOT publish standalone post when quoteUri lookup fails");

    // 2. Emoji ZWJ sequence: 50 family emojis = 50 graphemes, 550 UTF-16 code units!
    // Old z.string().max(300) rejected this at UTF-16 validation despite being only 50 graphemes!
    const familyEmoji50 = "👨‍👩‍👧‍👦".repeat(50);
    assert.ok(familyEmoji50.length > 300, "Fixture must exceed 300 UTF-16 code units");
    const emojiRes: any = await client.callTool({
      name: "create-post",
      arguments: {
        text: familyEmoji50,
        embedPreview: false,
      },
    });
    assert.equal(emojiRes.isError, undefined, `50-grapheme emoji post should succeed: ${emojiRes.content[0].text}`);
    assert.match(emojiRes.content[0].text, /Graphemes: 50\/300/);
    assert.equal(postedRecords.length, 1);

    // 3. create-thread pre-flight abort when post #3 has missing image (0 new posts published!)
    postedRecords.length = 0;
    const abortedThread: any = await client.callTool({
      name: "create-thread",
      arguments: {
        posts: [
          { text: "Post 1", embedPreview: false },
          { text: "Post 2", embedPreview: false },
          { text: "Post 3", imagePaths: ["/nonexistent/path/missing.png"], embedPreview: false },
        ],
      },
    });
    assert.equal(abortedThread.isError, true);
    assert.equal(postedRecords.length, 0, "Atomic pre-flight must publish 0 posts when Post #3 is invalid");

    // 4. Valid 3-post create-thread with quote+image on Post #2 chains root & parent CIDs properly
    const okThread: any = await client.callTool({
      name: "create-thread",
      arguments: {
        posts: [
          { text: "Thread opener 1/3", embedPreview: false },
          {
            text: "Receipt 2/3",
            quoteUri: "https://bsky.app/profile/valid.test/post/qtarget",
            imagePaths: [tempImg],
            imageAlts: ["Alt for receipt"],
            embedPreview: false,
          },
          { text: "Closer 3/3", embedPreview: false },
        ],
      },
    });
    assert.equal(okThread.isError, undefined, `Valid thread failed: ${okThread.content[0].text}`);
    assert.equal(postedRecords.length, 3);
    assert.equal(postedRecords[0].reply, undefined);
    assert.deepEqual(postedRecords[1].reply, {
      root: { uri: "at://did:plc:author/app.bsky.feed.post/rkey1", cid: "cid-1" },
      parent: { uri: "at://did:plc:author/app.bsky.feed.post/rkey1", cid: "cid-1" },
    });
    assert.equal(postedRecords[1].embed?.$type, "app.bsky.embed.recordWithMedia");
    assert.deepEqual(postedRecords[2].reply, {
      root: { uri: "at://did:plc:author/app.bsky.feed.post/rkey1", cid: "cid-1" },
      parent: { uri: "at://did:plc:author/app.bsky.feed.post/rkey2", cid: "cid-2" },
    });
  } finally {
    fs.rmSync(tempImg, { force: true });
    await close();
  }
}

async function testRegressionR6LikeUnlikeRepostUnrepostAndUrlVariants() {
  // Verify did:web: URIs, did:plc: web URLs, like/unlike, repost/unrepost, and malformed/foreign URI rejection
  assert.equal(isValidPostAtUri("at://did:web:example.com/app.bsky.feed.post/3kabc"), true);
  assert.equal(isValidPostAtUri("at://did:plc:mmtjkssv6jeneahkgfdxuy7p/app.bsky.feed.post/3kabc"), true);

  let resolveHandleCalls = 0;
  const fakeAgent: any = {
    did: "did:plc:me",
    resolveHandle: async () => {
      resolveHandleCalls += 1;
      return { success: true, data: { did: "did:plc:resolved" } };
    },
    like: async () => ({ uri: "at://did:plc:me/app.bsky.feed.like/like123" }),
    deleteLike: async () => {},
    repost: async () => ({ uri: "at://did:plc:me/app.bsky.feed.repost/rp123" }),
    deleteRepost: async () => {},
    app: {
      bsky: {
        feed: {
          getPosts: async ({ uris }: { uris: string[] }) => ({
            success: true,
            data: {
              posts: uris.map((u) => ({
                uri: u,
                cid: "cid-xyz",
                viewer: {
                  like: u.includes("liked") ? "at://did:plc:me/app.bsky.feed.like/existing" : undefined,
                  repost: u.includes("reposted") ? "at://did:plc:me/app.bsky.feed.repost/existing" : undefined,
                },
              })),
            },
          }),
        },
      },
    },
  };

  // Converting a URL that already embeds a DID should require 0 resolveHandle calls!
  const didUrlConverted = await convertBskyUrlToAtUri(
    "https://bsky.app/profile/did:plc:mmtjkssv6jeneahkgfdxuy7p/post/3mzx123",
    fakeAgent as Agent
  );
  assert.equal(didUrlConverted, "at://did:plc:mmtjkssv6jeneahkgfdxuy7p/app.bsky.feed.post/3mzx123");
  assert.equal(resolveHandleCalls, 0);

  const didWebNorm = await normalizePostUri("at://did:web:alice.example/app.bsky.feed.post/3mzx999", fakeAgent as Agent);
  assert.equal(didWebNorm, "at://did:web:alice.example/app.bsky.feed.post/3mzx999");

  const { client, close } = await harness(() => fakeAgent as Agent);
  try {
    const likeRes: any = await client.callTool({
      name: "like-post",
      arguments: { uri: "https://bsky.app/profile/did:plc:bob/post/post1" },
    });
    assert.equal(likeRes.isError, undefined);
    assert.match(likeRes.content[0].text, /like123/);

    const badUnlike: any = await client.callTool({
      name: "unlike-post",
      arguments: { likeUri: "http://did:plc:me/app.bsky.feed.like" },
    });
    assert.equal(badUnlike.isError, true);
    assert.match(badUnlike.content[0].text, /Invalid likeUri format/);

    const foreignRepostDel: any = await client.callTool({
      name: "unrepost",
      arguments: { repostUri: "at://did:plc:someoneelse/app.bsky.feed.repost/rp1" },
    });
    assert.equal(foreignRepostDel.isError, true);
    assert.match(foreignRepostDel.content[0].text, /not the authenticated user/);

    const okUnrepostByPost: any = await client.callTool({
      name: "unrepost",
      arguments: { postUri: "at://did:plc:bob/app.bsky.feed.post/reposted-1" },
    });
    assert.equal(okUnrepostByPost.isError, undefined);
    assert.match(okUnrepostByPost.content[0].text, /Removed repost successfully/);
  } finally {
    await close();
  }
}

// -----------------------------------------------------------------------------
// Bounded Systematic Exploration (Seeded Generator + Independent Invariants)
// -----------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADVERSARIAL_STRINGS = [
  'Plain text post',
  'XML traps: <post> & </post> "attr" \'single\' <![CDATA[x]]>',
  'Control bytes: \x00\x07\x0B\x0C\x1B[31mred\x1B[0m & newline\nline 2',
  'URLs with query params: https://example.com/a?x=1&y=2#frag and @alice.bsky.social #tag',
  'Emoji graphemes: 👨‍👩‍👧‍👦 🏳️‍🌈 👍🏽 — "quoted"',
  '',
];

async function runSystematicPropertyExploration() {
  const SEED = 20261110;
  const rng = mulberry32(SEED);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  const xmlBatchToVerify: Array<{ label: string; xml: string }> = [];
  const FEED_CASES = 150;
  const THREAD_CASES = 80;

  for (let c = 0; c < FEED_CASES; c++) {
    const size = Math.floor(rng() * 28); // 0..27 items including empty boundary
    const items: any[] = [];
    const nonRepostUris = new Set<string>();
    const recordWithMediaUris = new Set<string>();
    let repostCount = 0;

    const poolUris: string[] = [];
    for (let i = 0; i < size; i++) {
      const isRepost = rng() < 0.22;
      const isDup = !isRepost && poolUris.length > 0 && rng() < 0.1;
      const uri = isDup
        ? pick(poolUris)
        : `at://did:plc:u${c % 5}/app.bsky.feed.post/p${c}_${i}`;

      if (!isRepost) {
        poolUris.push(uri);
        nonRepostUris.add(uri);
      }

      // Choose reply topology: standalone, parent in pool, foreign absent parent, or self-cycle attempt
      let parentUri: string | undefined;
      let rootUri: string | undefined;
      const replyRoll = rng();
      if (replyRoll < 0.35 && poolUris.length > 0) {
        parentUri = pick(poolUris); // May even pick self to test cycle guard!
        rootUri = poolUris[0];
      } else if (replyRoll < 0.6) {
        parentUri = `at://did:plc:external/app.bsky.feed.post/ext_${i}`;
        rootUri = rng() < 0.5 ? (poolUris[0] || parentUri) : `at://did:plc:external/app.bsky.feed.post/root_ext`;
      }

      // Choose embed variant
      const embedRoll = rng();
      let embed: any = undefined;
      if (embedRoll < 0.2) {
        embed = {
          $type: "app.bsky.embed.images#view",
          images: [{ fullsize: "https://cdn.bsky.app/img/a.jpg?x=1&y=2", thumb: "", alt: pick(ADVERSARIAL_STRINGS) }],
        };
      } else if (embedRoll < 0.35) {
        embed = {
          $type: "app.bsky.embed.external#view",
          external: {
            uri: "https://example.org/story?a=1&b=2",
            title: pick(ADVERSARIAL_STRINGS),
            description: pick(ADVERSARIAL_STRINGS),
          },
        };
      } else if (embedRoll < 0.5) {
        embed = {
          $type: "app.bsky.embed.record#view",
          record:
            rng() < 0.7
              ? {
                  $type: "app.bsky.embed.record#viewRecord",
                  uri: `at://did:plc:q/app.bsky.feed.post/q_${i}`,
                  cid: "cid-q",
                  author: { did: "did:plc:q", handle: "q.test", displayName: pick(ADVERSARIAL_STRINGS) },
                  value: { text: pick(ADVERSARIAL_STRINGS), createdAt: "2026-11-10T12:00:00.000Z" },
                }
              : {
                  $type: "app.bsky.embed.record#viewNotFound",
                  uri: `at://did:plc:q/app.bsky.feed.post/deleted_${i}`,
                  notFound: true,
                },
        };
      } else if (embedRoll < 0.7) {
        if (!isRepost && !isDup) recordWithMediaUris.add(uri);
        embed = {
          $type: "app.bsky.embed.recordWithMedia#view",
          record: {
            $type: "app.bsky.embed.record#view",
            record: {
              $type: "app.bsky.embed.record#viewRecord",
              uri: `at://did:plc:q/app.bsky.feed.post/qwm_${i}`,
              cid: "cid-qwm",
              author: { did: "did:plc:q", handle: "qwm.test", displayName: pick(ADVERSARIAL_STRINGS) },
              value: { text: pick(ADVERSARIAL_STRINGS), createdAt: "2026-11-10T12:00:00.000Z" },
            },
          },
          media: {
            $type: "app.bsky.embed.images#view",
            images: [{ fullsize: "https://cdn.bsky.app/img/rwm.jpg", thumb: "", alt: pick(ADVERSARIAL_STRINGS) }],
          },
        };
      }

      const post = makePostView({
        uri,
        text: pick(ADVERSARIAL_STRINGS),
        displayName: pick(ADVERSARIAL_STRINGS),
        replyParentUri: parentUri,
        replyRootUri: rootUri,
        embed,
        createdAt: new Date(1762790000000 + i * 15000).toISOString(),
        indexedAt: new Date(1762790000000 + i * 15000 + (rng() < 0.3 ? 120000 : 2000)).toISOString(),
      });

      if (isRepost) {
        repostCount += 1;
        items.push({
          post,
          reason: {
            $type: "app.bsky.feed.defs#reasonRepost",
            by: { did: "did:plc:rp", handle: "reposter.test", displayName: pick(ADVERSARIAL_STRINGS) },
            indexedAt: "2026-11-10T19:00:00.000Z",
          },
        });
      } else {
        items.push({ post });
      }
    }

    const xmlWithReposts = preprocessPosts(items, { detail: "full", includeReposts: true });
    const xmlNoReposts = preprocessPosts(items, { detail: "full", includeReposts: false });
    const compactNoReposts = preprocessPosts(items, { detail: "compact", includeReposts: false });

    xmlBatchToVerify.push({ label: `feed-${c}-with-reposts`, xml: xmlWithReposts });
    xmlBatchToVerify.push({ label: `feed-${c}-no-reposts`, xml: xmlNoReposts });

    // Invariant 1: Exact repost count
    const emittedReposts = (xmlWithReposts.match(/<repost\b/g) || []).length;
    assert.equal(emittedReposts, repostCount, `feed-${c}: repost count mismatch`);
    assert.equal((xmlNoReposts.match(/<repost\b/g) || []).length, 0, `feed-${c}: includeReposts=false leaked repost`);

    // Invariant 2: Exact set equality & multiplicity=1 for all non-repost post URIs
    const nonRepostPostMatches = [...xmlNoReposts.matchAll(/<post\b[^>]*\buri="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(
      nonRepostPostMatches.length,
      nonRepostUris.size,
      `feed-${c}: expected ${nonRepostUris.size} unique posts, got ${nonRepostPostMatches.length}`
    );
    assert.deepEqual([...nonRepostPostMatches].sort(), [...nonRepostUris].sort());

    for (const u of nonRepostUris) {
      assert.ok(compactNoReposts.includes(u), `feed-${c}: compact output lost ${u}`);
    }

    // Invariant 3: Every recordWithMedia post preserves quote AND media
    if (recordWithMediaUris.size > 0) {
      assert.match(xmlNoReposts, /<quoted_post\b/);
      assert.match(xmlNoReposts, /<embed type="image">/);
      assert.match(compactNoReposts, /quote: /);
      assert.match(compactNoReposts, /media: \[image\]/);
    }
  }

  for (let t = 0; t < THREAD_CASES; t++) {
    const ancestorCount = Math.floor(rng() * 5);
    const replyCount = Math.floor(rng() * 6);
    const targetUri = `at://did:plc:target/app.bsky.feed.post/target_${t}`;

    let parentChain: any = undefined;
    for (let a = 0; a < ancestorCount; a++) {
      const aUri = `at://did:plc:anc/app.bsky.feed.post/anc_${t}_${a}`;
      const statusRoll = rng();
      if (statusRoll < 0.25) {
        parentChain = { $type: "app.bsky.feed.defs#notFoundPost", uri: aUri, notFound: true, parent: parentChain };
      } else if (statusRoll < 0.45) {
        parentChain = { $type: "app.bsky.feed.defs#blockedPost", uri: aUri, blocked: true, parent: parentChain };
      } else {
        parentChain = {
          $type: "app.bsky.feed.defs#threadViewPost",
          post: makePostView({ uri: aUri, text: pick(ADVERSARIAL_STRINGS), displayName: pick(ADVERSARIAL_STRINGS) }),
          parent: parentChain,
        };
      }
    }

    const replies: any[] = [];
    for (let r = 0; r < replyCount; r++) {
      const rUri = `at://did:plc:rep/app.bsky.feed.post/rep_${t}_${r}`;
      const rRoll = rng();
      if (rRoll < 0.2) {
        replies.push({ $type: "app.bsky.feed.defs#notFoundPost", uri: rUri, notFound: true });
      } else {
        replies.push({
          $type: "app.bsky.feed.defs#threadViewPost",
          post: makePostView({ uri: rUri, text: pick(ADVERSARIAL_STRINGS), replyParentUri: targetUri }),
        });
      }
    }

    const thread = {
      $type: "app.bsky.feed.defs#threadViewPost",
      post: makePostView({ uri: targetUri, text: pick(ADVERSARIAL_STRINGS), displayName: pick(ADVERSARIAL_STRINGS) }),
      parent: parentChain,
      replies,
    };

    const maxReplies = rng() < 0.5 ? 2 : undefined;
    const threadXml = formatPostThread(thread, { detail: "full", maxRepliesPerNode: maxReplies });
    const threadCompact = formatPostThread(thread, { detail: "compact", maxRepliesPerNode: maxReplies });

    xmlBatchToVerify.push({ label: `thread-${t}`, xml: threadXml });

    // Invariant 4: Target post always survives regardless of deleted/blocked ancestors
    assert.ok(threadXml.includes(`uri="${targetUri}"`) && threadXml.includes(`requested="true"`));
    assert.ok(threadCompact.includes(targetUri) && threadCompact.includes(`[REQUESTED]`));
  }

  verifyXmlDocumentsWithPython(xmlBatchToVerify);
  console.log(
    `ok - systematic exploration passed (seed=${SEED}: ${FEED_CASES} generated feeds + ${THREAD_CASES} generated threads, ${xmlBatchToVerify.length} XML docs verified with Python ElementTree)`
  );
}

async function main() {
  const suites: Array<[string, () => Promise<void>]> = [
    ["R1: deep orphaned replies & multi-sibling nested XML slice regression", testRegressionR1DeepOrphanedRepliesAndMultiSiblingXml],
    ["R2: recordWithMedia (quote + images) & deleted quote status stubs", testRegressionR2RecordWithMediaAndDeletedQuoteStubs],
    ["R3: deleted/blocked thread ancestors preserve requested target post", testRegressionR3DeletedAncestorInThreadPreservesRequestedPost],
    ["R4: repost of old post does not prematurely abort hours-window pagination", testRegressionR4OldRepostDoesNotAbortHoursPagination],
    ["R5: create-post & create-thread grapheme count, fail-closed quoteUri, and atomic pre-flight", testRegressionR5CreatePostAndCreateThreadContracts],
    ["R6: did:web:, did:plc: web URLs, and like/unlike/repost/unrepost validation", testRegressionR6LikeUnlikeRepostUnrepostAndUrlVariants],
    ["Systematic seeded exploration (150 feed graphs + 80 thread trees + XML oracle)", runSystematicPropertyExploration],
  ];

  let failed = 0;
  for (const [name, fn] of suites) {
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
    console.error(`\n${failed} / ${suites.length} regression suite(s) failed`);
    process.exit(1);
  }
  console.log(`\n${suites.length} / ${suites.length} regression & exploration suite(s) passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
