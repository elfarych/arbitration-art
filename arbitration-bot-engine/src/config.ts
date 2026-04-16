import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

export const config = {
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
    useTestnet: process.env.USE_TESTNET === 'true',
    port: parseInt(process.env.PORT || '3001', 10),
};
