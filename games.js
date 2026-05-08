const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

// ── Helpers ────────────────────────────────────────────
function genRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MBG-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function uniqueRef(client) {
  for (let i = 0; i < 10; i++) {
    const ref = genRef();
    const { rows } = await client.query('SELECT id FROM community_games WHERE ref_code = $1', [ref]);
    if (rows.length === 0) return ref;
  }
  throw new Error('Could not generate unique ref code');
}

// ── GET /api/games — list all open/upcoming games ─────
router.get('/games', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        g.id, g.ref_code, g.booking_date, g.sport, g.court_type,
        g.host_name, g.max_players, g.current_players, g.price_per_player,
        g.status, g.created_at,
        t.name AS turf_name, t.location,
        TO_CHAR(s.start_time, 'HH12:MI AM') AS start_time,
        TO_CHAR(s.end_time, 'HH12:MI AM') AS end_time
      FROM community_games g
      JOIN turfs t ON t.id = g.turf_id
      JOIN slots s ON s.id = g.slot_id
      WHERE g.status IN ('open', 'full')
        AND g.booking_date >= CURRENT_DATE
      ORDER BY g.booking_date ASC, s.start_time ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/games/:id — single game details ──────────
router.get('/games/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        g.id, g.ref_code, g.booking_date, g.sport, g.court_type,
        g.host_name, g.host_phone, g.max_players, g.current_players,
        g.price_per_player, g.status, g.created_at,
        t.name AS turf_name, t.location,
        TO_CHAR(s.start_time, 'HH12:MI AM') AS start_time,
        TO_CHAR(s.end_time, 'HH12:MI AM') AS end_time
      FROM community_games g
      JOIN turfs t ON t.id = g.turf_id
      JOIN slots s ON s.id = g.slot_id
      WHERE g.id = $1
    `, [req.params.id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Game not found' });

    const participants = await pool.query(
      `SELECT name, phone, joined_at FROM game_participants WHERE game_id = $1 ORDER BY joined_at ASC`,
      [req.params.id]
    );

    res.json({ ...rows[0], participants: participants.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/games — create a game ───────────────────
router.post('/games', async (req, res) => {
  const { turf_id, slot_id, booking_date, court_type, sport, host_name, host_phone, max_players } = req.body;
  if (!turf_id || !slot_id || !booking_date || !court_type || !sport || !host_name || !host_phone || !max_players) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check slot isn't already booked or blocked
    const conflict = await client.query(
      `SELECT id FROM bookings WHERE slot_id = $1 AND booking_date = $2 AND status NOT IN ('cancelled')`,
      [slot_id, booking_date]
    );
    if (conflict.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is already booked or blocked' });
    }

    // Check slot isn't already used for another game
    const gameConflict = await client.query(
      `SELECT id FROM community_games WHERE slot_id = $1 AND booking_date = $2 AND status != 'cancelled'`,
      [slot_id, booking_date]
    );
    if (gameConflict.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A community game already exists for this slot' });
    }

    // Get slot price for price_per_player
    const slotRes = await client.query('SELECT price FROM slots WHERE id = $1', [slot_id]);
    const price_per_player = parseFloat(slotRes.rows[0]?.price) || 0;

    const ref_code = await uniqueRef(client);

    // Create the game
    const gameRes = await client.query(`
      INSERT INTO community_games
        (id, turf_id, slot_id, booking_date, court_type, sport, host_name, host_phone, max_players, price_per_player, ref_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [uuidv4(), turf_id, slot_id, booking_date, court_type, sport, host_name, host_phone, max_players, price_per_player, ref_code]);

    // Add host as first participant
    await client.query(`
      INSERT INTO game_participants (id, game_id, name, phone)
      VALUES ($1, $2, $3, $4)
    `, [uuidv4(), gameRes.rows[0].id, host_name, host_phone]);

    // Block the slot in bookings table
    let customer = await client.query('SELECT id FROM customers WHERE phone = $1', ['GAME-BLOCKED']);
    if (customer.rows.length === 0) {
      customer = await client.query(
        `INSERT INTO customers (id, name, phone) VALUES ($1, 'Game Blocked', 'GAME-BLOCKED') RETURNING id`,
        [uuidv4()]
      );
    }
    await client.query(`
      INSERT INTO bookings (id, turf_id, slot_id, customer_id, booking_date, status, court_type, ref_code)
      VALUES ($1,$2,$3,$4,$5,'blocked',$6,$7)
    `, [uuidv4(), turf_id, slot_id, customer.rows[0].id, booking_date, court_type, ref_code]);

    await client.query('COMMIT');
    res.json({ success: true, game: gameRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/games/:id/join — join a game ────────────
router.post('/games/:id/join', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gameRes = await client.query(
      `SELECT * FROM community_games WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (gameRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameRes.rows[0];

    if (game.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: game.status === 'full' ? 'Game is full' : 'Game is no longer available' });
    }

    // Check if already joined
    const already = await client.query(
      `SELECT id FROM game_participants WHERE game_id = $1 AND phone = $2`,
      [req.params.id, phone]
    );
    if (already.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You have already joined this game' });
    }

    // Add participant
    await client.query(
      `INSERT INTO game_participants (id, game_id, name, phone) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), req.params.id, name, phone]
    );

    const newCount = game.current_players + 1;
    const newStatus = newCount >= game.max_players ? 'full' : 'open';

    await client.query(
      `UPDATE community_games SET current_players = $1, status = $2 WHERE id = $3`,
      [newCount, newStatus, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, current_players: newCount, status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /api/games/:id — host cancels game ─────────
router.delete('/games/:id', async (req, res) => {
  const { host_phone } = req.body;
  if (!host_phone) return res.status(400).json({ error: 'host_phone required to cancel' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gameRes = await client.query(
      `SELECT * FROM community_games WHERE id = $1`,
      [req.params.id]
    );
    if (gameRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameRes.rows[0];

    if (game.host_phone !== host_phone) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the host can cancel this game' });
    }

    if (game.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Game already cancelled' });
    }

    // Cancel the game
    await client.query(
      `UPDATE community_games SET status = 'cancelled' WHERE id = $1`,
      [req.params.id]
    );

    // Unblock the slot
    await client.query(
      `UPDATE bookings SET status = 'cancelled' WHERE slot_id = $1 AND booking_date = $2 AND status = 'blocked' AND ref_code = $3`,
      [game.slot_id, game.booking_date, game.ref_code]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
