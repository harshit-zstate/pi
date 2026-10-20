"""Harbor agent for a pi harness variant (tools registered from tool folders).

Installs the standalone Linux binary from a GitHub release of https://github.com/harshit-zstate/pi,
uploads the variant's tool folder and system prompt, runs `pi --print --mode json` with only those
tools, and converts pi's session JSONL to an ATIF trajectory (images included):

    harbor run -p <task-or-dataset> -m anthropic/claude-sonnet-4-5 \\
        --agent integrations.harbor.pi_harness:PiHarness \\
        --ak tools_dir=./tools --ak release=v1.3.0-harness.1 --ak system_prompt=./SYSTEM.md

Custom OpenAI-compatible endpoints work like Harbor's other agents: `-m openai/<model-id>` with
`OPENAI_BASE_URL` and `OPENAI_API_KEY` set, plus `--ak model_api=openai-completions`.
"""

import base64
import binascii
import json
import shlex
from collections.abc import Iterator
from itertools import count
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, Literal, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec, ResolvedModelConnection
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    ContentPart,
    FinalMetrics,
    ImageSource,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json
from pydantic import Field

RELEASE_REPOSITORY = "harshit-zstate/pi"

_REMOTE_DIR = PurePosixPath("/opt/pi-harness")
_REMOTE_TOOLS_DIR = _REMOTE_DIR / "tools"
_REMOTE_SYSTEM_PROMPT = _REMOTE_DIR / "SYSTEM.md"
_REMOTE_BINARY_DIR = _REMOTE_DIR / "pi"
# pi's config directory for the run: auth, settings, and models.json for custom endpoints.
_REMOTE_CONFIG_DIR = PurePosixPath("/tmp/pi-harness-agent")
_CUSTOM_PROVIDER = "harbor-endpoint"

_ImageMediaType = Literal["image/png", "image/jpeg", "image/gif", "image/webp"]
_IMAGE_EXTENSIONS: dict[_ImageMediaType, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}


class PiHarnessOptions(InstalledAgentOptions):
    thinking: Annotated[
        Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"] | None,
        Cli("--thinking"),
    ] = Field(default=None, description="Thinking level.")
    model_api: str | None = Field(
        default=None,
        description="pi API of a custom endpoint, for example openai-completions or anthropic-messages.",
    )
    tools_dir: str | None = Field(
        default=None, description="Local tool folder root (<group>/<tool>/info.yml) uploaded into the environment."
    )
    release: str = Field(
        default="latest",
        description=f"GitHub release tag of https://github.com/{RELEASE_REPOSITORY} whose Linux binary is installed.",
    )
    binary_archive: str | None = Field(
        default=None, description="Local pi-linux-<arch>.tar.gz to upload instead of downloading the release."
    )
    system_prompt: str | None = Field(default=None, description="Local file that replaces pi's system prompt.")
    setup_command: str | None = Field(
        default=None, description="Shell command run as root after upload, for tool dependencies."
    )


