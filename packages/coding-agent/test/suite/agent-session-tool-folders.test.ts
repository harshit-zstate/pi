import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ToolFolderRuntime } from "../../src/core/tool-folders/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** One group with an executable tool that writes a PNG and returns its path. */
function writeImagingTools(root: string): void {
	const toolDir = join(root, "imaging", "view_slice");
	mkdirSync(toolDir, { recursive: true });
	writeFileSync(
		join(root, "imaging", "group_info.yml"),
		"description: Inspect imaging studies.\nguidelines:\n  - View a slice before describing it.\n",
	);
	writeFileSync(
		join(toolDir, "info.yml"),
		[
			"description: Render one slice as PNG.",
			'command: ["node", "render.cjs"]',
			"parameters:",
			"  type: object",
			"  properties:",
			"    index: { type: integer }",
			"  required: [index]",
		].join("\n"),
	);
	writeFileSync(
		join(toolDir, "render.cjs"),
		`const { writeFileSync } = require("node:fs");
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
	const { input } = JSON.parse(raw);
	writeFileSync("slice.png", Buffer.from("${TINY_PNG_BASE64}", "base64"));
	process.stdout.write(JSON.stringify({ content: ["slice " + input.index, { type: "image", path: "slice.png" }] }));
});
`,
	);
}

describe("AgentSession tool folders", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("declares folder tools, lists them by group, and returns their images to the model", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-tool-folders-"));
		dirs.push(root);
		writeImagingTools(root);
		const toolFolders = await ToolFolderRuntime.load([root]);
		const harness = await createHarness({ toolFolders });
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toEqual(["view_slice"]);
		expect(harness.session.systemPrompt).toContain(
			"imaging: Inspect imaging studies.\n- view_slice: Render one slice as PNG.",
		);
		expect(harness.session.systemPrompt).toContain("- View a slice before describing it.");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("view_slice", { index: 3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("show slice 3");

		const result = getToolResult(harness, "view_slice");
		expect(result.isError).toBe(false);
		expect(result.content[0]).toEqual({ type: "text", text: "slice 3" });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});
});
