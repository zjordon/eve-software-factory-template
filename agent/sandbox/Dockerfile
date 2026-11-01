# The station sandbox image (self-hosted form, master plan item #8): git for
# the credentialed clone, Python 3.12 + uv for the target repo's toolchain,
# and Chromium with its system libraries so Playwright e2e runs inside the
# pipeline. eve picks this file up through the DockerSandbox.dockerfile()
# convention; keep it self-contained (no COPY from the build context) so the
# convention's context directory never matters.
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# uv straight from the official image (unpinned on purpose: a rebuild is an
# explicit act, and uv stays backward compatible with lockfiles).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Playwright's matching Chromium plus the system libraries it needs; baked in
# so a station session never downloads a browser at run time.
RUN uv pip install --system playwright \
  && playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# factoryInit clones into /workspace/repo and pre-registers safe.directory
# entries for /workspace and /workspace/repo, so the workdir must stay this.
WORKDIR /workspace
