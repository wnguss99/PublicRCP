import path from 'path';
import os from 'os';
import fs from 'fs';

const DATA_DIR_NAME = '.claudito';

export function getDataDirectory(): string {
  const dataDir = process.env.CLAUDITO_HOME || path.join(os.homedir(), DATA_DIR_NAME);

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}
