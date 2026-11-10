# Bluesky MCP Server

[![smithery badge](https://smithery.ai/badge/@brianellin/bsky-mcp-server)](https://smithery.ai/server/@brianellin/bsky-mcp-server)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that connects to [Bluesky](https://bsky.app/) and provides tools to interact with the ATProtocol.

You can use this MCP server to bring context from various Bluesky / ATProtocol API endpoints directly into the context window of your LLM based application. For example, you can add this server to Claude Desktop and then use it as a natural language Bluesky client. 

## Features & Tools

- Interact with common Bluesky features via natural language (e.g. "Get recent posts from David Roberts")
- Fetch and analyze feeds ("Find me a feed about Seattle and tell me what people are talking about")
- Fetch and analyze lists of followers ("What types of accounts does Mark Cuban follow? Give me a detailed report")
- Use an LLM to write a post and then post it for you 😱 ("Write a haiku about today's weather in my area and post it to bluesky")
- Search for feeds, posts, and people ("Find posts about the #teslatakedown and give me a summary of recent events")
- Analyze who follows you? ("Who follows me on Bluesky? Give me a report")

Here's the current list of tools provided:

- **get-my-handle-and-did**: returns the handle and DID of the authenticated session
- **get-pinned-feeds**: returns the set of all "pinned" items from the authenticated user's preferences
- **get-timeline-posts**: returns posts from the authenticated user's home timeline (`compact` or `full` XML, optional `includeReposts` and `cursor`)
- **get-feed-posts**: returns posts from the specified custom feed (`compact` or `full` XML)
- **get-list-posts**: returns posts from the specified list (`compact` or `full` XML)
- **get-user-posts**: returns a user's posts (`compact` or `full` XML, `includeReposts`, `cursor`, and `source: "appview" | "pds"` for direct PDS record reads)
- **get-posts**: batch-hydrates up to 25 post AT URIs or `bsky.app` web URLs in one call and flags deleted/not-found targets
- **get-post-thread**: returns a conversation thread for a specific post URI or web URL (configurable `depth`, `parentHeight`, `maxRepliesPerNode`, and `detail`)
- **get-post-quotes**: returns posts that quote-post a specific post URI or web URL
- **get-post-likes**: returns users who liked a specific post URI or web URL
- **get-notifications**: returns notifications with inline post text, reply/quote pointers, `hours`/`since` time windows, `authorFilter`, and PDS-backed `replyFilter` (`all` / `responded` / `unresponded`)
- **get-profile**: returns the profile details of the specified user
- **get-follows**: returns users an account follows (PDS-direct fast path for self, `compact` or `full`, `cursor`)
- **get-followers**: returns users who follow an account (`compact` or `full`, `cursor`)
- **get-liked-posts**: returns recent posts liked by the authenticated user
- **get-trends**: returns current trending topics on Bluesky with post counts
- **convert-url-to-uri**: converts a Bluesky web URL to an AT URI format
- **search-posts**: searches posts with native filters (`since`, `until`, `author`, `mentions`, `domain`, `url`, `tag`, `lang`, `cursor`, `sort`)
- **search-people**: returns people for a given search query
- **search-feeds**: returns feeds for a given query
- **create-post**: publishes a post (enforcing 300-grapheme limits, fail-closed `quoteUri` & `replyTo` resolution, up to 4 images including `recordWithMedia`, and post-flight metadata)
- **create-thread**: publishes a multi-post thread with atomic pre-flight validation of all posts before post #1 is sent
- **delete-post**: deletes a post by AT URI or web URL
- **like-post** / **unlike-post**: likes or unlikes a post by AT URI, web URL, or like record URI
- **repost** / **unrepost**: reposts or removes a repost by AT URI, web URL, or repost record URI
- **follow-user** / **unfollow-user**: follows or unfollows a user by handle/DID or follow record URI
- **list-resources**: lists available MCP resources
- **list-dm-conversations**: list direct message (DM) conversations with optional unread or request filters
- **get-dm-messages**: read messages from a DM conversation by `convoId` or participant handle/DID
- **send-dm**: send or reply to a DM by `convoId` or recipient handle/DID (supports rich text links/mentions/hashtags and post quotes)
- **manage-dm-conversation**: mark conversations as read (`mark-read`, `mark-all-read`), accept message requests (`accept`), `leave`, `mute`, or `unmute`
- **react-to-dm**: add or remove an emoji reaction on a DM message
- **delete-dm-message**: delete a DM message from your view (`deleteMessageForSelf`)

Tips:
- You can ask for post from search, timelines, lists, feeds, or profiles by time range. For example: Summarize posts from my timeline for the last three days" or "Find me the most interesting article people have been talking about this week"
- Get weird: "What the funniest/most unhinged/weirdest/goofiest post you've seen on my timeline in the last 24 hours?"
- Learn about yourself: "Analyze my liked posts and tell me what I'm into. Give me 3 interesting facts about what you've found and how it relates to my personality on bluesky" or "Who follows me on bluesky? Give me a comprehensive report."


## Installation

### Installing via Smithery

To install Bluesky MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@brianellin/bsky-mcp-server):

```bash
npx -y @smithery/cli install @brianellin/bsky-mcp-server --client claude
```

### Installing Manually
First clone this repo, then install dependencies and build the server:

```bash
# Install dependencies
pnpm install

# Build the project
pnpm run build
```

### Testing with MCP Inspector

You can test the bluesky tools directly without connecting to an LLM via the amazing [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector). First make sure you have built the server and then run:

```bash
npx @modelcontextprotocol/inspector node build/src/index.js
```

Navigate to the local URL provided in your terminal, and then set your BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD, and BLUESKY_SERVICE_URL environment variables from the panel on the left. Try the get-timeline tool to see the most recent posts from your home timeline. 

## MCP Client Configuration 

Follow the steps to set up MCP with your client of choice. For example, to set up Claude for desktop to connect to Bluesky, add the following to bluesky section to your claude_desktop_config.json:

```json
{
    "mcpServers": {
      "bluesky": {
        "command": "node",
        "args": ["/path/to/bsky-mcp-server/build/src/index.js"],
        "env": {
            "BLUESKY_IDENTIFIER": "your-bluesky-handle",
            "BLUESKY_APP_PASSWORD": "your-app-password",
            "BLUESKY_SERVICE_URL": "https://bsky.social"
          }
      }
    }
  }
```

For more details about running MCP servers in Claude for desktop, see https://modelcontextprotocol.io/quickstart/user


## Creating App Passwords

To use this MCP server, you need to create an app password for your Bluesky account:

1. Log in to Bluesky
2. Go to Settings > App Passwords
3. Create a new app password specifically for this integration
4. Set the app password using the BLUESKY_APP_PASSWORD environment variable

## Security Notes

- This server stores your session information in memory only and does not share it with the MCP client.
- The MCP client only has access to the tools, not to your authentication or app password

## License

MIT
