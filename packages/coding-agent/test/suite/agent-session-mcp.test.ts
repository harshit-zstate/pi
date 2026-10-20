import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension, MCP_SERVERS_SECTION } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { TOOL_SEARCH_DESCRIPTION } from "../../src/extensions/tool-search/tool.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	type Harness,
	getToolResult as toolResult,
} from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SERVER_TOOLS = [
	{
		name: "search",
		description: "Search the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: {
			type: "object",
			properties: { hits: { type: "array", items: { type: "string" } } },
			required: ["hits"],
		},
	},
	{
		name: "fail",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {} },
		annotations: { title: "Fail", destructiveHint: true, readOnlyHint: false, idempotentHint: "yes" },
	},
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/**
 * Minimal MCP server over an in-memory transport. Records the tool calls it receives.
 * `initializeDelayMs` delays the answer to `initialize`; `Infinity` never answers.
 */
function createFakeServer(
	calls: string[],
	options: {
		listTools?: () => unknown[];
		resources?: boolean;
		instructions?: string;
		initializeDelayMs?: number;
	} = {},
) {
	const { listTools = () => SERVER_TOOLS, resources = false, instructions, initializeDelayMs = 0 } = options;
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1.0.0" },
					...(instructions ? { instructions } : {}),
				};
			case "tools/list":
				return { tools: listTools() };
			case "resources/list":
				return {
					resources: [
						{ uri: "docs://intro", name: "intro", mimeType: "text/markdown", _meta: { x: 1 } },
						// MCP App user interfaces are left out.
						{ uri: "ui://docs/viewer", name: "viewer", mimeType: "text/html;profile=mcp-app" },
					],
				};
			case "resources/templates/list":
				return {
					resourceTemplates: [
						{ uriTemplate: "docs://pages/{slug}", name: "page", icons: [{ src: "data:image/png;base64,AAAA" }] },
					],
				};
			case "resources/read": {
				const { uri } = request.params as { uri: string };
				calls.push(`read:${uri}`);
				return { contents: [{ uri, mimeType: "text/markdown", text: `# ${uri}` }] };
			}
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
				if (params.name === "search") {
					const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
					return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
				}
				if (params.name === "shot") {
					return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
				}
				return { content: [{ type: "text", text: "server exploded" }], isError: true };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method !== "initialize" || initializeDelayMs === 0) queueMicrotask(send);
		else if (Number.isFinite(initializeDelayMs)) setTimeout(send, initializeDelayMs);
	});
	return pair;
}

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		exposure: McpExposure,
		listTools?: () => unknown[],
		options: {
			builtInTools?: string[];
			/** `--tools` and `--exclude-tools`. */
			allowedToolNames?: string[];
			excludedToolNames?: string[];
			/** Session to continue. */
			sessionManager?: SessionManager;
			/** Whether to wait for `mcp__docs__search` to register. Default: true. */
			waitForTools?: boolean;
			extensionFactories?: ExtensionFactory[];
			toolExposure?: Record<string, McpExposure>;
			resources?: boolean;
			withoutToolSearch?: boolean;
			description?: string;
			instructions?: string;
		} = {},
	) {
		const {
			builtInTools,
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			waitForTools = true,
			extensionFactories = [],
			toolExposure,
			resources,
			withoutToolSearch,
			description,
			instructions,
		} = options;
		const calls: string[] = [];
		const notifications: string[] = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: {
				url: "http://unused.invalid",
				exposure,
				...(toolExposure ? { toolExposure } : {}),
				...(description ? { description } : {}),
			},
			source: "test",
		};
		// `builtInTools` are the tools active at the start. The MCP extension activates tool_search for
		// deferred tools.
		const harness = await createHarness({
			initialActiveToolNames: allowedToolNames ?? builtInTools ?? [],
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			extensionFactories: [
				...extensionFactories,
				...(withoutToolSearch ? [] : [createToolSearchExtension()]),
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { listTools, resources, instructions });
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		// The first prompt waits only for servers with direct tools; wait for the others here.
		if (waitForTools) {
			await vi.waitFor(() =>
				expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);
		}
		return { harness, calls, servers, notifications };
	}

	function declaredToolNames(harness: Harness): string[] {
		return harness.session.messages
			.filter((message): message is SystemMessage => message.role === "system")
			.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
	}

	/** The `mcp_servers` prompt section as the model currently has it. */
	function serversSection(harness: Harness): string | null | undefined {
		let section: string | null | undefined;
		for (const message of harness.session.messages) {
			if (message.role === "system" && message.sections && MCP_SERVERS_SECTION in message.sections) {
				section = message.sections[MCP_SERVERS_SECTION];
			}
		}
		return section;
	}

	function nestedToolNames(harness: Harness): string[] {
		return harness.session.getCallableToolNames();
	}

	it("keeps MCP tools when --tools names no MCP tool", async () => {
		const { harness } = await setup("deferred", undefined, {
			allowedToolNames: ["read", "tool_search"],
			resources: true,
		});
		expect(harness.session.getActiveToolNames()).toEqual(["read", "tool_search"]);
		expect(nestedToolNames(harness)).toEqual(
			expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail", "list_mcp_resources", "read_mcp_resource"]),
		);
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("bash");

		// A direct MCP tool stays registered but is declared only when --tools names it.
		const direct = await setup("deferred", undefined, {
			allowedToolNames: ["tool_search"],
			toolExposure: { fail: "direct" },
		});
		await vi.waitFor(() =>
			expect(direct.harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__fail"),
		);
		expect(direct.harness.session.getActiveToolNames()).toEqual(["tool_search"]);
	});

	it("removes MCP tools with --no-tools", async () => {
		// The first prompt waits for servers with direct tools, so their tools would be registered by then.
		const { harness, servers } = await setup("direct", undefined, { allowedToolNames: [], waitForTools: false });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");

		expect(servers).toHaveLength(1);
		expect(harness.session.getAllTools()).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("does not declare unnamed MCP tools restored from the transcript", async () => {
		const first = await setup("direct");
		first.harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await first.harness.session.prompt("first");
		await first.harness.session.prompt("second");
		expect(declaredToolNames(first.harness)).toContain("mcp__docs__search");

		// Like `pi --tools read,tool_search -c` followed by /tree.
		const second = await setup("direct", undefined, {
			allowedToolNames: ["read", "tool_search"],
			sessionManager: first.harness.sessionManager,
		});
		const firstAssistant = second.harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await second.harness.session.navigateTree(firstAssistant.id);

		// The transcript's loadout is restored without the MCP tools it declared.
		expect(second.harness.session.getActiveToolNames()).toEqual([]);
		expect(second.harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search");
	});

	it("lets tool_search declare unnamed MCP tools when --tools names it", async () => {
		const { harness } = await setup("deferred", undefined, { allowedToolNames: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await harness.session.prompt("load");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "mcp__docs__search"]);
	});

	it("filters MCP tools by the mcp__ entries of --tools", async () => {
		const { harness } = await setup("deferred", undefined, {
			allowedToolNames: ["tool_search", "mcp__docs__s*"],
			resources: true,
			toolExposure: { shot: "direct" },
		});
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "mcp__docs__shot"]));
		const registered = harness.session.getAllTools().map((tool) => tool.name);
		expect(registered).toEqual(expect.arrayContaining(["mcp__docs__search", "mcp__docs__shot"]));
		expect(registered).not.toContain("mcp__docs__fail");
		expect(registered).not.toContain("list_mcp_resources");
	});

	it("removes MCP tools matching --exclude-tools patterns", async () => {
		const { harness } = await setup("deferred", undefined, {
			allowedToolNames: ["tool_search"],
			excludedToolNames: ["mcp__docs__f*"],
		});
		const registered = harness.session.getAllTools().map((tool) => tool.name);
		expect(registered).toContain("mcp__docs__search");
		expect(registered).not.toContain("mcp__docs__fail");
	});

	it("keeps deferred MCP tools callable across tree navigation", async () => {
		const { harness } = await setup("deferred");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		expect(nestedToolNames(harness)).toContain(searchName);

		const firstAssistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await harness.session.navigateTree(firstAssistant.id);

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		expect(nestedToolNames(harness)).toContain(searchName);
	});

	// Regression: #10239.
	it.each([false, true])("routes tools whose names differ only in - and _ (reverse: %s)", async (reverse) => {
		const tools = [
			{ name: "read-file", description: "dashed", inputSchema: { type: "object", properties: {} } },
			{ name: "read_file", description: "underscored", inputSchema: { type: "object", properties: {} } },
		];
		if (reverse) tools.reverse();
		const { harness, calls } = await setup("direct", () => [...tools, ...SERVER_TOOLS]);
		const nameOf = (description: string) => {
			const tool = harness.session.getAllTools().find((candidate) => candidate.description === description);
			if (!tool) throw new Error(`No tool described as ${description}`);
			return tool.name;
		};
		expect(nameOf("dashed")).not.toBe(nameOf("underscored"));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(nameOf("dashed"), {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall(nameOf("underscored"), {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls).toEqual(["read-file:{}", "read_file:{}"]);
	});

	it("rejects direct model calls to deferred MCP tools that are not loaded", async () => {
		const { harness, calls } = await setup("deferred");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(createMcpToolName("docs", "search"), { query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Tool mcp__docs__search not found");
		expect(calls).toEqual([]);
	});

	it("declares directly exposed MCP tools to the model", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(declaredToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
		// Boolean annotation hints are passed on for permission extensions.
		const annotations = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool.annotations]));
		expect(annotations.get("mcp__docs__fail")).toEqual({ destructiveHint: true, readOnlyHint: false });
		expect(annotations.get("mcp__docs__search")).toBeUndefined();
		const result = toolResult(harness, "mcp__docs__search");
		expect(getMessageText(result)).toBe("direct guide\ndirect faq");
	});

	it.each(["direct", "deferred"] as const)(
		"withdraws and restores %s MCP tools the server changes",
		async (exposure) => {
			let tools = SERVER_TOOLS;
			const { harness, servers } = await setup(exposure, () => tools);
			harness.setResponses([fauxAssistantMessage("ready")]);
			await harness.session.prompt("start");
			// Direct tools are declared to the model, deferred tools are registered for tool_search to load.
			const reachable = () =>
				exposure === "direct" ? harness.session.getActiveToolNames() : nestedToolNames(harness);
			const listChanged = async () => {
				await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				await new Promise((resolve) => setTimeout(resolve, 10));
			};
			expect(reachable()).toContain("mcp__docs__fail");

			tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
			await listChanged();
			expect(reachable()).not.toContain("mcp__docs__fail");
			expect(reachable()).toContain("mcp__docs__search");

			tools = SERVER_TOOLS;
			await listChanged();
			expect(reachable()).toContain("mcp__docs__fail");
		},
	);

	it("lists and reads resources with Codex's resource tools", async () => {
		const { harness, calls } = await setup("direct", undefined, { resources: true });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("list_mcp_resources", {}),
					fauxToolCall("list_mcp_resource_templates", { server: "docs" }),
					fauxToolCall("read_mcp_resource", { server: "docs", uri: "docs://pages/setup" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "nope", uri: "docs://x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		// The resource tools take the exposure of the servers they reach.
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]),
		);
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resources")))).toEqual({
			resources: [{ server: "docs", uri: "docs://intro", name: "intro", mimeType: "text/markdown" }],
		});
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resource_templates")))).toEqual({
			server: "docs",
			resourceTemplates: [{ server: "docs", uriTemplate: "docs://pages/{slug}", name: "page" }],
		});
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "read_mcp_resource",
		);
		expect(getMessageText(results[0])).toBe("# docs://pages/setup");
		expect(results[1].isError).toBe(true);
		expect(getMessageText(results[1])).toBe('MCP server "nope" has no resources. Servers with resources: docs');
		expect(calls).toEqual(["read:docs://pages/setup"]);
		const annotations = harness.session.getAllTools().find((tool) => tool.name === "read_mcp_resource");
		expect(annotations?.annotations).toEqual({ readOnlyHint: true });
	});

	it("lets tool_search load the resource tools for deferred servers", async () => {
		const { harness, calls } = await setup("deferred", undefined, { resources: true });
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("read_mcp_resource"),
		);
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "read_mcp_resource", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "docs", uri: "docs://intro" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "read_mcp_resource"]);
		expect(getMessageText(toolResult(harness, "read_mcp_resource"))).toBe("# docs://intro");
		expect(calls).toEqual(["read:docs://intro"]);
	});

	it("applies per-tool exposure overrides", async () => {
		const { harness } = await setup("hidden", undefined, { toolExposure: { search: "direct", "s*": "deferred" } });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		// `search` is declared, `shot` is deferred for tool_search, `fail` keeps the server's `hidden`.
		expect(declaredToolNames(harness)).toEqual(["tool_search", "mcp__docs__search"]);
		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__shot"]);
		const exposures = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool.exposure]));
		expect(exposures.get("mcp__docs__shot")).toBe("deferred");
		expect(exposures.get("mcp__docs__fail")).toBe("hidden");
	});

	it("describes the server with its configured description and keeps its instructions on the namespace", async () => {
		const { harness } = await setup("deferred", undefined, {
			description: "Search the product docs",
			instructions: "Always search before reading.",
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");

		// The instructions stay out of the tool_search description.
		const toolSearch = harness.session.agent.state.tools.find((tool) => tool.name === "tool_search");
		expect(toolSearch?.description).toBe(TOOL_SEARCH_DESCRIPTION);
		const search = harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__search");
		expect(search?.namespace).toMatchObject({
			name: "mcp__docs",
			description: "Search the product docs",
			instructions: "Always search before reading.",
		});
		// The system prompt lists the server with its configured description rather than its instructions.
		expect(serversSection(harness)).toContain("- mcp__docs (tool_search): Search the product docs");
		expect(serversSection(harness)).not.toContain("Always search");
	});

	it("lists servers by the first line of their instructions without a configured description", async () => {
		const { harness } = await setup("deferred", undefined, { instructions: "Docs search.\nLong guidance." });
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");

		const section = serversSection(harness);
		expect(section).toContain("- mcp__docs (tool_search): Docs search.\n");
		expect(section).not.toContain("Long guidance");
	});

	it("loads deferred MCP tools through an already active tool_search", async () => {
		const { harness, notifications } = await setup("deferred", undefined, { builtInTools: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "mcp__docs__search"]);
		expect(getMessageText(toolResult(harness, "mcp__docs__search"))).toBe("loaded guide\nloaded faq");
		expect(notifications).toEqual([]);
	});

	it("warns when deferred MCP tools have no tool_search", async () => {
		const { harness, notifications } = await setup("deferred", undefined, { withoutToolSearch: true });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual([
			"Deferred MCP tools are only reachable from the tool_search tool, but it is not registered; they cannot be called.",
		]);
	});

	it("does not warn about direct MCP tools without tool_search", async () => {
		const { harness, notifications } = await setup("direct", undefined, { withoutToolSearch: true });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(notifications).toEqual([]);
	});

	it("activates another extension's tool_search when it reaches other tools", async () => {
		const otherSearch: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "tool_search",
				label: "tool_search",
				description: "Another extension's tool_search.",
				parameters: Type.Object({}),
				defaultActive: false,
				reachesTools: () => "all",
				execute: async () => ({ content: [], details: undefined }),
			});
		};
		const { harness, notifications } = await setup("deferred", undefined, {
			extensionFactories: [otherSearch],
			withoutToolSearch: true,
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		expect(notifications).toEqual([]);
	});

	it("does not activate another extension's tool named tool_search", async () => {
		const otherSearch: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "tool_search",
				label: "tool_search",
				description: "Another extension's tool_search.",
				parameters: Type.Object({}),
				defaultActive: false,
				execute: async () => ({ content: [], details: undefined }),
			});
		};
		const { harness, notifications } = await setup("deferred", undefined, {
			extensionFactories: [otherSearch],
			withoutToolSearch: true,
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual([
			"Deferred MCP tools are only reachable from the tool_search tool, but it is not registered; they cannot be called.",
		]);
	});

	/** A server named `slow` whose answer to `initialize` takes `initializeDelayMs`, without waiting for it. */
	async function setupSlow(
		config: {
			exposure?: McpExposure;
			toolExposure?: Record<string, McpExposure>;
			name?: string;
			instructions?: string;
		},
		initializeDelayMs: number,
		startupWaitMs?: number,
		extensionFactories: ExtensionFactory[] = [],
	) {
		const calls: string[] = [];
		const notifications: string[] = [];
		const { name = "slow", instructions, ...serverConfig } = config;
		const entry: McpServerEntry = { name, config: { url: "http://unused.invalid", ...serverConfig }, source: "test" };
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				...extensionFactories,
				createToolSearchExtension(),
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { initializeDelayMs, instructions });
						void pair.server.start();
						return pair.client;
					},
					...(startupWaitMs === undefined ? {} : { startupWaitMs }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return { harness, calls, notifications };
	}

	it("does not hold the first prompt for deferred servers that are still connecting", async () => {
		// The server never answers `initialize`.
		const { harness } = await setupSlow({ exposure: "deferred" }, Number.POSITIVE_INFINITY);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		// tool_search is activated from the config, before the server connects.
		expect(declaredToolNames(harness)).toEqual(["tool_search"]);
	});

	it("keeps the tool_search description unchanged when the server connects", async () => {
		const { harness } = await setupSlow({ exposure: "deferred" }, 20);
		const description = () =>
			harness.session.agent.state.tools.find((tool) => tool.name === "tool_search")?.description;
		const before = description();
		expect(before).toBeDefined();
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		expect(description()).toBe(before);
	});

	it("lists a server before it connects and appends its summary with the next prompt", async () => {
		const { harness } = await setupSlow({ exposure: "deferred", instructions: "Slow docs.\nMore." }, 30);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		await harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		await harness.session.prompt("second");

		const systemMessages = harness.session.messages.filter(
			(message): message is SystemMessage => message.role === "system",
		);
		// The first request lists the server by name; its summary follows as an appended patch.
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[0].sections?.[MCP_SERVERS_SECTION]).toContain("- mcp__slow (tool_search)\n");
		expect(systemMessages[1].sections).toEqual({
			[MCP_SERVERS_SECTION]: expect.stringContaining("- mcp__slow (tool_search): Slow docs."),
		});
		expect(harness.session.messages.indexOf(systemMessages[1])).toBeGreaterThan(
			harness.session.messages.findIndex((message) => message.role === "assistant"),
		);
	});

	it("waits for servers with direct tools before listing the servers", async () => {
		const { harness } = await setupSlow(
			{ exposure: "direct", toolExposure: { shot: "deferred" }, instructions: "Slow docs." },
			30,
		);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(serversSection(harness)).toContain("- mcp__slow (tool_search): Slow docs.");
	});

	it("leaves servers with only direct tools out of the servers section", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 0);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(serversSection(harness)).toBeUndefined();
	});

	/**
	 * An extension tool that reaches the tools its `words` name, like a tool that calls other tools.
	 * It answers whether `mcp__<server>__search` was registered when it ran.
	 */
	const probeTool =
		(server: string): ExtensionFactory =>
		(pi) => {
			pi.registerTool({
				name: "probe",
				label: "probe",
				description: "Reaches the tools its words name.",
				parameters: Type.Object({ words: Type.Array(Type.String()) }),
				reachesTools: (input) => (input as { words: string[] }).words,
				execute: async () => {
					const registered = pi.getAllTools().some((tool) => tool.name === `mcp__${server}__search`);
					return { content: [{ type: "text", text: String(registered) }], details: undefined };
				},
			});
		};

	it("waits for the servers a tool that reaches tools names, by their namespace", async () => {
		const { harness } = await setupSlow({ name: "slow-docs", exposure: "deferred" }, 30, undefined, [
			probeTool("slow_docs"),
		]);
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "probe"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", { words: ["mcp__slow_docs__search"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "probe"))).toBe("true");
	});

	it("does not wait for servers a tool that reaches tools does not name", async () => {
		const { harness } = await setupSlow({ exposure: "deferred" }, Number.POSITIVE_INFINITY, undefined, [
			probeTool("slow"),
		]);
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "probe"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", { words: ["mcp__other"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "probe"))).toBe("false");
	});

	it("waits for servers before tool_search searches", async () => {
		const { harness } = await setupSlow({ exposure: "deferred" }, 30);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__slow__search", { query: "late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "mcp__slow__search"))).toBe("late guide\nlate faq");
	});

	it("holds the first prompt for servers with direct tools", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 30);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(declaredToolNames(harness)).toContain("mcp__slow__search");
	});

	it("holds the first prompt for servers with direct tools only up to startupWaitMs", async () => {
		const { harness, notifications } = await setupSlow({ exposure: "direct" }, Number.POSITIVE_INFINITY, 20);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
	});

	it("does not make inactive direct MCP tools callable", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		harness.session.setActiveToolsByName(["mcp__docs__search"]);

		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search"]);
	});

	it("activates tool_search for deferred MCP tools and keeps loaded tools declared on the branch", async () => {
		// No tools are active at the start; the MCP extension activates tool_search.
		const { harness, calls } = await setup("deferred");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall(searchName, { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find a docs tool");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", searchName]);
		// The description does not depend on the connected servers.
		const toolSearch = harness.session.agent.state.tools.find((tool) => tool.name === "tool_search");
		expect(toolSearch?.description).toBe(TOOL_SEARCH_DESCRIPTION);

		const search = toolResult(harness, "tool_search");
		expect(getMessageText(search)).toBe(
			`Loaded 1 tool. They are available from your next call:\n- ${searchName}: Search the docs.`,
		);
		// Only the loaded tool is added; earlier declarations are not repeated.
		const loadMessages = harness.session.messages.filter(
			(message): message is SystemMessage =>
				message.role === "system" && (message.toolsAdded ?? []).some((tool) => tool.name === searchName),
		);
		expect(loadMessages).toHaveLength(1);
		expect(loadMessages[0].toolsAdded?.map((tool) => tool.name)).toEqual([searchName]);
		expect(getMessageText(toolResult(harness, searchName))).toBe("loaded guide\nloaded faq");
		expect(calls).toEqual(['search:{"query":"loaded"}']);

		// Loads are recorded in the transcript: navigating back before the load drops the tool,
		// navigating to a later entry restores it.
		const branch = harness.sessionManager.getBranch();
		const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const last = branch.at(-1);
		if (!firstUser || !last) throw new Error("Missing entries");
		await harness.session.navigateTree(firstUser.id);
		expect(harness.session.getActiveToolNames()).not.toContain(searchName);
		await harness.session.navigateTree(last.id);
		expect(harness.session.getActiveToolNames()).toContain(searchName);
	});

	it("finds nothing to load when every matching tool is already declared", async () => {
		const { harness } = await setup("direct", undefined, { builtInTools: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "docs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(toolResult(harness, "tool_search"))).toBe("No matching tools found.");
	});
});

