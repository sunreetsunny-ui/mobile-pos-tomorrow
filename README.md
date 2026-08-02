# Mobile POS Tomorrow

Phone-first restaurant POS that can run from a hosted URL. It includes owner setup, staff login, menu, cart, KOT, bill, daily report, JSON backup export, cookie sessions, CSRF protection, and file persistence.

## Local Run

```bash
npm test
npm start
```

Open `http://localhost:8080` on the same device.

## Cloud Run Shape

This app is a single Node.js HTTP server with no external npm dependencies. It persists data to `DATA_DIR/pos.json`.

Use a host that provides:

- HTTPS
- Persistent disk or volume mounted at `/data`
- `PORT` environment variable
- `DATA_DIR=/data`
- `COOKIE_SECURE=1`

## Tomorrow Flow

1. Deploy it to a host with persistent disk.
2. Open the public HTTPS URL on your phone.
3. Complete owner setup.
4. Add staff users in Manage.
5. Add/edit menu items in Manage.
6. Start taking orders in Order.
7. Use KOT/Bill print buttons with your phone browser print/share flow.
8. At end of day, open Report and download Backup JSON.

## Important Limitations

- This is ready as an emergency phone POS, not a full enterprise POS.
- Browser printing depends on the phone/printer setup.
- Keep daily Backup JSON exports.
- Do not share the owner account with staff.
