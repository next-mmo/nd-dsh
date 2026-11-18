"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@renderer/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-black/10 p-[2px] transition-[background-color,box-shadow,border-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[20px] data-[size=default]:w-[36px] data-[size=sm]:h-[15px] data-[size=sm]:w-[26px] data-[state=checked]:border-primary/80 data-[state=checked]:bg-primary data-[state=checked]:shadow-[inset_0_1px_1px_rgba(0,0,0,0.12)] data-[state=unchecked]:bg-black/[0.14] data-[state=unchecked]:shadow-[inset_0_1px_2px_rgba(0,0,0,0.16)] dark:border-white/10 dark:data-[state=unchecked]:bg-white/[0.16]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.30),0_1px_1px_rgba(0,0,0,0.16),inset_0_0.5px_0_rgba(255,255,255,0.95)] ring-0 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[size=default]/switch:size-[14px] group-data-[size=sm]/switch:size-[11px] group-data-[size=default]/switch:data-[state=checked]:translate-x-[16px] group-data-[size=sm]/switch:data-[state=checked]:translate-x-[11px] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
