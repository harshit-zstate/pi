import { delimiter, join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { importModuleDefault } from "../extensions/loader.ts";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { type LoadedFolderTool, loadToolFolders, type ToolFolderInfo, type ToolFolderLoadResult } from "./loader.ts";
import { PersistentToolProcess, runToolProcess, type ToolRequest } from "./process-runtime.ts";
import { normalizeToolOutput } from "./result.ts";

export {
	GROUP_INFO_FILE,
	type LoadedFolderTool,
	loadToolFolders,
	TOOL_INFO_FILE,
	type ToolFolderInfo,
	type ToolFolderLoadResult,
	type ToolGroupInfo,
	type ToolImpl,
	type ToolRuntime,
} from "./loader.ts";
export { normalizeToolOutput } from "./result.ts";

/** Environment variable with extra tool folder roots, separated like PATH. */
export const ENV_TOOLS_DIR = "PI_TOOLS_DIR";

/** Context passed to in-process impls (`impl.ts`, `impl.js`, ...) as the second argument. */
export interface ToolImplContext {
	/** Session working directory. */
	cwd: string;
	/** The tool's folder. */
	toolDir: string;
	callId: string;
	signal: AbortSignal | undefined;
	/** Stream partial output; same shapes as the return value. */
	onUpdate: (partial: unknown) => void;
	/** Extension context: model, session manager, UI. */
	extension: ExtensionToolContext;
}

/** Default export of an in-process impl. Returns a string, content blocks, or `{ content, details, isError }`. */
export type ToolImplFunction = (input: Record<string, unknown>, context: ToolImplContext) => unknown;

/**
 * Tool folder roots, lowest precedence first: `<agentDir>/tools`, `<cwd>/.pi/tools` (only for a
 * trusted project, since tools run code), `PI_TOOLS_DIR`, the `toolDirs` setting, then
 * `--tools-dir` paths.
 */
export function resolveToolFolderRoots(options: {
	cwd: string;
	agentDir: string;
	includeDefaults: boolean;
	projectTrusted: boolean;
	settingsDirs?: readonly string[];
	cliDirs?: readonly string[];
}): string[] {
	const roots: string[] = [];
	if (options.includeDefaults) {
		roots.push(join(options.agentDir, "tools"));
		if (options.projectTrusted) roots.push(join(options.cwd, CONFIG_DIR_NAME, "tools"));
		const envDirs = process.env[ENV_TOOLS_DIR];
		if (envDirs) roots.push(...envDirs.split(delimiter).filter(Boolean));
		roots.push(...(options.settingsDirs ?? []));
	}
	roots.push(...(options.cliDirs ?? []));
	return [...new Set(roots.map((root) => resolvePath(root, options.cwd)))];
}

function describe(info: ToolFolderInfo): string {
	return info.outputDescription ? `${info.description}\n\nReturns: ${info.outputDescription}` : info.description;
}

/**
 * Turns loaded tool folders into tool definitions. Owns the impl modules and persistent processes
 * the tools start; call {@link dispose} when the session ends.
 */
export class ToolFolderRuntime {
	/** Roots the tools were loaded from, lowest precedence first. */
	readonly roots: readonly string[];
	readonly tools: readonly LoadedFolderTool[];
	/** Folders that failed to load. Their tools are skipped. */
	readonly errors: ToolFolderLoadResult["errors"];
	readonly definitions: ToolDefinition[];
	private readonly modules = new Map<string, Promise<ToolImplFunction>>();
	private readonly processes = new Map<string, PersistentToolProcess>();

	constructor(roots: readonly string[], loaded: ToolFolderLoadResult) {
		this.roots = roots;
		this.tools = loaded.tools;
		this.errors = loaded.errors;
		this.definitions = loaded.tools.map((tool) => this.createDefinition(tool));
	}

	static async load(roots: readonly string[]): Promise<ToolFolderRuntime> {
		return new ToolFolderRuntime(roots, await loadToolFolders(roots));
	}

	/** Load the same roots again, for `/reload`. The caller disposes this runtime. */
	reload(): Promise<ToolFolderRuntime> {
		return ToolFolderRuntime.load(this.roots);
	}

	private createDefinition({ group, info }: LoadedFolderTool): ToolDefinition {
		return {
			name: info.name,
			label: info.name,
			description: describe(info),
			promptSnippet: info.description.split("\n")[0],
			promptGuidelines: group.guidelines,
			parameters: info.parameters as unknown as TSchema,
			namespace: { name: group.name, description: group.description },
			executionMode: info.executionMode,
			defaultActive: info.defaultActive,
			execute: (callId, params, signal, onUpdate, ctx) => this.execute(info, callId, params, signal, onUpdate, ctx),
		};
	}

	private async execute(
		info: ToolFolderInfo,
		callId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<unknown>> {
		const input = (params ?? {}) as Record<string, unknown>;
		const resultContext = { cwd: ctx.cwd };
		let output: unknown;
		if (info.impl.kind === "module") {
			const impl = await this.loadModule(info.impl.path);
			output = await impl(input, {
				cwd: ctx.cwd,
				toolDir: info.dir,
				callId,
				signal,
				onUpdate: (partial) => {
					if (!onUpdate) return;
					void normalizeToolOutput(partial, resultContext).then(onUpdate, () => {});
				},
				extension: ctx,
			});
		} else {
			const request: ToolRequest = { input, callId, cwd: ctx.cwd, toolDir: info.dir };
			const options = { cwd: ctx.cwd, timeoutMs: info.timeoutMs, signal };
			output =
				info.impl.runtime === "persistent"
					? await this.getProcess(info, info.impl.command).call(request, options)
					: await runToolProcess(info.impl.command, info.dir, request, options);
		}
		return normalizeToolOutput(output, resultContext);
	}

	private loadModule(path: string): Promise<ToolImplFunction> {
		let module = this.modules.get(path);
		if (!module) {
			module = importModuleDefault(path).then((impl) => {
				if (typeof impl !== "function") throw new Error(`${path} must export a default function`);
				return impl as ToolImplFunction;
			});
			// A failed import is retried on the next call.
			module.catch(() => this.modules.delete(path));
			this.modules.set(path, module);
		}
		return module;
	}

	private getProcess(info: ToolFolderInfo, command: string[]): PersistentToolProcess {
		let worker = this.processes.get(info.name);
		if (!worker) {
			worker = new PersistentToolProcess(command, info.dir);
			this.processes.set(info.name, worker);
		}
		return worker;
	}

	/**
	 * Load in-process impls and start persistent processes in the background, so their startup
	 * overlaps the model's first response instead of delaying the first call. Failures surface on
	 * the call instead.
	 */
	prewarm(cwd: string, names: ReadonlySet<string>): void {
		for (const { info } of this.tools) {
			if (!names.has(info.name)) continue;
			if (info.impl.kind === "module") this.loadModule(info.impl.path).catch(() => {});
			else if (info.impl.runtime === "persistent") this.getProcess(info, info.impl.command).prewarm(cwd);
		}
	}

	dispose(): void {
		for (const worker of this.processes.values()) worker.dispose();
		this.processes.clear();
	}
}
