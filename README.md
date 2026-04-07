# Bounty Bot

GitHub bounty validation bot - controlled by Atlas via API.

## Architecture

- Controlled by [PlatformNetwork/atlas](https://github.com/PlatformNetwork/atlas)
- REST API on port 3235
- SQLite persistence
- GitHub integration for issue validation

## Endpoints

- `GET /health` - Health check
- `POST /api/validate` - Trigger validation (Atlas → Bounty-bot)
- `GET /api/status/:issue` - Check validation status
- `POST /api/requeue` - Requeue issue for validation
