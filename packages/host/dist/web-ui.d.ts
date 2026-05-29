export declare function renderLogin(opts?: {
    errorMessage?: string;
}): string;
export declare function renderSetup(): string;
export declare function renderSignup(opts?: {
    errorMessage?: string;
}): string;
export interface DashboardData {
    user: {
        id: string;
        email: string;
        name: string;
        isSuperuser?: boolean;
    };
    projects: {
        slug: string;
        name: string;
        role: string;
    }[];
    tokens: {
        id: string;
        label: string;
        createdAt: string;
        lastUsedAt?: string;
        plainPrefix: string;
    }[];
}
export interface ProjectPageData {
    user: {
        id: string;
        email: string;
        name: string;
        isSuperuser: boolean;
    };
    project: {
        slug: string;
        name: string;
        createdAt: string;
    };
    /** The viewer's role on this project (or 'read' for superusers without membership). */
    myRole: string;
    /** Whether the viewer can manage members (project admin or superuser). */
    canManage: boolean;
    members: {
        userId: string;
        email: string;
        name: string;
        role: string;
    }[];
}
export declare function renderDashboard(data: DashboardData): string;
export declare function renderProject(data: ProjectPageData): string;
