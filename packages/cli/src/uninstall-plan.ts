import { localChatModels, resolveProviderRouting, type Config } from '@aion/core';
import { existsSync, readFileSync } from 'node:fs';

import type { InstallManifest } from './install-manifest.js';
import { storeDropCommands, type InstallProfile } from './install-profile.js';

/**
 * What uninstall would do, decided before it does any of it.
 *
 * Three dispositions and they are the whole design. `remove` is something this install put there
 * and can prove it. `manual` is something that is there, that uninstall could technically delete,
 * and that nothing proves is ours — a Neo4j somebody already ran, a plugin jar they placed, a
 * config file they maintain — so it prints the command instead of taking the decision. `keep` is a
 * shared tool nobody should remove as a side effect of removing this: Homebrew's Neo4j, Ollama,
 * the models. Those are named with their commands in a block an operator can run or ignore.
 *
 * A half-installed machine is the ordinary case rather than the exception: init can stop at any
 * step, and the thing that follows a failed init is usually this. So every item is checked for
 * presence and an absent one is simply not in the plan.
 */

export type UninstallAction = 'remove' | 'manual' | 'keep';

export type UninstallItem = {
  readonly what: string;
  readonly target: string;
  readonly action: UninstallAction;
  /** Why it is in this column. Printed beside the item, because the column is a judgment. */
  readonly why: string;
  /** For `manual` and `keep`: what to run to do it yourself. */
  readonly commands?: readonly string[];
};

export type UninstallPlanInput = {
  readonly profile: InstallProfile;
  readonly dataDir: string;
  readonly manifest: InstallManifest | undefined;
  readonly launchAgentPath: string;
  readonly platform: string;
  /** The model tags this install pulled, which is what the Ollama line may offer to remove. */
  readonly models: readonly string[];
  /** Injected so the plan is decidable in a test against scratch paths. */
  readonly exists?: (path: string) => boolean;
  readonly readFile?: (path: string) => string;
};

/**
 * The tags this install pulled, read off config the way init reads it: the embed model, plus the
 * chat models routing still resolves locally. A role routed to Anthropic downloaded nothing, so
 * naming its tag would offer to remove a model something else on the machine put there.
 */
export function installedModelTags(config: Config): readonly string[] {
  const routing = resolveProviderRouting(config);
  return [...new Set([...localChatModels(routing), config.models.embed])];
}

/**
 * The shared tools, never removed and always named. Ollama holds models other things use too,
 * which is why the tags are the ones this install configured rather than the ones the defaults
 * shipped with: an operator who changed a model reads the command that removes theirs.
 */
export function sharedToolCommands(models: readonly string[]): readonly string[] {
  const tags = models.filter((tag) => tag.trim() !== '');
  return [
    'brew services stop neo4j && brew uninstall neo4j',
    ...(tags.length === 0 ? [] : [`ollama rm ${tags.join(' ')}`]),
    'brew uninstall ollama',
  ];
}

function neo4jConfigItem(
  input: UninstallPlanInput,
  exists: (path: string) => boolean,
): UninstallItem[] {
  const { manifest } = input;
  const confFile = manifest?.neo4jConfFile;
  if (confFile === undefined || !exists(confFile)) {
    return [];
  }
  const read = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const owned = manifest?.neo4jSettings ?? [];
  const present = owned.filter(([key, value]) => read(confFile).includes(`${key}=${value}`));
  if (present.length === 0) {
    return [];
  }
  return [
    {
      what: 'neo4j.conf settings',
      target: confFile,
      action: 'remove',
      why: `${String(present.length)} lines this install wrote, still carrying the values it wrote`,
    },
  ];
}

function gdsItem(
  manifest: InstallManifest | undefined,
  exists: (path: string) => boolean,
): UninstallItem[] {
  const jar = manifest?.gdsJar;
  if (jar !== undefined && exists(jar)) {
    return [
      {
        what: 'graph-data-science jar',
        target: jar,
        action: 'remove',
        why: 'this install downloaded it',
      },
    ];
  }
  return [];
}

/**
 * The plan. Order is the order things are removed in: the service first, because a running server
 * holding the database open is what makes the rest fail halfway.
 */
export function planUninstall(input: UninstallPlanInput): readonly UninstallItem[] {
  const exists = input.exists ?? existsSync;
  const items: UninstallItem[] = [];

  if (input.profile === 'native') {
    if (input.platform === 'darwin' && exists(input.launchAgentPath)) {
      items.push({
        what: 'launchd job',
        target: input.launchAgentPath,
        action: 'remove',
        why: 'unloaded and deleted; the server stops with it',
      });
    }
    items.push(...neo4jConfigItem(input, exists));
    items.push(...gdsItem(input.manifest, exists));
    if (input.manifest?.neo4jHome !== undefined) {
      items.push({
        what: 'neo4j server',
        target: input.manifest.neo4jHome,
        action: 'keep',
        why: 'a shared tool, and other things on this machine may use it',
        commands: sharedToolCommands(input.models),
      });
    }
  } else {
    items.push({
      what: 'compose services and volumes',
      target: 'aion_aion-neo4j, aion_aion-data',
      action: 'remove',
      why: 'the graph, the database and the experience archive',
      commands: storeDropCommands('docker', input.dataDir),
    });
  }

  if (exists(input.dataDir)) {
    items.push({
      what: 'data root',
      target: input.dataDir,
      action: 'remove',
      why: 'the memory store: the database, the experience archive and the log',
    });
  }
  if (input.profile === 'native' && input.manifest === undefined) {
    items.push({
      what: 'install record',
      target: input.dataDir,
      action: 'manual',
      why: 'no manifest: anything this install did not write is present but not provably ours',
      commands: [
        'check the plugins directory and neo4j.conf by hand before removing anything there',
      ],
    });
  }
  return items;
}
