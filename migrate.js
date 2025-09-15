
import { Database } from './sqlite.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, 'data', 'app.db'));
db.migrate();
console.log('Migration complete.');
