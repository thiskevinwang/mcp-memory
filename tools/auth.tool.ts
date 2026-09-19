import * as z from "zod/v4";

import type { McpServer } from "@modelcontextprotocol/server";

export function registerAuthTools(server: McpServer) {
  server.registerTool(
    "whoami",
    {
      description: "Return details about the current access token.",
      inputSchema: z.object({
        requireAuth: z.boolean().optional(),
      }),
      outputSchema: z.object({
        subject: z.string(),
        scopes: z.array(z.string()).nullable(),
        authenticated: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_, ctx) => {
      const authInfo = ctx.http?.authInfo;

      const result = {
        subject: authInfo ? authInfo.extra?.userId : "",
        scopes: authInfo ? authInfo.scopes : null,
        authenticated: !!authInfo,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