describe("AgentSession MCP servers registered by extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** `configured` are the mcp.json servers; `plugins` register servers through the extension API. */
	async function setup(plugins: ExtensionFactory | ExtensionFactory[], configured: McpServerEntry[] = []) {
		const connected: McpServerEntry[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				...(Array.isArray(plugins) ? plugins : [plugins]),
				createMcpExtension({
					loadConfig: () => ({ servers: configured, errors: [] }),
					createTransport: (entry) => {
						connected.push(entry);
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	it("connects servers registered while extensions load", async () => {
		const { harness, connected } = await setup((pi) => {
			pi.registerMcpServer("plugin", { url: "http://plugin.invalid", exposure: "direct" });
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(connected.map((entry) => [entry.name, entry.scope])).toEqual([["plugin", "extension"]]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__plugin__search");
	});

	it("connects and disconnects servers registered during the session", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, connected } = await setup((pi) => {
			api = pi;
		});
		if (!api) throw new Error("No extension API");
		const pi = api;

		pi.registerMcpServer("late", { url: "http://late.invalid" });
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__late__search"));
		expect(connected.map((entry) => entry.name)).toEqual(["late"]);
		// The default exposure is direct, so the tools are declared right away.
		expect(harness.session.getActiveToolNames()).toContain("mcp__late__search");

		pi.unregisterMcpServer("late");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).not.toContain("mcp__late__search"));
	});

	// "my_docs" shares the namespace of "my-docs" (#10239).
	it.each(["my-docs", "my_docs"])("prefers the mcp.json server over a registered %s", async (name) => {
		const configured: McpServerEntry = {
			name: "my-docs",
			config: { url: "http://config.invalid" },
			source: "mcp.json",
		};
		const { connected } = await setup(
			(pi) => {
				pi.registerMcpServer(name, { url: "http://plugin.invalid" });
			},
			[configured],
		);
		await vi.waitFor(() => expect(connected).toEqual([configured]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connected).toEqual([configured]);
	});

	it("rejects names another extension registered", async () => {
		const errors: string[] = [];
		await setup([
			(pi) => {
				pi.registerMcpServer("taken", { url: "http://x.invalid" });
				// Registering again replaces the extension's own registration.
				pi.registerMcpServer("taken", { url: "http://y.invalid" });
				pi.registerMcpServer("my-server", { url: "http://x.invalid" });
			},
			(pi) => {
				for (const name of ["taken", "my_server"]) {
					try {
						pi.registerMcpServer(name, { url: "http://z.invalid" });
					} catch (caught) {
						errors.push(String(caught));
					}
				}
			},
		]);
		expect(errors).toEqual([
			expect.stringMatching(/MCP server "taken" is already registered by extension/),
			// Names that differ only in - and _ share a namespace (#10239).
			'Error: MCP server "my_server" conflicts with registered server "my-server"',
		]);
	});

	it("reports registered servers when no extension connects them", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => pi.registerMcpServer("orphan", { url: "http://orphan.invalid" })],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });

		expect(errors).toEqual([expect.stringContaining('MCP server "orphan" is registered, but no loaded extension')]);
	});
});

