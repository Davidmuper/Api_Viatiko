import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import gastosRouter from './routes/gastos.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
// En Vercel la carpeta public/ la sirve directamente su CDN; esto aplica en local y en Render
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/gastos', gastosRouter);

// En Vercel la app se ejecuta como función (api/index.js) y no debe abrir un puerto
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor VIATIKO activo en http://localhost:${PORT}`);
  });
}

export default app;
