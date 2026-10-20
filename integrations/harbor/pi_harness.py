"""Harbor agent for a pi harness variant (tools registered from tool folders).

Extends Harbor's built-in `Pi` agent, which runs `pi --print --mode json` and converts pi's session
JSONL to an ATIF trajectory (images included). This class only changes what is installed and adds
the variant's tool folder and system prompt:

    harbor run -d <dataset> -m anthropic/claude-sonnet-4-5 \\
        --agent-import-path integrations.harbor.pi_harness:PiHarness \\
        --ak tools_dir=./tools --ak release=v1.3.0-harness.1 --ak system_prompt=./SYSTEM.md
"""

import shlex
from pathlib import Path, PurePosixPath

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment

RELEASE_REPOSITORY = "harshit-zstate/pi"

_REMOTE_DIR = PurePosixPath("/opt/pi-harness")
_REMOTE_TOOLS_DIR = _REMOTE_DIR / "tools"
_REMOTE_SYSTEM_PROMPT = _REMOTE_DIR / "SYSTEM.md"
_REMOTE_BINARY_DIR = _REMOTE_DIR / "pi"


class PiHarness(Pi):
    """Pi with tools from `tools_dir` (laid out as `<group>/<tool>/info.yml`) and no other tools.

    Args:
        tools_dir: Local tool folder root uploaded into the environment.
        release: GitHub release tag of https://github.com/harshit-zstate/pi whose standalone Linux
            binary (`pi-linux-x64.tar.gz` or `pi-linux-arm64.tar.gz`, picked by the container's
            architecture) is installed. Default: `latest`.
        binary_archive: Optional local `pi-linux-<arch>.tar.gz` to upload instead of downloading.
        system_prompt: Optional local file that replaces pi's default system prompt.
        setup_command: Optional shell command run as root after upload, for tool dependencies
            (for example `pip install -r /opt/pi-harness/tools/requirements.txt`).
    """

    def __init__(
        self,
        *args,
        tools_dir: str,
        release: str = "latest",
        binary_archive: str | None = None,
        system_prompt: str | None = None,
        setup_command: str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._tools_dir = Path(tools_dir).resolve()
        if not self._tools_dir.is_dir():
            raise ValueError(f"tools_dir is not a directory: {self._tools_dir}")
        self._release = release
        self._binary_archive = Path(binary_archive).resolve() if binary_archive else None
        if self._binary_archive and not self._binary_archive.is_file():
            raise ValueError(f"binary_archive is not a file: {self._binary_archive}")
        self._system_prompt = Path(system_prompt).resolve() if system_prompt else None
        if self._system_prompt and not self._system_prompt.is_file():
            raise ValueError(f"system_prompt is not a file: {self._system_prompt}")
        self._setup_command = setup_command

    @staticmethod
    def name() -> str:
        return "pi-harness"

    def _download_url(self, archive: str) -> str:
        base = f"https://github.com/{RELEASE_REPOSITORY}/releases"
        if self._release == "latest":
            return f"{base}/latest/download/{archive}"
        return f"{base}/download/{self._release}/{archive}"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        await environment.exec(f"mkdir -p {shlex.quote(_REMOTE_DIR.as_posix())}")
        await environment.upload_dir(self._tools_dir, _REMOTE_TOOLS_DIR.as_posix())
        if self._system_prompt:
            await environment.upload_file(self._system_prompt, _REMOTE_SYSTEM_PROMPT.as_posix())

        # The release archive holds a `pi/` directory with the binary and the assets it reads.
        archive_path = (_REMOTE_DIR / "pi.tar.gz").as_posix()
        if self._binary_archive:
            await environment.upload_file(self._binary_archive, archive_path)
            fetch = ":"
        else:
            arch = '$(case "$(uname -m)" in aarch64|arm64) echo arm64;; *) echo x64;; esac)'
            url = self._download_url("pi-linux-${ARCH}.tar.gz")
            fetch = f'ARCH={arch}; curl -fsSL "{url}" -o {shlex.quote(archive_path)}'
        await environment.exec(
            "set -eu; "
            f"{fetch}; "
            f"rm -rf {shlex.quote(_REMOTE_BINARY_DIR.as_posix())}; "
            f"tar -xzf {shlex.quote(archive_path)} -C {shlex.quote(_REMOTE_DIR.as_posix())}; "
            f"rm -f {shlex.quote(archive_path)}; "
            f"ln -sf {shlex.quote((_REMOTE_BINARY_DIR / 'pi').as_posix())} /usr/local/bin/pi"
        )
        # Tool impls run as the agent user; keep uploaded files readable and executables runnable.
        await environment.exec(f"chmod -R a+rX {shlex.quote(_REMOTE_DIR.as_posix())}")
        if self._setup_command:
            await environment.exec(self._setup_command)

        # Harbor's pi agent sources nvm before running pi, and tool impls may need Node.js.
        await self.exec_as_agent(
            environment,
            command=f"set -euo pipefail; {nvm_node_install_snippet()} && pi --version",
        )

    def build_cli_flags(self) -> str:
        flags = [
            super().build_cli_flags(),
            "--no-tool-dirs",
            f"--tools-dir {shlex.quote(_REMOTE_TOOLS_DIR.as_posix())}",
            # Harness runs must not pick up instructions or resources from the task's workspace.
            "--no-context-files --no-skills --no-prompt-templates --no-extensions",
        ]
        if self._system_prompt:
            flags.append(f"--system-prompt {shlex.quote(_REMOTE_SYSTEM_PROMPT.as_posix())}")
        return " ".join(flag for flag in flags if flag)
