export function isChromeTab(tab: unknown): tab is Record<string, unknown>
export function isQuickLink(link: unknown): link is Record<string, unknown>
export function chromeSession(value: unknown): { tabs: Record<string, unknown>[]; links: Record<string, unknown>[] }
export function describeAddress(url: string): string
export function addressBadge(url: string): string
export function fallbackTabTitle(url: string): string
