"""Harbor agent for a pi harness variant (tools registered from tool folders).

Extends Harbor's built-in `Pi` agent, which runs `pi --print --mode json` and converts pi's session
JSONL to an ATIF trajectory (images included). This class only changes what is installed and adds
the variant's tool folder and system prompt:

    harbor run -d <dataset> -m anthropic/claude-sonnet-4-5 \\
        --agent-import-path integrations.harbor.pi_harness:PiHarness \\
        --ak tools_dir=./tools --ak package=./release-tarballs --ak system_prompt=./SYSTEM.md
"""

import shlex
from pathlib import Path, PurePosixPath

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment

_REMOTE_DIR = PurePosixPath("/opt/pi-harness")
_REMOTE_TOOLS_DIR = _REMOTE_DIR / "tools"
_REMOTE_SYSTEM_PROMPT = _REMOTE_DIR / "SYSTEM.md"


class PiHarness(Pi):
    """Pi with tools from `tools_dir` (laid out as `<group>/<tool>/info.yml`) and no other tools.

    Args:
        tools_dir: Local tool folder root uploaded into the environment.
        package: a local directory with the release's npm tarballs (`*.tgz` from
            https://github.com/harshit-zstate/pi/releases), installed together so the packages resolve
            to each other; or an npm spec or tarball URL.
        system_prompt: Optional local file that replaces pi's default system prompt.
        setup_command: Optional shell command run as root after upload, for tool dependencies
            (for example `pip install -r /opt/pi-harness/tools/requirements.txt`).
    """

    def __init__(
        self,
        *args,
        tools_dir: str,
        package: str,
        system_prompt: str | None = None,
        setup_command: str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._tools_dir = Path(tools_dir).resolve()
        if not self._tools_dir.is_dir():
            raise ValueError(f"tools_dir is not a directory: {self._tools_dir}")
        self._package = package
        self._system_prompt = Path(system_prompt).resolve() if system_prompt else None
        if self._system_prompt and not self._system_prompt.is_file():
            raise ValueError(f"system_prompt is not a file: {self._system_prompt}")
        self._setup_command = setup_command

    @staticmethod
    def name() -> str:
        return "pi-harness"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        await environment.exec(f"mkdir -p {shlex.quote((_REMOTE_DIR / 'packages').as_posix())}")
        await environment.upload_dir(self._tools_dir, _REMOTE_TOOLS_DIR.as_posix())
        if self._system_prompt:
            await environment.upload_file(self._system_prompt, _REMOTE_SYSTEM_PROMPT.as_posix())

        packages = [self._package]
        local_package = Path(self._package)
        if local_package.is_dir():
            tarballs = sorted(local_package.glob("*.tgz"))
            if not tarballs:
                raise ValueError(f"package directory has no .tgz files: {local_package}")
            packages = []
            for tarball in tarballs:
                remote_tarball = _REMOTE_DIR / "packages" / tarball.name
                await environment.upload_file(tarball.resolve(), remote_tarball.as_posix())
                packages.append(remote_tarball.as_posix())
        # Tool impls run as the agent user; keep uploaded files readable and executables runnable.
        await environment.exec(f"chmod -R a+rX {shlex.quote(_REMOTE_DIR.as_posix())}")
        if self._setup_command:
            await environment.exec(self._setup_command)

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g --ignore-scripts {' '.join(shlex.quote(p) for p in packages)} && "
                "pi --version"
            ),
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
