import fs from "fs";
import path from "path";
import pino from "pino";
import { env } from "../config/env";

// Writes structured JSON logs to stdout (for `npm run dev` terminal) and to
// backend/logs/app.log (NDJSON) so Promtail can tail the file and ship it to
// Loki/Grafana. See docker-compose.logging.yml at the repo root.
const logDir = path.join(__dirname, "../../logs");
fs.mkdirSync(logDir, { recursive: true });

const fileDest = pino.destination({ dest: path.join(logDir, "app.log"), mkdir: true, sync: false });

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: { service: "hoanglam-bank-backend" },
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  pino.multistream([{ stream: process.stdout }, { stream: fileDest }])
);
