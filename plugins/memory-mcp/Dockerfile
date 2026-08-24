FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

# The state directory is mounted by the core at FORGEPOD_STATE_DIR, so nothing is
# created here: an image that ships a state directory would shadow the mount.
ENTRYPOINT ["python", "server.py"]
