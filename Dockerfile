# Build stage: resolve dependencies into a virtualenv we can copy wholesale, so the
# runtime image carries no pip cache, no compilers and no build metadata.
FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Dependencies resolve from the manifest against a stub package, so editing source
# code below does not invalidate this (slow) layer.
COPY pyproject.toml README.md ./
RUN mkdir -p src/nzcai_mcp && touch src/nzcai_mcp/__init__.py && pip install .

# Real source, installed without re-resolving anything.
COPY src ./src
RUN pip install --no-deps --force-reinstall .


# Runtime stage.
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="nzcai-mcp" \
      org.opencontainers.image.description="MCP layer for the NZC / ESG AI app" \
      org.opencontainers.image.source="https://github.com/jamescutter1980-portal/NZCAI"

# An MCP server executes tool calls on behalf of a model, so it runs unprivileged.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin nzcai

COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NZCAI_MCP_TRANSPORT=stdio \
    NZCAI_MCP_HOST=0.0.0.0 \
    NZCAI_MCP_PORT=8080 \
    NZCAI_DATA_DIR=/data

# Reference data is mounted at runtime, not baked in: factor tables change every
# year and CRREM pathways are licensed. The image ships the directory, not the data.
RUN mkdir -p /data && chown nzcai:nzcai /data

USER nzcai
WORKDIR /home/nzcai

EXPOSE 8080

# No CMD arguments: transport and everything else come from the environment, so the
# same image serves a stdio subprocess and a long-lived HTTP service.
ENTRYPOINT ["python", "-m", "nzcai_mcp"]
