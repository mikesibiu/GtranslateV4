#!/bin/bash
# Generate self-signed SSL certificate for local development

openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"

echo "✅ Certificate generated: cert.pem and key.pem"
echo "⚠️  You'll need to accept the security warning in your browser"
