FROM python:3.12-alpine

WORKDIR /app
COPY server.py .

# No requirements.txt. A hook handler is an ordinary MCP tool, and answering the protocol
# takes a standard library and nothing else.
ENTRYPOINT ["python", "server.py"]
