import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"

import { cn } from "@/lib/utils"
import { ChevronRightIcon, CheckIcon } from "lucide-react"

// Workaround: Radix UI 2.3+ types don't include className/children on some primitives
const P = ContextMenuPrimitive as any;

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <P.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger> & {
  className?: string
  children?: React.ReactNode
  asChild?: boolean
}) {
  return (
    <P.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <P.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return (
    <P.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <P.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <P.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  className?: string
  side?: "top" | "right" | "bottom" | "left"
}) {
  return (
    <P.Portal>
      <P.Content
        data-slot="context-menu-content"
        className={cn(
          "z-50 max-h-(--radix-context-menu-content-available-height) min-w-36 origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto",
          "bg-white/90 backdrop-blur-md border border-white/80 shadow-lg rounded-xl p-1.5",
          "dark:bg-stone-800/90 dark:border-stone-700/50",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
          "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </P.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  className?: string
  inset?: boolean
  variant?: "default" | "destructive"
  children?: React.ReactNode
  onClick?: React.MouseEventHandler<HTMLDivElement>
}) {
  return (
    <P.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-hidden select-none transition-colors",
        "data-inset:pl-7",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // 默认项：主题强调色 hover
        variant === "default" && [
          "text-neutral-700 dark:text-stone-300",
          "hover:bg-[var(--element-muted)] hover:text-[var(--element-color-raw)]",
          "focus:bg-[var(--element-muted)] focus:text-[var(--element-color-raw)]",
          "[&_svg]:text-neutral-400 dark:[&_svg]:text-stone-500",
          "hover:[&_svg]:text-[var(--element-color-raw)] focus:[&_svg]:text-[var(--element-color-raw)]",
        ],
        // 破坏性操作：保持红色，不受主题色影响
        variant === "destructive" && [
          "text-red-500 dark:text-red-400",
          "hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-600 dark:hover:text-red-300",
          "focus:bg-red-50 dark:focus:bg-red-950/30 focus:text-red-600 dark:focus:text-red-300",
          "[&_svg]:text-red-400",
          "hover:[&_svg]:text-red-500 focus:[&_svg]:text-red-500",
        ],
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  className?: string
  inset?: boolean
  children?: React.ReactNode
}) {
  return (
    <P.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-hidden select-none",
        "text-neutral-700 dark:text-stone-300",
        "hover:bg-[var(--element-muted)] hover:text-[var(--element-color-raw)]",
        "focus:bg-[var(--element-muted)] focus:text-[var(--element-color-raw)]",
        "data-open:bg-[var(--element-muted)] data-open:text-[var(--element-color-raw)]",
        "data-inset:pl-7",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </P.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent> & {
  className?: string
}) {
  return (
    <P.SubContent
      data-slot="context-menu-sub-content"
      className={cn(
        "z-50 min-w-32 origin-(--radix-context-menu-content-transform-origin) overflow-hidden",
        "bg-white/90 backdrop-blur-md border border-white/80 shadow-lg rounded-xl p-1.5",
        "dark:bg-stone-800/90 dark:border-stone-700/50",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  className?: string
  inset?: boolean
  children?: React.ReactNode
  checked?: boolean
}) {
  return (
    <P.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-lg py-2 pr-8 pl-2.5 text-sm outline-hidden select-none",
        "text-neutral-700 dark:text-stone-300",
        "hover:bg-[var(--element-muted)] hover:text-[var(--element-color-raw)]",
        "focus:bg-[var(--element-muted)] focus:text-[var(--element-color-raw)]",
        "data-inset:pl-7",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <P.ItemIndicator>
          <CheckIcon />
        </P.ItemIndicator>
      </span>
      {children}
    </P.CheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  className?: string
  inset?: boolean
  children?: React.ReactNode
}) {
  return (
    <P.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-lg py-2 pr-8 pl-2.5 text-sm outline-hidden select-none",
        "text-neutral-700 dark:text-stone-300",
        "hover:bg-[var(--element-muted)] hover:text-[var(--element-color-raw)]",
        "focus:bg-[var(--element-muted)] focus:text-[var(--element-color-raw)]",
        "data-inset:pl-7",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <P.ItemIndicator>
          <CheckIcon />
        </P.ItemIndicator>
      </span>
      {children}
    </P.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  className?: string
  inset?: boolean
}) {
  return (
    <P.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-2.5 py-1.5 text-xs font-medium text-neutral-400 dark:text-stone-500 data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator> & {
  className?: string
}) {
  return (
    <P.Separator
      data-slot="context-menu-separator"
      className={cn("my-1 h-px bg-neutral-200/30 dark:bg-stone-700/30", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-neutral-400 dark:text-stone-500",
        "group-hover/context-menu-item:text-[var(--element-color-raw)]",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
