import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Agent, RichText } from "@atproto/api";
import {
  cleanHandle,
  formatSummaryText,
  getFeedNameFromId,
  validateUri,
  convertBskyUrlToAtUri,
  extractFirstUrl,
  mcpErrorResponse,
  mcpSuccessResponse,
} from './utils.js';
import { preprocessPosts, formatPostThread } from "./llm-preprocessor.js";
import { resourcesList } from './resources.js';
import { fetchLinkMetadata, uploadThumbnail } from './link-preview.js';

export type AgentProvider = () => Agent | null;

/**
 * Register all Bluesky MCP tools on the provided server.
 * `getAgent` returns the currently authenticated AtpAgent for this session,
 * or null if the caller is not authenticated. It is evaluated per tool call
 * so OAuth-backed sessions can rotate credentials between invocations.
 */
export function registerTools(server: McpServer, getAgent: AgentProvider): void {
  server.tool(
    'get-my-handle-and-did',
    'Return the handle and did of the currently authenticated user for this blusesky session. Useful for when someone asks information about themselves using "me" or "my" on bluesky.',
    {},
    async () => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }
      if (!agent.did) {
        return mcpErrorResponse("Not authenticated.");
      }
      try {
        const profile = await agent.getProfile({ actor: agent.did });
        return mcpSuccessResponse(`Your handle is: ${profile.data.handle}\nYour did is: ${agent.did}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching profile: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );


  server.tool(
    "get-timeline-posts",
    "Fetch your home timeline from Bluesky, which includes posts from all of the people you follow in reverse chronological order",
    {
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back")
    },
    async ({ count, type }) => {
      try {
        const agent = getAgent();
        if (!agent) {
          return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
        }

        const MAX_TOTAL_POSTS = 500; // Safety limit to prevent excessive API calls

        let allPosts: any[] = [];
        let nextCursor: string | undefined = undefined;
        let shouldContinueFetching = true;

        // Set up time-based or count-based fetching
        const useHoursLimit = type === "hours";
        const targetHours = count;
        const targetDate = new Date(Date.now() - targetHours * 60 * 60 * 1000);

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          // Calculate how many posts to fetch in this batch
          const batchLimit = 100;

          const response = await agent.getTimeline({
            limit: batchLimit,
            cursor: nextCursor
          });

          if (!response.success) {
            break;
          }

          const { feed, cursor } = response.data;

          // Filter posts based on time window if using hours limit
          let filteredFeed = feed;
          if (useHoursLimit) {
            filteredFeed = feed.filter(post => {
              const createdAt = post?.post?.record?.createdAt;
              if (!createdAt || typeof createdAt !== 'string') return false;
              const postDate = new Date(createdAt);
              return postDate >= targetDate;
            });
          }

          // Add the filtered posts to our collection
          allPosts = allPosts.concat(filteredFeed);

          // Update cursor for the next batch
          nextCursor = cursor;

          // Check if we should continue fetching based on the mode
          if (useHoursLimit) {
            // Check if we've reached posts older than our target date
            const oldestPost = feed[feed.length - 1];
            if (oldestPost?.post?.record?.createdAt && typeof oldestPost.post.record.createdAt === 'string') {
              const postDate = new Date(oldestPost.post.record.createdAt);
              if (postDate < targetDate) {
                shouldContinueFetching = false;
              }
            }
          } else {
            // If we're using count-based fetching, stop when we have enough posts
            shouldContinueFetching = allPosts.length < count;
          }

          // Stop if we don't have a cursor for the next page
          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        // If we're using count-based fetching, limit the posts to the requested count
        const finalPosts = !useHoursLimit
          ? allPosts.slice(0, count)
          : allPosts;

        if (finalPosts.length === 0) {
          return mcpSuccessResponse("Your timeline is empty.");
        }

        // Format the posts
        const timelineData = preprocessPosts(finalPosts);

        const summaryText = formatSummaryText(finalPosts.length, "timeline");

        return mcpSuccessResponse(`${summaryText}\n\n${timelineData}`);

      } catch (error) {
        return mcpErrorResponse(`Error fetching timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-notifications",
    "Fetch your notifications from Bluesky, optionally filtered by type (reply, mention, like, repost, follow, quote)",
    {
      limit: z.number().min(1).max(500).default(50).describe("Number of notifications to fetch (1-500)"),
      reasons: z.array(z.enum([
        "like",
        "repost",
        "follow",
        "mention",
        "reply",
        "quote",
        "starterpack-joined"
      ])).optional().describe("Filter by notification types (e.g., ['reply', 'mention']). If not provided, returns all types."),
      replyFilter: z.enum(["all", "responded", "unresponded"]).optional().default("all").describe("Filter reply notifications by response status. 'responded' shows only replies you've responded to, 'unresponded' shows only replies you haven't responded to. This filter only applies to notifications with reason 'reply'."),
      authorFilter: z.string().optional().describe("Filter notifications by the handle or DID of the user who triggered them (e.g., 'alice.bsky.social').")
    },
    async ({ limit, reasons, replyFilter, authorFilter }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const MAX_NOTIFICATIONS = 500; // Safety limit
        let matchedNotifications: any[] = [];
        let nextCursor: string | undefined = undefined;
        let shouldContinueFetching = true;

        const targetAuthor = authorFilter ? (authorFilter.startsWith('@') ? authorFilter.substring(1) : authorFilter) : null;

        // If filtering by response status, we need our own recent replies to compare
        let repliedToUris = new Set<string>();
        if (replyFilter !== "all") {
          const myDid = agent.did;
          if (!myDid) {
            return mcpErrorResponse("Could not determine your DID. Are you authenticated?");
          }

          // Fetch last 100 posts to see what we've replied to
          // We use posts_with_replies to see where we've engaged
          const myFeed = await agent.app.bsky.feed.getAuthorFeed({
            actor: myDid,
            limit: 100,
            filter: 'posts_with_replies'
          });

          if (myFeed.success) {
            for (const item of myFeed.data.feed) {
              if (item.reply?.parent && 
                  item.reply.parent.$type === 'app.bsky.feed.defs#postView' && 
                  'uri' in item.reply.parent) {
                repliedToUris.add((item.reply.parent as any).uri);
              }
            }
          }
        }

        // If replyFilter is set but no reasons provided, default to 'reply'
        const effectiveReasons = (replyFilter !== "all" && (!reasons || reasons.length === 0)) ? ["reply"] : reasons;

        while (shouldContinueFetching && matchedNotifications.length < limit && matchedNotifications.length < MAX_NOTIFICATIONS) {
          // Fetch batches until we have enough matches
          const response = await agent.app.bsky.notification.listNotifications({
            limit: Math.max(50, Math.min(100, limit - matchedNotifications.length + 10)),
            cursor: nextCursor,
            reasons: effectiveReasons
          });

          if (!response.success) {
            break;
          }

          const { notifications, cursor } = response.data;
          
          // Apply filters
          const filtered = notifications.filter(notif => {
            // Apply author filter if provided
            if (targetAuthor) {
              if (notif.author.handle !== targetAuthor && notif.author.did !== targetAuthor) {
                return false;
              }
            }

            // If it's not a reply, only keep it if we're not filtering replies
            // or if this reason was specifically requested in the original reasons
            if (notif.reason !== 'reply') {
              return replyFilter === 'all' || (reasons && reasons.includes(notif.reason as any));
            }
            
            // It's a reply, so apply the reply status filter
            if (replyFilter === 'all') return true;
            const isResponded = repliedToUris.has(notif.uri);
            return replyFilter === 'responded' ? isResponded : !isResponded;
          });

          matchedNotifications = matchedNotifications.concat(filtered);
          nextCursor = cursor;

          // Stop if we have enough or no more results
          shouldContinueFetching = matchedNotifications.length < limit && !!cursor;
        }

        // Limit to requested count
        const finalNotifications = matchedNotifications.slice(0, limit);

        if (finalNotifications.length === 0) {
          const filterDesc = reasons ? ` with filter: ${reasons.join(', ')}` : '';
          const replyDesc = replyFilter !== 'all' ? ` and reply status: ${replyFilter}` : '';
          const authorDesc = authorFilter ? ` and author: ${authorFilter}` : '';
          return mcpSuccessResponse(`No notifications found${filterDesc}${replyDesc}${authorDesc}.`);
        }

        // Format notifications output
        let output = `Retrieved ${finalNotifications.length} notification(s):\n\n`;

        for (const notif of finalNotifications) {
          const displayName = notif.author.displayName || notif.author.handle;
          let statusLabel = `[${notif.reason.toUpperCase()}]`;
          
          if (notif.reason === 'reply' && replyFilter !== 'all') {
            statusLabel += ` [${repliedToUris.has(notif.uri) ? 'RESPONDED' : 'UNRESPONDED'}]`;
          }
          
          output += `${statusLabel} ${displayName} (@${notif.author.handle})\n`;
          output += `  URI: ${notif.uri}\n`;
          output += `  Time: ${notif.indexedAt}\n`;
          output += `  Read: ${notif.isRead}\n`;
          if (notif.reasonSubject) {
            output += `  Subject: ${notif.reasonSubject}\n`;
          }
          output += `\n`;
        }

        return mcpSuccessResponse(output);
      } catch (error) {
        return mcpErrorResponse(`Error fetching notifications: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "create-post",
    "Create a new post on Bluesky",
    {
      text: z.string().max(300).describe("The content of your post"),
      replyTo: z.string().optional().describe("Optional URI of post to reply to"),
      previewUrl: z.string().url().optional().describe("Optional URL to generate preview card for. If not provided, uses first URL detected in text."),
      embedPreview: z.boolean().optional().default(true).describe("Whether to fetch and attach a link preview card. Defaults to true."),
    },
    async ({ text, replyTo, previewUrl, embedPreview = true }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // Detect facets (mentions, links, hashtags) from the post text.
        const rt = new RichText({ text });
        await rt.detectFacets(agent);

        const record: any = {
          text: rt.text,
          createdAt: new Date().toISOString(),
        };

        if (rt.facets && rt.facets.length > 0) {
          record.facets = rt.facets;
        }

        let replyRef;
        if (replyTo) {
          // Handle reply format
          try {
            const parts = replyTo.split('/');
            const did = parts[2];
            const rkey = parts[parts.length - 1];
            const collection = parts[parts.length - 2] === 'app.bsky.feed.post' ? 'app.bsky.feed.post' : parts[parts.length - 2];

            // Resolve the CID of the post we're replying to
            const cidResponse = await agent.app.bsky.feed.getPostThread({ uri: replyTo });
            if (!cidResponse.success) {
              throw new Error('Could not get post information');
            }

            const threadPost = cidResponse.data.thread as any;
            const parentPost = threadPost.post;
            const parentCid = parentPost.cid;
            const parentRecord = parentPost.record;

            // Determine the root — if parent is a reply, use its root;
            // otherwise the parent IS the root. Setting both to the parent
            // when replying to a nested reply breaks thread rendering in
            // the Bluesky web UI.
            let rootUri: string;
            let rootCid: string;
            if (parentRecord.reply) {
              rootUri = parentRecord.reply.root.uri;
              rootCid = parentRecord.reply.root.cid;
            } else {
              rootUri = replyTo;
              rootCid = parentCid;
            }

            record.reply = {
              parent: { uri: replyTo, cid: parentCid },
              root: { uri: rootUri, cid: rootCid }
            };

          } catch (error) {
            return mcpErrorResponse(`Error parsing reply URI: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Generate link preview embed if enabled.
        if (embedPreview) {
          const urlToPreview = previewUrl || extractFirstUrl(text);
          if (urlToPreview) {
            const metadata = await fetchLinkMetadata(urlToPreview);
            if (metadata) {
              const externalEmbed: any = {
                $type: 'app.bsky.embed.external',
                external: {
                  uri: metadata.url,
                  title: metadata.title,
                  description: metadata.description,
                },
              };

              if (metadata.imageUrl) {
                const thumbBlob = await uploadThumbnail(agent, metadata.imageUrl);
                if (thumbBlob) {
                  externalEmbed.external.thumb = thumbBlob;
                }
              }

              record.embed = externalEmbed;
            }
          }
        }

        const response = await agent.post(record);

        return mcpSuccessResponse(`Post created successfully! URI: ${response.uri}`);
      } catch (error) {
        return mcpErrorResponse(`Error creating post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-profile",
    "Get a user's profile from Bluesky",
    {
      handle: z.string().describe("The handle of the user (e.g., alice.bsky.social)"),
    },
    async ({ handle }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.getProfile({ actor: cleanHandle(handle) });

        if (!response.success) {
          return mcpErrorResponse(`Failed to get profile for ${handle}.`);
        }

        const profile = response.data;

        let profileText = `Profile for ${profile.displayName || handle} (@${profile.handle})
DID: ${profile.did}
${profile.description ? `Bio: ${profile.description}` : ''}
Followers: ${profile.followersCount || 0}
Following: ${profile.followsCount || 0}
Posts: ${profile.postsCount || 0}
${profile.labels?.length ? `Labels: ${profile.labels.map((l: any) => l.val).join(', ')}` : ''}`;

        return mcpSuccessResponse(profileText);
      } catch (error) {
        return mcpErrorResponse(`Error fetching profile: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "search-posts",
    "Search for posts on Bluesky. Note: Bluesky uses strict AND matching - all search terms must be present in a post for it to match. This differs from web search engines which use loose/fuzzy matching. Searching for 'a b c' requires ALL of a, b, AND c to appear in matching posts. Supported operators: from:handle, to:handle, mentions:handle, url:domain, lang:code (e.g., lang:en), has:images, has:video, has:link.",
    {
      query: z.string().describe("Search query. Uses strict AND matching - all terms must match. Supported operators: from:, to:, mentions:, url:, lang:, has:images, has:video, has:link"),
      limit: z.number().min(1).max(100).default(50).describe("Number of results to fetch (1-100)"),
      sort: z.enum(["top", "latest"]).default("top").describe("Sort order for search results - 'top' for most relevant or 'latest' for most recent"),
    },
    async ({ query, limit, sort }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.app.bsky.feed.searchPosts({ q: query, limit, sort });

        if (!response.success) {
          return mcpErrorResponse("Failed to search posts.");
        }

        const { posts } = response.data;

        if (posts.length === 0) {
          return mcpSuccessResponse(`No results found for query: "${query}"`);
        }

        // Transform search posts to FeedViewPost format
        const feedViewPosts = posts.map(post => ({
          post: post,
          reply: undefined,
          reason: undefined
        }));

        // Format the search results using preprocessPosts
        const formattedPosts = preprocessPosts(feedViewPosts);

        // Add summary information
        const summaryText = formatSummaryText(posts.length, "search results");

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error searching posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-post-thread",
    "Get a full conversation thread for a specific post, showing replies and context",
    {
      uri: z.string().describe("URI of the post to fetch the thread for (e.g., at://did:plc:abcdef/app.bsky.feed.post/123)"),
    },
    async ({ uri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        // Validate the URI format
        if (!uri.startsWith('at://did:plc:') || !uri.includes('/app.bsky.feed.post/')) {
          return mcpErrorResponse("Invalid post URI format. Expected format: at://did:plc:abcdef/app.bsky.feed.post/123");
        }

        const response = await agent.app.bsky.feed.getPostThread({
          uri,
          depth: 100,
          parentHeight: 100
        });

        if (!response.success) {
          return mcpErrorResponse("Failed to fetch post thread.");
        }

        // Process the thread structure and format it according to POST_FORMAT_SPEC
        const threadData = formatPostThread(response.data.thread);

        return mcpSuccessResponse(threadData);
      } catch (error) {
        return mcpErrorResponse(`Error fetching post thread: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "convert-url-to-uri",
    "Convert a Bluesky web URL to an AT URI format that can be used with other tools",
    {
      url: z.string().describe("Bluesky post URL to convert (e.g., https://bsky.app/profile/username.bsky.social/post/postid)")
    },
    async ({ url }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const atUri = await convertBskyUrlToAtUri(url, agent);

        if (!atUri) {
          return mcpErrorResponse(`Failed to convert URL: ${url}. Make sure it's a valid Bluesky post URL.`);
        }

        return mcpSuccessResponse(`Successfully converted to AT URI: ${atUri}`);
      } catch (error) {
        return mcpErrorResponse(`Error converting URL: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "search-people",
    "Search for users/actors on Bluesky",
    {
      query: z.string().describe("Search query for finding users"),
      limit: z.number().min(1).max(100).default(20).describe("Number of results to fetch (1-100)"),
    },
    async ({ query, limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.app.bsky.actor.searchActors({ q: query, limit });

        if (!response.success) {
          return mcpErrorResponse("Failed to search for users.");
        }

        const { actors } = response.data;

        if (actors.length === 0) {
          return mcpSuccessResponse(`No users found for query: "${query}"`);
        }

        const results = actors.map((actor: any, index: number) => {
          return `User #${index + 1}:
Display Name: ${actor.displayName || 'No display name'}
Handle: @${actor.handle}
DID: ${actor.did}
${actor.description ? `Bio: ${actor.description}` : 'Bio: No bio provided'}
${actor.followersCount !== undefined ? `Followers: ${actor.followersCount}` : ''}
${actor.followsCount !== undefined ? `Following: ${actor.followsCount}` : ''}
${actor.postsCount !== undefined ? `Posts: ${actor.postsCount}` : ''}
${actor.indexedAt ? `Indexed At: ${new Date(actor.indexedAt).toLocaleString()}` : ''}
---`;
        }).join("\n\n");

        return mcpSuccessResponse(results);
      } catch (error) {
        return mcpErrorResponse(`Error searching for users: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "search-feeds",
    "Search for custom feeds on Bluesky",
    {
      query: z.string().describe("Search query for finding feeds"),
      limit: z.number().min(1).max(100).default(10).describe("Number of results to fetch (1-100)"),
    },
    async ({ query, limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.api.app.bsky.unspecced.getPopularFeedGenerators({
          query,
          limit
        });

        if (!response.success) {
          return mcpErrorResponse("Failed to search for feeds.");
        }

        const { feeds } = response.data;

        if (!feeds || feeds.length === 0) {
          return mcpSuccessResponse(`No feeds found for query: "${query}"`);
        }

        const results = feeds.map((feed: any, index: number) => {
          return `Feed #${index + 1}:
Name: ${feed.displayName || 'Unnamed Feed'}
URI: ${feed.uri}
${feed.description ? `Description: ${feed.description}` : ''}
Creator: @${feed.creator.handle} ${feed.creator.displayName ? `(${feed.creator.displayName})` : ''}
Likes: ${feed.likeCount || 0}
${feed.indexedAt ? `Indexed At: ${new Date(feed.indexedAt).toLocaleString()}` : ''}
---`;
        }).join("\n\n");

        return mcpSuccessResponse(results);
      } catch (error) {
        return mcpErrorResponse(`Error searching for feeds: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-liked-posts",
    "Get a list of posts that the authenticated user has liked",
    {
      limit: z.number().min(1).max(100).default(50).describe("Maximum number of liked posts to fetch (1-100)"),
    },
    async ({ limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        // We can only get likes for the authenticated user
        if (!agent.did) {
          return mcpErrorResponse("Not properly authenticated. Please check your credentials.");
        }

        const authenticatedUser = agent.did;

        // Now fetch the authenticated user's likes with pagination
        const MAX_BATCH_SIZE = 100; // Maximum number of likes per API call
        const MAX_BATCHES = 5;      // Maximum number of API calls to make (100 x 5 = 500)
        let allLikes: any[] = [];
        let nextCursor: string | undefined = undefined;
        let batchCount = 0;

        // Loop to fetch likes with pagination
        while (batchCount < MAX_BATCHES && allLikes.length < limit) {
          // Calculate how many likes to fetch in this batch
          const batchLimit = Math.min(MAX_BATCH_SIZE, limit - allLikes.length);

          // Make the API call with cursor if we have one
          const response = await agent.app.bsky.feed.getActorLikes({
            actor: authenticatedUser,
            limit: batchLimit,
            cursor: nextCursor || undefined
          });

          if (!response.success) {
            // If we've already fetched some likes, return those
            if (allLikes.length > 0) {
              break;
            }
            return mcpErrorResponse(`Failed to fetch your likes.`);
          }

          const { feed, cursor } = response.data;

          // Add the fetched likes to our collection
          allLikes = allLikes.concat(feed);

          // Update cursor for the next batch
          nextCursor = cursor;
          batchCount++;

          // If no cursor returned or we've reached our limit, stop paginating
          if (!cursor || allLikes.length >= limit) {
            break;
          }
        }

        if (allLikes.length === 0) {
          return mcpSuccessResponse(`You haven't liked any posts.`);
        }

        // Format the likes list using preprocessPosts
        const formattedLikes = preprocessPosts(allLikes);

        // Create a summary
        const summaryText = formatSummaryText(allLikes.length, "liked posts");

        return mcpSuccessResponse(`${summaryText}\n\n${formattedLikes}`);

      } catch (error) {
        return mcpErrorResponse(`Error fetching likes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-trends",
    "Get current trending topics on Bluesky",
    {
      limit: z.number().min(1).max(50).default(10).describe("Number of trending topics to fetch (1-50)"),
      includeSuggested: z.boolean().default(false).describe("Whether to include suggested topics in addition to trending topics"),
    },
    async ({ limit, includeSuggested }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // Call the unspecced API endpoint for trending topics
        const response = await agent.api.app.bsky.unspecced.getTrendingTopics({
          limit: Math.min(50, limit) // API accepts up to 50 per call
        });

        if (!response.success) {
          return mcpErrorResponse("Failed to fetch trending topics.");
        }

        const { topics, suggested } = response.data;

        if (!topics || topics.length === 0) {
          return mcpSuccessResponse("No trending topics found at this time.");
        }

        // Format trending topics
        const formattedTopics = topics.map((topic: any, index: number) => {
          const startTime = new Date(topic.startTime).toLocaleString();
          return `#${index + 1}: ${topic.topic}
Post Count: ${topic.postCount} posts
Started Trending: ${startTime}
Feed Link: https://bsky.app${topic.link}
---`;
        }).join("\n\n");

        // Format suggested topics if requested
        let suggestedContent = "";
        if (includeSuggested && suggested && suggested.length > 0) {
          const formattedSuggested = suggested.map((topic: any, index: number) => {
            return `#${index + 1}: ${topic.topic}
Feed Link: https://bsky.app${topic.link}
---`;
          }).join("\n\n");

          suggestedContent = `\n\n## Suggested Topics for Exploration\n\n${formattedSuggested}`;
        }

        return mcpSuccessResponse(`## Current Trending Topics on Bluesky\n\n${formattedTopics}${suggestedContent}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching trending topics: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "like-post",
    "Like a post on Bluesky",
    {
      uri: z.string().describe("The URI of the post to like"),
    },
    async ({ uri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        // First, we need to get the CID of the post
        const parts = uri.split('/');
        const repo = parts[2]; // The DID
        const collection = parts[4]; // Usually app.bsky.feed.post
        const rkey = parts[5]; // The record key

        const response = await agent.app.bsky.feed.getPostThread({ uri });

        if (!response.success || response.data.thread.$type !== 'app.bsky.feed.defs#threadViewPost') {
          return mcpErrorResponse("Failed to get post information.");
        }

        // Type assertion to tell TypeScript this is a post
        const threadPost = response.data.thread as any;
        const post = threadPost.post;
        const cid = post.cid;

        await agent.like(uri, cid);

        return mcpSuccessResponse("Post liked successfully!");
      } catch (error) {
        return mcpErrorResponse(`Error liking post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "follow-user",
    "Follow a user on Bluesky",
    {
      handle: z.string().describe("The handle of the user to follow"),
    },
    async ({ handle }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        // Resolve the handle to a DID
        const resolveResponse = await agent.resolveHandle({ handle: cleanHandle(handle) });

        if (!resolveResponse.success) {
          return mcpErrorResponse(`Failed to resolve handle: ${handle}`);
        }

        const did = resolveResponse.data.did;
        await agent.follow(did);

        return mcpSuccessResponse(`Successfully followed @${handle}`);
      } catch (error) {
        return mcpErrorResponse(`Error following user: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "unfollow-user",
    "Remove an existing follow from the authenticated user's Bluesky account. Pass followUri (preferred — the at:// URI of your follow record, as returned by get-follows for self) for a direct delete with no extra round trips. If you only have a handle or DID, pass user instead and the tool will scan your follow records to find the matching rkey before deleting.",
    {
      followUri: z.string().optional().describe("The at:// URI of YOUR follow record to delete (e.g., at://did:plc:you/app.bsky.graph.follow/3kabc...). Returned by get-follows for the self path. Mutually exclusive with `user`."),
      user: z.string().optional().describe("The handle or DID of the followee. Used when you don't already have the follow record URI; the tool will list your follow records to find the matching rkey. Mutually exclusive with `followUri`."),
    },
    async ({ followUri, user }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }
      if (!agent.did) {
        return mcpErrorResponse("Not authenticated.");
      }
      if (!followUri && !user) {
        return mcpErrorResponse("Provide either followUri or user.");
      }
      if (followUri && user) {
        return mcpErrorResponse("Provide only one of followUri or user, not both.");
      }

      try {
        let uriToDelete = followUri;
        let label = followUri ?? '';

        if (!uriToDelete) {
          // Look up the rkey by scanning the authenticated user's follow
          // records for one whose subject matches the requested followee.
          // Costs one listRecords page (100 records) per ~100 follows the
          // user has; if you already have the URI, prefer that path.
          const profileRes = await agent.getProfile({ actor: cleanHandle(user!) });
          if (!profileRes.success) {
            return mcpErrorResponse(`User not found: ${user}`);
          }
          const targetDid = profileRes.data.did;
          if (targetDid === agent.did) {
            return mcpErrorResponse("You can't unfollow yourself.");
          }

          let cursor: string | undefined;
          let foundUri: string | undefined;
          while (!foundUri) {
            const res = await agent.com.atproto.repo.listRecords({
              repo: agent.did,
              collection: 'app.bsky.graph.follow',
              limit: 100,
              cursor,
            });
            if (!res.success) break;
            for (const r of res.data.records) {
              const subject = (r.value as { subject?: unknown })?.subject;
              if (subject === targetDid) {
                foundUri = r.uri;
                break;
              }
            }
            cursor = res.data.cursor;
            if (!cursor || res.data.records.length === 0) break;
          }
          if (!foundUri) {
            return mcpSuccessResponse(`You are not currently following @${user} (${targetDid}); nothing to unfollow.`);
          }
          uriToDelete = foundUri;
          label = `@${profileRes.data.handle} (${targetDid})`;
        } else {
          // Sanity-check that the URI is one of the authenticated user's
          // own follow records. The server would reject foreign URIs, but
          // a clear local error is friendlier than a 4xx surface.
          const parts = uriToDelete.split('/');
          // at://{repo}/{collection}/{rkey} → ['at:', '', repo, collection, rkey]
          const repo = parts[2];
          const collection = parts[3];
          if (repo !== agent.did) {
            return mcpErrorResponse(`followUri belongs to ${repo}, not the authenticated user (${agent.did}). You can only delete your own follow records.`);
          }
          if (collection !== 'app.bsky.graph.follow') {
            return mcpErrorResponse(`followUri is a ${collection} record, not app.bsky.graph.follow.`);
          }
        }

        await agent.deleteFollow(uriToDelete);
        return mcpSuccessResponse(`Unfollowed ${label || uriToDelete}.`);
      } catch (error) {
        return mcpErrorResponse(`Error unfollowing user: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-pinned-feeds",
    "Get the authenticated user's pinned feeds and lists.",
    {},
    async () => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // Get user preferences which include pinned feeds
        const response = await agent.app.bsky.actor.getPreferences();

        if (!response.success) {
          return mcpErrorResponse("Failed to get user preferences.");
        }

        // Find the savedFeedsPrefV2 in preferences
        const savedFeedsPref = response.data.preferences.find((pref: any) =>
          pref.$type === 'app.bsky.actor.defs#savedFeedsPrefV2'
        ) as { $type: string, items: Array<{ id: string, pinned: boolean, type: string, value: string }> } | undefined;

        if (!savedFeedsPref || !savedFeedsPref.items) {
          return mcpSuccessResponse("No saved feeds found in user preferences.");
        }

        // Get the pinned feeds
        const pinnedFeeds = savedFeedsPref.items.filter((item: any) => item.pinned);

        if (pinnedFeeds.length === 0) {
          return mcpSuccessResponse("You don't have any pinned feeds.");
        }

        // Get additional details for each feed
        const feedDetails = await Promise.all(
          pinnedFeeds.map(async (feed: any) => {
            try {
              // Custom feeds (regular feeds)
              if (feed.type === 'feed' && feed.value) {
                const feedInfo = await agent.app.bsky.feed.getFeedGenerator({
                  feed: feed.value
                });

                if (feedInfo?.success) {
                  return {
                    id: feed.id,
                    uri: feed.value,
                    name: feedInfo.data.view.displayName,
                    description: feedInfo.data.view.description || 'No description',
                    creator: `@${feedInfo.data.view.creator.handle}`,
                    type: 'Custom Feed'
                  };
                }
              }

              // Lists
              else if (feed.type === 'list' && feed.value) {
                const listInfo = await agent.app.bsky.graph.getList({
                  list: feed.value
                });

                if (listInfo?.success) {
                  const list = listInfo.data.list;
                  const memberCount = listInfo.data.items.length;

                  return {
                    id: feed.id,
                    uri: feed.value,
                    name: list.name,
                    description: list.description || 'No description',
                    creator: `@${list.creator.handle}`,
                    members: memberCount,
                    purpose: list.purpose === 'app.bsky.graph.defs#curatelist' ? 'Curated List' :
                            list.purpose === 'app.bsky.graph.defs#modlist' ? 'Moderation List' :
                            'Unknown Purpose',
                    type: 'List'
                  };
                }
              }

              // For built-in feeds or if feed generator info failed
              return {
                id: feed.id,
                uri: feed.value || 'N/A',
                name: getFeedNameFromId(feed.id),
                description: 'Built-in feed',
                creator: 'Bluesky',
                type: feed.type
              };
            } catch (error) {
              return {
                id: feed.id,
                uri: feed.value || 'N/A',
                name: getFeedNameFromId(feed.id),
                description: 'Error fetching details',
                type: feed.type
              };
            }
          })
        );

        const formattedFeeds = feedDetails.map((feed: any, index: number) => {
          // Common fields
          let output = `Feed #${index + 1}:
Name: ${feed.name}
Type: ${feed.type}
${feed.uri !== 'N/A' ? `URI: ${feed.uri}` : ''}
${feed.description ? `Description: ${feed.description}` : ''}
${feed.creator ? `Creator: ${feed.creator}` : ''}`;

          // List-specific fields
          if (feed.type === 'List') {
            output += `\n${feed.members !== undefined ? `Members: ${feed.members}` : ''}
${feed.purpose ? `Purpose: ${feed.purpose}` : ''}`;
          }

          output += '\n---';
          return output;
        }).join("\n\n");

        return mcpSuccessResponse(`Your Pinned Feeds:\n\n${formattedFeeds}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching pinned feeds: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-feed-posts",
    "Fetch posts from a specified feed",
    {
      feed: z.string().describe("The URI of the feed to fetch posts from (e.g., at://did:plc:abcdef/app.bsky.feed.generator/whats-hot)"),
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back")
    },
    async ({ feed, count, type }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // First, validate the feed by getting its info
        const feedInfo = await validateUri(agent, feed, 'feed');
        if (!feedInfo) {
          return mcpErrorResponse(`Invalid feed URI or feed not found: ${feed}.`);
        }

        const MAX_TOTAL_POSTS = 500; // Safety limit to prevent excessive API calls

        let allPosts: any[] = [];
        let nextCursor: string | undefined = undefined;
        let shouldContinueFetching = true;

        // Set up time-based or count-based fetching
        const useHoursLimit = type === "hours";
        const targetHours = count;
        const targetDate = new Date(Date.now() - targetHours * 60 * 60 * 1000);

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          // Calculate how many posts to fetch in this batch
          const batchLimit = 100;

          const response = await agent.app.bsky.feed.getFeed({
            feed,
            limit: batchLimit,
            cursor: nextCursor
          });

          if (!response.success) {
            break;
          }

          const { feed: feedPosts, cursor } = response.data;

          // Filter posts based on time window if using hours limit
          let filteredFeed = feedPosts;
          if (useHoursLimit) {
            filteredFeed = feedPosts.filter(post => {
              const createdAt = post?.post?.record?.createdAt;
              if (!createdAt || typeof createdAt !== 'string') return false;
              const postDate = new Date(createdAt);
              return postDate >= targetDate;
            });
          }

          // Add the filtered posts to our collection
          allPosts = allPosts.concat(filteredFeed);

          // Update cursor for the next batch
          nextCursor = cursor;

          // Check if we should continue fetching based on the mode
          if (useHoursLimit) {
            // Check if we've reached posts older than our target date
            const oldestPost = feedPosts[feedPosts.length - 1];
            if (oldestPost?.post?.record?.createdAt && typeof oldestPost.post.record.createdAt === 'string') {
              const postDate = new Date(oldestPost.post.record.createdAt);
              if (postDate < targetDate) {
                shouldContinueFetching = false;
              }
            }
          } else {
            // If we're using count-based fetching, stop when we have enough posts
            shouldContinueFetching = allPosts.length < count;
          }

          // Stop if we don't have a cursor for the next page
          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        // If we're using count-based fetching, limit the posts to the requested count
        const finalPosts = !useHoursLimit
          ? allPosts.slice(0, count)
          : allPosts;

        // If no posts were found after filtering
        if (finalPosts.length === 0) {
          return mcpSuccessResponse(`No posts found in the feed: ${feed}`);
        }

        // Format the posts
        const formattedPosts = preprocessPosts(finalPosts);

        // Add summary information
        const summaryText = formatSummaryText(finalPosts.length, "feed");

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-list-posts",
    "Fetch posts from users in a specified list",
    {
      list: z.string().describe("The URI of the list (e.g., at://did:plc:abcdef/app.bsky.graph.list/listname)"),
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back")
    },
    async ({ list, count, type }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // Validate the list by getting its info
        const listInfo = await validateUri(agent, list, 'list');
        if (!listInfo) {
          return mcpErrorResponse(`Invalid list URI or list not found: ${list}.`);
        }

        const MAX_TOTAL_POSTS = 500; // Safety limit to prevent excessive API calls

        let allPosts: any[] = [];
        let nextCursor: string | undefined = undefined;
        let shouldContinueFetching = true;

        // Set up time-based or count-based fetching
        const useHoursLimit = type === "hours";
        const targetHours = count;
        const targetDate = new Date(Date.now() - targetHours * 60 * 60 * 1000);

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          // Calculate how many posts to fetch in this batch
          const batchLimit = 100;

          const response = await agent.app.bsky.feed.getListFeed({
            list,
            limit: batchLimit,
            cursor: nextCursor
          });

          if (!response.success) {
            break;
          }

          const { feed, cursor } = response.data;

          // Filter posts based on time window if using hours limit
          let filteredFeed = feed;
          if (useHoursLimit) {
            filteredFeed = feed.filter(post => {
              const createdAt = post?.post?.record?.createdAt;
              if (!createdAt || typeof createdAt !== 'string') return false;
              const postDate = new Date(createdAt);
              return postDate >= targetDate;
            });
          }

          // Add the filtered posts to our collection
          allPosts = allPosts.concat(filteredFeed);

          // Update cursor for the next batch
          nextCursor = cursor;

          // Check if we should continue fetching based on the mode
          if (useHoursLimit) {
            // Check if we've reached posts older than our target date
            const oldestPost = feed[feed.length - 1];
            if (oldestPost?.post?.record?.createdAt && typeof oldestPost.post.record.createdAt === 'string') {
              const postDate = new Date(oldestPost.post.record.createdAt);
              if (postDate < targetDate) {
                shouldContinueFetching = false;
              }
            }
          } else {
            // If we're using count-based fetching, stop when we have enough posts
            shouldContinueFetching = allPosts.length < count;
          }

          // Stop if we don't have a cursor for the next page
          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        // If we're using count-based fetching, limit the posts to the requested count
        const finalPosts = !useHoursLimit
          ? allPosts.slice(0, count)
          : allPosts;

        // If no posts were found after filtering
        if (finalPosts.length === 0) {
          return mcpSuccessResponse(`No posts found from the list.`);
        }

        // Format the posts
        const formattedPosts = preprocessPosts(finalPosts);

        // Add summary information
        const summaryText = formatSummaryText(finalPosts.length, "list");

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching list posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-user-posts",
    "Fetch posts from a specific user",
    {
      user: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back"),
      filter: z.enum([
        "posts_with_replies",
        "posts_no_replies",
        "posts_and_author_threads",
        "posts_with_media",
        "posts_with_video"
      ]).default("posts_with_replies").describe("Filter posts by type. Default includes replies. Options: posts_with_replies (all posts including replies), posts_no_replies (exclude replies), posts_and_author_threads (posts and self-reply threads), posts_with_media (only posts with media), posts_with_video (only posts with video)")
    },
    async ({ user, count, type, filter }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // Verify the user exists by trying to get their profile
        try {
          const profileResponse = await agent.getProfile({ actor: cleanHandle(user) });
          if (!profileResponse.success) {
            return mcpErrorResponse(`User not found: ${user}`);
          }

          const MAX_TOTAL_POSTS = 500; // Safety limit to prevent excessive API calls

          let allPosts: any[] = [];
          let nextCursor: string | undefined = undefined;
          let shouldContinueFetching = true;

          // Set up time-based or count-based fetching
          const useHoursLimit = type === "hours";
          const targetHours = count;
          const targetDate = new Date(Date.now() - targetHours * 60 * 60 * 1000);

          while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
            // Calculate how many posts to fetch in this batch
            const batchLimit = 100;

            const response = await agent.app.bsky.feed.getAuthorFeed({
              actor: profileResponse.data.did,
              limit: batchLimit,
              cursor: nextCursor,
              filter: filter
            });

            if (!response.success) {
              break;
            }

            const { feed, cursor } = response.data;

            // Filter posts based on time window if using hours limit
            let filteredFeed = feed;
            if (useHoursLimit) {
              filteredFeed = feed.filter(post => {
                const createdAt = post?.post?.record?.createdAt;
                if (!createdAt || typeof createdAt !== 'string') return false;
                const postDate = new Date(createdAt);
                return postDate >= targetDate;
              });
            }

            // Add the filtered posts to our collection
            allPosts = allPosts.concat(filteredFeed);

            // Update cursor for the next batch
            nextCursor = cursor;

            // Check if we should continue fetching based on the mode
            if (useHoursLimit) {
              // Check if we've reached posts older than our target date
              const oldestPost = feed[feed.length - 1];
              if (oldestPost?.post?.record?.createdAt && typeof oldestPost.post.record.createdAt === 'string') {
                const postDate = new Date(oldestPost.post.record.createdAt);
                if (postDate < targetDate) {
                  shouldContinueFetching = false;
                }
              }
            } else {
              // If we're using count-based fetching, stop when we have enough posts
              shouldContinueFetching = allPosts.length < count;
            }

            // Stop if we don't have a cursor for the next page
            if (!cursor) {
              shouldContinueFetching = false;
            }
          }

          // If we're using count-based fetching, limit the posts to the requested count
          const finalPosts = !useHoursLimit
            ? allPosts.slice(0, count)
            : allPosts;

          // If no posts were found after filtering
          if (finalPosts.length === 0) {
            return mcpSuccessResponse(`No posts found from @${user}.`);
          }

          // Format the posts
          const formattedPosts = preprocessPosts(finalPosts);

          // Add summary information
          const summaryText = formatSummaryText(finalPosts.length, "user");

          return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
        } catch (profileError) {
          return mcpErrorResponse(`Error retrieving user profile: ${profileError instanceof Error ? profileError.message : String(profileError)}`);
        }
      } catch (error) {
        return mcpErrorResponse(`Error fetching user posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-follows",
    "Get one page of users that a person follows. For the authenticated user's own follows, reads records directly from their PDS (fast when colocated, surfaces the follow record URI needed for unfollow-user, and preserves deactivated/takedown follows that the AppView filters out); otherwise uses the AppView graph.getFollows endpoint. Returns a cursor that should be passed back in to fetch the next page.",
    {
      user: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
      limit: z.number().min(1).max(500).default(100).describe("Maximum follows to return in this response (1-500). The tool loops the underlying PDS/AppView pagination (100/page) internally to fulfill larger requests. Raise this when you intend to dump the result to a file; keep it small when the output is meant to stay in the model's context."),
      cursor: z.string().optional().describe("Pagination cursor returned by a previous call. Omit on the first call."),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity. 'compact' (default) returns one line per follow with handle, display name, and DID — ~80 bytes per entry. 'full' additionally includes bio and counts; note that at large limits the payload can exceed what some Claude clients will render."),
    },
    async ({ user, limit, cursor, detail }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const profileResponse = await agent.getProfile({ actor: cleanHandle(user) });
        if (!profileResponse.success) {
          return mcpErrorResponse(`User not found: ${user}`);
        }
        const targetDid = profileResponse.data.did;
        const isSelf = agent.did === targetDid;

        const PAGE_SIZE = 100; // Both listRecords and graph.getFollows cap a single call at 100.
        type FollowEntry = { did: string; followUri?: string };
        const follows: FollowEntry[] = [];
        const profileByDid = new Map<string, any>();
        let nextCursor: string | undefined = cursor;

        while (follows.length < limit) {
          const batchLimit = Math.min(PAGE_SIZE, limit - follows.length);
          if (isSelf) {
            // Fast path: read app.bsky.graph.follow records directly from the
            // user's PDS. No AppView aggregation lag, returns the record URI
            // we need to call unfollow-user, and preserves follows of accounts
            // the AppView has filtered out (deactivated/takedown) — exactly
            // the cleanup candidates an unfollow pass wants surfaced.
            const res = await agent.com.atproto.repo.listRecords({
              repo: targetDid,
              collection: 'app.bsky.graph.follow',
              limit: batchLimit,
              cursor: nextCursor,
            });
            if (!res.success) {
              if (follows.length === 0) {
                return mcpErrorResponse(`Failed to list follow records for ${user}.`);
              }
              break;
            }
            for (const r of res.data.records) {
              const subject = (r.value as { subject?: unknown })?.subject;
              if (typeof subject === 'string') {
                follows.push({ did: subject, followUri: r.uri });
              }
            }
            nextCursor = res.data.cursor;
          } else {
            // Other users' graphs go through AppView — we don't host their
            // records. graph.getFollows already returns ProfileView objects;
            // capture them inline so compact rendering needs no hydration.
            const res = await agent.app.bsky.graph.getFollows({
              actor: targetDid,
              limit: batchLimit,
              cursor: nextCursor,
            });
            if (!res.success) {
              if (follows.length === 0) {
                return mcpErrorResponse(`Failed to fetch follows for ${user}.`);
              }
              break;
            }
            for (const f of res.data.follows) {
              follows.push({ did: f.did });
              profileByDid.set(f.did, f);
            }
            nextCursor = res.data.cursor;
          }
          if (!nextCursor) break;
        }

        if (follows.length === 0) {
          return mcpSuccessResponse(`@${user} doesn't follow anyone.`);
        }

        // Hydrate to ProfileViewDetailed via AppView for any DIDs we don't
        // already have. In full-detail mode hydrate everything regardless,
        // because followers/follows/posts counts only exist on the Detailed
        // view (graph.getFollows returns plain ProfileView, no counts).
        // getProfiles caps at 25 actors per call; fire chunks in parallel so
        // hydration cost is one round trip instead of N.
        const toHydrate = detail === "full"
          ? follows.map((f) => f.did)
          : follows.filter((f) => !profileByDid.has(f.did)).map((f) => f.did);
        if (toHydrate.length > 0) {
          const CHUNK = 25;
          const chunks: string[][] = [];
          for (let i = 0; i < toHydrate.length; i += CHUNK) {
            chunks.push(toHydrate.slice(i, i + CHUNK));
          }
          const chunkResults = await Promise.all(chunks.map(async (chunk) => {
            try {
              const res = await agent.app.bsky.actor.getProfiles({ actors: chunk });
              return res.success ? res.data.profiles : [];
            } catch {
              return []; // Any inline ProfileView already in the map survives as fallback.
            }
          }));
          for (const profiles of chunkResults) {
            for (const p of profiles) profileByDid.set(p.did, p);
          }
        }

        const formattedFollows = follows.map(({ did, followUri }, index) => {
          const p = profileByDid.get(did);
          const handle = p?.handle ? `@${p.handle}` : '(handle unresolved)';
          if (detail === "compact") {
            const name = p?.displayName ? ` (${p.displayName})` : "";
            const uri = followUri ? ` [${followUri}]` : "";
            return `${index + 1}. ${handle}${name} — ${did}${uri}`;
          }
          return `User #${index + 1}:
Display Name: ${p?.displayName || 'No display name'}
Handle: ${handle}
DID: ${did}
${followUri ? `Follow Record URI: ${followUri}` : ''}
${p?.description ? `Bio: ${p.description}` : 'Bio: No bio provided'}
${p?.followersCount !== undefined ? `Followers: ${p.followersCount}` : ''}
${p?.followsCount !== undefined ? `Following: ${p.followsCount}` : ''}
${p?.postsCount !== undefined ? `Posts: ${p.postsCount}` : ''}
${p?.indexedAt ? `Indexed at: ${new Date(p.indexedAt).toLocaleString()}` : ''}
---`;
        }).join(detail === "compact" ? "\n" : "\n\n");

        const source = isSelf ? "PDS-direct" : "AppView";
        const uriHint = isSelf ? " The bracketed at:// URI on each line is the follow record; pass it to unfollow-user as followUri to remove that follow without re-resolving the DID." : "";
        const summaryText = `Retrieved ${follows.length} users that @${user} follows (via ${source}).${uriHint}${nextCursor ? ` More pages available — pass cursor="${nextCursor}" to continue.` : ""}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedFollows}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching follows: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-followers",
    "Get a list of users that follow a person",
    {
      user: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
      limit: z.number().min(1).max(500).default(500).describe("Maximum number of followers to fetch (1-500)"),
    },
    async ({ user, limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // First, verify the user exists by trying to get their profile
        try {
          const profileResponse = await agent.getProfile({ actor: cleanHandle(user) });
          if (!profileResponse.success) {
            return mcpErrorResponse(`User not found: ${user}`);
          }

          // Use the display name in the summary if available
          const displayName = profileResponse.data.displayName || user;

          // Now fetch who follows this user with pagination
          const MAX_BATCH_SIZE = 100; // Maximum number of followers per API call
          const MAX_BATCHES = 5;      // Maximum number of API calls to make (100 x 5 = 500)
          let allFollowers: any[] = [];
          let nextCursor: string | undefined = undefined;
          let batchCount = 0;

          // Loop to fetch followers with pagination
          while (batchCount < MAX_BATCHES && allFollowers.length < limit) {
            // Calculate how many followers to fetch in this batch
            const batchLimit = Math.min(MAX_BATCH_SIZE, limit - allFollowers.length);

            // Make the API call with cursor if we have one
            const response = await agent.app.bsky.graph.getFollowers({
              actor: cleanHandle(user),
              limit: batchLimit,
              cursor: nextCursor
            });

            if (!response.success) {
              // If we've already fetched some followers, return those
              if (allFollowers.length > 0) {
                break;
              }
              return mcpErrorResponse(`Failed to fetch followers for ${user}.`);
            }

            const { followers, cursor } = response.data;

            // Add the fetched followers to our collection
            allFollowers = allFollowers.concat(followers);

            // Update cursor for the next batch
            nextCursor = cursor;
            batchCount++;

            // If no cursor returned or we've reached our limit, stop paginating
            if (!cursor || allFollowers.length >= limit) {
              break;
            }
          }

          if (allFollowers.length === 0) {
            return mcpSuccessResponse(`@${user} doesn't have any followers.`);
          }

          // Format the followers list
          const formattedFollowers = allFollowers.map((follower: any, index: number) => {
            return `User #${index + 1}:
Display Name: ${follower.displayName || 'No display name'}
Handle: @${follower.handle}
DID: ${follower.did}
${follower.description ? `Bio: ${follower.description}` : 'Bio: No bio provided'}
${follower.followersCount !== undefined ? `Followers: ${follower.followersCount}` : ''}
${follower.followsCount !== undefined ? `Following: ${follower.followsCount}` : ''}
${follower.postsCount !== undefined ? `Posts: ${follower.postsCount}` : ''}
${follower.indexedAt ? `Following since: ${new Date(follower.indexedAt).toLocaleString()}` : ''}
---`;
          }).join("\n\n");

          // Create a summary
          const summaryText = `Retrieved ${allFollowers.length} followers of @${user}.${nextCursor ? ' More results are available.' : ''}`;

          return mcpSuccessResponse(`${summaryText}\n\n${formattedFollowers}`);

        } catch (profileError) {
          return mcpErrorResponse(`Error retrieving user profile: ${profileError instanceof Error ? profileError.message : String(profileError)}`);
        }
      } catch (error) {
        return mcpErrorResponse(`Error fetching followers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get-post-likes",
    "Get information about users who have liked a specific post",
    {
      uri: z.string().describe("The URI of the post to get likes for (e.g., at://did:plc:abcdef/app.bsky.feed.post/123)"),
      limit: z.number().min(1).max(100).default(100).describe("Maximum number of likes to fetch (1-100)"),
    },
    async ({ uri, limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // First, we need to get the post's CID
        const response = await agent.app.bsky.feed.getPostThread({ uri });

        if (!response.success || response.data.thread.$type !== 'app.bsky.feed.defs#threadViewPost') {
          return mcpErrorResponse("Failed to get post information.");
        }

        // Get the post's CID
        const threadPost = response.data.thread as any;
        const post = threadPost.post;
        const cid = post.cid;

        // Now fetch the likes
        const likesResponse = await agent.app.bsky.feed.getLikes({
          uri,
          cid,
          limit
        });

        if (!likesResponse.success) {
          return mcpErrorResponse("Failed to fetch likes for the post.");
        }

        const { likes } = likesResponse.data;

        if (!likes || likes.length === 0) {
          return mcpSuccessResponse("No likes found for this post.");
        }

        // Format the likes list
        const formattedLikes = likes.map((like: any, index: number) => {
          const actor = like.actor;
          return `User #${index + 1}:
Display Name: ${actor.displayName || 'No display name'}
Handle: @${actor.handle}
DID: ${actor.did}
${actor.description ? `Bio: ${actor.description.substring(0, 100)}${actor.description.length > 100 ? '...' : ''}` : 'Bio: No bio provided'}
${actor.followersCount !== undefined ? `Followers: ${actor.followersCount}` : ''}
${actor.followsCount !== undefined ? `Following: ${actor.followsCount}` : ''}
${actor.postsCount !== undefined ? `Posts: ${actor.postsCount}` : ''}
${like.indexedAt ? `Liked at: ${new Date(like.indexedAt).toLocaleString()}` : ''}
---`;
        }).join("\n\n");

        // Create a summary
        const summaryText = `Retrieved ${likes.length} likes for the post.${likesResponse.data.cursor ? ' More likes are available.' : ''}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedLikes}`);

      } catch (error) {
        return mcpErrorResponse(`Error fetching post likes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "list-resources",
    "List all available MCP resources with their descriptions",
    {},
    async () => {
      const formattedResources = resourcesList.map((resource, index) => {
        return `Resource #${index + 1}:
Name: ${resource.name}
URI: ${resource.uri}
Description: ${resource.description}
---`;
      }).join("\n\n");

      return mcpSuccessResponse(`Available MCP Resources:\n\n${formattedResources}\n\nTo use these resources, reference them by URI in your prompts or queries.`);
    }
  );
}
