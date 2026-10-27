// Minimal Model Context Protocol server (Streamable HTTP transport, JSON
// responses) exposing AURA's validated tools to the Claude Code CLI.
//
// The endpoint only answers on the loopback interface, and each request URL
// carries a per-run random token: a token is valid only while its agent run is
// in progress and gives access only to that run's private overlay.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { log } from "../logger";
import type { Agent } from "./agent";
import { executeTool, toolDefinitions } from "./tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function isLoopback(ip: string) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function registerMcp(app: FastifyInstance, agent: Agent, version: string) {
  const guard = (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    if (!isLoopback(req.ip)) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    const run = agent.getRun(req.params.token);
    if (!run) {
      reply.code(404).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown or finished session" } });
      return null;
    }
    return run;
  };

  app.get<{ Params: { token: string } }>("/mcp/:token", (req, reply) => {
    if (!guard(req, reply)) return;
    reply.code(405).header("Allow", "POST").send();
  });

  app.delete<{ Params: { token: string } }>("/mcp/:token", (req, reply) => {
    if (!guard(req, reply)) return;
    reply.code(200).send();
  });

  app.post<{ Params: { token: string }; Body: JsonRpcRequest | JsonRpcRequest[] }>("/mcp/:token", (req, reply) => {
    const run = guard(req, reply);
    if (!run) return;
    const handleOne = (msg: JsonRpcRequest): object | null => {
      if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
      }
      const isNotification = msg.id === undefined || msg.id === null;
      const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize": {
          const requested = String(msg.params?.protocolVersion ?? "");
          return ok({
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "aura", title: "AURA planning tools", version },
            instructions: "Tools for reading and changing the user's tasks, projects, events and schedule. Changes are staged for the user's review.",
          });
        }
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: toolDefinitions(run.readOnly) });
        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          const r = executeTool(run, name, msg.params?.arguments);
          if (!r.ok) log.debug("tool rejected", { tool: name, error: r.error });
          return ok({
            content: [{ type: "text", text: r.ok ? JSON.stringify(r.result) : r.error }],
            isError: !r.ok,
          });
        }
        default:
          if (msg.method.startsWith("notifications/")) return null;
          return isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
      }
    };
    const body = req.body;
    if (Array.isArray(body)) {
      const responses = body.map(handleOne).filter((r): r is object => r !== null);
      if (responses.length === 0) return reply.code(202).send();
      return reply.header("content-type", "application/json").send(responses);
    }
    const response = handleOne(body);
    if (response === null) return reply.code(202).send();
    return reply.header("content-type", "application/json").send(response);
  });
}
