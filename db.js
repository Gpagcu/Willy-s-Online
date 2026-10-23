require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Copy .env.example to .env and paste your Neon connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 10,
});

const query = (text, params) => pool.query(text, params);

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  // Sample products so the store isn't empty (delete them in the admin panel later)
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (count.rows[0].n === 0) {
    const samples = [
      ['Full-Grain Leather Belt', 'LTH-BELT-001', 'Leather Goods', 'Handcrafted full-grain leather belt with solid brass buckle.', 850, 20],
      ['Bifold Leather Wallet', 'LTH-WAL-001', 'Leather Goods', 'Slim bifold wallet with card slots and coin pocket.', 650, 15],
      ['Tactical Leather Holster Belt', 'LTH-TAC-001', 'Leather Goods', 'Heavy-duty 1.5" belt for everyday carry.', 1200, 10],
      ['Combat Uniform Top (Woodland)', 'MIL-TOP-001', 'Military Clothing', 'Durable ripstop combat uniform top.', 1450, 25],
      ['Combat Trousers (Woodland)', 'MIL-TRS-001', 'Military Clothing', 'Reinforced knees, multiple cargo pockets.', 1550, 25],
      ['Military Boots', 'MIL-BTS-001', 'Footwear', 'Water-resistant lace-up boots with rubber sole.', 2800, 12],
      ['Tactical Cap', 'MIL-CAP-001', 'Accessories', 'Adjustable cap with hook-and-loop patch panel.', 350, 40],
      ['Tactical Vest', 'TAC-VST-001', 'Tactical Gear', 'Adjustable tactical vest with MOLLE webbing and quick-release buckles.', 1800, 15],
      ['Chest Rig', 'TAC-RIG-001', 'Tactical Gear', 'Lightweight chest rig with magazine pouches and admin panel.', 1350, 15],
      ['Padded Gun Case', 'TAC-CSE-001', 'Tactical Gear', 'Water-resistant padded case with carry handles and shoulder strap.', 2200, 10],
    ];
    for (const s of samples) {
      await pool.query(
        'INSERT INTO products (name,sku,category,description,price,stock) VALUES ($1,$2,$3,$4,$5,$6)',
        s
      );
    }
    console.log('Added sample products.');
  }
}

module.exports = { pool, query, init };
