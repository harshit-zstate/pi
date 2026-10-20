import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { loadToolFolders, ToolFolderRuntime } from "../src/core/tool-folders/index.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** Reads one JSON request from stdin and passes it to `body`, which prints the result. */
function stdinScript(body: string): string {
	return `let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
	const request = JSON.parse(raw);
	${body}
});
`;
}

/** Answers JSONL requests, keeping a counter across calls. Input `{crash: true}` exits. */
const COUNTER_SCRIPT = `const { createInterface } = require("node:readline");
let count = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.input.crash) process.exit(3);
	const current = ++count;
	setTimeout(() => {
		process.stdout.write(JSON.stringify({ id: request.id, result: "count=" + current + " pid=" + process.pid }) + "\\n");
	}, request.input.delayMs ?? 0);
});
`;

interface ToolFiles {
	info: string;
	files?: Record<string, string>;
}

function writeGroup(
	root: string,
	group: string,
	groupInfo: string | undefined,
	tools: Record<string, ToolFiles>,
): void {
	const groupDir = join(root, group);
	mkdirSync(groupDir, { recursive: true });
	if (groupInfo !== undefined) writeFileSync(join(groupDir, "group_info.yml"), groupInfo);
	for (const [name, tool] of Object.entries(tools)) {
		const toolDir = join(groupDir, name);
		mkdirSync(toolDir, { recursive: true });
		writeFileSync(join(toolDir, "info.yml"), tool.info);
		for (const [file, content] of Object.entries(tool.files ?? {})) writeFileSync(join(toolDir, file), content);
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join("\n");
}

describe("tool folders", () => {
	let tempDir: string;
	let root: string;
	let cwd: string;
	const runtimes: ToolFolderRuntime[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-tool-folders-"));
		root = join(tempDir, "tools");
		cwd = join(tempDir, "work");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		for (const runtime of runtimes.splice(0)) runtime.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function load(...roots: string[]): Promise<ToolFolderRuntime> {
		const runtime = await ToolFolderRuntime.load(roots.length > 0 ? roots : [root]);
		runtimes.push(runtime);
		return runtime;
	}

	function run(
		runtime: ToolFolderRuntime,
		name: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>> {
		const definition = runtime.definitions.find((candidate) => candidate.name === name);
		if (!definition) throw new Error(`No tool ${name}`);
		return definition.execute(`call-${name}`, params, signal, undefined, { cwd } as ExtensionToolContext);
	}

	it("builds definitions from group_info.yml and info.yml", async () => {
		writeGroup(root, "imaging", "description: Inspect studies.\nguidelines:\n  - View before marking.\n", {
			view: {
				info: [
					"description: |-",
					"  Render a slice.",
					"  Second line.",
					"parameters:",
					"  type: object",
					"  properties:",
					"    index: { type: integer, minimum: 0 }",
					"  required: [index]",
					"output:",
					"  description: One PNG.",
					"execution: sequential",
				].join("\n"),
				files: { "impl.ts": "export default () => 'ok';\n" },
			},
		});

		const runtime = await load();

		expect(runtime.errors).toEqual([]);
		const [definition] = runtime.definitions;
		expect(definition).toMatchObject({
			name: "view",
			description: "Render a slice.\nSecond line.\n\nReturns: One PNG.",
			promptSnippet: "Render a slice.",
			promptGuidelines: ["View before marking."],
			namespace: { name: "imaging", description: "Inspect studies." },
			executionMode: "sequential",
			parameters: { type: "object", required: ["index"] },
		});
	});

	it("runs in-process impls with input and context", async () => {
		writeGroup(root, "demo", undefined, {
			echo: {
				info: "description: Echo.\n",
				files: {
					"impl.ts": [
						"export default async (input: { text: string }, ctx: { cwd: string; toolDir: string }) => ({",
						"\tcontent: [{ type: 'text', text: input.text + '@' + ctx.cwd }],",
						"\tdetails: { toolDir: ctx.toolDir },",
						"});",
					].join("\n"),
				},
			},
		});

		const result = await run(await load(), "echo", { text: "hi" });

		expect(textOf(result)).toBe(`hi@${cwd}`);
		expect(result.details).toEqual({ toolDir: join(root, "demo", "echo") });
	});

	it("runs per-call executables with JSON or plain-text stdout", async () => {
		writeGroup(root, "demo", undefined, {
			json_out: {
				info: 'description: JSON.\ncommand: ["node", "run.cjs"]\n',
				files: {
					"run.cjs": stdinScript(
						"process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: 'n=' + request.input.n + ' cwd=' + request.cwd }], isError: request.input.n < 0 }));",
					),
				},
			},
			text_out: {
				info: 'description: Text.\ncommand: ["node", "run.cjs"]\n',
				files: { "run.cjs": stdinScript("process.stdout.write('plain ' + request.callId);") },
			},
		});
		const runtime = await load();

		expect(textOf(await run(runtime, "json_out", { n: 2 }))).toBe(`n=2 cwd=${cwd}`);
		expect((await run(runtime, "json_out", { n: -1 })).isError).toBe(true);
		expect(textOf(await run(runtime, "text_out"))).toBe("plain call-text_out");
	});

	it("reports a failing executable's stderr and enforces timeout_ms", async () => {
		writeGroup(root, "demo", undefined, {
			fails: {
				info: 'description: Fails.\ncommand: ["node", "run.cjs"]\n',
				files: { "run.cjs": stdinScript("process.stderr.write('series not found'); process.exit(2);") },
			},
			slow: {
				info: 'description: Slow.\ncommand: ["node", "run.cjs"]\ntimeout_ms: 300\n',
				files: { "run.cjs": stdinScript("setTimeout(() => {}, 10000);") },
			},
		});
		const runtime = await load();

		await expect(run(runtime, "fails")).rejects.toThrow("series not found");
		await expect(run(runtime, "slow")).rejects.toThrow("timed out after 300 ms");
	});

	it("kills a per-call executable on abort", async () => {
		writeGroup(root, "demo", undefined, {
			slow: {
				info: 'description: Slow.\ncommand: ["node", "run.cjs"]\n',
				files: { "run.cjs": stdinScript("setTimeout(() => {}, 10000);") },
			},
		});
		const runtime = await load();
		const controller = new AbortController();
		const call = run(runtime, "slow", {}, controller.signal);
		setTimeout(() => controller.abort(), 100);

		await expect(call).rejects.toThrow("aborted");
	});

	it("keeps one persistent process across concurrent calls and restarts it after a crash", async () => {
		writeGroup(root, "demo", undefined, {
			counter: {
				info: 'description: Count.\ncommand: ["node", "counter.cjs"]\nruntime: persistent\n',
				files: { "counter.cjs": COUNTER_SCRIPT },
			},
		});
		const runtime = await load();

		// The first call answers last, so responses are matched by id, not order.
		const results = await Promise.all([
			run(runtime, "counter", { delayMs: 150 }),
			run(runtime, "counter"),
			run(runtime, "counter"),
		]);
		const texts = results.map(textOf);
		const pids = new Set(texts.map((text) => text.split(" pid=")[1]));
		expect(pids.size).toBe(1);
		expect(texts.map((text) => text.split(" ")[0]).sort()).toEqual(["count=1", "count=2", "count=3"]);

		await expect(run(runtime, "counter", { crash: true })).rejects.toThrow("exited with code 3");
		const restarted = textOf(await run(runtime, "counter"));
		expect(restarted.startsWith("count=1 ")).toBe(true);
		expect(pids.has(restarted.split(" pid=")[1])).toBe(false);
	});

	it("loads images by path and by base64 data", async () => {
		writeFileSync(join(cwd, "slice.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
		writeGroup(root, "demo", undefined, {
			image: {
				info: "description: Image.\n",
				files: {
					"impl.ts": [
						"export default () => [",
						"\t{ type: 'text', text: 'slice' },",
						"\t{ type: 'image', path: 'slice.png' },",
						`\t{ type: 'image', data: '${TINY_PNG_BASE64}' },`,
						"\t{ type: 'image', path: 'missing.png' },",
						"];",
					].join("\n"),
				},
			},
		});

		const result = await run(await load(), "image");

		expect(result.content).toEqual([
			{ type: "text", text: "slice" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			{ type: "text", text: expect.stringContaining("[Image omitted: cannot read") },
		]);
	});

	it("reports invalid folders and keeps loading the rest", async () => {
		writeGroup(root, "bad", undefined, {
			no_description: { info: "parameters: { type: object }\n", files: { "impl.ts": "" } },
			two_impls: { info: "description: x\n", files: { "impl.ts": "", "impl.py": "" } },
			no_impl: { info: "description: x\n" },
			"bad name": { info: "description: x\n", files: { "impl.ts": "" } },
			array_params: { info: "description: x\nparameters: { type: array }\n", files: { "impl.ts": "" } },
			ok: { info: "description: Fine.\n", files: { "impl.ts": "" } },
		});

		const result = await loadToolFolders([root]);

		expect(result.tools.map((tool) => tool.info.name)).toEqual(["ok"]);
		const errors = Object.fromEntries(
			result.errors.map(({ path, error }) => [path.split("/").at(-2), error] as const),
		);
		expect(errors).toEqual({
			no_description: '"description" is required',
			two_impls: 'several impl files (impl.py, impl.ts); keep one or set "command"',
			no_impl: 'no impl file and no "command" in info.yml',
			"bad name": 'tool name "bad name" must match ^[a-zA-Z0-9_-]{1,64}$',
			array_params: '"parameters" must be a JSON Schema with type: object',
		});
	});

	it("lets later roots override tools and rejects duplicates within a root", async () => {
		const later = join(tempDir, "later");
		writeGroup(root, "a", undefined, { view: { info: "description: Base view.\n", files: { "impl.ts": "" } } });
		writeGroup(root, "b", undefined, {
			dup: { info: "name: view\ndescription: Duplicate.\n", files: { "impl.ts": "" } },
		});
		writeGroup(later, "c", undefined, { view: { info: "description: Variant view.\n", files: { "impl.ts": "" } } });

		const result = await loadToolFolders([root, later, join(tempDir, "missing")]);

		expect(result.tools.map((tool) => [tool.info.name, tool.info.description])).toEqual([["view", "Variant view."]]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain('tool name "view" is also used by');
	});

	it("honors the group_info.yml tools list for order and selection", async () => {
		writeGroup(root, "g", "tools: [second, first]\n", {
			first: { info: "description: First.\n", files: { "impl.ts": "" } },
			second: { info: "description: Second.\n", files: { "impl.ts": "" } },
			unlisted: { info: "description: Unlisted.\n", files: { "impl.ts": "" } },
		});

		const result = await loadToolFolders([root]);

		expect(result.tools.map((tool) => tool.info.name)).toEqual(["second", "first"]);
	});

	it("lists tools under their group in the system prompt", () => {
		const sections = buildSystemPromptSections({
			cwd: "/work",
			selectedTools: ["helper", "view", "mark"],
			toolSnippets: { helper: "Help.", view: "View a slice.", mark: "Mark a finding." },
			toolGroups: {
				view: { name: "imaging", description: "Inspect studies." },
				mark: { name: "imaging", description: "Inspect studies." },
			},
		});

		expect(sections.tools).toBe(
			"<tools>\n- helper: Help.\n\nimaging: Inspect studies.\n- view: View a slice.\n- mark: Mark a finding.\n</tools>",
		);
	});
});