class PiHarness(BaseInstalledAgent):
    """pi with tools from `tools_dir` (laid out as `<group>/<tool>/info.yml`) and no other tools.

    Options (`--ak key=value`): `tools_dir` (required), `release` (GitHub release tag, default
    `latest`; the binary matching the container's architecture is downloaded), `binary_archive`
    (local `pi-linux-<arch>.tar.gz` instead of downloading), `system_prompt`, `setup_command` (run
    as root after upload, for tool dependencies), `model_api` and `thinking`.
    """

    capabilities = AgentCapabilities(atif=True)
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    _OUTPUT_FILENAME = "pi.txt"
    _TRAJECTORY_FILENAME = "trajectory.json"
    _SESSIONS_DIRECTORY = Path("pi/sessions")

    options_model = PiHarnessOptions
    options: PiHarnessOptions

    @staticmethod
    def _local_path(value: str | None, what: str, *, directory: bool) -> Path | None:
        if not value:
            return None
        path = Path(value).expanduser().resolve()
        if not (path.is_dir() if directory else path.is_file()):
            raise ValueError(f"{what} is not a {'directory' if directory else 'file'}: {path}")
        return path

    @staticmethod
    @override
    def name() -> str:
        return "pi-harness"

    @override
    def get_version_command(self) -> str | None:
        return "pi --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def _download_url(self, archive: str) -> str:
        base = f"https://github.com/{RELEASE_REPOSITORY}/releases"
        if self.options.release == "latest":
            return f"{base}/latest/download/{archive}"
        return f"{base}/download/{self.options.release}/{archive}"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        tools_dir = self._local_path(self.options.tools_dir, "tools_dir", directory=True)
        if tools_dir is None:
            raise ValueError("pi-harness requires --ak tools_dir=<tool folder root>")
        binary_archive = self._local_path(self.options.binary_archive, "binary_archive", directory=False)
        system_prompt = self._local_path(self.options.system_prompt, "system_prompt", directory=False)

        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_root(environment, command=f"mkdir -p {shlex.quote(_REMOTE_DIR.as_posix())}")
        await environment.upload_dir(tools_dir, _REMOTE_TOOLS_DIR.as_posix())
        if system_prompt:
            await environment.upload_file(system_prompt, _REMOTE_SYSTEM_PROMPT.as_posix())

        # The release archive holds a `pi/` directory with the binary and the assets it reads.
        archive_path = (_REMOTE_DIR / "pi.tar.gz").as_posix()
        if binary_archive:
            await environment.upload_file(binary_archive, archive_path)
            fetch = ":"
        else:
            arch = '$(case "$(uname -m)" in aarch64|arm64) echo arm64;; *) echo x64;; esac)'
            url = self._download_url("pi-linux-${ARCH}.tar.gz")
            fetch = f'ARCH={arch}; curl -fsSL "{url}" -o {shlex.quote(archive_path)}'
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"{fetch}; "
                f"rm -rf {shlex.quote(_REMOTE_BINARY_DIR.as_posix())}; "
                f"tar -xzf {shlex.quote(archive_path)} -C {shlex.quote(_REMOTE_DIR.as_posix())}; "
                f"rm -f {shlex.quote(archive_path)}; "
                f"ln -sf {shlex.quote((_REMOTE_BINARY_DIR / 'pi').as_posix())} /usr/local/bin/pi; "
                # Tool impls run as the agent user; keep uploaded files readable and executables runnable.
                f"chmod -R a+rX {shlex.quote(_REMOTE_DIR.as_posix())}"
            ),
        )
        if self.options.setup_command:
            await self.exec_as_root(environment, command=self.options.setup_command)
        await self.exec_as_agent(environment, command="pi --version")

    @staticmethod
    def _api_key_env_name(access: ResolvedModelConnection) -> str | None:
        if access.api_key is None:
            return None
        return next((name for name, value in sorted(access.env.items()) if value == access.api_key), None)

    def _custom_models_json(self, access: ResolvedModelConnection, model_id: str) -> dict[str, Any] | None:
        model_api = (self.options.model_api or "").strip() or None
        endpoint = access.configured_base_url
        if endpoint is None:
            if model_api is not None:
                raise ValueError("model_api requires an explicitly configured base URL")
            return None
        if model_api is None:
            raise ValueError("custom endpoints require the model_api agent argument")
        api_key_env = self._api_key_env_name(access)
        if api_key_env is None:
            raise ValueError("custom endpoints require an API-key environment variable")
        # Tools return images, so the model must accept image input or pi drops them.
        model: dict[str, Any] = {"id": model_id, "input": ["text", "image"]}
        if self.options.thinking not in (None, "off"):
            model["reasoning"] = True
        return {
            "providers": {
                _CUSTOM_PROVIDER: {
                    "baseUrl": endpoint,
                    "apiKey": f"${api_key_env}",
                    "api": model_api,
                    "models": [model],
                }
            }
        }

    @override
    def build_cli_flags(self) -> str:
        flags = [
            super().build_cli_flags(),
            "--no-tool-dirs",
            f"--tools-dir {shlex.quote(_REMOTE_TOOLS_DIR.as_posix())}",
            # Harness runs must not pick up instructions or resources from the task's workspace.
            "--no-context-files --no-skills --no-prompt-templates --no-extensions",
        ]
        if self.options.system_prompt:
            flags.append(f"--system-prompt {shlex.quote(_REMOTE_SYSTEM_PROMPT.as_posix())}")
        return " ".join(flag for flag in flags if flag)

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider, model_id = self.model_name.split("/", 1)
        access = self.model_connection
        provider = access.provider or provider
        env = dict(access.env)

        config_dir = shlex.quote(_REMOTE_CONFIG_DIR.as_posix())
        await self.exec_as_agent(environment, command=f"mkdir -p {config_dir} && chmod 700 {config_dir}")
        models_json = self._custom_models_json(access, model_id)
        if models_json is not None:
            models_path = (_REMOTE_CONFIG_DIR / "models.json").as_posix()
            await self._upload_config_text(
                environment,
                content=json.dumps(models_json, indent=2) + "\n",
                remote_path=models_path,
                filename="models.json",
            )
            await self.exec_as_agent(environment, command=f"chmod 600 {shlex.quote(models_path)}")
            provider = _CUSTOM_PROVIDER

        output_path = self.environment_logs_dir / self._OUTPUT_FILENAME
        session_dir = self.environment_logs_dir / self._SESSIONS_DIRECTORY
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {shlex.quote(str(session_dir))} && "
                f"PI_CODING_AGENT_DIR={config_dir} PI_OFFLINE=1 pi --print --mode json "
                f"--session-dir {shlex.quote(str(session_dir))} "
                f"--provider {shlex.quote(provider)} --model {shlex.quote(model_id)} "
                f"{self.build_cli_flags()} "
                f"{shlex.quote(instruction)} "
                f"2>&1 </dev/null | grep --line-buffered -v '\"type\":\"message_update\"' "
                f"| tee {shlex.quote(str(output_path))}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        trajectory_path = self.logs_dir / self._TRAJECTORY_FILENAME
        trajectory_path.unlink(missing_ok=True)
        loaded = self._load_trajectory()
        if loaded is None:
            return
        trajectory, metrics = loaded
        trajectory_path.write_text(format_trajectory_json(trajectory.to_json_dict()))
        context.n_input_tokens = sum(m.prompt_tokens or 0 for m in metrics)
        context.n_output_tokens = sum(m.completion_tokens or 0 for m in metrics)
        context.n_cache_tokens = sum(m.cached_tokens or 0 for m in metrics)
        costs = [m.cost_usd for m in metrics if m.cost_usd is not None]
        context.cost_usd = sum(costs) if costs else None

    # Session JSONL -> ATIF. pi's session format is the upstream one, so this follows Harbor's
    # built-in pi agent conversion.

    def _load_trajectory(self) -> tuple[Trajectory, list[Metrics]] | None:
        session_files = list((self.logs_dir / self._SESSIONS_DIRECTORY).glob("*.jsonl"))
        if not session_files:
            return None
        session_path = max(session_files, key=lambda path: (path.stat().st_mtime_ns, path.name))
        events: list[dict[str, Any]] = []
        for line in session_path.read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        try:
            trajectory = self._convert_events(self._active_branch(events))
        except Exception:
            self.logger.exception("Failed to convert pi session to trajectory")
            return None
        if trajectory is None:
            return None
        return trajectory, [m for m in (self._metrics(self._usage_of(e)) for e in events) if m is not None]

    @staticmethod
    def _usage_of(event: dict[str, Any]) -> Any:
        if event.get("type") in {"compaction", "branch_summary"}:
            return event.get("usage")
        message = event.get("message")
        if event.get("type") == "message" and isinstance(message, dict):
            if message.get("role") in {"assistant", "toolResult"}:
                return message.get("usage")
        return None

    @staticmethod
    def _active_branch(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The current root-to-leaf path of pi's append-only session tree."""
        by_id: dict[str, dict[str, Any]] = {}
        headers: list[dict[str, Any]] = []
        leaf_id: str | None = None
        for event in events:
            if event.get("type") == "session":
                headers.append(event)
                continue
            event_id = event.get("id")
            if isinstance(event_id, str) and event_id:
                by_id[event_id] = event
                leaf_id = event_id
        if leaf_id is None:
            return events
        branch: list[dict[str, Any]] = []
        visited: set[str] = set()
        while leaf_id is not None and leaf_id not in visited:
            visited.add(leaf_id)
            event = by_id.get(leaf_id)
            if event is None:
                break
            branch.append(event)
            parent_id = event.get("parentId")
            leaf_id = parent_id if isinstance(parent_id, str) and parent_id else None
        branch.reverse()
        return [*headers, *branch]

    @staticmethod
    def _integer(value: Any) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    @classmethod
    def _metrics(cls, usage: Any) -> Metrics | None:
        if not isinstance(usage, dict) or not {"input", "output", "cacheRead", "cacheWrite", "totalTokens"} & set(usage):
            return None
        cache_read = cls._integer(usage.get("cacheRead"))
        cache_write = cls._integer(usage.get("cacheWrite"))
        cost = usage.get("cost")
        cost_total = cost.get("total") if isinstance(cost, dict) else None
        return Metrics(
            prompt_tokens=cls._integer(usage.get("input")) + cache_read + cache_write,
            completion_tokens=cls._integer(usage.get("output")),
            cached_tokens=cache_read,
            cost_usd=float(cost_total) if isinstance(cost_total, int | float) and cost_total > 0 else None,
            extra={"cache_write_tokens": cache_write, "pi_total_tokens": cls._integer(usage.get("totalTokens"))},
        )

    def _save_image(self, data: str, mime_type: str, index: int) -> ContentPart | None:
        extension = _IMAGE_EXTENSIONS.get(mime_type)  # type: ignore[arg-type]
        if extension is None:
            return None
        image_path = self.logs_dir / "images" / f"pi_image_{index}.{extension}"
        try:
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.write_bytes(base64.b64decode(data, validate=True))
        except (binascii.Error, OSError, ValueError):
            return None
        return ContentPart(
            type="image",
            source=ImageSource(media_type=mime_type, path=f"images/{image_path.name}"),  # type: ignore[arg-type]
        )

    def _content(self, content: Any, image_indexes: Iterator[int]) -> str | list[ContentPart]:
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return ""
        parts: list[ContentPart] = []
        has_image = False
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(ContentPart(type="text", text=block["text"]))
            elif block.get("type") == "image" and isinstance(block.get("data"), str):
                image = self._save_image(block["data"], str(block.get("mimeType")), next(image_indexes))
                if image is not None:
                    parts.append(image)
                    has_image = True
        if has_image:
            return parts
        return "\n".join(part.text or "" for part in parts).strip()

    def _convert_events(self, events: list[dict[str, Any]]) -> Trajectory | None:
        session_id = "unknown"
        model_name = self.model_name
        steps: list[Step] = []
        call_steps: dict[str, Step] = {}
        image_indexes = count(1)
        totals = {"prompt": 0, "completion": 0, "cached": 0, "cost": 0.0}

        def add(metrics: Metrics | None) -> Metrics | None:
            if metrics is not None:
                totals["prompt"] += metrics.prompt_tokens or 0
                totals["completion"] += metrics.completion_tokens or 0
                totals["cached"] += metrics.cached_tokens or 0
                totals["cost"] += metrics.cost_usd or 0.0
            return metrics

        for event in events:
            event_type = event.get("type")
            timestamp = event.get("timestamp") if isinstance(event.get("timestamp"), str) else None
            if event_type == "session":
                if isinstance(event.get("id"), str):
                    session_id = event["id"]
                continue
            if event_type == "model_change":
                if isinstance(event.get("provider"), str) and isinstance(event.get("modelId"), str):
                    model_name = f"{event['provider']}/{event['modelId']}"
                continue
            if event_type in {"compaction", "branch_summary"}:
                summary = event.get("summary")
                if isinstance(summary, str) and summary.strip():
                    steps.append(
                        Step(
                            step_id=len(steps) + 1,
                            timestamp=timestamp,
                            source="agent",
                            model_name=model_name,
                            message=summary.strip(),
                            metrics=add(self._metrics(event.get("usage"))),
                            llm_call_count=1,
                            extra={"pi_event_type": event_type},
                        )
                    )
                continue
            message = event.get("message")
            if event_type != "message" or not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "user":
                steps.append(
                    Step(
                        step_id=len(steps) + 1,
                        timestamp=timestamp,
                        source="user",
                        message=self._content(message.get("content"), image_indexes),
                    )
                )
            elif role == "assistant":
                texts: list[str] = []
                reasoning: list[str] = []
                tool_calls: list[ToolCall] = []
                for block in message.get("content") or []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and isinstance(block.get("text"), str):
                        texts.append(block["text"])
                    elif block.get("type") == "thinking" and isinstance(block.get("thinking"), str):
                        reasoning.append(block["thinking"])
                    elif block.get("type") == "toolCall" and isinstance(block.get("id"), str):
                        arguments = block.get("arguments")
                        tool_calls.append(
                            ToolCall(
                                tool_call_id=block["id"],
                                function_name=str(block.get("name")),
                                arguments=arguments if isinstance(arguments, dict) else {},
                            )
                        )
                if message.get("stopReason") == "aborted" and not (texts or reasoning or tool_calls):
                    continue
                step = Step(
                    step_id=len(steps) + 1,
                    timestamp=timestamp,
                    source="agent",
                    model_name=model_name,
                    message="\n".join(texts).strip(),
                    reasoning_content="\n".join(reasoning).strip() or None,
                    tool_calls=tool_calls or None,
                    observation=Observation(results=[]) if tool_calls else None,
                    metrics=add(self._metrics(message.get("usage"))),
                    llm_call_count=1,
                    extra={"stop_reason": message.get("stopReason"), "error": message.get("errorMessage")},
                )
                steps.append(step)
                for tool_call in tool_calls:
                    call_steps[tool_call.tool_call_id] = step
            elif role == "toolResult":
                step = call_steps.get(str(message.get("toolCallId")))
                if step is None or step.observation is None:
                    continue
                step.observation.results.append(
                    ObservationResult(
                        source_call_id=message["toolCallId"],
                        content=self._content(message.get("content"), image_indexes),
                        extra={"tool_name": message.get("toolName"), "is_error": bool(message.get("isError"))},
                    )
                )

        if not steps:
            return None
        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=session_id,
            agent=Agent(name=self.name(), version=self.version() or "unknown", model_name=model_name),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=totals["prompt"],
                total_completion_tokens=totals["completion"],
                total_cached_tokens=totals["cached"],
                total_cost_usd=totals["cost"] or None,
                total_steps=len(steps),
            ),
        )
