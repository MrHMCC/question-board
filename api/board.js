
import { Redis } from '@upstash/redis';
import { randomUUID, randomInt } from 'node:crypto';

// Works with both the Upstash and the Vercel "KV" env var names.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const TTL = 60 * 60 * 24 * 30;          // boards expire after 30 days of no activity
const EMOJIS = ['👍', '❤️', '😮', '🤔', '💡'];
const MAX_POST = 280;
const MAX_PROMPT = 300;
const MAX_POSTS_PER_BOARD = 300;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L confusion

const makeCode = () =>
  Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

const isTeacher = (req) =>
  !!process.env.TEACHER_KEY && req.headers['x-teacher-key'] === process.env.TEACHER_KEY;

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

// Very light rate limit. The IP is only used as a short-lived counter key (expires in 60s).
async function rateLimited(req, code, limit) {
  const key = `rl:${code}:${clientIp(req)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 60);
  return n > limit;
}

async function touch(code) {
  await Promise.all([
    redis.expire(`s:${code}`, TTL),
    redis.expire(`p:${code}`, TTL),
    redis.expire(`r:${code}`, TTL),
  ]);
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    // ---------- READ (students + teacher poll this) ----------
    if (req.method === 'GET') {
      const code = clean(req.query.code, 10).toUpperCase();
      const [session, posts, reacts] = await Promise.all([
        redis.hgetall(`s:${code}`),
        redis.hgetall(`p:${code}`),
        redis.hgetall(`r:${code}`),
      ]);
      if (!session || !Object.keys(session).length) {
        return res.status(404).json({ error: 'Class code not found' });
      }
      const teacher = isTeacher(req);
      const list = Object.values(posts || {})
        .filter((p) => teacher || !p.hidden)
        .map((p) => ({
          ...p,
          reactions: Object.fromEntries(
            EMOJIS.map((e) => [e, Math.max(0, Number(reacts?.[`${p.id}:${e}`] || 0))])
          ),
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      return res.status(200).json({
        code,
        title: session.title || '',
        prompt: session.prompt || '',
        highlightedId: session.highlightedId || '',
        locked: !!session.locked,
        emojis: EMOJIS,
        posts: list,
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const action = body.action;
    const code = clean(body.code, 10).toUpperCase();

    // ---------- TEACHER: create a board ----------
    if (action === 'create') {
      if (!isTeacher(req)) return res.status(401).json({ error: 'Wrong teacher key' });
      let newCode;
      for (let i = 0; i < 10; i++) {
        const c = makeCode();
        if (!(await redis.exists(`s:${c}`))) { newCode = c; break; }
      }
      if (!newCode) return res.status(500).json({ error: 'Could not make a code, try again' });
      await redis.hset(`s:${newCode}`, {
        title: clean(body.title, 80),
        prompt: clean(body.prompt, MAX_PROMPT),
        highlightedId: '',
        locked: false,
        createdAt: Date.now(),
      });
      await touch(newCode);
      return res.status(200).json({ code: newCode });
    }

    // Everything below needs an existing board
    if (!(await redis.exists(`s:${code}`))) {
      return res.status(404).json({ error: 'Class code not found' });
    }

    // ---------- STUDENT: post ----------
    if (action === 'post') {
      const session = await redis.hgetall(`s:${code}`);
      if (session.locked) return res.status(403).json({ error: 'Posting is paused' });
      if (await rateLimited(req, code, 6)) {
        return res.status(429).json({ error: 'Slow down a little!' });
      }
      const text = clean(body.text, MAX_POST);
      if (!text) return res.status(400).json({ error: 'Write something first' });
      if ((await redis.hlen(`p:${code}`)) >= MAX_POSTS_PER_BOARD) {
        return res.status(403).json({ error: 'This board is full' });
      }
      const post = { id: randomUUID().slice(0, 8), text, createdAt: Date.now(), hidden: false };
      await redis.hset(`p:${code}`, { [post.id]: post });
      await touch(code);
      return res.status(200).json({ ok: true, id: post.id });
    }

    // ---------- STUDENT: react (toggle on/off is handled client-side with delta +1 / -1) ----------
    if (action === 'react') {
      if (!EMOJIS.includes(body.emoji)) return res.status(400).json({ error: 'Bad reaction' });
      if (await rateLimited(req, code, 60)) return res.status(429).json({ error: 'Slow down' });
      const postId = clean(body.postId, 16);
      if (!(await redis.hexists(`p:${code}`, postId))) {
        return res.status(404).json({ error: 'Post not found' });
      }
      const delta = body.delta === -1 ? -1 : 1;
      const field = `${postId}:${body.emoji}`;
      const n = await redis.hincrby(`r:${code}`, field, delta);
      if (n < 0) await redis.hset(`r:${code}`, { [field]: 0 });
      return res.status(200).json({ ok: true });
    }

    // ---------- TEACHER-ONLY actions ----------
    if (!isTeacher(req)) return res.status(401).json({ error: 'Wrong teacher key' });

    switch (action) {
      case 'setPrompt':
        await redis.hset(`s:${code}`, {
          prompt: clean(body.prompt, MAX_PROMPT),
          ...(body.title !== undefined ? { title: clean(body.title, 80) } : {}),
        });
        break;
      case 'highlight': // postId '' clears the highlight
        await redis.hset(`s:${code}`, { highlightedId: clean(body.postId, 16) });
        break;
      case 'lock':
        await redis.hset(`s:${code}`, { locked: !!body.locked });
        break;
      case 'hide': {
        const p = await redis.hget(`p:${code}`, clean(body.postId, 16));
        if (p) await redis.hset(`p:${code}`, { [p.id]: { ...p, hidden: !!body.hidden } });
        break;
      }
      case 'remove': {
        const id = clean(body.postId, 16);
        await redis.hdel(`p:${code}`, id);
        const s = await redis.hgetall(`s:${code}`);
        if (s.highlightedId === id) await redis.hset(`s:${code}`, { highlightedId: '' });
        break;
      }
      case 'clear':
        await Promise.all([
          redis.del(`p:${code}`),
          redis.del(`r:${code}`),
          redis.hset(`s:${code}`, { highlightedId: '' }),
        ]);
        break;
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
    await touch(code);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
