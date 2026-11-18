import * as React from "react"

import { cn } from "@renderer/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-[9px] border border-input bg-surface-0/60 px-3 py-2 text-base text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.14),0_1px_0_rgba(255,255,255,0.04)] transition-[background-color,border-color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-border-strong focus-visible:border-ring focus-visible:bg-surface-1/85 focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
