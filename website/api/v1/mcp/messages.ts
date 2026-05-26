// website/api/v1/mcp/messages.ts
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: any, res: any) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const message = req.body;
  if (!message || typeof message !== "object") {
    return res.status(400).json({ error: "Invalid JSON-RPC request." });
  }

  const { jsonrpc, method, id, params } = message;

  if (jsonrpc !== "2.0") {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: id || null,
      error: { code: -32600, message: "Invalid Request: expected jsonrpc: '2.0'" }
    });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "Server configuration error: Supabase credentials are missing on Vercel." }
    });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    switch (method) {
      case "initialize": {
        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "CodeGraphContext-Dynamic-MCP",
              version: "1.0.0"
            }
          }
        });
      }

      case "notifications/initialized": {
        return res.status(200).end();
      }

      case "tools/list": {
        const staticTools = [
          {
            name: "get_repository_stats",
            description: "Retrieves general repository graph statistics (counts of files, classes, methods, and relationship linkages).",
            inputSchema: {
              type: "object",
              properties: {
                repo: {
                  type: "string",
                  description: "GitHub repository path in 'owner/repo' format (e.g. 'requests/requests')."
                },
                branch: {
                  type: "string",
                  description: "Optional active branch of the repository (e.g. 'main') for version-scoped routing."
                },
                commit: {
                  type: "string",
                  description: "Optional active 7-character commit hash of the repository (e.g. 'a1b2c3d') for version-scoped routing."
                }
              },
              required: ["repo"]
            }
          },
          {
            name: "find_dead_code",
            description: "Locates unreferenced classes and functions inside the repository codebase.",
            inputSchema: {
              type: "object",
              properties: {
                repo: {
                  type: "string",
                  description: "GitHub repository path in 'owner/repo' format (e.g. 'requests/requests')."
                },
                branch: {
                  type: "string",
                  description: "Optional active branch of the repository (e.g. 'main') for version-scoped routing."
                },
                commit: {
                  type: "string",
                  description: "Optional active 7-character commit hash of the repository (e.g. 'a1b2c3d') for version-scoped routing."
                }
              },
              required: ["repo"]
            }
          },
          {
            name: "calculate_cyclomatic_complexity",
            description: "Computes cyclomatic complexity scores for all functions in the codebase.",
            inputSchema: {
              type: "object",
              properties: {
                repo: {
                  type: "string",
                  description: "GitHub repository path in 'owner/repo' format (e.g. 'requests/requests')."
                },
                branch: {
                  type: "string",
                  description: "Optional active branch of the repository (e.g. 'main') for version-scoped routing."
                },
                commit: {
                  type: "string",
                  description: "Optional active 7-character commit hash of the repository (e.g. 'a1b2c3d') for version-scoped routing."
                }
              },
              required: ["repo"]
            }
          },
          {
            name: "find_most_complex_functions",
            description: "Retrieves the functions with the highest cyclomatic complexity scores.",
            inputSchema: {
              type: "object",
              properties: {
                repo: {
                  type: "string",
                  description: "GitHub repository path in 'owner/repo' format (e.g. 'requests/requests')."
                },
                branch: {
                  type: "string",
                  description: "Optional active branch of the repository (e.g. 'main') for version-scoped routing."
                },
                commit: {
                  type: "string",
                  description: "Optional active 7-character commit hash of the repository (e.g. 'a1b2c3d') for version-scoped routing."
                },
                limit: {
                  type: "integer",
                  description: "Maximum number of functions to return (default: 10).",
                  default: 10
                }
              },
              required: ["repo"]
            }
          },
          {
            name: "analyze_code_relationships",
            description: "Inspects coupling references, inherits, imports, and calls between symbols.",
            inputSchema: {
              type: "object",
              properties: {
                repo: {
                  type: "string",
                  description: "GitHub repository path in 'owner/repo' format (e.g. 'requests/requests')."
                },
                symbol: {
                  type: "string",
                  description: "Target symbol name to inspect relationships for."
                },
                branch: {
                  type: "string",
                  description: "Optional active branch of the repository (e.g. 'main') for version-scoped routing."
                },
                commit: {
                  type: "string",
                  description: "Optional active 7-character commit hash of the repository (e.g. 'a1b2c3d') for version-scoped routing."
                }
              },
              required: ["repo", "symbol"]
            }
          },
          {
            name: "list_indexed_repositories",
            description: "Scans for all repositories that have local graphs indexed in local WASM storage.",
            inputSchema: {
              type: "object",
              properties: {
                repo: {
                  type: "string",
                  description: "Active GitHub repository path in 'owner/repo' format to route the request."
                },
                branch: {
                  type: "string",
                  description: "Optional active branch of the repository (e.g. 'main') for version-scoped routing."
                },
                commit: {
                  type: "string",
                  description: "Optional active 7-character commit hash of the repository (e.g. 'a1b2c3d') for version-scoped routing."
                }
              },
              required: ["repo"]
            }
          }
        ];

        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: staticTools
          }
        });
      }

      case "tools/call": {
        const { name: toolName, arguments: toolArgs } = params || {};
        if (!toolName) {
          return res.status(400).json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: name is required." }
          });
        }

        const repo = toolArgs?.repo || toolArgs?.repository || "";
        const branch = toolArgs?.branch || "";
        const commit = toolArgs?.commit || "";

        if (!repo || typeof repo !== "string") {
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{
                type: "text",
                text: "Error: Missing required argument 'repo' (owner/repo) inside tool arguments. All remote tools require a target repository path."
              }]
            }
          });
        }

        const cleanRepo = repo.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, "").replace(/\/$/, "");
        const cleanRepoName = cleanRepo.replace(/\//g, "_").toLowerCase();
        const cleanBranch = branch ? String(branch).replace(/\//g, "_").toLowerCase() : "main";
        const commitStr = commit ? String(commit) : "latest";
        const cleanCommit = commitStr.length === 40 && /^[0-9a-fA-F]+$/.test(commitStr) ? commitStr.substring(0, 7).toLowerCase() : commitStr.toLowerCase();
        
        const channelName = `cgc-tunnel-${cleanRepoName}-${cleanBranch}-${cleanCommit}`;
        const channel = supabase.channel(channelName);
        const requestId = Math.random().toString(36).substring(2, 15);
        let hasResponded = false;
        let responsePayload: any = null;

        const cleanup = () => {
          try { supabase.removeChannel(channel); } catch (err) {}
        };

        // Step 1: Establish subscription first
        await new Promise<void>((resolve, reject) => {
          channel
            .on(
              "broadcast",
              { event: "tool-call-response" },
              ({ payload }: { payload: any }) => {
                if (payload && payload.id === requestId) {
                  hasResponded = true;
                  responsePayload = payload;
                  cleanup();
                }
              }
            )
            .subscribe((status: string) => {
              if (status === "SUBSCRIBED") {
                resolve();
              } else if (status === "CLOSED" || status === "TIMED_OUT") {
                reject(new Error(`Failed to connect to signaling tunnel: ${status}`));
              }
            });
        });

        // Step 2: Broadcast execution command
        const sendStatus = await channel.send({
          type: "broadcast",
          event: "tool-call-request",
          payload: {
            id: requestId,
            toolName,
            args: toolArgs
          }
        });

        if (sendStatus !== "ok") {
          cleanup();
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error: Failed to broadcast tool call over signaling channel: ${sendStatus}` }]
            }
          });
        }

        // Step 3: Await response or handle offline state on timeout
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!hasResponded) {
              cleanup();
            }
            resolve();
          }, 7000);
        });

        if (!hasResponded) {
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{
                type: "text",
                text: `Error: The Browser-as-a-Server dashboard for '${cleanRepo}' is currently closed.\n\nTo enable Claude to run your Python tools, please open https://codegraphcontext.vercel.app in an active browser tab.`
              }]
            }
          });
        }

        if (responsePayload?.status === "error") {
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Python MCPServer Error: ${responsePayload.error}` }]
            }
          });
        }

        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: responsePayload?.result
        });
      }

      default: {
        return res.status(404).json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: '${method}'` }
        });
      }
    }

  } catch (error: any) {
    console.error("MCP handler error:", error);
    return res.status(500).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal server error: ${error.message}` }
    });
  }
}
