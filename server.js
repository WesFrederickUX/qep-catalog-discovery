import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import catalogRoutes from './routes/catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/api/catalog', catalogRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QEP Catalog Discovery running at http://localhost:${PORT}`);
});
