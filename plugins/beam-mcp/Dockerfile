FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

# stdio transport, so the core talks over the container's stdin and stdout and
# there is no port to allocate or network to configure.
ENTRYPOINT ["python", "server.py"]
