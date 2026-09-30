#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AtpAgent } from "@atproto/api";
import * as dotenv from "dotenv";
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { registerTools } from './tools.js';

// Re-exported for backwards compatibility with any existing importers.
export { mcpLog, mcpErrorResponse, mcpSuccessResponse } from './utils.js';

// Load environment variables
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

// Create server instance
const server = new McpServer({
  name: "bluesky",
  version: "1.0.0",
  title: "Bluesky MCP Server",
  description: "MCP server for interacting with Bluesky social network and AT Protocol",
});

registerResources(server);
registerPrompts(server);

// Initialize ATP agent and session
let agent: AtpAgent | null = null;

registerTools(server, () => agent);

// Connect to Bluesky using environment variables
async function initializeBlueskyConnection() {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  const service = process.env.BLUESKY_SERVICE_URL || "https://bsky.social";

  if (!identifier || !password) {
    console.error("Error: BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD environment variables must be set");
    return false;
  }

  try {
    agent = new AtpAgent({ service });
    const result = await agent.login({ identifier, password });

    if (result.success) {
      console.error(`Successfully logged in as ${result.data.handle} (${result.data.did})`);
      return true;
    } else {
      console.error("Login failed: Invalid credentials.");
      return false;
    }
  } catch (error) {
    console.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// Start the server
(async function() {
  try {
    await initializeBlueskyConnection();

    serveStdio(() => server);
    console.error("Bluesky MCP Server running on stdio (MCP 2026-07-28 dual-era)");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();

