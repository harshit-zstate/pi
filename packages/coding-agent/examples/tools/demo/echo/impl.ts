import type { ToolImplFunction } from "@earendil-works/pi-coding-agent";

// In-process impl: loaded on the first call, then reused. Return a string, content blocks, or
// { content, details, isError }.
const echo: ToolImplFunction = (input) => {
	const text = String(input.text);
	return {
		content: [{ type: "text", text: input.upper ? text.toUpperCase() : text }],
		details: { length: text.length },
	};
};

export default echo;
