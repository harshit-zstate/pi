/**
 * Discovers tools from folder roots laid out as `<root>/<group>/<tool>/info.yml`.
 *
 * Each group folder may hold `group_info.yml`; each tool folder holds `info.yml` and an `impl`
 * file. `impl.ts`/`impl.js`/... run in-process; any other `impl*` file (or `command` in
 * `info.yml`) runs as a subprocess that speaks JSON. Startup only reads YAML: impl modules and
 * processes start on a tool's first call.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { parse } from "yaml";

export const GROUP_INFO_FILE = "group_info.yml";
export const TOOL_INFO_FILE = "info.yml";

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);
/** Interpreters for executable impls that need not have the executable bit or a shebang. */
const INTERPRETERS: Record<string, string> = {
	".py": "python3",
	".sh": "bash",
	".rb": "ruby",
	".pl": "perl",
};

export type ToolRuntime = "per-call" | "persistent";

export type ToolImpl = { kind: "module"; path: string } | { kind: "process"; command: string[]; runtime: ToolRuntime };

export interface ToolGroupInfo {
	name: string;
	description?: string;
	/** Rules added to the system prompt while any tool of the group is active. */
	guidelines: string[];
	dir: string;
}

export interface ToolFolderInfo {
	name: string;
	description: string;
	/** JSON Schema of the tool input (an object schema). */
	parameters: Record<string, unknown>;
	/** What the tool returns, appended to the model-facing description. */
	outputDescription?: string;
	executionMode?: ToolExecutionMode;
	/** False when the tool is off unless named in `--tools`, `defaultTools`, or `setActiveTools()`. */
	defaultActive: boolean;
	/** Subprocess time limit per call. */
	timeoutMs?: number;
	impl: ToolImpl;
	dir: string;
}

export interface LoadedFolderTool {
	group: ToolGroupInfo;
	info: ToolFolderInfo;
}

export interface ToolFolderLoadResult {
	tools: LoadedFolderTool[];
	errors: Array<{ path: string; error: string }>;
}

class ToolFolderError extends Error {}

function fail(message: string): never {
	throw new ToolFolderError(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) fail(`${what} must be a mapping`);
	return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") fail(`"${key}" must be a string`);
	const trimmed = value.trim();
	return trimmed || undefined;
}

function optionalStringList(record: Record<string, unknown>, key: string): string[] | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		fail(`"${key}" must be a list of strings`);
	}
	return value;
}

async function readYaml(path: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return asRecord(parse(text), basename(path));
}

async function listDirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path)).isDirectory())) dirs.push(entry.name);
	}
	return dirs.sort();
}

/** Resolve command arguments that name files in the tool folder, so they work from any cwd. */
function resolveCommand(command: string[], toolDir: string): string[] {
	return command.map((arg) => {
		if (isAbsolute(arg)) return arg;
		const candidate = resolve(toolDir, arg);
		return existsSync(candidate) ? candidate : arg;
	});
}

async function resolveImpl(toolDir: string, record: Record<string, unknown>): Promise<ToolImpl> {
	const runtimeValue = record.runtime ?? "per-call";
	if (runtimeValue !== "per-call" && runtimeValue !== "persistent") {
		fail(`"runtime" must be "per-call" or "persistent"`);
	}
	const runtime: ToolRuntime = runtimeValue;
	const command = optionalStringList(record, "command");
	if (command) {
		if (command.length === 0) fail(`"command" must not be empty`);
		return { kind: "process", command: resolveCommand(command, toolDir), runtime };
	}

	const impls = (await readdir(toolDir)).filter((name) => name === "impl" || name.startsWith("impl.")).sort();
	if (impls.length === 0) fail(`no impl file and no "command" in ${TOOL_INFO_FILE}`);
	if (impls.length > 1) fail(`several impl files (${impls.join(", ")}); keep one or set "command"`);
	const implPath = join(toolDir, impls[0]!);
	const extension = extname(implPath);
	if (MODULE_EXTENSIONS.has(extension)) {
		if (record.runtime !== undefined) fail(`"runtime" applies only to executable impls, not ${impls[0]}`);
		return { kind: "module", path: implPath };
	}
	const interpreter = INTERPRETERS[extension];
	return { kind: "process", command: interpreter ? [interpreter, implPath] : [implPath], runtime };
}

