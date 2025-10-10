# GTranslate V4 - Docker Deployment Guide

This guide explains how to deploy GTranslate V4 using Docker containers.

## Prerequisites

1. **Docker** installed on your system
   - [Docker Desktop](https://www.docker.com/products/docker-desktop) (Mac/Windows)
   - Docker Engine (Linux)

2. **Google Cloud credentials file** (`google-credentials.json`)
   - See main README for instructions on obtaining credentials

## Directory Structure

```
GtranslateV4/
├── docker/
│   ├── Dockerfile              # Container image definition
│   ├── .dockerignore          # Files to exclude from build
│   └── DOCKER-DEPLOYMENT.md   # This file
├── docker-compose.yml         # Docker Compose configuration (project root)
├── google-credentials.json    # Your Google Cloud credentials
├── server.js                  # Application server
├── index.html                 # Web interface
└── logs/                      # Application logs (created automatically)
```

**Note:** All Docker-related files are in the `docker/` subdirectory, but `docker-compose.yml` stays in the project root for convenience.

## Quick Start

### Option 1: Using Docker Compose (Recommended)

1. **Place your Google credentials file in the project root directory:**
   ```bash
   # Make sure google-credentials.json is in the project root (not in docker/)
   ls google-credentials.json
   ```

2. **Create logs directory:**
   ```bash
   mkdir -p logs
   ```

3. **Start the container:**
   ```bash
   docker-compose up -d
   ```

4. **Access the application:**
   ```
   http://localhost:3003
   ```

5. **View logs:**
   ```bash
   docker-compose logs -f
   ```

6. **Stop the container:**
   ```bash
   docker-compose down
   ```

### Option 2: Using Docker CLI

1. **Build the image:**
   ```bash
   docker build -f docker/Dockerfile -t gtranslate-v4 .
   ```

2. **Run the container:**
   ```bash
   docker run -d \
     --name gtranslate-v4 \
     -p 3003:3003 \
     -v $(pwd)/google-credentials.json:/app/google-credentials.json:ro \
     -v $(pwd)/logs:/app/logs \
     -e GOOGLE_APPLICATION_CREDENTIALS=/app/google-credentials.json \
     -e NODE_ENV=production \
     gtranslate-v4
   ```

3. **View logs:**
   ```bash
   docker logs -f gtranslate-v4
   ```

4. **Stop and remove:**
   ```bash
   docker stop gtranslate-v4
   docker rm gtranslate-v4
   ```

## Configuration

### Environment Variables

Customize the container behavior using environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Node environment |
| `PORT` | `3003` | Server port |
| `MAX_CONNECTIONS` | `50` | Maximum concurrent connections |
| `MAX_CONNECTIONS_PER_IP` | `5` | Maximum connections per IP |
| `INACTIVITY_TIMEOUT` | `1800000` | Session timeout in ms (30 min) |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/app/google-credentials.json` | Path to credentials (inside container) |

### Resource Limits

The default `docker-compose.yml` includes resource limits:

- **CPU Limit:** 2.0 cores
- **Memory Limit:** 2GB
- **CPU Reservation:** 0.5 cores
- **Memory Reservation:** 512MB

Adjust these in the `deploy.resources` section of `docker-compose.yml` based on your needs.

## Security Features

The Docker deployment includes several security hardening features:

1. **Non-root user:** Container runs as user `nodejs` (UID 1001)
2. **Read-only root filesystem:** Prevents container modification
3. **No new privileges:** Prevents privilege escalation
4. **Resource limits:** Prevents resource exhaustion
5. **Health checks:** Automatic container health monitoring
6. **Credentials mounted read-only:** Prevents credential tampering

## Production Deployment

### Using a Reverse Proxy (Recommended)

For production, use a reverse proxy like Nginx or Traefik:

**Example Nginx configuration:**

```nginx
server {
    listen 80;
    server_name gtranslate.example.com;

    location / {
        proxy_pass http://localhost:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeouts
        proxy_read_timeout 86400;
    }
}
```

### HTTPS Setup

For HTTPS, add SSL certificates to your reverse proxy or use:

1. **Traefik** with automatic Let's Encrypt certificates
2. **Nginx** with Certbot
3. **Cloudflare** for SSL termination

**Note:** Update CORS origins in `server.js` if using a different domain.

### Docker Compose with Nginx

Example `docker-compose.yml` with Nginx:

```yaml
version: '3.8'

services:
  gtranslate:
    build: .
    image: gtranslate-v4:latest
    container_name: gtranslate-v4
    expose:
      - "3003"
    volumes:
      - ./google-credentials.json:/app/google-credentials.json:ro
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
      - PORT=3003
      - GOOGLE_APPLICATION_CREDENTIALS=/app/google-credentials.json
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    container_name: gtranslate-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - gtranslate
    restart: unless-stopped
```

## Monitoring

### Health Checks

The container includes automatic health checks:

```bash
# Check container health status
docker ps

# View health check logs
docker inspect --format='{{json .State.Health}}' gtranslate-v4
```

### Log Management

Logs are stored in the mounted `logs` directory:

```bash
# View application logs
tail -f logs/gtranslate-v4.log

# View Docker container logs
docker-compose logs -f gtranslate
```

### Log Rotation

Configure log rotation to prevent disk space issues:

```bash
# Create logrotate config
sudo nano /etc/logrotate.d/gtranslate

# Add configuration:
/path/to/gtranslate/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    notifempty
    missingok
    copytruncate
}
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs gtranslate

