# Docker Files

This directory contains all Docker-related files for GTranslate V4.

## Files

- **Dockerfile** - Container image definition
- **.dockerignore** - Files excluded from Docker build context
- **DOCKER-DEPLOYMENT.md** - Comprehensive deployment guide

## Quick Start

See [DOCKER-DEPLOYMENT.md](./DOCKER-DEPLOYMENT.md) for complete instructions.

From the **project root** directory:

```bash
# Start with Docker Compose
docker-compose up -d

# Or build manually
docker build -f docker/Dockerfile -t gtranslate-v4 .
```

## Note

The `docker-compose.yml` file is kept in the project root for convenience, but references this directory for the Dockerfile.
