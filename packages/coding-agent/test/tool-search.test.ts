import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolExposure, ToolInfo } from "../src/core/extensions/types.ts";
import {
	Bm25Ranker,
	createToolSearchDocument,
	createToolSearchToolDefinition,
	tokenize,
} from "../src/extensions/tool-search/tool.ts";

function tool(name: string, description: string, properties: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Unsafe({ type: "object", properties }),
		execute: async () => ({ content: [], details: undefined }),
	};
}

describe("tokenize", () => {
	it("splits camelCase and snake_case, drops stop words, and folds plurals", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		expect(tokenize("searches queries HTTPServer")).toEqual(["search", "query", "http", "server"]);
	});
});

describe("Bm25Ranker", () => {
	const tools = [
		tool("mcp__github__list_issues", "List issues in a repository.", {
			state: { type: "string", description: "open or closed" },
		}),
		tool("mcp__github__create_pull_request", "Open a pull request."),
		tool("mcp__linear__search_issues", "Search Linear issues by text."),
		tool("mcp__docs__search", "Search the documentation."),
	];
	const documents = tools.map((entry) => createToolSearchDocument(entry));

	it("ranks by term relevance and respects the limit", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("issue", documents, 8).map((match) => match.name)).toEqual([
			"mcp__linear__search_issues",
			"mcp__github__list_issues",
		]);
		expect(ranker.rank("pull requests", documents, 8)[0].name).toBe("mcp__github__create_pull_request");
		expect(ranker.rank("search", documents, 1)).toHaveLength(1);
		// Property names and descriptions are searchable.
		expect(ranker.rank("closed", documents, 8).map((match) => match.name)).toEqual(["mcp__github__list_issues"]);
	});

	it("returns nothing for unknown or empty queries", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("kubernetes", documents, 8)).toEqual([]);
		expect(ranker.rank("the", documents, 8)).toEqual([]);
		// Known v1 limit: no synonyms, so "tickets" does not find "issues".
		expect(ranker.rank("tickets", documents, 8)).toEqual([]);
	});

	it("includes the namespace in the search text", () => {
		const document = createToolSearchDocument(tool("mcp__x__run", "Run it."), {
			name: "mcp__x",
			description: "Kubernetes cluster tools",
		});
		expect(new Bm25Ranker().rank("kubernetes", [document], 8)).toEqual([
			{ name: "mcp__x__run", score: expect.any(Number) },
		]);
	});
});

describe("tool_search", () => {
	const registered: { name: string; description: string; exposure: ToolExposure }[] = [
		{ name: "mcp__docs__search", description: "Search the docs.", exposure: "deferred" },
		// Extension tools may still use the `codemode` exposure; tool_search finds them like deferred ones.
		{ name: "ext_search_notes", description: "Search the notes.", exposure: "codemode" },
		{ name: "direct_search", description: "Search directly.", exposure: "direct" },
		{ name: "hidden_search", description: "Search hidden.", exposure: "hidden" },
		{ name: "loaded_search", description: "Search, already loaded.", exposure: "deferred" },
	];

	it("loads matching deferred and codemode tools that are not active yet", async () => {
		let active = ["direct_search", "loaded_search"];
		const tools = {
			getAllTools: () =>
				registered.map((entry) => ({
					...entry,
					parameters: Type.Object({}),
				})) as unknown as ToolInfo[],
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
		};
		const definition = createToolSearchToolDefinition({ tools });
		const result = await definition.execute("call", { query: "search" }, undefined, undefined, {} as never);
		expect(result.details.loaded.sort()).toEqual(["ext_search_notes", "mcp__docs__search"]);
		expect(active.slice(0, 2)).toEqual(["direct_search", "loaded_search"]);
		expect(active.slice(2).sort()).toEqual(["ext_search_notes", "mcp__docs__search"]);
	});
});
