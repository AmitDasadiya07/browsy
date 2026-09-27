import { VercelRequest, VercelResponse } from '@vercel/node';
import { getCombinedState } from '../src/dashboard/state-helper';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const state = await getCombinedState();
    res.status(200).json(state);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
