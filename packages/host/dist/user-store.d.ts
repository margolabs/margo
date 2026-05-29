/** Stored shape of a user record. The display name is optional so a
 *  GitHub-OAuth-bootstrapped user works before we've collected one. */
export interface UserRecord {
    id: string;
    email: string;
    name: string;
    createdAt: string;
    /** Superusers bypass project ACL checks — used for the bootstrap user
     *  so the operator who set the host up can manage everything. Future:
     *  this flag is grantable to any user via CLI. */
    isSuperuser?: boolean;
    /** scrypt-hashed password for web UI login. Stored as
     *  `<salt-hex>:<derived-hex>`. Absent for users created via env-
     *  bootstrap or CLI without a password — they can still use the API
     *  with bearer tokens but can't log in to the UI until they `signup`
     *  with the same email (which fills in the hash). */
    passwordHash?: string;
}
/** Per-project role a user holds. read/write/admin form a strict hierarchy:
 *  admin > write > read. The auth layer compares against the role required
 *  by the route (GET → read, PUT/POST/DELETE → write, manage-members → admin). */
export type Role = 'read' | 'write' | 'admin';
export interface ProjectRecord {
    /** URL-safe slug — also serves as the directory name under <dataRoot>/.
     *  This is what clients put in margo.config.server.project. */
    slug: string;
    name: string;
    createdAt: string;
}
export interface MembershipRecord {
    userId: string;
    projectSlug: string;
    role: Role;
    addedAt: string;
}
/** Stored shape of a token. plainPrefix is the first 8 chars of the
 *  plaintext, retained to help an operator identify tokens in a UI
 *  listing without exposing the secret. */
export interface TokenRecord {
    id: string;
    userId: string;
    hashedToken: string;
    plainPrefix: string;
    label: string;
    createdAt: string;
    lastUsedAt?: string;
    revokedAt?: string;
}
/** Result of creating a token. plainToken is shown to the operator ONCE
 *  at creation; it's not persisted in plain form. */
export interface CreateTokenResult {
    record: TokenRecord;
    plainToken: string;
}
export declare class UserStore {
    private readonly file;
    private data;
    private loaded;
    private writeChain;
    constructor(dataRoot: string);
    load(): Promise<void>;
    /** Force a re-read from disk. Used by resolveToken so cross-process
     *  changes (CLI revoke while host is running) take effect immediately. */
    reload(): Promise<void>;
    /** Total users currently on file (excluding none — there's no soft-delete). */
    userCount(): Promise<number>;
    listUsers(): Promise<UserRecord[]>;
    getUser(id: string): Promise<UserRecord | null>;
    findUserByEmail(email: string): Promise<UserRecord | null>;
    createUser(email: string, name: string, opts?: {
        isSuperuser?: boolean;
    }): Promise<UserRecord>;
    /** Sign up a new regular user. Returns null on duplicate email.
     *  Always creates a non-superuser account — the first-run admin claim
     *  goes through a separate setupAdmin() path with its own UI. Callers
     *  must check `userCount()` upstream and refuse the signup if no
     *  admin exists yet; this method doesn't gate on that, but consumers
     *  (web-routes) do. */
    signup(email: string, name: string, plainPassword: string): Promise<UserRecord | null>;
    /** First-run admin claim: creates the superuser account on a fresh
     *  host. Asserts inside the mutate critical section that no user
     *  exists yet, so two concurrent /setup submissions can't both win.
     *  Returns:
     *   - the new superuser record on success
     *   - 'already_initialized' if the host already has at least one user
     *   - 'duplicate_email' is impossible here (the store was empty), but
     *      we keep the same shape for symmetry with signup(). */
    setupAdmin(email: string, name: string, plainPassword: string): Promise<UserRecord | 'already_initialized'>;
    /** Set or replace a user's password hash. Used by signup-after-bootstrap
     *  (a CLI-created user wants UI access) and by future password-reset
     *  flows. Email-on-record stays the lookup key. */
    setPassword(userId: string, plainPassword: string): Promise<void>;
    /** Verify a plaintext password against the stored hash. Returns the
     *  user record on success, null on bad credentials OR unknown email.
     *  Same return shape for both cases keeps the timing leak small (the
     *  caller can't distinguish "wrong password" from "no such user"). */
    verifyLogin(email: string, plainPassword: string): Promise<UserRecord | null>;
    /** Lazily mint and persist the session-signing HMAC key, then return
     *  it. Called by the session module on first use; the key sticks
     *  around for the lifetime of the host until explicitly rotated. */
    getOrCreateSessionSecret(): Promise<string>;
    /** Toggle a user's superuser bit. Useful when promoting an additional
     *  operator after the host has been running for a while. */
    setSuperuser(userId: string, value: boolean): Promise<void>;
    listProjects(): Promise<ProjectRecord[]>;
    getProject(slug: string): Promise<ProjectRecord | null>;
    createProject(slug: string, name: string): Promise<ProjectRecord>;
    /** GitLab-style: any signed-in user can create a project and becomes
     *  its admin in one atomic step. Race-safe — the slug uniqueness check
     *  and the create both run inside the mutate critical section, so two
     *  concurrent create-project calls for the same slug get one winner
     *  and one 'duplicate' error. */
    createProjectAsAdmin(creatorUserId: string, slug: string, name: string): Promise<ProjectRecord>;
    /** Memberships for a user, joined with project metadata. Drives the
     *  dashboard's "Your projects" section. */
    listMembershipsForUser(userId: string): Promise<Array<{
        project: ProjectRecord;
        role: Role;
    }>>;
    listMembers(projectSlug: string): Promise<MembershipRecord[]>;
    getMembership(userId: string, projectSlug: string): Promise<MembershipRecord | null>;
    addMember(userId: string, projectSlug: string, role: Role): Promise<MembershipRecord>;
    removeMember(userId: string, projectSlug: string): Promise<void>;
    listTokens(): Promise<TokenRecord[]>;
    createToken(userId: string, label: string): Promise<CreateTokenResult>;
    /** Store a pre-existing plaintext token under a user. Only used by the
     *  env-bootstrap path — the operator already chose the secret (via
     *  MARGO_HOST_TOKEN) before we ever ran, and we adopt it as-is so the
     *  upgrade is seamless. Normal token issuance goes through createToken,
     *  which generates entropy itself. */
    adoptToken(userId: string, plainToken: string, label: string): Promise<TokenRecord>;
    revokeToken(tokenId: string): Promise<void>;
    /** Look up the user a plaintext token authenticates as. Returns null
     *  for unknown / revoked tokens. Touches lastUsedAt as a side effect
     *  so operators can see which tokens are live.
     *
     *  Always reads fresh from disk before checking. The host and the CLI
     *  are separate processes that both touch users.json — the CLI revokes
     *  a token, the host must pick that up on the next auth lookup without
     *  needing a restart. The file is tiny (sub-KB for typical
     *  installations), so re-reading per request is microseconds. */
    resolveToken(plainToken: string): Promise<{
        user: UserRecord;
        token: TokenRecord;
    } | null>;
    private touchLastUsedAt;
    private mutate;
    /** Atomic write: serialize to a tmp file, then rename over the target.
     *  Rename is atomic on POSIX, so a crash mid-write never leaves a
     *  corrupt half-file on disk. */
    private persist;
}
