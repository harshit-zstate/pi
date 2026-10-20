#!/usr/bin/env node

// Runs a pi binary (or dist/bundle cli.js) against a fake OpenAI-compatible server. The fake model
// calls two tool-folder tools in one turn: an in-process `impl.ts` returning a text marker, and an
// executable impl returning a PNG by path. The second request must carry both results.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const MODULE_MARKER = "PI_TOOL_FOLDER_MODULE_OK";
const SUCCESS_MARKER = "PI_TOOL_FOLDERS_BINARY_SMOKE_OK";
const FAILURE_MARKER = "PI_TOOL_FOLDERS_BINARY_SMOKE_FAILED";
const TIMEOUT_MS = 30_000;
// 1x1 PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function completionChunk(id, delta, finishReason = null, usage) {
	return {
		id,
		object: "chat.completion.chunk",
		created: 0,
		model: "tool-folders-smoke",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

function sendCompletion(response, chunks) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "close",
	});
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

async function readRequest(request) {
	let body = "";
	for await (const chunk of request) body += chunk.toString();
	return body;
}

function toolCall(index, id, name, args) {
	return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** The follow-up request has the module tool's text and the executable tool's image. */
function requestHasResults(body) {
	const messages = JSON.parse(body).messages;
	if (!Array.isArray(messages)) return false;
	const text = messages.some((message) => message?.role === "tool" && JSON.stringify(message.content).includes(MODULE_MARKER));
	const image = JSON.stringify(messages).includes("data:image/png;base64,");
	return text && image;
}

async function writeTools(root) {
	const group = join(root, "smoke");
	await mkdir(join(group, "echo_marker"), { recursive: true });
	await mkdir(join(group, "dot_image"), { recursive: true });
	await writeFile(join(group, "group_info.yml"), "description: Smoke test tools.\n");
	await writeFile(
		join(group, "echo_marker", "info.yml"),
		"description: Return a marker.\nparameters:\n  type: object\n  properties:\n    suffix: { type: string }\n",
	);
	await writeFile(
		join(group, "echo_marker", "impl.ts"),
		`export default async function (input: { suffix?: string }): Promise<string> {\n\treturn "${MODULE_MARKER}" + (input.suffix ?? "");\n}\n`,
	);
	await writeFile(
		join(group, "dot_image", "info.yml"),
		'description: Draw a dot.\ncommand: ["node", "draw.cjs"]\noutput:\n  description: A PNG.\n',
	);
	await writeFile(
		join(group, "dot_image", "draw.cjs"),
		`const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
	const request = JSON.parse(raw);
	const path = join(request.cwd, "dot.png");
	writeFileSync(path, Buffer.from("${PNG_BASE64}", "base64"));
	process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "dot" }, { type: "image", path }] }));
});
`,
	);
}

async function main() {
	const binaryArg = process.argv[2];
	if (!binaryArg || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/smoke-test-tool-folders-binary.mjs <pi-binary>");
	}
	const binary = resolve(binaryArg);
	const tempDir = await mkdtemp(join(tmpdir(), "pi-tool-folders-binary-smoke-"));
	let requestCount = 0;
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const body = await readRequest(request);
		requestCount++;
		const id = `chatcmpl-tool-folders-smoke-${requestCount}`;
		if (requestCount === 1) {
			sendCompletion(response, [
				completionChunk(id, {
					role: "assistant",
					tool_calls: [
						toolCall(0, "call_echo", "echo_marker", { suffix: "" }),
						toolCall(1, "call_dot", "dot_image", {}),
					],
				}),
				completionChunk(id, {}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1 }),
			]);
			return;
		}
		const marker = requestHasResults(body) ? SUCCESS_MARKER : FAILURE_MARKER;
		sendCompletion(response, [
			completionChunk(id, { role: "assistant", content: marker }),
			completionChunk(id, {}, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
		]);
	});

	try {
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Smoke-test server did not bind to a TCP port");
		await writeFile(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					"tool-folders-smoke": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						apiKey: "smoke-test",
						models: [{ id: "tool-folders-smoke", input: ["text", "image"] }],
					},
				},
			}),
		);
		const toolsDir = join(tempDir, "tools");
		await writeTools(toolsDir);

		const piArgs = [
			"--provider",
			"tool-folders-smoke",
			"--model",
			"tool-folders-smoke",
			"--tools-dir",
			toolsDir,
			"--no-tool-dirs",
			"--print",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"Run the tool folders binary smoke test.",
		];
		const javaScript = extname(binary) === ".js";
		const child = spawn(javaScript ? process.execPath : binary, javaScript ? [binary, ...piArgs] : piArgs, {
			cwd: tempDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempDir,
				PI_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exitCode = await new Promise((resolveExit, reject) => {
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`Smoke test timed out after ${TIMEOUT_MS} ms`));
			}, TIMEOUT_MS);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
		});
		if (exitCode !== 0 || !stdout.includes(SUCCESS_MARKER) || requestCount < 2) {
			throw new Error(
				`Tool folders binary smoke test failed (exit ${exitCode}, requests ${requestCount})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		process.stdout.write(stdout);
	} finally {
		await new Promise((resolveClose) => server.close(resolveClose));
		await rm(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
