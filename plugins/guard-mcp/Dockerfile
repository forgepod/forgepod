FROM python:3.12-alpine

WORKDIR /app
COPY server.py .

# No requirements.txt. A guardrail is an ordinary MCP tool, and answering the protocol
# takes a standard library and nothing else. rules.json arrives on the state mount, so
# the image carries no policy.
ENTRYPOINT ["python", "server.py"]
