/**
 * Tools Configuration
 *
 * Tools come from tool folders: `<root>/<group>/<tool>/info.yml` plus an impl. Without options,
 * pi loads `~/.pi/agent/tools`, `<cwd>/.pi/tools` (trusted projects), `PI_TOOLS_DIR`, and the
 * `toolDirs` setting. See docs/tools.md and examples/tools/.
 *
 * For tools defined in code, see 06-extensions.ts (pi.registerTool()) or the `customTools` option.
 */

import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const demoTools = join(import.meta.dirname, "../tools");

// Only the demo tool folder, none of the default roots
const { session: demoSession } = await createAgentSession({
	toolDirs: [demoTools],
	defaultToolDirs: false,
	sessionManager: SessionManager.inMemory(),
});
console.log("Tools:", demoSession.getActiveToolNames().join(", "));
demoSession.dispose();

// Allowlist: only the named tools (patterns with * work too)
const { session: allowlistSession } = await createAgentSession({
	toolDirs: [demoTools],
	tools: ["echo", "checker*"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Allowlisted tools:", allowlistSession.getActiveToolNames().join(", "));
allowlistSession.dispose();

// Denylist: everything except the named tools
const { session: denylistSession } = await createAgentSession({
	toolDirs: [demoTools],
	excludeTools: ["counter"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Without counter:", denylistSession.getActiveToolNames().join(", "));
denylistSession.dispose();
