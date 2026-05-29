#!/usr/bin/env node
// `margo-host` — CLI entry for the standalone margo comment server.
//
// Usage:
//   margo-host                      run the server (default subcommand)
//   margo-host create-user --email E --name N [--superuser]
//   margo-host create-token --user-id ID --label L
//   margo-host list-users
//   margo-host list-tokens
//   margo-host revoke-token --token-id ID
//   margo-host set-superuser --user-id ID --value true|false
//   margo-host set-password --user-id ID --password PLAIN
//   margo-host create-project --slug S --name N
//   margo-host list-projects
//   margo-host add-member --project SLUG --user-id ID --role read|write|admin
//   margo-host remove-member --project SLUG --user-id ID
//   margo-host list-members --project SLUG
//
// All subcommands accept --data-dir DIR (defaults to ./margo-data).
// `run` accepts --port N (defaults to 7331).
//
// First-run UX: start the server with no env vars; whoever signs up first
// at `/setup` becomes the superuser. CLI subcommands let you provision /
// audit users + projects out-of-band when you need to.
import * as path from 'node:path';
import { startHost } from './index.js';
import { UserStore } from './user-store.js';
const USAGE = `usage: margo-host [run] [flags]
       margo-host <subcommand> [flags]

Commands:
  run                run the server (default; flags: --port N, --data-dir DIR)
  create-user        --email E --name N [--superuser]
  create-token       --user-id ID --label L
  list-users
  list-tokens
  revoke-token       --token-id ID
  set-superuser      --user-id ID --value true|false
  set-password       --user-id ID --password PLAIN
  create-project     --slug S --name N
  list-projects
  add-member         --project SLUG --user-id ID --role read|write|admin
  remove-member      --project SLUG --user-id ID
  list-members       --project SLUG

All commands accept --data-dir DIR (default ./margo-data). The server
process needs no env vars — first signup at /setup becomes superuser.`;
async function main() {
    const cmd = process.argv[2] ?? 'run';
    const rest = process.argv.slice(3);
    const flags = parseFlags(rest);
    const cwd = process.cwd();
    const dataDir = flags.dataDir ?? path.join(cwd, 'margo-data');
    switch (cmd) {
        case 'run':
            await runServer({ port: flags.port, dataDir });
            break;
        case 'create-user':
            await runCreateUser({ dataDir, email: flags.email, name: flags.name, superuser: flags.superuser });
            break;
        case 'create-token':
            await runCreateToken({ dataDir, userId: flags.userId, label: flags.label });
            break;
        case 'list-users':
            await runListUsers({ dataDir });
            break;
        case 'list-tokens':
            await runListTokens({ dataDir });
            break;
        case 'revoke-token':
            await runRevokeToken({ dataDir, tokenId: flags.tokenId });
            break;
        case 'set-superuser':
            await runSetSuperuser({ dataDir, userId: flags.userId, value: flags.value });
            break;
        case 'set-password':
            await runSetPassword({ dataDir, userId: flags.userId, password: flags.password });
            break;
        case 'create-project':
            await runCreateProject({ dataDir, slug: flags.slug, name: flags.name });
            break;
        case 'list-projects':
            await runListProjects({ dataDir });
            break;
        case 'add-member':
            await runAddMember({ dataDir, project: flags.project, userId: flags.userId, role: flags.role });
            break;
        case 'remove-member':
            await runRemoveMember({ dataDir, project: flags.project, userId: flags.userId });
            break;
        case 'list-members':
            await runListMembers({ dataDir, project: flags.project });
            break;
        case '-h':
        case '--help':
        case 'help':
            console.log(USAGE);
            break;
        default:
            console.error(`unknown command: ${cmd}`);
            console.error(USAGE);
            process.exit(1);
    }
}
async function runServer(opts) {
    const users = new UserStore(opts.dataDir);
    await users.load();
    const handle = await startHost({ port: opts.port, dataRoot: opts.dataDir, users });
    const shutdown = () => {
        void handle.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
async function runCreateUser(opts) {
    if (!opts.email || !opts.name) {
        console.error('usage: margo-host create-user --email <e> --name <n> [--superuser]');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    const user = await users.createUser(opts.email, opts.name, { isSuperuser: opts.superuser });
    const { record, plainToken } = await users.createToken(user.id, 'initial');
    const flag = opts.superuser ? ' [superuser]' : '';
    console.log(`created user ${user.id} (${user.email})${flag}`);
    console.log(`token   ${record.id}  label=${record.label}`);
    console.log('');
    console.log('  TOKEN (shown once — store securely, the host only keeps a hash):');
    console.log(`  ${plainToken}`);
}
async function runCreateToken(opts) {
    if (!opts.userId || !opts.label) {
        console.error('usage: margo-host create-token --user-id <id> --label <l>');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    const { record, plainToken } = await users.createToken(opts.userId, opts.label);
    console.log(`token ${record.id}  user=${record.userId}  label=${record.label}`);
    console.log('');
    console.log('  TOKEN (shown once — store securely):');
    console.log(`  ${plainToken}`);
}
async function runListUsers(opts) {
    const users = new UserStore(opts.dataDir);
    const list = await users.listUsers();
    if (list.length === 0) {
        console.log('(no users)');
        return;
    }
    for (const u of list) {
        const sup = u.isSuperuser ? ' [superuser]' : '';
        console.log(`${u.id}  ${u.email}  ${u.name}  created=${u.createdAt}${sup}`);
    }
}
async function runListTokens(opts) {
    const users = new UserStore(opts.dataDir);
    const list = await users.listTokens();
    if (list.length === 0) {
        console.log('(no active tokens)');
        return;
    }
    for (const t of list) {
        const last = t.lastUsedAt ?? 'never';
        console.log(`${t.id}  user=${t.userId}  label=${t.label}  prefix=${t.plainPrefix}…  last-used=${last}`);
    }
}
async function runRevokeToken(opts) {
    if (!opts.tokenId) {
        console.error('usage: margo-host revoke-token --token-id <id>');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    await users.revokeToken(opts.tokenId);
    console.log(`revoked token ${opts.tokenId}`);
}
async function runSetSuperuser(opts) {
    if (!opts.userId || (opts.value !== 'true' && opts.value !== 'false')) {
        console.error('usage: margo-host set-superuser --user-id <id> --value true|false');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    await users.setSuperuser(opts.userId, opts.value === 'true');
    console.log(`user ${opts.userId} isSuperuser=${opts.value}`);
}
async function runSetPassword(opts) {
    if (!opts.userId || !opts.password) {
        console.error('usage: margo-host set-password --user-id <id> --password <plain>');
        process.exit(1);
    }
    if (opts.password.length < 8) {
        console.error('[margo-host] password must be at least 8 characters');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    await users.setPassword(opts.userId, opts.password);
    console.log(`password set for ${opts.userId} — they can now log in at /login`);
}
async function runCreateProject(opts) {
    if (!opts.slug || !opts.name) {
        console.error('usage: margo-host create-project --slug <s> --name <n>');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    const project = await users.createProject(opts.slug, opts.name);
    console.log(`created project ${project.slug} (${project.name})`);
    console.log('Note: project is now ACL-enforced. Add members with `margo-host add-member`.');
}
async function runListProjects(opts) {
    const users = new UserStore(opts.dataDir);
    const list = await users.listProjects();
    if (list.length === 0) {
        console.log('(no projects registered)');
        return;
    }
    for (const p of list) {
        console.log(`${p.slug}  ${p.name}  created=${p.createdAt}`);
    }
}
async function runAddMember(opts) {
    if (!opts.project || !opts.userId || (opts.role !== 'read' && opts.role !== 'write' && opts.role !== 'admin')) {
        console.error('usage: margo-host add-member --project <slug> --user-id <id> --role read|write|admin');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    await users.addMember(opts.userId, opts.project, opts.role);
    console.log(`added/updated ${opts.userId} on ${opts.project} as ${opts.role}`);
}
async function runRemoveMember(opts) {
    if (!opts.project || !opts.userId) {
        console.error('usage: margo-host remove-member --project <slug> --user-id <id>');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    await users.removeMember(opts.userId, opts.project);
    console.log(`removed ${opts.userId} from ${opts.project}`);
}
async function runListMembers(opts) {
    if (!opts.project) {
        console.error('usage: margo-host list-members --project <slug>');
        process.exit(1);
    }
    const users = new UserStore(opts.dataDir);
    const members = await users.listMembers(opts.project);
    if (members.length === 0) {
        console.log(`(no members on ${opts.project})`);
        return;
    }
    for (const m of members) {
        console.log(`${m.userId}  role=${m.role}  added=${m.addedAt}`);
    }
}
function parseFlags(args) {
    return {
        port: readNumberFlag(args, '--port', 7331),
        dataDir: readStringFlag(args, '--data-dir'),
        email: readStringFlag(args, '--email'),
        name: readStringFlag(args, '--name'),
        userId: readStringFlag(args, '--user-id'),
        label: readStringFlag(args, '--label'),
        tokenId: readStringFlag(args, '--token-id'),
        password: readStringFlag(args, '--password'),
        superuser: args.includes('--superuser'),
        value: readStringFlag(args, '--value'),
        slug: readStringFlag(args, '--slug'),
        project: readStringFlag(args, '--project'),
        role: readStringFlag(args, '--role'),
    };
}
function readStringFlag(args, name) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === name && i + 1 < args.length)
            return args[i + 1];
        if (a.startsWith(`${name}=`))
            return a.slice(name.length + 1);
    }
    return undefined;
}
function readNumberFlag(args, name, fallback) {
    const raw = readStringFlag(args, name);
    if (raw === undefined)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
// Self-invocation guard — when imported (e.g. by tests) the CLI shouldn't
// actually run. The Docker entrypoint passes argv[1] = .../cli.js so
// import.meta.url's pathname matches.
main().catch((err) => {
    console.error('[margo-host]', err.message);
    process.exit(1);
});