function parseParameters(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return { type: "object", properties: {} };
	const schema = asRecord(value, `"parameters"`);
	if (schema.type !== "object") fail(`"parameters" must be a JSON Schema with type: object`);
	return { properties: {}, ...schema };
}

async function loadTool(group: ToolGroupInfo, toolDir: string): Promise<LoadedFolderTool | undefined> {
	const record = await readYaml(join(toolDir, TOOL_INFO_FILE));
	if (!record) return undefined;
	const name = optionalString(record, "name") ?? basename(toolDir);
	if (!TOOL_NAME.test(name)) fail(`tool name "${name}" must match ${TOOL_NAME.source}`);
	const description = optionalString(record, "description") ?? fail(`"description" is required`);
	const output = asRecord(record.output, `"output"`);
	const execution = record.execution;
	if (execution !== undefined && execution !== "parallel" && execution !== "sequential") {
		fail(`"execution" must be "parallel" or "sequential"`);
	}
	const defaultActive = record.default_active ?? true;
	if (typeof defaultActive !== "boolean") fail(`"default_active" must be true or false`);
	const timeoutMs = record.timeout_ms;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
		fail(`"timeout_ms" must be a positive number`);
	}
	return {
		group,
		info: {
			name,
			description,
			parameters: parseParameters(record.parameters),
			outputDescription: optionalString(output, "description"),
			executionMode: execution,
			defaultActive,
			timeoutMs,
			impl: await resolveImpl(toolDir, record),
			dir: toolDir,
		},
	};
}

async function loadGroup(groupDir: string, result: ToolFolderLoadResult): Promise<LoadedFolderTool[]> {
	const groupInfoPath = join(groupDir, GROUP_INFO_FILE);
	let group: ToolGroupInfo;
	let order: string[] | undefined;
	try {
		const record = (await readYaml(groupInfoPath)) ?? {};
		group = {
			name: optionalString(record, "name") ?? basename(groupDir),
			description: optionalString(record, "description"),
			guidelines: optionalStringList(record, "guidelines") ?? [],
			dir: groupDir,
		};
		order = optionalStringList(record, "tools");
	} catch (error) {
		result.errors.push({ path: groupInfoPath, error: errorMessage(error) });
		return [];
	}

	const toolDirs = order ?? (await listDirs(groupDir));
	const tools = await Promise.all(
		toolDirs.map(async (dirName) => {
			const toolDir = join(groupDir, dirName);
			try {
				const tool = await loadTool(group, toolDir);
				if (!tool && order) fail(`listed in ${GROUP_INFO_FILE} but has no ${TOOL_INFO_FILE}`);
				return tool;
			} catch (error) {
				result.errors.push({ path: join(toolDir, TOOL_INFO_FILE), error: errorMessage(error) });
				return undefined;
			}
		}),
	);
	return tools.filter((tool): tool is LoadedFolderTool => tool !== undefined);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Load every tool under `roots`, in order. A later root's tool replaces an earlier tool of the
 * same name; two tools with one name in the same root are an error. Missing roots are skipped.
 */
export async function loadToolFolders(roots: readonly string[]): Promise<ToolFolderLoadResult> {
	const result: ToolFolderLoadResult = { tools: [], errors: [] };
	const perRoot = await Promise.all(
		roots.map(async (root) => {
			if (!existsSync(root)) return [];
			try {
				const groups = await listDirs(root);
				return (await Promise.all(groups.map((group) => loadGroup(join(root, group), result)))).flat();
			} catch (error) {
				result.errors.push({ path: root, error: errorMessage(error) });
				return [];
			}
		}),
	);

	const byName = new Map<string, LoadedFolderTool>();
	for (const tools of perRoot) {
		const seenInRoot = new Map<string, LoadedFolderTool>();
		for (const tool of tools) {
			const duplicate = seenInRoot.get(tool.info.name);
			if (duplicate) {
				result.errors.push({
					path: join(tool.info.dir, TOOL_INFO_FILE),
					error: `tool name "${tool.info.name}" is also used by ${duplicate.info.dir}`,
				});
				continue;
			}
			seenInRoot.set(tool.info.name, tool);
			byName.delete(tool.info.name);
			byName.set(tool.info.name, tool);
		}
	}
	result.tools = [...byName.values()];
	return result;
}
