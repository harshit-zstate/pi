/**
 * Runs executable tool impls.
 *
 * per-call: one process per call. stdin gets the request JSON, stdout returns the result (JSON, or
 * plain text), a non-zero exit code is an error with stderr as the message.
 *
 * persistent: one long-lived process per tool, started on the first call. Requests and responses
 * are JSON lines carrying an `id`, so concurrent calls share the process:
 *   -> {"id":"1","input":{...},"callId":"...","cwd":"...","toolDir":"..."}
 *   <- {"id":"1","result":<same shape as per-call stdout>}   or   {"id":"1","error":"message"}
 * The process restarts on the next call after it exits. Lines without a known `id` are ignored.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

/** stderr kept for error messages. */
const MAX_STDERR_BYTES = 16 * 1024;

export interface ToolRequest {
	input: unknown;
	callId: string;
	cwd: string;
	toolDir: string;
}

export interface CallOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

function spawnTool(command: string[], cwd: string, toolDir: string): ChildProcess {
	const [file, ...args] = command;
	const child = spawn(file!, args, {
		cwd,
		detached: process.platform !== "win32",
		env: { ...getShellEnv(), PI_TOOL_DIR: toolDir },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid) trackDetachedChildPid(child.pid);
	child.once("exit", () => {
		if (child.pid) untrackDetachedChildPid(child.pid);
	});
	child.stdin?.on("error", () => {});
	return child;
}

function kill(child: ChildProcess): void {
	if (child.pid && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
}

function appendTail(buffer: string, chunk: string): string {
	const next = buffer + chunk;
	return next.length > MAX_STDERR_BYTES ? next.slice(next.length - MAX_STDERR_BYTES) : next;
}

/** Parse impl stdout: JSON when it parses, otherwise the trimmed text. */
export function parseToolStdout(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

/** Run one call in a fresh process. */
export function runToolProcess(
	command: string[],
	toolDir: string,
	request: ToolRequest,
	options: CallOptions,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawnTool(command, options.cwd, toolDir);
		const stdout: Buffer[] = [];
		let stderr = "";
		let failure: Error | undefined;
		const onAbort = () => {
			failure = new Error("Operation aborted");
			kill(child);
		};
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						failure = new Error(`Tool timed out after ${options.timeoutMs} ms`);
						kill(child);
					}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendTail(stderr, chunk.toString("utf8"));
		});
		child.once("error", (error) => {
			finish();
			reject(new Error(`Cannot start ${command[0]}: ${error.message}`));
		});
		child.once("close", (code, signal) => {
			finish();
			if (failure) reject(failure);
			else if (code !== 0) {
				const reason = stderr.trim() || `exited with ${code === null ? `signal ${signal}` : `code ${code}`}`;
				reject(new Error(reason));
			} else resolve(parseToolStdout(Buffer.concat(stdout).toString("utf8")));
		});
		child.stdin?.end(JSON.stringify(request));
	});
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** One long-lived impl process shared by the calls of one tool. */
export class PersistentToolProcess {
	private readonly command: string[];
	private readonly toolDir: string;
	private child: ChildProcess | undefined;
	private readonly pending = new Map<string, PendingCall>();
	private nextId = 0;
	private stderr = "";
	private disposed = false;

	constructor(command: string[], toolDir: string) {
		this.command = command;
		this.toolDir = toolDir;
	}

	private start(cwd: string): ChildProcess {
		const child = spawnTool(this.command, cwd, this.toolDir);
		this.stderr = "";
		const lines = createInterface({ input: child.stdout! });
		lines.on("line", (line) => this.onLine(line));
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = appendTail(this.stderr, chunk.toString("utf8"));
		});
		const onGone = (reason: string) => {
			if (this.child !== child) return;
			this.child = undefined;
			const error = new Error(this.stderr.trim() || reason);
			for (const call of this.pending.values()) call.reject(error);
			this.pending.clear();
		};
		child.once("error", (error) => onGone(`Cannot start ${this.command[0]}: ${error.message}`));
		child.once("exit", (code, signal) =>
			onGone(`Tool process exited with ${code === null ? `signal ${signal}` : `code ${code}`}`),
		);
		this.child = child;
		return child;
	}

	private onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const { id, result, error } = message as { id?: unknown; result?: unknown; error?: unknown };
		const call = typeof id === "string" || typeof id === "number" ? this.pending.get(String(id)) : undefined;
		if (!call) return;
		this.pending.delete(String(id));
		if (error !== undefined && error !== null) call.reject(new Error(String(error)));
		else call.resolve(result);
	}

	/** Start the process now (if it is not running) so the first call does not wait for startup. */
	prewarm(cwd: string): void {
		if (!this.disposed && !this.child) this.start(cwd);
	}

	call(request: ToolRequest, options: CallOptions): Promise<unknown> {
		if (this.disposed) return Promise.reject(new Error("Tool process was shut down"));
		if (options.signal?.aborted) return Promise.reject(new Error("Operation aborted"));
		const child = this.child ?? this.start(options.cwd);
		const id = String(++this.nextId);
		return new Promise<unknown>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => settle(() => reject(new Error("Operation aborted")));
			const settle = (action: () => void) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				action();
			};
			this.pending.set(id, {
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
			});
			if (options.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					settle(() => reject(new Error(`Tool timed out after ${options.timeoutMs} ms`)));
					// A process that missed its deadline may be stuck; the next call starts a fresh one.
					kill(child);
				}, options.timeoutMs);
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
		});
	}

	dispose(): void {
		this.disposed = true;
		const child = this.child;
		this.child = undefined;
		if (child) {
			child.stdin?.end();
			kill(child);
		}
		const error = new Error("Tool process was shut down");
		for (const call of this.pending.values()) call.reject(error);
		this.pending.clear();
	}
}
