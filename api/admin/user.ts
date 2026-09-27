import { VercelRequest, VercelResponse } from '@vercel/node';
/**
 * Admin endpoint to create a new bot user (e.g., "jorge").
 *
 * Body: { username: string, password: string }
 *
 * The request is forwarded to the external bot host (BOT_HOST env var).
 * The bot host must implement `/api/user/create` to store the credentials
 * securely (e.g., in a DB or encrypted file).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const adminToken = process.env.ADMIN_TOKEN;
  const auth = req.headers.authorization?.split(' ')[1];
  if (!adminToken || auth !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const botHost = process.env.BOT_HOST;
  if (!botHost) return res.status(500).json({ error: 'BOT_HOST not set' });

  if (req.method === 'POST') {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    try {
      const resp = await fetch(`${botHost}/api/user/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  } else if (req.method === 'GET') {
    try {
      const resp = await fetch(`${botHost}/api/user/list`);
      const data = await resp.json();
      return res.status(resp.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}
