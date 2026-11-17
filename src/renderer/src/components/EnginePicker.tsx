import { useMemo, useState } from 'react'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import type { CodingEngineDescriptor } from '../../../shared/contracts'
import { ND_HARNESS_ENGINE_ID } from '../../../shared/coding-engines'
import { cn } from '../lib/utils'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const DEFAULT_ENGINE_LABEL = 'Default · ND Harness'

interface EnginePickerOption {
  id: string
  label: string
  keywords: string[]
  available: boolean
  title?: string
}

interface EnginePickerProps {
  value: string
  engines: CodingEngineDescriptor[]
  onValueChange(engineId: string): void
  triggerClassName?: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  title?: string
}

export function EnginePicker({
  value,
  engines,
  onValueChange,
  triggerClassName,
  side = 'bottom',
  align = 'start',
  title,
}: EnginePickerProps) {
  const [open, setOpen] = useState(false)

  const options = useMemo<EnginePickerOption[]>(() => [
    {
      id: ND_HARNESS_ENGINE_ID,
      label: DEFAULT_ENGINE_LABEL,
      keywords: ['default', 'nd harness', 'harness', ND_HARNESS_ENGINE_ID],
      available: true,
      title: 'ND Harness — durable ND runtime with browser, MCP, skills, and provider-routed models',
    },
    ...engines
      .filter((engine) => engine.id !== ND_HARNESS_ENGINE_ID)
      .map((engine) => ({
        id: engine.id,
        label: `${engine.name}${engine.available ? '' : ' · Unavailable'}`,
        keywords: [engine.name, engine.id],
        available: engine.available,
        title: engine.available ? engine.description : engine.unavailableReason ?? `${engine.name} is unavailable`,
      })),
  ], [engines])

  const selectedLabel = options.find((option) => option.id === value)?.label ?? value

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="Coding engine"
          title={title}
          className={cn(
            'flex items-center justify-between gap-1 rounded-md border border-border-soft bg-transparent font-mono text-faint transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3 [&_svg]:shrink-0',
            triggerClassName,
          )}
        >
          <span className="min-w-0 truncate">{selectedLabel}</span>
          <ChevronDownIcon className="opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className="w-[252px] rounded-[10px] border-border-strong bg-surface-1 p-0 shadow-[0_14px_40px_rgba(0,0,0,0.42)]"
      >
        <Command className="bg-transparent">
          <CommandInput
            placeholder="Search engines…"
            aria-label="Search engines"
            wrapperClassName="h-8 border-border-soft px-2.5 [&_svg]:size-3.5"
            className="h-8 py-0 text-[11px] placeholder:text-faint"
          />
          <CommandList className="max-h-[268px] p-1">
            <CommandEmpty className="py-6 text-[10px]">No engine matches.</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                keywords={option.keywords}
                disabled={!option.available}
                title={option.title}
                onSelect={(selected) => {
                  onValueChange(selected)
                  setOpen(false)
                }}
                className="gap-2 rounded-md px-2 py-1.5 font-mono text-[10px] text-soft data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {value === option.id ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}