describe("AgentSession MCP tools after resume and reload", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/**
	 * A deferred `docs` server that answers `initialize` after `initializeDelayMs`; `connected` counts
	 * its connections. `/reload` loads the extensions again.
	 */
	async function setup(
		sessionManager?: SessionManager,
		extensionFactories: ExtensionFactory[] = [],
		initializeDelayMs = 0,
	) {
		const connected: string[] = [];
		const servers: McpServerEntry[] = [
			{ name: "docs", config: { url: "http://unused.invalid", exposure: "deferred" }, source: "test" },
		];
		const factories = [
			...extensionFactories,
			createToolSearchExtension(),
			createMcpExtension({
				loadConfig: () => ({ servers, errors: [] }),
				createTransport: (entry) => {
					connected.push(entry.name);
					const pair = createFakeServer([], { initializeDelayMs });
					void pair.server.start();
					return pair.client;
				},
			}),
		];
		let extensions = await createTestExtensionsResult(factories);
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult(factories);
			},
		};
		const harness = await createHarness({ resourceLoader, sessionManager });
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	async function loadDocsSearch(harness: Harness) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await harness.session.prompt("load");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
	}

	it("declares tools tool_search loaded again on resume once their server connects", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		// The session restores its tools before the server connects again.
		const second = await setup(first.harness.sessionManager);
		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");

		expect(getMessageText(toolResult(second.harness, "mcp__docs__search"))).toBe("again guide\nagain faq");
		const removals = second.harness.session.messages.filter(
			(message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0,
		);
		expect(removals).toEqual([]);
	});

	it.each([
		["drops", ["read"], false],
		["keeps", undefined, true],
	] as const)(
		"%s restored tools when an extension sets the loadout before they register",
		async (_, loadout, kept) => {
			const first = await setup();
			await loadDocsSearch(first.harness);

			// Like plan mode restoring its tools, or an extension adding one to the current loadout.
			const setLoadout: ExtensionFactory = (pi) => {
				pi.on("session_start", () => pi.setActiveTools(loadout ? [...loadout] : [...pi.getActiveTools(), "read"]));
			};
			const second = await setup(first.harness.sessionManager, [setLoadout]);
			await vi.waitFor(() =>
				expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);

			expect(second.harness.session.getActiveToolNames().includes("mcp__docs__search")).toBe(kept);
		},
	);

	it("does not activate restored tools that register after the next prompt starts", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		// The first prompt does not wait for servers without direct tools.
		const second = await setup(first.harness.sessionManager, [], 200);
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		await vi.waitFor(() =>
			expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);

		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it("declares tools tool_search loaded again after /reload", async () => {
		const { harness, connected } = await setup();
		await loadDocsSearch(harness);

		await harness.session.reload();

		await vi.waitFor(() => expect(connected).toEqual(["docs", "docs"]));
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
	});
});
