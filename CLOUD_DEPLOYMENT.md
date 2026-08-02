# Cloud Deployment

Fastest practical path for tomorrow: Render, Railway, Fly.io, or Google Cloud Run with a persistent volume.

## Render

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Use the included `render.yaml`, or configure manually:
   - Environment: Docker
   - Health check path: `/api/status`
   - Persistent disk: mount `/data`, size 1 GB
   - Env vars:
     - `DATA_DIR=/data`
     - `COOKIE_SECURE=1`
4. Deploy.
5. Open the HTTPS URL on your phone.

## Railway

1. Create a new project from GitHub.
2. Select this repo/folder.
3. Add a volume mounted to `/data`.
4. Set env vars:
   - `DATA_DIR=/data`
   - `COOKIE_SECURE=1`
5. Deploy and open the generated HTTPS domain.

## Google Cloud Run

Cloud Run alone has ephemeral filesystem. For real use, connect a persistent store before relying on it. For tomorrow, Render/Railway with a mounted disk is simpler.

## Pre-Service Checklist

- Owner setup completed with a strong password.
- At least one staff user created.
- Menu checked on the phone.
- KOT created successfully.
- Bill created successfully.
- Report shows the bill.
- Backup JSON downloaded.
- Phone print/share flow tested.
