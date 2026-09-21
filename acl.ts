import {
  type CallToolRequestParams,
  type CallToolRequest,
  type ClientRequest,
  isJSONRPCRequest,
} from "@modelcontextprotocol/server";

// Access Control List typedef
type Rule =
  | { effect: "allow"; method: Exclude<ClientRequest["method"], "tools/call"> }
  | {
      effect: "allow";
      method: CallToolRequest["method"];
      name: string;
      when: (params: CallToolRequestParams) => boolean;
    };

// Access Control List
export const acl: Rule[] = [
  { effect: "allow", method: "server/discover" },
  { effect: "allow", method: "subscriptions/listen" },
  { effect: "allow", method: "tools/list" },
  {
    effect: "allow",
    method: "tools/call",
    name: "whoami",
    when: (params) => !params?.arguments?.requireAuth,
  },
];

// runs rules against incoming request
// returns false for...
// - non JSON RPC requests
// - request that doesn't have a rule that explicitly allows it
export const isPublicRequest = (request: ClientRequest, acl: Rule[]) => {
  if (!isJSONRPCRequest(request)) {
    return false;
  }

  return acl.some((rule) => {
    // reject bad rules
    if (rule.effect !== "allow") return false;

    // allow explicity defined client methods, expect tool calls
    if (rule.method !== "tools/call" && rule.method === request.method) {
      return true;
    }

    // allow defined tool calls
    if (
      rule.method === "tools/call" &&
      request.method === "tools/call" &&
      rule.name === request.params?.name &&
      rule.when(request.params)
    ) {
      return true;
    }
  });
};