# Common issues:
# - Missing google-credentials.json
# - Port 3003 already in use
# - Insufficient permissions
```

### Credentials not found

```bash
# Verify credentials are mounted correctly
docker exec gtranslate-v4 ls -la /app/google-credentials.json

# Should show: -r--r--r-- 1 nodejs nodejs [size] [date] /app/google-credentials.json
```

### Permission errors

```bash
# Ensure logs directory is writable
chmod 755 logs

# Check ownership
ls -la logs
```

### WebSocket connection issues

Ensure your reverse proxy properly handles WebSocket upgrades (see Nginx config above).

## Scaling

### Multiple Instances

To run multiple instances (e.g., for load balancing):

```bash
docker-compose up -d --scale gtranslate=3
```

**Note:** You'll need a load balancer (Nginx, HAProxy, Traefik) to distribute traffic across instances.

### Kubernetes

For Kubernetes deployment, create manifests based on the Docker image:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gtranslate-v4
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gtranslate
  template:
    metadata:
      labels:
        app: gtranslate
    spec:
      containers:
      - name: gtranslate
        image: gtranslate-v4:latest
        ports:
        - containerPort: 3003
        env:
        - name: GOOGLE_APPLICATION_CREDENTIALS
          value: /app/google-credentials.json
        volumeMounts:
        - name: credentials
          mountPath: /app/google-credentials.json
          subPath: google-credentials.json
          readOnly: true
      volumes:
      - name: credentials
        secret:
          secretName: google-credentials
```

## Updates

### Updating the Application

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Updating Dependencies

```bash
# Rebuild image with updated dependencies
docker-compose build --no-cache --pull
docker-compose up -d
```

## Backup

### Backup Credentials

```bash
# Backup credentials securely
cp google-credentials.json ~/backups/google-credentials-$(date +%Y%m%d).json
chmod 600 ~/backups/google-credentials-*.json
```

### Backup Configuration

```bash
# Backup all configuration
tar czf gtranslate-backup-$(date +%Y%m%d).tar.gz \
  docker-compose.yml \
  google-credentials.json \
  nginx.conf \
  logs/
```

## Support

For issues specific to Docker deployment, please check:

1. Docker logs: `docker-compose logs -f`
2. Container health: `docker ps`
3. Resource usage: `docker stats gtranslate-v4`
4. Network connectivity: `docker network inspect gtranslatev4_default`
