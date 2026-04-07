// Bounty-bot: GitHub bounty validation service
// Controlled by Atlas via REST API

import express from 'express';

const app = express();
const PORT = process.env.PORT || 3235;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'bounty-bot' });
});

app.listen(PORT, () => {
  console.log(`bounty-bot listening on port ${PORT}`);
});
