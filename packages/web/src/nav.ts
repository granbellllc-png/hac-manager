import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  GitCompareArrows,
  History,
  ListChecks,
  Server,
  Settings,
  Users,
} from 'lucide-react';

export interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

export const navItems: readonly NavItem[] = [
  {
    path: '/',
    label: 'Hosts',
    description: 'Proxmox hosts defined in the data directory.',
    icon: Server,
  },
  {
    path: '/resources',
    label: 'Resources',
    description: 'Guests (LXC and VM) across all hosts.',
    icon: Activity,
  },
  {
    path: '/drift',
    label: 'Drift',
    description: 'Differences between YAML and live state.',
    icon: GitCompareArrows,
  },
  {
    path: '/jobs',
    label: 'Jobs',
    description: 'Plans, applies and task runs.',
    icon: ListChecks,
  },
  {
    path: '/audit',
    label: 'Audit',
    description: 'Who changed what, and when.',
    icon: History,
  },
  {
    path: '/users',
    label: 'Users',
    description: 'Accounts, roles and host access.',
    icon: Users,
  },
  {
    path: '/settings',
    label: 'Settings',
    description: 'Application settings.',
    icon: Settings,
  },
];
