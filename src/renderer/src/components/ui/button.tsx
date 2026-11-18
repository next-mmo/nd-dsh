import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@renderer/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[9px] text-sm font-medium whitespace-nowrap outline-none transition-[transform,background-color,border-color,color,box-shadow,opacity] duration-150 active:scale-[0.985] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45 disabled:active:scale-100 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border border-primary/80 bg-primary bg-gradient-to-b from-white/[0.15] to-transparent text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.24)] hover:brightness-105 active:brightness-95",
        destructive:
          "border border-destructive/80 bg-destructive bg-gradient-to-b from-white/[0.14] to-transparent text-white shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.20)] hover:brightness-105 active:brightness-95 focus-visible:ring-destructive/20",
        outline:
          "border border-border-strong/90 bg-surface-1/85 bg-gradient-to-b from-white/[0.06] to-transparent text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl hover:bg-accent hover:text-accent-foreground",
        secondary:
          "border border-border-soft bg-secondary bg-gradient-to-b from-white/[0.05] to-transparent text-secondary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.07)] hover:bg-accent",
        ghost:
          "border border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        link: "rounded-none text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-[7px] px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-lg px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-[10px] px-6 has-[>svg]:px-4",
        icon: "size-9 rounded-[9px]",
        "icon-xs": "size-6 rounded-[7px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-lg",
        "icon-lg": "size-10 rounded-[10px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
