/**
 * ND Emulator — pure logic module type declarations.
 */

export interface EmulatorDevice {
  serial: string
  type: string
  model: string
  product: string
  transportId: string
}

export interface EmulatorProvider {
  id: string
  name: string
  category: string
  badge: string
  description: string
  defaultPort: number | null
  hostAddress: string | null
  downloadUrl: string
  setupGuide: string
  installCmd: string | null
  icon: string
}

export function parseDeviceList(value: unknown): EmulatorDevice[]
export function formatDeviceInfo(device: Pick<EmulatorDevice, 'serial' | 'type' | 'model' | 'product'>): string
export function formatTimestamp(): string
export const EMULATOR_PROVIDERS: EmulatorProvider[]
export function filterProviders(category?: string, query?: string): EmulatorProvider[]
export function detectProvider(serialOrAddress: string): string | null
