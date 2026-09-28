import { Info } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Small (i) icon that explains a feature on hover or focus. */
export function Hint({ children, className, side = 'top' }: {
  children: React.ReactNode
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="More info"
          className={cn('inline-flex size-4 items-center justify-center rounded-full align-middle text-muted-foreground/70 transition hover:text-foreground focus-visible:text-foreground', className)}>
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-72 text-xs leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  )
}

/** Wrap any element with an explanatory tooltip. */
export function Tip({ label, children, side = 'top' }: {
  label: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-72 text-xs leading-relaxed">{label}</TooltipContent>
    </Tooltip>
  )
}
