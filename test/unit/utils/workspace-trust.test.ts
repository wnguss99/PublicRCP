import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureWorkspaceTrusted, toTrustKey, getClaudeConfigPath } from '../../../src/utils/workspace-trust';

describe('workspace-trust', () => {
  let tmpHome: string;
  let configPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    configPath = path.join(tmpHome, '.claude.json');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const write = (obj: unknown) => fs.writeFileSync(configPath, JSON.stringify(obj), 'utf-8');

  describe('toTrustKey', () => {
    it('uses forward slashes like the CLI does', () => {
      expect(toTrustKey('D:\\repos\\MyProjects')).toBe('D:/repos/MyProjects');
    });

    it('drops a trailing separator so the key matches the spawn cwd', () => {
      expect(toTrustKey('D:/repos/MyProjects/')).toBe('D:/repos/MyProjects');
    });

    it('preserves drive letter case, because the CLI keys are case sensitive', () => {
      // A real config held both 'D:/Aleatorik' and 'd:/Aleatorik' as separate
      // entries; lowercasing here would write to the wrong one.
      expect(toTrustKey('d:/Aleatorik')).toBe('d:/Aleatorik');
      expect(toTrustKey('D:/Aleatorik')).toBe('D:/Aleatorik');
    });
  });

  describe('ensureWorkspaceTrusted', () => {
    it('marks an untrusted project as trusted', () => {
      write({ projects: { 'D:/p': { hasTrustDialogAccepted: false } } });

      expect(ensureWorkspaceTrusted('D:/p')).toBe(true);
      expect(read().projects['D:/p'].hasTrustDialogAccepted).toBe(true);
    });

    it('adds an entry for a project the CLI has never seen', () => {
      write({ projects: {} });

      expect(ensureWorkspaceTrusted('D:\\new\\project')).toBe(true);
      expect(read().projects['D:/new/project'].hasTrustDialogAccepted).toBe(true);
    });

    it('reports no change when already trusted', () => {
      write({ projects: { 'D:/p': { hasTrustDialogAccepted: true } } });

      expect(ensureWorkspaceTrusted('D:/p')).toBe(false);
    });

    it('keeps the other state in the config file', () => {
      // The same file holds auth state, MCP servers and per-project history.
      write({
        projects: {
          'D:/p': { hasTrustDialogAccepted: false, history: ['a', 'b'] },
          'D:/other': { hasTrustDialogAccepted: true },
        },
        oauthAccount: { emailAddress: 'someone@example.com' },
        mcpServers: { foo: { command: 'bar' } },
      });

      ensureWorkspaceTrusted('D:/p');
      const after = read();

      expect(after.projects['D:/p'].history).toEqual(['a', 'b']);
      expect(after.projects['D:/other'].hasTrustDialogAccepted).toBe(true);
      expect(after.oauthAccount.emailAddress).toBe('someone@example.com');
      expect(after.mcpServers.foo.command).toBe('bar');
    });

    it('leaves an unparseable config untouched rather than rewriting it', () => {
      fs.writeFileSync(configPath, '{ not json', 'utf-8');

      expect(ensureWorkspaceTrusted('D:/p')).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ not json');
    });

    it('does not create a config when the CLI has never run', () => {
      expect(ensureWorkspaceTrusted('D:/p')).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('never throws when the file cannot be written', () => {
      write({ projects: {} });
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('EACCES');
      });

      // Failing to record trust must not stop an agent from starting.
      expect(() => ensureWorkspaceTrusted('D:/p')).not.toThrow();
      expect(ensureWorkspaceTrusted('D:/p')).toBe(false);
    });

    it('ignores an empty path', () => {
      write({ projects: {} });

      expect(ensureWorkspaceTrusted('')).toBe(false);
    });

    it('leaves no temp file behind', () => {
      write({ projects: {} });
      ensureWorkspaceTrusted('D:/p');

      expect(fs.readdirSync(tmpHome).filter((f) => f.includes('.tmp'))).toEqual([]);
    });

    it('resolves the config from the current home directory', () => {
      expect(getClaudeConfigPath()).toBe(configPath);
    });
  });
});
