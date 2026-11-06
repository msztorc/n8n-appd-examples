ARG N8N_VERSION=2.45.5
FROM docker.io/n8nio/runners:${N8N_VERSION} AS upstream

FROM docker.io/library/python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini libstdc++6 \
    && apt-get clean \
    && groupadd --gid 1000 runner \
    && useradd --uid 1000 --gid 1000 --create-home runner

COPY --from=upstream /usr/local/bin/task-runner-launcher /usr/local/bin/task-runner-launcher
COPY --from=upstream /opt/runners/task-runner-python/.venv/lib/python3.13/site-packages/src /opt/runner/src
COPY requirements.txt /opt/runner/requirements.txt

RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir -r /opt/runner/requirements.txt \
    && printf '%s\n' /opt/runner > /opt/venv/lib/python3.13/site-packages/n8n-runner.pth

RUN /opt/venv/bin/python -I -c "import src.main"
COPY bootstrap.py /opt/runner/bootstrap.py
COPY task_context.py /opt/runner/task_context.py

ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /home/runner
USER runner
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/task-runner-launcher"]
CMD ["python"]
