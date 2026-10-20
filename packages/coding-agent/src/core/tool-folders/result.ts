import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../tools/truncate.ts";

/**
 * Image MIME types by extension, for formats magic bytes do not identify. The session converts and
 * resizes tool result images once as they enter history (`normalizeToolResultImages`).
 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
};

export interface ResultContext {
	/** Directory relative image paths resolve against. */
	cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(text: string): string {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return text;
	return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
}

async function loadImage(block: Record<string, unknown>, context: ResultContext): Promise<TextContent | ImageContent> {
	const declaredMimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
	if (typeof block.data === "string") {
		const mimeType = declaredMimeType ?? detectSupportedImageMimeType(Buffer.from(block.data, "base64"));
		if (!mimeType) return { type: "text", text: "[Image omitted: unknown image format; set `mimeType`.]" };
		return { type: "image", data: block.data, mimeType };
	}
	if (typeof block.path !== "string") {
		return { type: "text", text: "[Image omitted: image blocks need a `path` or base64 `data`.]" };
	}
	const path = resolve(context.cwd, block.path);
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		return { type: "text", text: `[Image omitted: cannot read ${path}: ${(error as Error).message}]` };
	}
	const mimeType =
		declaredMimeType ?? detectSupportedImageMimeType(bytes) ?? IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
	if (!mimeType) return { type: "text", text: `[Image omitted: unknown image format for ${path}; set \`mimeType\`.]` };
	return { type: "image", data: bytes.toString("base64"), mimeType };
}

async function normalizeBlock(block: unknown, context: ResultContext): Promise<Array<TextContent | ImageContent>> {
	if (typeof block === "string") return [{ type: "text", text: truncateText(block) }];
	if (!isRecord(block)) return [{ type: "text", text: truncateText(JSON.stringify(block)) }];
	if (block.type === "image") return [await loadImage(block, context)];
	if (block.type === "text" && typeof block.text === "string")
		return [{ type: "text", text: truncateText(block.text) }];
	return [{ type: "text", text: truncateText(JSON.stringify(block)) }];
}

/**
 * Convert what a tool impl returned into a tool result. Accepts a string, a list of content
 * blocks, or `{ content, details, isError, terminate }` where `content` is a string or a list of
 * `{type:"text",text}` and `{type:"image", path | data, mimeType?}` blocks.
 */
export async function normalizeToolOutput(output: unknown, context: ResultContext): Promise<AgentToolResult<unknown>> {
	const record = isRecord(output) && ("content" in output || "details" in output || "isError" in output);
	const rawContent = record ? output.content : output;
	const blocks =
		rawContent === undefined || rawContent === null ? [] : Array.isArray(rawContent) ? rawContent : [rawContent];
	const content = (await Promise.all(blocks.map((block) => normalizeBlock(block, context)))).flat();
	const result: AgentToolResult<unknown> = {
		content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
		details: record ? output.details : undefined,
	};
	if (record && output.isError === true) result.isError = true;
	if (record && output.terminate === true) result.terminate = true;
	return result;
}
