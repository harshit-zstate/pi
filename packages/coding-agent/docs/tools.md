# Tool Folders

Pi has no built-in model tools. Every tool comes from a tool folder: a directory with a YAML description and an implementation. A variant of Pi (for example one for radiology or pathology) is a set of tool folders plus an optional system prompt.

## Layout

```
tools/
  imaging/                     # group
    group_info.yml
    list_series/               # tool
      info.yml
      impl.ts
    view_slice/
      info.yml
      impl.py
```

A root holds group folders, and a group folder holds tool folders. Folders whose names start with `.` are skipped.

## Where Pi looks

Roots are loaded in this order. A tool in a later root replaces a tool with the same name from an earlier root:

1. `~/.pi/agent/tools`
2. `.pi/tools` in the working directory, only when the project is trusted (see [Configuration](configuration.md))
3. `PI_TOOLS_DIR`, a list of directories separated like `PATH`
4. The `toolDirs` setting
5. `--tools-dir <dir>`, repeatable

`--no-tool-dirs` skips roots 1 to 4. Harness runs usually pass `--no-tool-dirs --tools-dir <variant>/tools` so only the variant's tools load. Two tools with the same name in one root are an error, and the second one is skipped.

`/reload` reads the roots again, which helps while you write a tool.

## group_info.yml

All fields are optional.

```yaml
name: imaging                  # default: folder name
description: Inspect imaging studies.
guidelines:                    # rules added to the system prompt while any tool of the group is active
  - View a series thumbnail before marking findings.
tools: [list_series, view_slice]   # which tool folders to load, in order; default: all, sorted
```

The system prompt lists tools under their group:

```
imaging: Inspect imaging studies.
- list_series: List the series of a study.
- view_slice: Render one slice as PNG.
```

## info.yml

```yaml
name: view_slice               # default: folder name; letters, digits, _ and -, up to 64 characters
description: |-                # required; the first line is the tool's line in the system prompt
  Render one slice of a series as PNG.
  Use index 0 for the first slice.
parameters:                    # JSON Schema with type: object; default: no parameters
  type: object
  properties:
    series: { type: string }
    index: { type: integer, minimum: 0 }
  required: [series, index]
output:
  description: One PNG image and a caption.   # appended to the model-facing description as "Returns: ..."
execution: parallel            # parallel (default) or sequential
default_active: true           # false: off unless named in --tools, defaultTools, or setActiveTools()
timeout_ms: 60000              # executables only; default: no limit
runtime: per-call              # executables only: per-call (default) or persistent
command: ["python3", "impl.py"]   # optional; arguments naming files in the tool folder become absolute paths
```

Arguments are validated against `parameters` before the impl runs. Invalid calls go back to the model as errors.

## Implementations

A tool folder has exactly one `impl` file, or a `command` in `info.yml`.

| impl | Runs as |
|---|---|
| `impl.ts`, `impl.mts`, `impl.js`, `impl.mjs`, `impl.cjs` | In-process module |
| `impl.py` | `python3 impl.py` |
| `impl.sh` | `bash impl.sh` |
| `impl.rb`, `impl.pl` | `ruby` / `perl` |
| `impl` or any other `impl.*` | The file itself; it must be executable |
| `command` in `info.yml` | That command |

Pi loads modules and starts persistent processes in the background on the first prompt, so their startup overlaps the model's first response.

### In-process modules

The default export is called with the validated input and a context:

```ts
import type { ToolImplFunction } from "@earendil-works/pi-coding-agent";

const listSeries: ToolImplFunction = async (input, { cwd, toolDir, callId, signal, onUpdate }) => {
	return { content: [{ type: "text", text: `series in ${String(input.study)}` }], details: {} };
};

export default listSeries;
```

The module is loaded once and reused. `onUpdate(partial)` streams partial output in the same shape as the result. `context.extension` is the extension tool context (model, session manager, UI).

### Executables

**per-call** starts a process for each call, with the session working directory as its cwd and `PI_TOOL_DIR` set to the tool folder. Its stdin gets one JSON request:

