// Authentication routes: login (bcrypt + JWT), current user, logout.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('./prismaClient');
const { loadAuthContext, JWT_SECRET } = require('./authContext');
const { authenticate } = require('./middleware');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || !user.active || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
  const context = await loadAuthContext(user.id);
  res.json({ token, user: context });
});

router.get('/me', authenticate, (req, res) => res.json({ user: req.user }));

// Stateless JWT — logout is client-side (drop the token). Endpoint kept for symmetry.
router.post('/logout', (req, res) => res.json({ ok: true }));

module.exports = router;
