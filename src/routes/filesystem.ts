import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mime = require('mime-types') as { lookup: (path: string) => string | false };

export interface FilesystemService {
  listDrives(): Promise<DriveInfo[]>;
  listDirectory(dirPath: string): Promise<DirectoryEntry[]>;
  listDirectoryWithFiles(dirPath: string): Promise<DirectoryEntry[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  createDirectory(dirPath: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  deleteDirectory(dirPath: string): Promise<void>;
  isTextFile(filePath: string): boolean;
}

export interface DriveInfo {
  name: string;
  path: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

abstract class BaseFilesystemService implements FilesystemService {
  abstract listDrives(): Promise<DriveInfo[]>;

  async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
    const normalizedPath = path.normalize(dirPath);
    const entries = await fs.promises.readdir(normalizedPath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(normalizedPath, entry.name),
        isDirectory: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listDirectoryWithFiles(dirPath: string): Promise<DirectoryEntry[]> {
    const normalizedPath = path.normalize(dirPath);
    const entries = await fs.promises.readdir(normalizedPath, { withFileTypes: true });

    const result = entries
      .map((entry) => ({
        name: entry.name,
        path: path.join(normalizedPath, entry.name),
        isDirectory: entry.isDirectory(),
      }));

    return result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(filePath: string): Promise<string> {
    const normalizedPath = path.normalize(filePath);
    return fs.promises.readFile(normalizedPath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const normalizedPath = path.normalize(filePath);
    await fs.promises.writeFile(normalizedPath, content, 'utf-8');
  }

  async createDirectory(dirPath: string): Promise<void> {
    const normalizedPath = path.normalize(dirPath);
    await fs.promises.mkdir(normalizedPath, { recursive: false });
  }

  async deleteFile(filePath: string): Promise<void> {
    const normalizedPath = path.normalize(filePath);
    await fs.promises.unlink(normalizedPath);
  }

  async deleteDirectory(dirPath: string): Promise<void> {
    const normalizedPath = path.normalize(dirPath);
    await fs.promises.rm(normalizedPath, { recursive: true });
  }

  isTextFile(filePath: string): boolean {
    // First check MIME type
    const mimeType = mime.lookup(filePath);

    if (mimeType) {
      // Check if MIME type indicates text
      if (mimeType.startsWith('text/')) {
        return true;
      }

      // Common text-based MIME types that don't start with text/
      const textMimeTypes = [
        'application/json',
        'application/xml',
        'application/javascript',
        'application/typescript',
        'application/x-sh',
        'application/x-httpd-php',
        'application/graphql',
        'application/sql',
        'application/toml',
        'application/x-yaml',
      ];

      if (textMimeTypes.includes(mimeType)) {
        return true;
      }
    }

    // Fallback to extension check for files mime-types doesn't recognize
    const ext = path.extname(filePath).toLowerCase();

    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      return true;
    }

    // Check filename for dotfiles and extensionless files
    const fileName = path.basename(filePath);
    return TEXT_FILE_NAMES.has(fileName);
  }
}

export class WindowsFilesystemService extends BaseFilesystemService {
  async listDrives(): Promise<DriveInfo[]> {
    const drives: DriveInfo[] = [];

    for (let charCode = 65; charCode <= 90; charCode++) {
      const letter = String.fromCharCode(charCode);
      const drivePath = `${letter}:\\`;

      if (await this.driveExists(drivePath)) {
        drives.push({ name: `${letter}:`, path: drivePath });
      }
    }

    return drives;
  }

  private async driveExists(drivePath: string): Promise<boolean> {
    try {
      await fs.promises.access(drivePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class UnixFilesystemService extends BaseFilesystemService {
  async listDrives(): Promise<DriveInfo[]> {
    const drives: DriveInfo[] = [{ name: '/', path: '/' }];

    if (await this.directoryExists('/Volumes')) {
      const volumes = await this.listMountedVolumes();
      drives.push(...volumes);
    }

    return drives;
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async listMountedVolumes(): Promise<DriveInfo[]> {
    try {
      const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true });

      return entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => ({
          name: entry.name,
          path: path.join('/Volumes', entry.name),
        }));
    } catch {
      return [];
    }
  }
}

export function createFilesystemService(): FilesystemService {
  if (process.platform === 'win32') {
    return new WindowsFilesystemService();
  }

  return new UnixFilesystemService();
}

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.xml', '.yaml', '.yml', '.toml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyw', '.pyi',
  '.rb', '.rake', '.gemspec',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx',
  '.cs', '.fs', '.fsx',
  '.go', '.rs', '.swift', '.m', '.mm',
  '.php', '.phtml',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sql', '.graphql', '.gql',
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
  '.lua', '.vim', '.el', '.clj', '.cljs', '.edn',
  '.r', '.R', '.rmd', '.Rmd',
  '.pl', '.pm', '.perl',
  '.ex', '.exs', '.erl', '.hrl',
  '.hs', '.lhs', '.elm',
  '.vue', '.svelte', '.astro',
  '.ini', '.cfg', '.conf', '.config',
  '.log', '.csv', '.tsv',
  '.rst', '.tex', '.bib',
]);

// Files without extensions or dotfiles that should be editable
const TEXT_FILE_NAMES = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc',
  '.dockerignore', '.env', '.npmrc', '.nvmrc', '.yarnrc', '.babelrc',
  '.prettierignore', '.eslintignore', '.stylelintrc', '.browserslistrc',
  '.npmignore', '.slugignore', '.vercelignore', '.nowignore', '.helmignore', '.cfignore',
  'Makefile', 'Dockerfile', 'Vagrantfile', 'Gemfile', 'Rakefile', 'Procfile',
  'CMakeLists.txt', 'LICENSE', 'AUTHORS', 'CHANGELOG', 'README', 'INSTALL',
  'CONTRIBUTING', 'CODEOWNERS', '.htaccess', '.mailmap',
]);

function handleDrives(service: FilesystemService, res: Response): void {
  service
    .listDrives()
    .then((drives) => res.json(drives))
    .catch(() => res.status(500).json({ error: 'Failed to list drives' }));
}

function handleBrowse(service: FilesystemService, dirPath: string, res: Response): void {
  service
    .listDirectory(dirPath)
    .then((entries) => res.json(entries))
    .catch(() => res.status(500).json({ error: 'Failed to list directory' }));
}

function handleReadFile(service: FilesystemService, filePath: string, res: Response): void {
  service
    .readFile(filePath)
    .then((content) => res.json({ content }))
    .catch(() => res.status(404).json({ error: 'Failed to read file' }));
}

function handleBrowseWithFiles(service: FilesystemService, dirPath: string, res: Response): void {
  service
    .listDirectoryWithFiles(dirPath)
    .then((entries) => {
      const entriesWithEditable = entries.map((entry) => ({
        ...entry,
        isEditable: !entry.isDirectory && service.isTextFile(entry.path),
      }));
      res.json(entriesWithEditable);
    })
    .catch(() => res.status(500).json({ error: 'Failed to list directory' }));
}

function handleWriteFile(
  service: FilesystemService,
  filePath: string,
  content: string,
  res: Response
): void {
  service
    .writeFile(filePath, content)
    .then(() => res.json({ success: true }))
    .catch(() => res.status(500).json({ error: 'Failed to write file' }));
}

function handleDelete(
  service: FilesystemService,
  targetPath: string,
  isDirectory: boolean,
  res: Response
): void {
  const deletePromise = isDirectory
    ? service.deleteDirectory(targetPath)
    : service.deleteFile(targetPath);

  deletePromise
    .then(() => res.json({ success: true }))
    .catch(() => res.status(500).json({ error: 'Failed to delete' }));
}

function handleCreateDirectory(
  service: FilesystemService,
  dirPath: string,
  res: Response
): void {
  service
    .createDirectory(dirPath)
    .then(() => res.json({ success: true }))
    .catch((err: Error) => {
      if (err.message.includes('EEXIST')) {
        res.status(409).json({ error: 'Folder already exists' });
      } else {
        res.status(500).json({ error: 'Failed to create folder' });
      }
    });
}

/**
 * Restricts which paths file operations may touch.
 *
 * `/api/fs` used to accept any absolute path for read/write/delete/move. With a
 * single trusted operator that was merely blunt; with one instance per colleague
 * — all running as the same (elevated) Windows account — it means any logged-in
 * user can read or destroy anything on the machine, including other people's
 * project data. Browsing stays open because picking a project folder needs it;
 * everything that reads content or mutates the disk is confined to registered
 * project paths, plus whatever `CLAUDITO_FS_ROOTS` adds as an escape hatch.
 */
export interface FsPathPolicy {
  allowedRoots(): Promise<string[]>;
}

function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);

  if (rel === '') {
    return true;
  }

  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function isPathAllowed(policy: FsPathPolicy, target: string): Promise<boolean> {
  const roots = await policy.allowedRoots();

  if (roots.length === 0) {
    return false;
  }

  const normalizedTarget = normalizeForCompare(target);

  for (const root of roots) {
    if (isPathInside(normalizeForCompare(root), normalizedTarget)) {
      return true;
    }
  }

  return false;
}

export function createFsPathPolicy(listProjectPaths: () => Promise<string[]>): FsPathPolicy {
  const extraRoots = (process.env.CLAUDITO_FS_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    async allowedRoots(): Promise<string[]> {
      try {
        const projectPaths = await listProjectPaths();
        return [...projectPaths, ...extraRoots];
      } catch {
        return extraRoots;
      }
    },
  };
}

export function createFilesystemRouter(service: FilesystemService, policy?: FsPathPolicy): Router {
  const router = Router();

  /** Resolves true when the request may proceed; otherwise the response is already sent. */
  const guard = async (targetPath: string, res: Response): Promise<boolean> => {
    if (!policy) {
      return true;
    }

    if (await isPathAllowed(policy, targetPath)) {
      return true;
    }

    res.status(403).json({
      error: 'Path is outside the allowed project directories',
      code: 'FS_PATH_NOT_ALLOWED',
    });
    return false;
  };

  router.get('/drives', (_req: Request, res: Response) => {
    handleDrives(service, res);
  });

  router.get('/browse', (req: Request, res: Response) => {
    const dirPath = req.query['path'] as string;

    if (!dirPath) {
      res.status(400).json({ error: 'Path parameter is required' });
      return;
    }

    handleBrowse(service, dirPath, res);
  });

  router.get('/read', (req: Request, res: Response) => {
    const filePath = req.query['path'] as string;

    if (!filePath) {
      res.status(400).json({ error: 'Path parameter is required' });
      return;
    }

    void guard(filePath, res).then((ok) => {
      if (ok) {
        handleReadFile(service, filePath, res);
      }
    });
  });

  router.get('/browse-with-files', (req: Request, res: Response) => {
    const dirPath = req.query['path'] as string;

    if (!dirPath) {
      res.status(400).json({ error: 'Path parameter is required' });
      return;
    }

    handleBrowseWithFiles(service, dirPath, res);
  });

  router.put('/write', (req: Request, res: Response) => {
    const body = req.body as { path?: string; content?: string };
    const filePath = body.path;
    const content = body.content;

    if (!filePath) {
      res.status(400).json({ error: 'Path is required' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    void guard(filePath, res).then((ok) => {
      if (ok) {
        handleWriteFile(service, filePath, content, res);
      }
    });
  });

  router.delete('/delete', (req: Request, res: Response) => {
    const body = req.body as { path?: string; isDirectory?: boolean };
    const targetPath = body.path;
    const isDirectory = body.isDirectory;

    if (!targetPath) {
      res.status(400).json({ error: 'Path is required' });
      return;
    }

    void guard(targetPath, res).then((ok) => {
      if (ok) {
        handleDelete(service, targetPath, isDirectory === true, res);
      }
    });
  });

  router.post('/mkdir', (req: Request, res: Response) => {
    const body = req.body as { path?: string };
    const dirPath = body.path;

    if (!dirPath) {
      res.status(400).json({ error: 'Path is required' });
      return;
    }

    void guard(dirPath, res).then((ok) => {
      if (ok) {
        handleCreateDirectory(service, dirPath, res);
      }
    });
  });

  router.put('/move', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
    const { sourcePath, targetPath } = req.body as { sourcePath?: string; targetPath?: string };

    if (!sourcePath || !targetPath) {
      res.status(400).json({ error: 'sourcePath and targetPath are required' });
      return;
    }

    // Both ends matter: moving an allowed file to an arbitrary destination, or an
    // arbitrary file into a project, would both sidestep the restriction.
    if (await guard(sourcePath, res) === false) {
      return;
    }

    if (await guard(targetPath, res) === false) {
      return;
    }

    try {
      const fsPromises = fs.promises;

      // Check if source exists
      try {
        await fsPromises.stat(sourcePath);
      } catch {
        res.status(404).json({ error: 'Source file or directory not found' });
        return;
      }

      // Check if target already exists
      try {
        await fsPromises.stat(targetPath);
        res.status(409).json({ error: 'Target already exists' });
        return;
      } catch {
        // Target doesn't exist, which is good
      }

      // Perform the move
      await fsPromises.rename(sourcePath, targetPath);

      res.json({ success: true });
    } catch (error) {
      console.error('Move error:', error);
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Source file or directory not found' });
      } else if (err.code === 'EEXIST') {
        res.status(409).json({ error: 'Target already exists' });
      } else if (err.code === 'EXDEV') {
        res.status(400).json({ error: 'Cannot move across different drives' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to move file or directory' });
      }
    }
    })();
  });

  return router;
}
