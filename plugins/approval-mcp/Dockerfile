FROM python:3.12-alpine

WORKDIR /app
COPY server.py .

# No requirements.txt. SQLite ships with Python, and answering the protocol takes the
# standard library and nothing else. The approvals database lives on the state mount.
ENTRYPOINT ["python", "server.py"]
