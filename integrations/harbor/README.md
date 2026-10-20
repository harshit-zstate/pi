# Harbor agent

`pi_harness.py` runs a pi harness variant (a tool folder plus an optional system prompt) as a [Harbor](https://github.com/laude-institute/harbor) agent. It does not depend on Harbor's built-in `pi` agent or on npm.

In each task container it:

1. Installs the standalone Linux binary (`pi-linux-x64.tar.gz` or `pi-linux-arm64.tar.gz`, picked by the container's `uname -m`) from a release of https://github.com/harshit-zstate/pi. The archive is downloaded once on the host into `~/.cache/pi-harness/<tag>/` (or `$PI_HARNESS_CACHE`), checked against the release's `SHA256SUMS`, and uploaded into each container, so trials do not download it again and containers need no network access to GitHub.
2. Uploads `tools_dir` to `/opt/pi-harness/tools` and `system_prompt` to `/opt/pi-harness/SYSTEM.md`.
3. Runs `pi --print --mode json --no-tool-dirs --tools-dir /opt/pi-harness/tools` with context files, skills, prompt templates, and extensions off, so only the variant's tools and prompt apply.
4. Converts pi's session to `agent/trajectory.json` (ATIF) and saves tool images to `agent/images/`.

## Run

```sh
PYTHONPATH=/path/to/pi harbor run -p <task-or-dataset> -m anthropic/claude-sonnet-4-5 \
  -a integrations.harbor.pi_harness:PiHarness \
  --ak tools_dir=./tools --ak release=v1.3.0-harness.1 --ak system_prompt=./SYSTEM.md
```

Provider keys come from the environment as for other Harbor agents (for example `ANTHROPIC_API_KEY`).

| Option (`--ak`) | Default | Meaning |
|---|---|---|
| `tools_dir` | required | Tool folder root, `<group>/<tool>/info.yml` |
| `release` | `latest` | Release tag to download the binary from |
| `binary_archive` | | Local `pi-linux-<arch>.tar.gz` to upload instead of downloading |
| `system_prompt` | | File that replaces pi's system prompt |
| `setup_command` | | Shell command run as root after upload, for tool dependencies (`pip install ...`) |
| `thinking` | | pi thinking level |
| `model_api` | | pi API for a custom endpoint, for example `openai-completions` |

The task image must provide `tar` and what the tool impls need (for example `python3` for `impl.py`). The binary itself needs no Node.js.

The first trial of a release downloads about 42 MB inside Harbor's agent setup time (6 minutes by default). On a slow connection, raise it with `--agent-setup-timeout-multiplier`, or download the archive beforehand and pass `--ak binary_archive=<path>`.

## Custom endpoints

`-m openai/<model-id>` with `OPENAI_BASE_URL` and `OPENAI_API_KEY` set, plus `--ak model_api=openai-completions`, points pi at any OpenAI-compatible server. The model is declared with image input, so tool images reach it.
