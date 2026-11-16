import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { commandFor, initializeConfig, prepareCampaign } from '../../tools/cli.mjs';
import { normalizeHumanConfig } from '../../tools/keyteki-human-config.mjs';
import { normalizeCampaignConfig } from '../../tools/keyteki-live-campaign.mjs';

const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test('CLI routing preserves offline preflight, explicit execution, and lifecycle action identity', () => {
  assert.deepEqual(commandFor(['preflight', '--config', 'seat.json', '--create-public']), {
    script: 'keyteki-human-launcher.mjs',
    args: ['--config', 'seat.json', '--create-public'],
  });
  assert.throws(() => commandFor(['preflight', '--run']), /PREFLIGHT_CANNOT_RUN/);
  assert.deepEqual(commandFor(['seat', 'create', '--config', 'seat.json']).args, [
    '--config',
    'seat.json',
    '--run',
    '--create-public',
  ]);
  assert.deepEqual(commandFor(['host', 'pause', '--profile', '/local/host']), {
    script: 'keyteki-session-host.mjs',
    args: ['pause', '--profile', '/local/host'],
  });
  assert.deepEqual(commandFor(['campaign', 'status', '--config', 'campaign.json']).args, [
    '--config',
    'campaign.json',
  ]);
  assert.throws(() => commandFor(['campaign', 'status', '--run']), /CAMPAIGN_ACTION_DUPLICATED/);
  assert.deepEqual(
    commandFor(['recovery', 'storage', 'prepare', '--config', 'campaign.json', '--output', 'request.json'])
      .args,
    ['--config', 'campaign.json', '--output', 'request.json', '--prepare-request'],
  );
});
test('init writes one private explicit-origin configuration and never overwrites an existing directory', (t) => {
  const directory = path.join(temporary(t), 'settings');
  const args = [
    '--directory',
    directory,
    '--origin',
    'https://keyteki.example',
    '--account',
    'ExampleBot',
    '--server-deck-id',
    '123',
    '--deck-name',
    'Example Deck',
  ];
  const result = initializeConfig(args);
  assert.equal(result.browserStarted, false);
  const input = JSON.parse(fs.readFileSync(result.config, 'utf8'));
  const normalized = normalizeHumanConfig(input, { createPublic: true });
  assert.equal(normalized.self.name, 'ExampleBot');
  assert.equal(normalized.self.serverDeckId, 123);
  assert.ok(path.isAbsolute(input.output));
  assert.ok(path.isAbsolute(input.credentialsPath));
  assert.equal(fs.statSync(input.credentialsPath).mode & 0o777, 0o600);
  const credentials = fs.readFileSync(input.credentialsPath, 'utf8');
  assert.equal(JSON.parse(credentials).accounts.ExampleBot.password, '');
  assert.throws(() => initializeConfig(args), /CONFIG_DIRECTORY_ALREADY_EXISTS/);
  assert.equal(fs.readFileSync(input.credentialsPath, 'utf8'), credentials);
});
test('campaign prepare binds actual manifest bytes and keeps run authorization separate', (t) => {
  const root = temporary(t),
    directory = path.join(root, 'settings');
  const init = initializeConfig([
    '--directory',
    directory,
    '--origin',
    'https://keyteki.example',
    '--account',
    'ExampleBot',
    '--server-deck-id',
    '123',
    '--deck-name',
    'Example Deck',
  ]);
  const manifestFile = path.join(root, 'runtime-manifest.json');
  const bytes = Buffer.from(
    JSON.stringify({ schema: 'kf-live-runtime-freeze-v1', root: path.join(root, 'runtime'), files: [] }) +
      '\n',
  );
  fs.writeFileSync(manifestFile, bytes);
  const configFile = path.join(root, 'campaign.json');
  const args = [
    '--seat',
    init.config,
    '--manifest',
    manifestFile,
    '--config',
    configFile,
    '--output',
    path.join(root, 'campaign-data'),
    '--id',
    'my-campaign',
  ];
  const result = prepareCampaign(args),
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(result.browserStarted, false);
  assert.equal(config.runtimeManifestSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(normalizeCampaignConfig(config).selfName, 'ExampleBot');
  assert.throws(() => prepareCampaign(args), /CAMPAIGN_CONFIG_ALREADY_EXISTS/);
});