```json
{ "input": { "series": "CT-1", "index": 3 }, "callId": "toolu_01", "cwd": "/case", "toolDir": "/tools/imaging/view_slice" }
```

Its stdout is the result: JSON, or plain text. A non-zero exit is an error, and stderr becomes the message. An abort or timeout kills the process tree.

**persistent** starts one process on the first call and keeps it for the run. Requests and responses are JSON lines with an `id`, so concurrent calls share the process:

```
-> {"id":"1","input":{...},"callId":"toolu_01","cwd":"/case","toolDir":"/tools/imaging/view_slice"}
<- {"id":"1","result":{"content":[...]}}
<- {"id":"2","error":"series CT-9 not found"}
```

Responses may come in any order. Lines that are not JSON or carry an unknown `id` are ignored, so logging to stdout does not break the protocol (stderr is better). If the process exits, pending calls fail with its stderr and the next call starts a new process. A timed-out call kills the process.

Use `persistent` when startup is slow (Python with numpy, pydicom, or openslide) or when the tool keeps state across calls, such as an open slide. A minimal Python worker:

```python
import json, sys

for line in sys.stdin:
    request = json.loads(line)
    try:
        result = {"content": [{"type": "text", "text": f"got {request['input']}"}]}
        response = {"id": request["id"], "result": result}
    except Exception as error:
        response = {"id": request["id"], "error": str(error)}
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
```

## Results

Every runtime returns the same shape:

```json
{
  "content": [
    { "type": "text", "text": "Slice 3 of 120" },
    { "type": "image", "path": "out/slice-3.png" },
    { "type": "image", "data": "<base64>", "mimeType": "image/png" }
  ],
  "details": { "series": "CT-1" },
  "isError": false
}
```

- A string, or a list of blocks, is accepted in place of the object. A string block is text.
- `content` is what the model sees. `details` is kept in the session for UIs and logs and is not sent to the model.
- Images by `path` are read from disk; a relative path resolves against the session working directory. Writing a file is cheaper than base64 over stdout. The type is detected from the file; set `mimeType` for formats Pi cannot detect.
- Pi converts images to a supported format and resizes them to the model's limits once, as they enter the session (`images.autoResize` setting). Models without image input get a text placeholder instead.
- Text over 2000 lines or 50 KB is truncated.
- `isError: true` marks the result as a failure for the model. `terminate: true` stops the run after this batch of tool calls when every result in the batch sets it.

## Selecting tools

All loaded tools are active unless `default_active: false`. `--tools`, `--exclude-tools`, `--no-tools`, and the `defaultTools` setting work on tool-folder names; see [Command Line](cli.md#tools).

## Example

[`examples/tools/demo`](../examples/tools/demo) has one tool of each kind: `echo` (in-process TypeScript), `checkerboard` (per-call executable that returns a PNG by path), and `counter` (persistent Python worker).

```sh
pi --no-tool-dirs --tools-dir examples/tools "Draw a 6x6 checkerboard and describe it"
```

## Harbor

[`integrations/harbor/pi_harness.py`](../../../integrations/harbor/pi_harness.py) runs a variant in [Harbor](https://github.com/laude-institute/harbor). It extends Harbor's `pi` agent, which records the run as an ATIF trajectory with images. It installs the standalone Linux binary from a [GitHub release](https://github.com/harshit-zstate/pi/releases) (x64 or arm64, by the container's architecture), uploads the variant's tool folder and system prompt, and runs `pi` with only those tools:

```sh
harbor run -d <dataset> -m anthropic/claude-sonnet-4-5 \
  --agent-import-path integrations.harbor.pi_harness:PiHarness \
  --ak tools_dir=./tools --ak release=v1.3.0-harness.1 --ak system_prompt=./SYSTEM.md
```

`release` defaults to `latest`. `binary_archive=<local pi-linux-x64.tar.gz>` uploads a local build instead of downloading, and `setup_command` runs as root after upload, for tool dependencies such as `pip install -r /opt/pi-harness/tools/requirements.txt`.
