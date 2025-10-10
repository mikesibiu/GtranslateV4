# GTranslate V4 - Heroku Deployment Guide

Deploy GTranslate V4 to Heroku for cloud hosting.

## ⚠️ Important Considerations

### Limitations
1. **No Free Tier** - Heroku starts at $5/month minimum (Eco dyno)
2. **Dyno Restarts** - App restarts every 24 hours (sessions will disconnect)
3. **Ephemeral Filesystem** - Logs don't persist across restarts
4. **Single Dyno** - May struggle with many concurrent WebSocket connections

### Costs
- **Heroku Dyno**: $5-7/month (Eco/Basic)
- **Google Cloud APIs**: ~$0.50-2.00/hour during active use

### Better Alternatives
Consider these instead:
- **Docker** - Self-hosted on your own server (see `docker/DOCKER-DEPLOYMENT.md`)
- **Railway** - Similar to Heroku, better pricing
- **Fly.io** - Modern alternative with better WebSocket support
- **DigitalOcean App Platform** - $5/month with better persistence

## Prerequisites

1. **Heroku Account** - [Sign up](https://signup.heroku.com/)
2. **Heroku CLI** - [Install](https://devcenter.heroku.com/articles/heroku-cli)
3. **Git** - For deployment
4. **Google Cloud Credentials** - Service account JSON file

## Quick Start

### 1. Login to Heroku

```bash
heroku login
```

### 2. Create Heroku App

```bash
cd /Users/mfarace/ClaudeProjects/GtranslateV4

# Create app (replace with your preferred name)
heroku create gtranslate-v4

# Or use a custom name
heroku create your-app-name
```

### 3. Set Google Cloud Credentials

**CRITICAL:** You must provide credentials as an environment variable (not a file):

```bash
# Copy your google-credentials.json contents
cat google-credentials.json

# Set as environment variable (paste the ENTIRE JSON as one line)
heroku config:set GOOGLE_CREDENTIALS_JSON='{"type":"service_account","project_id":"your-project",...}'
```

**Alternative: Use Heroku Dashboard**
1. Go to your app in Heroku Dashboard
2. Settings → Config Vars
3. Add key: `GOOGLE_CREDENTIALS_JSON`
4. Paste entire contents of `google-credentials.json` as value

### 4. Configure Environment Variables (Optional)

```bash
# Set production environment
heroku config:set NODE_ENV=production

# Adjust connection limits if needed
heroku config:set MAX_CONNECTIONS=50
heroku config:set MAX_CONNECTIONS_PER_IP=5

# Adjust session timeout (30 minutes default)
heroku config:set INACTIVITY_TIMEOUT=1800000
```

### 5. Initialize Git (if not already)

```bash
# Check if git is initialized
git status

# If not initialized:
git init
git add .
git commit -m "Initial commit for Heroku deployment"
```

### 6. Deploy to Heroku

```bash
# Add Heroku remote
heroku git:remote -a gtranslate-v4  # Use your app name

# Deploy
git push heroku main

# Or if using master branch:
git push heroku master
```

### 7. Open Your App

```bash
heroku open
```

Your app will be available at: `https://gtranslate-v4.herokuapp.com`

## Verify Deployment

### Check Logs

```bash
# View real-time logs
heroku logs --tail

# View recent logs
heroku logs --num=200
```

### Check App Status

```bash
heroku ps
```

### Test the App

1. Open the URL: `https://your-app-name.herokuapp.com`
2. Click "Start Listening"
3. Grant microphone permissions
4. Speak and verify translations appear

## Environment Variables

View all configured variables:

```bash
heroku config
```

Update a variable:

```bash
heroku config:set VARIABLE_NAME=value
```

Remove a variable:

```bash
heroku config:unset VARIABLE_NAME
```

## Scaling

### Upgrade Dyno Type

```bash
# Basic dyno ($7/month) - Better for production
heroku ps:scale web=1:basic

# Standard-1X ($25/month) - More memory/CPU
heroku ps:scale web=1:standard-1x
```

### Multiple Dynos (Not Recommended)

WebSocket apps don't scale well horizontally without sticky sessions:

```bash
# Not recommended without load balancer
heroku ps:scale web=2
```

## Custom Domain

### Add Domain

```bash
heroku domains:add www.yourdomain.com
```

### Configure DNS

Point your domain CNAME to:
```
your-app-name.herokuapp.com
```

### Enable SSL (Automatic)

Heroku provides free SSL certificates for custom domains.

## Monitoring

### View Metrics

```bash
heroku metrics
```

Or use the Heroku Dashboard: **Your App → Metrics**

### Add-ons (Optional)

```bash
# Papertrail for log management (free tier available)
heroku addons:create papertrail:choklad

# View logs
heroku addons:open papertrail
```

## Troubleshooting

### App Won't Start

```bash
# Check logs for errors
heroku logs --tail

# Common issues:
# - Missing GOOGLE_CREDENTIALS_JSON environment variable
# - Invalid JSON in credentials
# - Node.js version mismatch
```

### WebSocket Connection Fails

1. Check Heroku logs for errors
2. Verify app is using correct PORT (Heroku provides this)
3. Ensure CORS origins include your Heroku domain

```bash
# Update CORS in server.js to include Heroku domain
# Edit server.js, search for "allowedOrigins"
```

### Credentials Not Working

```bash
# Verify credentials are set
heroku config:get GOOGLE_CREDENTIALS_JSON

# Should show your JSON credentials
# If empty, re-add them:
heroku config:set GOOGLE_CREDENTIALS_JSON='...'
```

### App Crashes After 24 Hours

This is normal - Heroku restarts dynos daily. Active sessions will disconnect, but the app will restart automatically.

## Updates

### Deploy Updates

```bash
# Make your changes
git add .
git commit -m "Update description"
git push heroku main
```

### Rollback to Previous Version

```bash
# View releases
heroku releases

# Rollback to previous version
heroku rollback
```

## Cost Management

### Minimize Costs

1. **Use Eco Dyno** - $5/month (sleeps after 30 min inactivity)
2. **Monitor Google Cloud Usage** - Set budget alerts
3. **Limit concurrent connections** - Reduce MAX_CONNECTIONS

### Check Current Costs

```bash
# View app info including dyno type
heroku ps

# View billing
heroku billing  # Opens dashboard
```

## Migrating Away from Heroku

### Export Your Data

Heroku doesn't store persistent data, but you can:

1. Download code: Already in Git
2. Download environment variables:
   ```bash
   heroku config --shell > .env.heroku
   ```

### Migrate to Docker

See [docker/DOCKER-DEPLOYMENT.md](./docker/DOCKER-DEPLOYMENT.md) for self-hosted deployment.

## Alternative Cloud Platforms

### Railway (Recommended Alternative)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

**Benefits:**
- $5/month with better resource limits
- Better WebSocket support
- Easier environment variable management

### Fly.io

```bash
# Install flyctl
brew install flyctl  # macOS

# Deploy
fly launch
fly deploy
```

**Benefits:**
- Better for WebSocket apps
- Global edge deployment
- $5/month starter plan

### DigitalOcean App Platform

Use the DigitalOcean dashboard to deploy from Git.

**Benefits:**
- $5/month
- Persistent storage available
- Better pricing at scale

## Support

### Heroku Resources

- [Heroku Dev Center](https://devcenter.heroku.com/)
- [Node.js on Heroku](https://devcenter.heroku.com/articles/getting-started-with-nodejs)
- [WebSockets on Heroku](https://devcenter.heroku.com/articles/websockets)

### GTranslate V4 Issues

For app-specific issues:
1. Check app logs: `heroku logs --tail`
2. Review [README.md](./README.md)
3. Review [SETUP.md](./SETUP.md)

---

**Note:** Heroku is convenient but expensive for long-running apps. Consider Docker deployment for better cost efficiency.
